# -*- coding: utf-8 -*-
"""
最小示例：只收指令，不返回内容（MicroPython，裸 socket，不依赖 esp32web）
=====================================================================

适用场景：网页按钮用「URL 查询参数」或「纯文本 body」发过来，ESP32 只管动作，
不需要给网页任何数据（no-cors / 图片信标本来也读不到响应）。

要点：不返回内容 ≠ 什么都不发。必须回一个 204 空响应，否则浏览器会等到超时。

接线：LED -> GPIO4，蜂鸣器 -> GPIO5（按需改）
用法：改 WiFi 账号密码 → 存成 main.py → 复位，串口会打印 IP
"""

import network
import socket
import time

from machine import Pin

# ------------------------- 改这里 -------------------------
WIFI_SSID = "your-wifi"
WIFI_PASSWORD = "your-password"
PORT = 8080

LED_PIN = 4
BUZZER_PIN = 5
# ---------------------------------------------------------

led = Pin(LED_PIN, Pin.OUT)
buzzer = Pin(BUZZER_PIN, Pin.OUT)
led.value(0)
buzzer.value(0)


def beep(times=1, ms=80):
    for _ in range(times):
        buzzer.value(1)
        time.sleep(ms / 1000)
        buzzer.value(0)
        time.sleep(ms / 1000)


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print("连接 WiFi…")
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        start = time.time()
        while not wlan.isconnected():
            if time.time() - start > 20:
                print("连不上，检查账号密码")
                return None
            time.sleep(0.3)
    print("IP:", wlan.ifconfig()[0])
    return wlan


def read_request(conn):
    """读出完整请求，返回 (path, body 文本)。"""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(512)
        if not chunk:
            break
        data += chunk

    head, _, body = data.partition(b"\r\n\r\n")

    length = 0
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1])
            except ValueError:
                length = 0
    while len(body) < length:
        chunk = conn.recv(length - len(body))
        if not chunk:
            break
        body += chunk

    first = head.split(b"\r\n")[0].decode()
    parts = first.split(" ")
    path = parts[1] if len(parts) > 1 else "/"
    return path, body.decode().strip()


def handle(path, body):
    """解析指令并执行。GET 的参数在 path 里，POST 的在 body 里。"""
    msg = body
    if not msg and "msg=" in path:
        msg = path.split("msg=", 1)[1].split("&")[0]
    msg = msg.strip().lower()
    print("收到:", msg)

    if msg in ("on", "1", "open"):
        led.value(1)
        beep(1)
    elif msg in ("off", "0", "close"):
        led.value(0)
    elif msg in ("toggle", "switch"):
        led.value(0 if led.value() else 1)
        beep(1)
    elif msg in ("beep", "buzz"):
        beep(3)
    # 其他内容忽略，也可以在这里加自己的逻辑


def main():
    connect_wifi()

    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT))
    s.listen(5)
    print("监听 0.0.0.0:%d" % PORT)

    while True:
        conn, addr = s.accept()
        try:
            conn.settimeout(1.0)
            try:
                path, body = read_request(conn)
                handle(path, body)
            except Exception as e:
                # 动作出错也照样回 204，不然网页那边会一直等到超时
                print("处理出错:", e)

            # ← 关键：不返回内容，但必须有响应头
            conn.send(b"HTTP/1.1 204 No Content\r\n"
                      b"Access-Control-Allow-Origin: *\r\n"
                      b"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                      b"Access-Control-Allow-Headers: *\r\n"
                      b"Content-Length: 0\r\n"
                      b"Connection: close\r\n\r\n")
        except Exception as e:
            print("连接出错:", e)
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
