#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ESP32 转发器（forward.py）
=========================

一个文件搞定三件事，不需要装任何东西（只用 Python 自带的标准库）：

1. 把网页面板托管出来     http://127.0.0.1:8765/
2. 把网页按钮的请求转发给 ESP32（绕开 CORS 和 HTTPS 混合内容）
3. 顺手给个命令行测试接口  http://127.0.0.1:8765/send?msg=on

用法
----
    python forward.py                          # 最常用，默认 8765 端口
    python forward.py --target 192.168.4.1:8080    # 顺便记住板子地址
    python forward.py --port 9000 --open       # 换端口并自动开浏览器

Windows 也可以直接双击 `启动转发.bat`。

网页里怎么配
------------
- 页面地址：http://127.0.0.1:8765/
- 左侧「代理地址」留空即可（同源 /proxy 自动生效）
- 按钮的目标地址照常写 http://192.168.4.1:8080/cmd
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

APP_VERSION = "1.0.0"
DEFAULT_PORT = 8765
DEFAULT_TARGET = ""      # --target 传入后作为相对路径的默认目标
ROOT = os.path.dirname(os.path.abspath(__file__))

# Windows 控制台默认 GBK，中文容易炸，先兜一下
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass


def local_ip():
    """局域网 IP，拿不到就 127.0.0.1。

    用 UDP connect 只查路由表、不发包，比 TCP connect 更稳
    （没外网、只连了 ESP32 的 WiFi 也能拿到地址）。
    """
    for probe in ("8.8.8.8", "114.114.114.114", "10.255.255.255"):
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((probe, 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
        except Exception:
            pass
        finally:
            if s is not None:
                try:
                    s.close()
                except Exception:
                    pass

    # 退回主机名解析
    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return "127.0.0.1"


def normalize_target(t):
    """把 192.168.4.1:8080 补成 http://192.168.4.1:8080。"""
    t = (t or "").strip()
    if not t:
        return ""
    if "://" not in t:
        t = "http://" + t
    return t.rstrip("/")


class Handler(SimpleHTTPRequestHandler):
    server_version = "ESP32Forward/" + APP_VERSION

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------------- 基础 ----------------
    def log_message(self, fmt, *args):
        if "/proxy" in (self.path or "") or "/send" in (self.path or ""):
            return                      # 转发日志自己打印，带状态码和耗时
        sys.stderr.write("  %s\n" % (fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        # 让公网 https 页面（GitHub Pages）也能访问本地转发器
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def end_headers(self):
        self._cors()
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # ---------------- 路由 ----------------
    def do_GET(self):
        if self.path.startswith("/proxy"):
            return self._proxy()
        if self.path.startswith("/send"):
            return self._quick_send()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/proxy"):
            return self._proxy()
        if self.path.startswith("/send"):
            return self._quick_send()
        self.send_response(404)
        self.end_headers()

    def do_PUT(self):
        if self.path.startswith("/proxy"):
            return self._proxy()
        self.send_response(404)
        self.end_headers()

    # ---------------- 快捷发送 ----------------
    def _quick_send(self):
        """GET /send?msg=on  ->  直接打到 --target 的 /cmd。"""
        if not DEFAULT_TARGET:
            return self._json({"error": "启动时没带 --target，无法快捷发送"}, 400)
        qs = parse_qs(urlparse(self.path).query)
        msg = unquote(qs.get("msg", ["on"])[0])
        url = DEFAULT_TARGET + "/cmd"
        self._forward(url, "POST", msg.encode("utf-8"),
                      {"Content-Type": "text/plain; charset=utf-8"}, 5.0)

    # ---------------- 核心：转发 ----------------
    def _proxy(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if "ping" in qs:                     # 网页用来探测代理是否在线
            return self._json({"ok": True, "proxy": True, "target": DEFAULT_TARGET})

        body = b""
        length = self.headers.get("Content-Length")
        if length:
            try:
                body = self.rfile.read(int(length))
            except Exception:
                body = b""

        if body:
            try:
                env = json.loads(body.decode("utf-8"))
            except Exception:
                return self._json({"error": "请求体必须是 JSON"}, 400)
            url = env.get("url") or ""
            method = (env.get("method") or "GET").upper()
            headers = env.get("headers") or {}
            data = env.get("body")
            timeout = float(env.get("timeout") or 5)
        else:
            url = unquote(qs.get("url", [""])[0])
            method = (qs.get("method", ["GET"])[0] or "GET").upper()
            headers = {}
            data = None
            timeout = float(qs.get("timeout", ["5"])[0])

        url = self._resolve(url)
        if not url:
            raw = (qs.get("url", [""])[0] if not body else "").strip()
            if raw.startswith("/"):
                return self._json({
                    "error": "url 是相对路径（%s），但启动时没带 --target，不知道转发到哪台设备" % raw,
                    "hint": "改成完整地址 /proxy?url=http://192.168.4.1:8080%s，或启动加 --target 192.168.4.1:8080" % raw,
                }, 400)
            return self._json({"error": "缺少 url 参数，例如 /proxy?url=http://192.168.4.1:8080/status"}, 400)

        payload = None
        if data is not None and method != "GET":
            payload = data.encode("utf-8") if isinstance(data, str) else data
        self._forward(url, method, payload, headers, timeout)

    def _resolve(self, url):
        """相对路径时挂到 --target 上。"""
        url = (url or "").strip()
        if not url:
            return DEFAULT_TARGET + "/cmd" if DEFAULT_TARGET else ""
        if url.startswith("/"):
            if not DEFAULT_TARGET:
                return ""
            return DEFAULT_TARGET + url
        if "://" not in url:
            url = "http://" + url
        return url

    def _forward(self, url, method, payload=None, headers=None, timeout=5.0):
        req = urllib.request.Request(url, data=payload, method=method)
        for k, v in (headers or {}).items():
            if k.lower() == "host":
                continue
            req.add_header(k, v)
        req.add_header("User-Agent", "esp32-forward/" + APP_VERSION)

        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read(65536)
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read(65536) if hasattr(e, "read") else b""
            status = e.code
        except Exception as e:
            ms = int((time.time() - t0) * 1000)
            msg = self._friendly(e)
            print("  ✕ %-5s %s  %dms  %s" % (method, "---", ms, msg))
            return self._json({"error": msg}, 502)

        ms = int((time.time() - t0) * 1000)
        text = raw.decode("utf-8", "replace")
        print("  → %-5s %-4d %4dms  %s" % (method, status, ms, url))
        return self._json({"ok": True, "status": status, "body": text, "ms": ms})

    @staticmethod
    def _friendly(e):
        s = str(e).lower()
        if "refused" in s:
            return "连不上设备（Connection refused），检查 IP / 端口 / 是否同一 WiFi"
        if "timed out" in s or "timeout" in s:
            return "连接超时，设备没响应"
        if "getaddrinfo" in s or "name or service not known" in s:
            return "地址解析失败，IP 写错了？"
        if "network is unreachable" in s:
            return "网络不可达，电脑和 ESP32 可能不在同一网段"
        return "%s: %s" % (type(e).__name__, e)

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    global DEFAULT_TARGET

    p = argparse.ArgumentParser(
        description="ESP32 转发器：托管网页面板 + 把请求转发给板子（单文件，零依赖）")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="本机端口，默认 8765")
    p.add_argument("--host", default="0.0.0.0", help="绑定地址，默认 0.0.0.0（手机也能访问）")
    p.add_argument("--target", default="", help="默认设备地址，例如 192.168.4.1:8080")
    p.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    p.add_argument("-v", "--version", action="version", version="forward " + APP_VERSION)
    args = p.parse_args()

    DEFAULT_TARGET = normalize_target(args.target)

    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("  ! 当前目录找不到 index.html，请把 forward.py 和 index.html 放在一起")
        return 1

    try:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print("  ! 端口 %d 启动失败：%s" % (args.port, e))
        print("    换个端口试试：python forward.py --port 9000")
        return 1

    ip = local_ip()
    print("")
    print("  ╭──────────────────────────────────────────────╮")
    print("  │  ESP32 转发器已启动                          │")
    print("  ╰──────────────────────────────────────────────╯")
    print("    本机打开：http://127.0.0.1:%d/" % args.port)
    if ip.startswith("127."):
        print("    手机/平板：未检测到局域网地址（本机没连 WiFi / 网线？）")
    else:
        print("    手机/平板：http://%s:%d/" % (ip, args.port))
    if DEFAULT_TARGET:
        print("    默认设备：%s" % DEFAULT_TARGET)
        print("    快捷测试：http://127.0.0.1:%d/send?msg=on" % args.port)
    else:
        print("    默认设备：未设置（网页里按钮写完整地址即可）")
    print("")
    print("    网页里「代理地址」留空就行，转发走同源 /proxy")
    print("    按 Ctrl+C 停止")
    print("")

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open("http://127.0.0.1:%d/" % args.port)).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
