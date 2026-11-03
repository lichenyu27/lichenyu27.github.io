# -*- coding: utf-8 -*-
"""
esp32web —— ESP32 与网页互通的极简 HTTP 工具库
================================================

单文件、零依赖，同一份代码既能在 PC 的 CPython 上跑，也能直接丢进
ESP32 的 MicroPython 里当 main.py 用。

三个核心功能
------------
1. start()   —— 在 ESP32 上启动一个 IP 地址（开一个 HTTP 服务，绑定端口）
2. query()   —— 查询这个地址（拿 /status、看延迟、确认板子活着）
3. listen()  —— 监听其他地址发来的信息（网页按钮、另一块板子、脚本）

另外附带：
4. send()    —— 主动往某个地址发一条消息（命令行 / 脚本都好用）
5. ui 子命令 —— 本地托管网页面板 + 反向代理，彻底绕开 CORS 与 HTTPS 混合内容

MicroPython 用法（ESP32 上）
---------------------------
    import esp32web
    srv = esp32web.start(port=8080, name="my-esp32")

    def on_msg(m):
        print("收到：", m["msg"])
        if m["msg"] == "on":
            led.value(1)

    esp32web.listen(port=8080, callback=on_msg)

CPython 用法（电脑上）
---------------------
    import esp32web
    esp32web.start(port=8080)                 # 电脑上开一个假的 ESP32，方便调试
    print(esp32web.query("192.168.4.1"))      # 查板子
    esp32web.send("192.168.4.1", "on")        # 给板子发指令
    esp32web.listen(port=8080, callback=print)

命令行
------
    python esp32web.py serve  --port 8080          # 起服务（模拟 ESP32）
    python esp32web.py query  192.168.4.1          # 查询状态
    python esp32web.py send   192.168.4.1 on       # 发消息
    python esp32web.py listen --port 8080          # 监听打印
    python esp32web.py ui                          # 本地托管网页（含代理）

协议（HTTP，全部带 CORS 头）
---------------------------
    GET  /status          -> {"ok":true, "name":..., "ip":..., "uptime":...}
    GET  /ping            -> pong
    GET  /cmd?msg=on      -> 触发回调
    POST /cmd  body=on    -> 触发回调
    OPTIONS *             -> 204（预检直接放行）
"""

import socket
import sys
import time

try:                      # MicroPython
    import ujson as json
except ImportError:       # CPython
    import json

try:
    import threading
except ImportError:       # MicroPython 默认没有 threading
    threading = None

__version__ = "1.0.0"
__all__ = ["Esp32Web", "start", "query", "listen", "send", "local_ip"]

_IS_MICRO = getattr(getattr(sys, "implementation", None), "name", "") == "micropython"
_MAX_BODY = 8192
_HISTORY = 20

_REASONS = {
    200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request",
    403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    500: "Internal Server Error",
}


# --------------------------------------------------------------------------
# 小工具（不依赖 urllib，MicroPython 也能跑）
# --------------------------------------------------------------------------

def _unquote(s):
    """URL 解码：+ -> 空格，%XX -> 字节。"""
    if "%" not in s and "+" not in s:
        return s
    s = s.replace("+", " ")
    buf = bytearray()
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "%" and i + 2 < n:
            try:
                buf.append(int(s[i + 1:i + 3], 16))
                i += 3
                continue
            except ValueError:
                pass
        buf.append(ord(c))
        i += 1
    try:
        return buf.decode("utf-8")
    except Exception:
        return buf.decode("latin-1")


def _quote(s):
    """URL 编码，保留常见安全字符。"""
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~"
    out = []
    for ch in str(s):
        if ch in safe:
            out.append(ch)
        elif ch == " ":
            out.append("%20")
        else:
            for b in ch.encode("utf-8"):
                out.append("%%%02X" % b)
    return "".join(out)


def _parse_qs(qs):
    out = {}
    if not qs:
        return out
    for part in qs.split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        out[_unquote(k)] = _unquote(v)
    return out


def _to_bytes(x):
    if x is None:
        return b""
    if isinstance(x, bytes):
        return x
    if isinstance(x, bytearray):
        return bytes(x)
    return str(x).encode("utf-8")


def _to_str(x):
    if x is None:
        return ""
    if isinstance(x, (bytes, bytearray)):
        try:
            return bytes(x).decode("utf-8")
        except Exception:
            return bytes(x).decode("latin-1")
    return str(x)


def local_ip():
    """拿到本机在局域网里的 IP（拿不到就返回 127.0.0.1）。"""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass


# --------------------------------------------------------------------------
# 核心类
# --------------------------------------------------------------------------

class Esp32Web(object):
    """一个跑在 ESP32（或电脑）上的迷你 HTTP 服务 + 客户端。

    :param name: 设备名，会出现在 /status 里
    :param port: 默认端口
    :param host: 默认绑定地址，0.0.0.0 表示所有网卡
    """

    def __init__(self, name="esp32", port=8080, host="0.0.0.0", debug=False):
        self.name = name
        self.port = int(port)
        self.host = host
        self.debug = debug

        self.routes = {}          # path -> handler
        self.messages = []        # 最近收到的消息（新的在前）
        self.count = 0            # 累计收到多少条
        self.last = None          # 最后一条消息
        self.callback = None      # 全局回调
        self.started_at = time.time()

        self._sock = None
        self._running = False
        self._thread = None
        self._ip = None

    # ---------------- 1. 启动服务（在 ESP32 上开一个 IP 地址） ----------------

    def start(self, ip=None, port=None, background=True):
        """绑定地址并开始监听，返回 self（方便链式调用）。

        :param ip:   绑定的本地地址，默认 0.0.0.0（所有网卡）
        :param port: 端口，默认用构造函数里的
        :param background: True 时在后台线程跑（仅 CPython）；
                           MicroPython 请用 False，然后在 while 循环里 poll()
        """
        if self._running:
            return self
        if port:
            self.port = int(port)
        if ip:
            self.host = ip

        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except Exception:
            pass
        s.bind((self.host, self.port))
        s.listen(5)
        s.settimeout(0.2)
        self._sock = s
        self._running = True
        self.started_at = time.time()
        self._ip = local_ip() if self.host in ("0.0.0.0", "") else self.host

        if background and threading is not None:
            self._thread = threading.Thread(target=self._loop, name="esp32web")
            self._thread.daemon = True
            self._thread.start()

        if self.debug:
            print("[esp32web] 服务已启动 http://%s:%d  (%s)" % (self._ip, self.port, self.name))
        return self

    def stop(self):
        """停止服务。"""
        self._running = False
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
        self._sock = None
        return self

    def poll(self, timeout=0.2):
        """处理一次请求（非阻塞轮询，MicroPython 的 while 循环里用）。

        返回 True 表示处理了一个请求，False 表示这轮没动静。
        """
        if self._sock is None:
            return False
        try:
            self._sock.settimeout(timeout)
            conn, addr = self._sock.accept()
        except Exception:
            return False
        try:
            self._handle(conn, addr)
        except Exception as e:                      # 单次请求出错不能弄挂服务
            if self.debug:
                print("[esp32web] 处理出错:", e)
            try:
                self._respond(conn, 500, '{"ok":false,"error":"server error"}')
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return True

    def _loop(self):
        while self._running:
            self.poll(0.2)

    def is_running(self):
        return self._running

    # ---------------- 2. 查询地址 ----------------

    def query(self, ip, port=None, path="/status", timeout=3.0):
        """查询某个地址，返回 dict：

        {"ok": True, "status": 200, "body": "...", "json": {...}, "ms": 12.3}
        """
        port = int(port or self.port)
        return self._request(ip, port, path, "GET", None, timeout)

    def send(self, ip, port, msg, path="/cmd", method="POST", timeout=3.0):
        """往某个地址发一条消息。"""
        body = _to_bytes(msg)
        hdrs = {"Content-Type": "text/plain; charset=utf-8"}
        return self._request(ip, port, path, method, body, timeout, hdrs)

    def _request(self, ip, port, path, method="GET", body=None, timeout=3.0, headers=None):
        t0 = time.time()
        result = {"ok": False, "status": 0, "body": "", "json": None,
                  "ms": 0, "error": None, "url": "http://%s:%s%s" % (ip, port, path)}
        conn = None
        try:
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.settimeout(timeout)
            conn.connect((ip, port))
            body = _to_bytes(body)
            lines = [
                "%s %s HTTP/1.1" % (method, path),
                "Host: %s:%s" % (ip, port),
                "User-Agent: esp32web/%s" % __version__,
                "Accept: */*",
                "Connection: close",
            ]
            headers = headers or {}
            for k, v in headers.items():
                lines.append("%s: %s" % (k, v))
            if body:
                lines.append("Content-Length: %d" % len(body))
                if "Content-Type" not in headers:
                    lines.append("Content-Type: text/plain; charset=utf-8")
            raw = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + body
            conn.send(raw)

            buf = b""
            while True:
                chunk = conn.recv(1024)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > 65536:
                    break
            result.update(self._parse_response(buf))
        except Exception as e:
            result["error"] = "%s: %s" % (type(e).__name__, e)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
        result["ms"] = round((time.time() - t0) * 1000, 1)
        result["ok"] = bool(result["status"] and 200 <= result["status"] < 400)
        return result

    @staticmethod
    def _parse_response(buf):
        out = {"status": 0, "body": "", "json": None, "headers": {}}
        if not buf:
            return out
        head, _, body = buf.partition(b"\r\n\r\n")
        head_lines = _to_str(head).split("\r\n")
        if head_lines and head_lines[0].startswith("HTTP/"):
            parts = head_lines[0].split(" ", 2)
            if len(parts) >= 2:
                try:
                    out["status"] = int(parts[1])
                except ValueError:
                    pass
        for line in head_lines[1:]:
            k, _, v = line.partition(":")
            if k:
                out["headers"][k.strip().lower()] = v.strip()
        text = _to_str(body)
        out["body"] = text
        if text.strip():
            try:
                out["json"] = json.loads(text)
            except Exception:
                out["json"] = None
        return out

    # ---------------- 3. 监听消息 ----------------

    def listen(self, callback=None, duration=None, port=None, ip=None):
        """启动服务（如果还没启动）并开始监听别的地址发来的消息。

        :param callback: 收到消息时调用，参数是 dict：
                         {"msg","method","path","query","body","addr","time"}
        :param duration: 监听多少秒后自动结束；None 表示一直听（Ctrl+C 退出）
        :return: self，之后可以用 .messages 看历史
        """
        if callback is not None:
            self.callback = callback
        if not self._running:
            self.start(ip=ip, port=port, background=False)

        # 如果已经有后台线程在收，就别再重复 poll 抢同一个 socket
        has_bg = self._thread is not None and hasattr(self._thread, "is_alive") and self._thread.is_alive()

        if self.debug:
            print("[esp32web] 监听中 http://%s:%d  (Ctrl+C 结束)" % (self._ip, self.port))
        end = None if duration is None else time.time() + duration
        try:
            while self._running:
                if has_bg:
                    time.sleep(0.1)
                else:
                    self.poll(0.2)
                if end is not None and time.time() >= end:
                    break
        except KeyboardInterrupt:
            if self.debug:
                print("\n[esp32web] 已停止")
        return self

    def on(self, path, handler):
        """注册自定义路由。handler(req) 返回 dict / str / (status, body)。"""
        self.routes[path] = handler
        return self

    def history(self, limit=None):
        """最近收到的消息（新的在前）。"""
        return self.messages[:limit] if limit else list(self.messages)

    def info(self):
        up = int(time.time() - self.started_at)
        free = None
        try:
            import gc
            free = gc.mem_free()
        except Exception:
            pass
        return {
            "ok": True,
            "name": self.name,
            "ip": self._ip or self.host,
            "port": self.port,
            "uptime": up,
            "count": self.count,
            "last": self.last,
            "free_mem": free,
            "version": __version__,
        }

    # ---------------- 请求处理 ----------------

    def _handle(self, conn, addr):
        conn.settimeout(0.8)
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 4096:
            chunk = conn.recv(512)
            if not chunk:
                break
            data += chunk
        if not data:
            return

        head, _, rest = data.partition(b"\r\n\r\n")
        lines = _to_str(head).split("\r\n")
        req_line = lines[0].split(" ") if lines else [""]
        method = req_line[0].upper() if req_line else "GET"
        target = req_line[1] if len(req_line) > 1 else "/"

        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            if k:
                headers[k.strip().lower()] = v.strip()

        length = 0
        try:
            length = int(headers.get("content-length", "0") or 0)
        except ValueError:
            length = 0
        body = rest
        while len(body) < length and len(body) < _MAX_BODY:
            chunk = conn.recv(min(512, length - len(body)))
            if not chunk:
                break
            body += chunk

        path, _, qs = target.partition("?")
        query = _parse_qs(qs)
        text = _to_str(body)

        # CORS 预检：直接放行
        if method == "OPTIONS":
            self._respond(conn, 204, b"", extra={
                "Access-Control-Allow-Private-Network": "true",
            })
            return

        # 静态首页，方便浏览器直接打开看看
        if path in ("/", "/index.html") and method == "GET":
            self._respond(conn, 200, self._home_html(), "text/html; charset=utf-8")
            return

        if path == "/status":
            self._respond_json(conn, 200, self.info())
            return

        if path == "/ping":
            self._respond(conn, 200, "pong", "text/plain; charset=utf-8")
            return

        # 自定义路由优先
        handler = self.routes.get(path)
        if handler is None and path.rstrip("/") in self.routes:
            handler = self.routes[path.rstrip("/")]
        if handler is not None:
            try:
                res = handler(self._make_msg(method, path, query, text, addr))
                if isinstance(res, tuple):
                    status, out = res[0], res[1]
                else:
                    status, out = 200, res
                if isinstance(out, (dict, list)):
                    self._respond_json(conn, status, out)
                else:
                    self._respond(conn, status, out)
            except Exception as e:
                self._respond_json(conn, 500, {"ok": False, "error": str(e)})
            return

        # 默认指令入口
        if path in ("/cmd", "/message", "/msg", "/api/cmd"):
            msg = self._make_msg(method, path, query, text, addr)
            self._record(msg)
            try:
                if self.callback:
                    self.callback(msg)
            except Exception as e:
                if self.debug:
                    print("[esp32web] 回调异常:", e)
                self._respond_json(conn, 500, {"ok": False, "error": str(e), "count": self.count})
                return
            self._respond_json(conn, 200, {
                "ok": True, "received": msg["msg"], "count": self.count,
                "name": self.name,
            })
            return

        self._respond_json(conn, 404, {"ok": False, "error": "not found", "path": path})

    def _make_msg(self, method, path, query, body, addr):
        msg = query.get("msg")
        if msg is None and body:
            msg = body
            # 如果 body 是 JSON，试着抠出 msg 字段
            stripped = body.strip()
            if stripped[:1] in ("{", "["):
                try:
                    obj = json.loads(stripped)
                    if isinstance(obj, dict):
                        msg = obj.get("msg", obj.get("message", body))
                except Exception:
                    pass
        if msg is None:
            msg = ""
        return {
            "msg": msg,
            "method": method,
            "path": path,
            "query": query,
            "body": body,
            "addr": str(addr[0]) if addr else "",
            "time": time.time(),
        }

    def _record(self, msg):
        self.count += 1
        self.last = msg
        self.messages.insert(0, msg)
        if len(self.messages) > _HISTORY:
            self.messages.pop()
        if self.debug:
            print("[esp32web] <- %s  %r" % (msg["addr"], msg["msg"]))

    def _respond_json(self, conn, status, obj):
        try:
            body = json.dumps(obj)
        except Exception:
            body = '{"ok":false}'
        self._respond(conn, status, body, "application/json; charset=utf-8")

    def _respond(self, conn, status, body, ctype="text/plain; charset=utf-8", extra=None):
        body = _to_bytes(body)
        head = "HTTP/1.1 %d %s\r\n" % (status, _REASONS.get(status, "OK"))
        head += "Content-Type: %s\r\n" % ctype
        head += "Content-Length: %d\r\n" % len(body)
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS, HEAD\r\n"
        head += "Access-Control-Allow-Headers: *\r\n"
        head += "Access-Control-Max-Age: 86400\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n"
        if extra:
            for k, v in extra.items():
                head += "%s: %s\r\n" % (k, v)
        head += "\r\n"
        conn.send(head.encode("utf-8") + body)

    def _home_html(self):
        return (
            "<!doctype html><meta charset='utf-8'>"
            "<title>%s</title>"
            "<style>body{background:#070a0f;color:#e8eef6;font:15px/1.7 system-ui;"
            "display:grid;place-items:center;height:100vh;margin:0;text-align:center}"
            "code{color:#22d3ee;background:#0d1620;padding:2px 7px;border-radius:6px}"
            "h1{font-size:20px;margin:0 0 6px}p{color:#8b9bb0;margin:4px}</style>"
            "<div><h1>◉ %s 在线</h1>"
            "<p>端口 <code>%d</code> · 已收 <code>%d</code> 条消息</p>"
            "<p>试试 <code>/status</code> · <code>/ping</code> · <code>/cmd?msg=on</code></p></div>"
        ) % (self.name, self.name, self.port, self.count)


# --------------------------------------------------------------------------
# 模块级快捷函数
# --------------------------------------------------------------------------

_default = None


def start(ip=None, port=8080, name="esp32", background=True, debug=False):
    """在 ESP32（或本机）上启动一个 IP 地址：开服务、绑端口。"""
    global _default
    _default = Esp32Web(name=name, port=port, debug=debug)
    return _default.start(ip=ip, port=port, background=background)


def query(ip, port=8080, path="/status", timeout=3.0):
    """查询某个地址，返回 dict（ok / status / body / json / ms）。"""
    return Esp32Web().query(ip, port=port, path=path, timeout=timeout)


def send(ip, port=8080, msg="on", path="/cmd", method="POST", timeout=3.0):
    """往某个地址发一条消息。"""
    return Esp32Web().send(ip, port, msg, path=path, method=method, timeout=timeout)


def listen(port=8080, callback=None, duration=None, ip="0.0.0.0", debug=True):
    """监听其他地址发来的信息（阻塞）。"""
    srv = _default or Esp32Web(name="esp32", port=port, debug=debug)
    return srv.listen(callback=callback, duration=duration, port=port, ip=ip)


# --------------------------------------------------------------------------
# 命令行（仅 CPython）
# --------------------------------------------------------------------------

def _cli_ui(root, port, proxy_default):
    """本地托管网页 + 反向代理：绕开 CORS 和 HTTPS 混合内容。"""
    import json as _json
    import os
    import time as _time
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs, unquote
    import urllib.request
    import urllib.error

    root = os.path.abspath(root)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args):
            if "/proxy" not in (self.path or ""):
                sys.stderr.write("  %s\n" % (fmt % args))

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Max-Age", "86400")

        def end_headers(self):
            self._cors()
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/proxy"):
                return self._proxy()
            return super().do_GET()

        def do_POST(self):
            if self.path.startswith("/proxy"):
                return self._proxy()
            self.send_response(404)
            self.end_headers()

        def _proxy(self):
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            if "ping" in qs:
                return self._json({"ok": True, "proxy": True})

            body = b""
            length = self.headers.get("Content-Length")
            if length:
                try:
                    body = self.rfile.read(int(length))
                except Exception:
                    body = b""

            if body:
                try:
                    env = _json.loads(body.decode("utf-8"))
                except Exception:
                    return self._json({"error": "请求体必须是 JSON"}, 400)
                url = env.get("url")
                method = (env.get("method") or "GET").upper()
                headers = env.get("headers") or {}
                data = env.get("body")
                timeout = float(env.get("timeout") or 4)
            else:
                url = unquote(qs.get("url", [""])[0])
                method = (qs.get("method", ["GET"])[0] or "GET").upper()
                headers = {}
                data = None
                timeout = float(qs.get("timeout", ["4"])[0])

            if not url:
                return self._json({"error": "缺少 url 参数"}, 400)

            payload = None
            if data is not None and method != "GET":
                payload = data.encode("utf-8") if isinstance(data, str) else data
            ua = "esp32web-proxy/%s" % __version__
            req = urllib.request.Request(url, data=payload, method=method)
            for k, v in (headers or {}).items():
                req.add_header(k, v)
            req.add_header("User-Agent", ua)

            t0 = _time.time()
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read(65536)
                    status = resp.status
            except urllib.error.HTTPError as e:
                raw = e.read(65536) if hasattr(e, "read") else b""
                status = e.code
            except Exception as e:
                msg = "%s: %s" % (type(e).__name__, e)
                low = str(e).lower()
                if "refused" in low:
                    msg = "连不上设备（Connection refused），检查 IP / 端口 / 是否同一网络"
                elif "timed out" in low or "timeout" in low:
                    msg = "连接超时，设备没有响应"
                elif "name or service not known" in low or "getaddrinfo" in low:
                    msg = "地址解析失败，检查 IP 是否写错"
                return self._json({"error": msg}, 502)

            ms = int((_time.time() - t0) * 1000)
            text = raw.decode("utf-8", "replace")
            print("  proxy %-6s %-6d %4dms  %s" % (method, status, ms, url))
            return self._json({"ok": True, "status": status, "body": text, "ms": ms})

        def _json(self, obj, status=200):
            data = _json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("")
    print("  ◉ ESP32 按钮控制台已托管")
    print("    本机访问：http://127.0.0.1:%d/" % port)
    print("    局域网访问：http://%s:%d/" % (local_ip(), port))
    print("    代理接口：http://127.0.0.1:%d/proxy?url=http://192.168.4.1:8080/status" % port)
    print("    目录：%s" % root)
    print("    按 Ctrl+C 停止\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    finally:
        srv.server_close()


def main(argv=None):
    import argparse

    p = argparse.ArgumentParser(
        prog="esp32web",
        description="ESP32 与网页互通的极简 HTTP 工具（启动 / 查询 / 监听 / 网页托管）",
    )
    p.add_argument("-v", "--version", action="version", version="esp32web %s" % __version__)
    sub = p.add_subparsers(dest="cmd")

    s1 = sub.add_parser("serve", help="启动一个 HTTP 服务（相当于在电脑上模拟 ESP32）")
    s1.add_argument("--port", type=int, default=8080)
    s1.add_argument("--host", default="0.0.0.0")
    s1.add_argument("--name", default="esp32")

    s2 = sub.add_parser("query", help="查询设备状态")
    s2.add_argument("ip")
    s2.add_argument("--port", type=int, default=8080)
    s2.add_argument("--path", default="/status")
    s2.add_argument("--timeout", type=float, default=3.0)
    s2.add_argument("--json", action="store_true", help="只输出原始 JSON")

    s3 = sub.add_parser("send", help="给设备发一条消息")
    s3.add_argument("ip")
    s3.add_argument("msg", nargs="?", default="on")
    s3.add_argument("--port", type=int, default=8080)
    s3.add_argument("--path", default="/cmd")
    s3.add_argument("--method", default="POST")

    s4 = sub.add_parser("listen", help="监听其他设备/网页发来的消息")
    s4.add_argument("--port", type=int, default=8080)
    s4.add_argument("--ip", default="0.0.0.0")
    s4.add_argument("--duration", type=float, default=None)

    s5 = sub.add_parser("ui", help="本地托管网页控制台 + 代理（推荐）")
    s5.add_argument("--port", type=int, default=8765)
    s5.add_argument("--root", default=".")
    s5.add_argument("--open", action="store_true", help="自动打开浏览器")

    args = p.parse_args(argv)

    if args.cmd == "serve":
        srv = Esp32Web(name=args.name, port=args.port, debug=True)
        srv.start(ip=args.host, port=args.port, background=True)
        print("  服务地址：http://%s:%d/" % (local_ip(), args.port))
        print("  按 Ctrl+C 停止\n")
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            srv.stop()
            print("\n  已停止")
        return 0

    if args.cmd == "query":
        r = Esp32Web().query(args.ip, port=args.port, path=args.path, timeout=args.timeout)
        if args.json and r.get("json") is not None:
            print(json.dumps(r["json"], ensure_ascii=False, indent=2))
        elif r["ok"]:
            print("✓ %s 在线  %dms" % (r["url"], r["ms"]))
            print(r["body"][:2000])
        else:
            print("✕ 查询失败：%s（%s）" % (r["error"] or "无响应", r["url"]))
        return 0 if r["ok"] else 1

    if args.cmd == "send":
        r = Esp32Web().send(args.ip, args.port, args.msg, path=args.path, method=args.method)
        if r["ok"]:
            print("✓ 已发送 -> %s  (%dms)" % (r["url"], r["ms"]))
            if r["body"]:
                print("  返回：", r["body"][:400])
            return 0
        print("✕ 发送失败：%s" % r["error"])
        return 1

    if args.cmd == "listen":
        srv = Esp32Web(port=args.port, debug=True)

        def show(m):
            print("  %s  <- %-15s %-5s %s" % (
                time.strftime("%H:%M:%S"), m["addr"], m["method"], m["msg"]))

        print("  监听 0.0.0.0:%d ，Ctrl+C 结束\n" % args.port)
        srv.listen(callback=show, duration=args.duration, port=args.port, ip=args.ip)
        return 0

    if args.cmd == "ui":
        if args.open:
            import threading as _t
            import webbrowser
            _t.Timer(0.6, lambda: webbrowser.open("http://127.0.0.1:%d/" % args.port)).start()
        _cli_ui(args.root, args.port, None)
        return 0

    p.print_help()
    return 0


if __name__ == "__main__" and not _IS_MICRO:
    sys.exit(main())
