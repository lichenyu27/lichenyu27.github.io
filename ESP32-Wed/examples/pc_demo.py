# -*- coding: utf-8 -*-
"""
电脑端示例（CPython）
=====================

先跑这个脚本，可以在没有 ESP32 的情况下把网页调通：
它会在本机 8080 端口起一个"假 ESP32"，然后演示 启动 / 查询 / 发送 / 监听。

    python examples/pc_demo.py

然后另开一个终端托管网页：

    python python/esp32web.py ui --open

网页里按钮地址填 http://127.0.0.1:8080/cmd 即可。
"""

import sys
import os
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import esp32web  # noqa: E402


def main():
    port = 8080

    # ---- 1. 启动一个 IP 地址（这里用本机模拟 ESP32）----
    srv = esp32web.start(port=port, name="pc-mock-esp32", background=True, debug=True)
    print("① 服务已启动：http://%s:%d/" % (esp32web.local_ip(), port))

    received = []

    def on_msg(m):
        print("   收到指令 -> %-12s 来自 %s" % (m["msg"], m["addr"]))
        received.append(m["msg"])

    srv.callback = on_msg

    # ---- 2. 查询这个地址 ----
    time.sleep(0.3)
    r = esp32web.query("127.0.0.1", port=port)
    print("② 查询结果：ok=%s status=%s 耗时=%sms" % (r["ok"], r["status"], r["ms"]))
    print("   ", r["body"][:160])

    # ---- 3. 监听其他地址发来的信息 ----
    t = threading.Thread(target=lambda: srv.listen(duration=8), daemon=True)
    t.start()
    time.sleep(0.3)

    # 模拟网页/另一块板子发指令
    for cmd in ("on", "beep", "off"):
        esp32web.send("127.0.0.1", port, cmd)
        time.sleep(0.4)

    time.sleep(0.5)
    print("③ 收到 %d 条指令：%s" % (len(received), received))
    print("   最近 3 条：", [m["msg"] for m in srv.history(3)])

    srv.stop()
    print("演示结束。提示：用 `python python/esp32web.py ui --open` 托管网页面板。")


if __name__ == "__main__":
    main()
