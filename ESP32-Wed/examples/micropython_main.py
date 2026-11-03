# -*- coding: utf-8 -*-
"""
ESP32 端示例（MicroPython）
===========================

用法：
1. 把 esp32web.py 和本文件一起拷到 ESP32（Thonny / mpremote / Mixly 都行）
2. 改下面的 WIFI_SSID / WIFI_PASSWORD
3. 把本文件改名为 main.py，上电自动运行
4. 串口会打印分配到的 IP，例如 192.168.4.1
5. 浏览器打开网页控制台，按钮地址填 http://192.168.4.1:8080/cmd

接线（按需修改）：
    LED      -> GPIO4
    蜂鸣器   -> GPIO5
    触摸模块 -> GPIO6
"""

import time

import esp32web

try:
    import network
    from machine import Pin
except ImportError:          # 在电脑上跑这个文件时走这里（方便先调试逻辑）
    network = None
    Pin = None

# ------------------------- 配置区 -------------------------
WIFI_SSID = "your-wifi"
WIFI_PASSWORD = "your-password"
PORT = 8080
DEVICE_NAME = "esp32-led"

LED_PIN = 4
BUZZER_PIN = 5
TOUCH_PIN = 6

# ------------------------- 硬件初始化 -------------------------
led = Pin(LED_PIN, Pin.OUT) if Pin else None
buzzer = Pin(BUZZER_PIN, Pin.OUT) if Pin else None
touch = Pin(TOUCH_PIN, Pin.IN) if Pin else None

if led:
    led.value(0)
if buzzer:
    buzzer.value(0)


def beep(times=1, delay_ms=90):
    """哔一声（阻塞式，演示用）。"""
    if not buzzer:
        print("[demo] beep x%d" % times)
        return
    for _ in range(times):
        buzzer.value(1)
        time.sleep_ms(delay_ms)
        buzzer.value(0)
        time.sleep_ms(delay_ms)


# ------------------------- 指令处理 -------------------------
def on_message(m):
    """网页按钮 / 其他设备发来消息时被调用。

    m 的结构：
        {"msg": "on", "method": "POST", "path": "/cmd",
         "query": {...}, "body": "on", "addr": "192.168.1.23", "time": 123.4}
    """
    cmd = (m["msg"] or "").strip().lower()
    print("[cmd] %-16s %s" % (m["addr"], cmd))

    if cmd in ("on", "1", "open", "开", "开灯"):
        led.value(1) if led else None
        beep(1)
        return "led on"

    if cmd in ("off", "0", "close", "关", "关灯"):
        led.value(0) if led else None
        return "led off"

    if cmd in ("toggle", "switch"):
        if led:
            led.value(0 if led.value() else 1)
        beep(2)
        return "toggled"

    if cmd in ("beep", "buzz", "响"):
        beep(3)
        return "beeped"

    if cmd in ("status", "状态"):
        return "led=%s" % (led.value() if led else "n/a")

    print("[cmd] 未知指令:", cmd)
    return "unknown: %s" % cmd


# ------------------------- 联网 -------------------------
def connect_wifi(timeout=20):
    if not network:
        print("[wifi] 非 MicroPython 环境，跳过联网")
        return None
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print("[wifi] 连接", WIFI_SSID, "…")
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        start = time.time()
        while not wlan.isconnected():
            if time.time() - start > timeout:
                print("[wifi] 连接超时，请检查账号密码")
                return wlan
            time.sleep(0.5)
    print("[wifi] 已连接，IP =", wlan.ifconfig()[0])
    return wlan


# ------------------------- 主流程 -------------------------
def main():
    connect_wifi()

    # 1. 启动 IP 地址（开服务、绑端口）
    srv = esp32web.start(port=PORT, name=DEVICE_NAME, debug=True)

    # 2. 注册一个自定义路由：GET /led?value=1
    def led_route(req):
        v = req["query"].get("value", "1")
        if led:
            led.value(1 if v in ("1", "on", "true") else 0)
        return {"ok": True, "led": led.value() if led else None}

    srv.on("/led", led_route)

    # 3. 监听其他地址发来的信息（阻塞）
    srv.listen(callback=on_message)


if __name__ == "__main__":
    main()
