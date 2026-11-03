# ESP32-Wed · 网页按钮控制台

> 一个可以随便加按钮的网页面板：按下按钮，就往指定的 IP / 端口发一条消息（主要给 ESP32）。
> 按钮能拖、能改色、能分组；配套一个单文件 Python 库，三行代码让 ESP32 开服务、被查询、收指令。

- 🌐 在线版：<https://lichenyu27.github.io/ESP32-Wed/>（已在 `lichenyu27.github.io` 站点下托管）
- 🐍 Python 库：`python/esp32web.py`（CPython 与 MicroPython 通用，零依赖）
- 📦 仓库：<https://github.com/lichenyu27/ESP32-Wed>

> **关于托管**：在线地址当前由 `lichenyu27.github.io` 站点下的 `/ESP32-Wed/` 目录提供，打开即用。
> 如果希望改由 `ESP32-Wed` 仓库自身发布（URL 不变），去仓库 **Settings → Pages → Deploy from a branch → main / (root) → Save** 点一下即可；
> 创建仓库用的令牌没有 `pages` 权限，所以这一步只能手动完成。

---

## 1. 它解决什么问题

ESP32 上跑个 HTTP 服务很容易，难的是**浏览器怎么把请求送过去**：

| 坑 | 现象 | 本项目怎么处理 |
| --- | --- | --- |
| CORS 跨域 | `fetch` 报 `blocked by CORS policy` | 设备端所有响应都带 `Access-Control-Allow-Origin: *`，并直接放行 `OPTIONS` 预检 |
| 预检失败 | POST JSON 时先发 `OPTIONS`，设备不认就 404 | 库内置 `OPTIONS → 204`，网页端也会自动降级成「简单请求」 |
| HTTPS 混合内容 | GitHub Pages 是 https，请求 `http://192.168.x.x` 被浏览器直接拦截 | 单文件转发器 `forward.py`（双击 `启动转发.bat`），由电脑转发，彻底绕开 |
| 读不到响应 | 盲发（no-cors）拿不到返回 | 自动分级：CORS → 盲发 → 图片信标，日志里标明走的哪条通道 |

---

## 2. 目录结构

```
ESP32-Wed/
├── index.html                  网页控制台（单页，无框架无构建）
├── forward.py                  ★ 单文件转发器：托管页面 + 转发请求（零依赖）
├── 启动转发.bat                Windows 双击启动上面那个
├── assets/
│   ├── style.css               样式
│   └── app.js                  交互逻辑（拖动 / 发送 / 日志 / 存储）
├── python/
│   └── esp32web.py             Python 库 + 命令行工具（单文件）
├── examples/
│   ├── micropython_main.py     ESP32 端完整示例（WiFi + LED + 蜂鸣器 + 触摸）
│   ├── micropython_minimal.py  只收不回的最小示例（裸 socket，回 204）
│   └── pc_demo.py              电脑端示例（没有板子也能先把网页调通）
├── .vscode/launch.json         VS Code 按 F5 直接跑（自动开浏览器）
├── .nojekyll                   GitHub Pages 用，别删
└── README.md
```

---

## 3. 网页控制台怎么用

### 3.0 最快的一条路：双击转发器

仓库根目录的 **`forward.py`** 是个单文件转发器（只需 Python 自带库），它会把网页面板和转发接口一起跑起来，跨域、HTTPS 混合内容全都不用管。

**Windows**：双击 **`启动转发.bat`**，黑窗口出现、浏览器自动打开 `http://127.0.0.1:8765/`，就能用了。

**命令行**（Windows / macOS / Linux 都行）：

```bash
python forward.py                     # 默认 8765 端口
python forward.py --target 192.168.4.1:8080    # 顺便记住板子地址
python forward.py --port 9000 --open  # 换端口 + 自动开浏览器
```

启动后打印：

```
  ╭──────────────────────────────────────────────╮
  │  ESP32 转发器已启动                          │
  ╰──────────────────────────────────────────────╯
    本机打开：http://127.0.0.1:8765/
    手机/平板：http://192.168.1.23:8765/
    默认设备：http://192.168.4.1:8080
    快捷测试：http://127.0.0.1:8765/send?msg=on
```

页面里 **「代理地址」留空即可**——转发走同源 `/proxy`，会自动生效。按钮的目标地址照常写 `http://192.168.4.1:8080/cmd`。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8765` | 本机端口，被占用就换一个 |
| `--host` | `0.0.0.0` | 绑定地址，默认允许手机/平板访问 |
| `--target` | 空 | 默认设备地址，写 `192.168.4.1:8080` 这种就行，`http://` 可省 |
| `--open` | 关 | 启动后自动开浏览器 |

除了 `/proxy`，它还提供两个顺手的小接口：

```
GET  /proxy?url=http://192.168.4.1:8080/status   # 原样转发，返回 {status, body, ms}
GET  /send?msg=on                                # 直接打到 --target 的 /cmd
GET  /proxy?ping=1                               # 探测转发器是否在线
```

#### 在编辑器里直接运行

可以，不用装插件、不用建虚拟环境、不用 `pip install`。`forward.py` 只用标准库，任何 Python 3.7+ 都能跑。

| 编辑器 | 操作 |
| --- | --- |
| **VS Code** | 打开 `forward.py` → 右上角 ▷ **Run Python File**；或按 `F5` 用仓库自带的 `.vscode/launch.json`（有两个配置：自动开浏览器 / 启动时输入板子地址） |
| **PyCharm** | 右键 `forward.py` → **Run 'forward'** |
| **IDLE** | `File → Open` 选中 `forward.py` → `F5` |
| **Thonny** | 打开文件 → 绿色 ▶（注意：Thonny 默认解释器是 MicroPython 时要切成电脑端 Python） |

三点须知：

1. **服务跑在编辑器下方那个终端里**，终端一关服务就停；要停就点终端里的 ⏹ 或按 `Ctrl+C`。
2. **不一定自动开浏览器**，手动访问 `http://127.0.0.1:8765/` 即可；想要自动开，命令行加 `--open`（VS Code 的 F5 配置里已带）。
3. **和当前目录无关**：脚本用 `__file__` 定位 `index.html`，所以从任何目录运行都能找到页面。实测从 `/tmp` 直接运行，首页与静态资源都是 200。

> 断点调试也能用：在 `do_GET` / `do_POST` 里下断点，点一次按钮就会停在断点上，能看到设备地址、方法、请求体。

### 3.1 打开

三种方式，任选：

| 方式 | 地址 | 适用 |
| --- | --- | --- |
| 双击 `启动转发.bat`（或 `python forward.py`） | <http://127.0.0.1:8765/> | **日常就用这个**，托管 + 转发一步到位 |
| 在线托管（GitHub Pages） | <https://lichenyu27.github.io/ESP32-Wed/> | 随手看看、编辑配置；发请求需配本地转发器 |
| 直接双击 `index.html` | `file://` | 能用，但浏览器限制较多 |

### 3.2 三步发出第一条指令

1. 左上「设置」里填 ESP32 地址，例如 `http://192.168.4.1:8080/cmd`
2. 点「＋ 新建按钮」，填名称、内容（如 `on`），保存
3. 点按钮 —— 日志面板会显示 `✓ 成功 · 直连 200 · 14ms`

### 3.3 按钮能改什么

| 属性 | 说明 |
| --- | --- |
| 名称 / 颜色 | 内置 10 个配色，也可用取色器自选 |
| 目标地址 | 每个按钮可单独指定，留空则用全局默认地址 |
| 方法 | `GET` / `POST` / `PUT` |
| 数据格式 | `?msg=` 查询参数 / 纯文本 body / JSON body / 表单 body |
| 发送内容 | 就是你按下去要发的那句话，例如 `on`、`{"cmd":"led","v":1}` |
| 宽高 / 坐标 | 数字精确调，也可以直接拖 |
| 超时 | 默认 4000ms，WiFi 慢可以调大 |

**拖动位置**：打开右上角「布局模式」→ 拖动 → 松手自动保存。
运行模式下也能拖动：**按住 0.4 秒**再拖。
**改属性**：双击按钮，或布局模式下单击。

所有配置存在浏览器 `localStorage`，换电脑/换浏览器用「导出 / 导入」迁移 JSON。

### 3.4 四种发送通道

左侧「模式」下拉切换，默认「自动」会按 `CORS → 盲发 → 图片信标` 依次降级：

| 模式 | 原理 | 能读响应 | 适用 |
| --- | --- | --- | --- |
| 直连 CORS | 标准 `fetch`，设备返回 CORS 头 | ✅ | 设备跑本项目的库，或自己加了 CORS 头 |
| 直连盲发（no-cors） | 只发简单请求，不触发预检 | ❌ | 设备没开 CORS，但能收到请求 |
| 图片信标 | `new Image().src = url` | ❌ | 最原始的 GET 兼容方案 |
| 本地代理 | 浏览器 → `127.0.0.1:8765/proxy` → 设备 | ✅ | HTTPS 页面、设备不配合 CORS 时的万能方案 |

> **为什么 HTTPS 页面必须用代理？**
> 浏览器规定：https 页面不能发起 http 明文请求（混合内容）。GitHub Pages 是 https，ESP32 基本只有 http，所以直连一定失败——这不是代码问题，是浏览器安全策略。代理把请求交给电脑端的 Python 进程去发，浏览器只跟 `http://127.0.0.1:8765` 通信，同源、不混用，问题消失。

---

## 4. Python 库 `esp32web`

就是本仓库里的 [`python/esp32web.py`](./python/esp32web.py) 这一个文件，不是什么第三方包，也没有依赖：拷过去就能 `import esp32web`。
单文件、零依赖，**同一份代码 CPython 和 MicroPython 都能跑**（ESP32 上直接当库用，也可以当 `main.py` 的一部分）。

### 4.1 拿过来

```bash
git clone https://github.com/lichenyu27/ESP32-Wed.git
# 或者只下载 python/esp32web.py 放到同目录
```

ESP32 上：把 `esp32web.py` 和你的 `main.py` 一起拷进板子根目录即可（Thonny 拖拽、`mpremote cp`、Mixly 上传都行）。

### 4.2 三个核心功能

#### ① `start()` —— 在 ESP32 上启动一个 IP 地址

```python
import esp32web

srv = esp32web.start(port=8080, name="my-esp32")
print(srv.info())        # {'ok': True, 'ip': '192.168.4.1', 'port': 8080, ...}
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `ip` | `0.0.0.0` | 绑定的本地地址，`0.0.0.0` = 所有网卡 |
| `port` | `8080` | 端口 |
| `name` | `esp32` | 设备名，出现在 `/status` 里 |
| `background` | `True` | CPython 下后台线程跑；MicroPython 会自动忽略，用 `poll()` 循环 |

#### ② `query()` —— 查询这个地址

```python
r = esp32web.query("192.168.4.1", port=8080)
# {'ok': True, 'status': 200, 'body': '{"ok":true,...}',
#  'json': {...}, 'ms': 12.4, 'error': None}

if r["ok"]:
    print("在线，延迟", r["ms"], "ms")
else:
    print("掉线了：", r["error"])
```

#### ③ `listen()` —— 监听其他地址发来的信息

```python
def on_msg(m):
    print(m["msg"], "来自", m["addr"])   # 网页按钮发来的内容

esp32web.listen(port=8080, callback=on_msg)
```

`listen()` 是阻塞的（`Ctrl+C` 退出），也可以传 `duration=30` 只监听 30 秒。
收到的消息结构：

```python
{
    "msg":    "on",              # 指令内容（query 的 msg / body / JSON 里的 msg）
    "method": "POST",
    "path":   "/cmd",
    "query":  {"msg": "on", "from": "web"},
    "body":   "on",
    "addr":   "192.168.1.23",    # 谁发来的
    "time":   1712345678.9,
}
```

#### 附加：`send()` —— 主动发一条

```python
esp32web.send("192.168.4.1", 8080, "on")               # POST /cmd body=on
esp32web.send("192.168.4.1", 8080, "", path="/led?value=1")  # 也可以打自定义路由
```

#### 完整对象式用法

```python
from esp32web import Esp32Web

srv = Esp32Web(name="esp32", port=8080, debug=True)
srv.on("/led", lambda req: {"ok": True, "v": req["query"].get("value")})
srv.start()
srv.callback = lambda m: print("收到", m["msg"])
srv.listen()                  # 阻塞收消息
print(srv.history(5))         # 最近 5 条
```

### 4.3 HTTP 协议（自己写固件也能对上）

| 方法 | 路径 | 作用 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/status` | 设备状态 | `{"ok":true,"name","ip","port","uptime","count","last","free_mem"}` |
| `GET` | `/ping` | 心跳 | `pong` |
| `GET` | `/cmd?msg=on` | 发指令 | `{"ok":true,"received":"on","count":3}` |
| `POST` | `/cmd`，body 任意 | 发指令 | 同上 |
| `OPTIONS` | 任意 | CORS 预检 | `204` |
| `GET` | `/` | 一个极简状态页 | HTML |

所有响应都带：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS, HEAD
Access-Control-Allow-Headers: *
Access-Control-Allow-Private-Network: true
```

### 4.4 命令行

```bash
python python/esp32web.py serve  --port 8080          # 电脑上模拟一块 ESP32
python python/esp32web.py query  192.168.4.1          # 查状态
python python/esp32web.py send   192.168.4.1 on       # 发指令
python python/esp32web.py listen --port 8080          # 监听并打印
python python/esp32web.py ui     --port 8765 --open   # 托管网页面板 + 代理
```

`ui` 是日常最常用的那个：它同时提供静态网页和 `/proxy` 转发接口。

```
◉ ESP32 按钮控制台已托管
  本机访问：http://127.0.0.1:8765/
  代理接口：http://127.0.0.1:8765/proxy?url=http://192.168.4.1:8080/status
```

### 4.5 只收不回：不返回内容怎么写

ESP32 只管动作、不给网页任何数据时，**不能一个字节都不发就 `close()`**，否则客户端会一直等到超时；正确做法是回一个空的 `204 No Content`（body 长度 0）。

**用库：把 `/cmd` 路由改成返回空**

```python
import esp32web
from machine import Pin

led = Pin(4, Pin.OUT)
srv = esp32web.start(port=8080, name="esp32")

def on_cmd(req):                 # req["msg"] 就是按钮发来的内容
    if req["msg"] == "on":
        led.value(1)
    elif req["msg"] == "off":
        led.value(0)
    return (204, "")             # ← 不返回内容

srv.on("/cmd", on_cmd)           # 覆盖默认 /cmd（默认会回 JSON）
srv.listen()                     # 内部就是 while True: srv.poll()
```

想连 `/status` 也不回内容，就 `srv.on("/status", lambda r: (204, ""))`。
返回 `(200, "ok")` 就是带内容，返回 `(204, "")` 就是不带，写法一样。

**不用库：裸 socket 版**

完整可运行文件见 [`examples/micropython_minimal.py`](./examples/micropython_minimal.py)，核心就这几行：

```python
path, body = read_request(conn)      # GET 参数在 path 里，POST 在 body 里
handle(path, body)                   # 解析 msg 并执行动作

conn.send(b"HTTP/1.1 204 No Content\r\n"
          b"Access-Control-Allow-Origin: *\r\n"
          b"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
          b"Access-Control-Allow-Headers: *\r\n"
          b"Content-Length: 0\r\n"
          b"Connection: close\r\n\r\n")
```

**网页端对应配置**

| 按钮设置 | 建议值 |
| --- | --- |
| 数据格式 | 「URL 查询参数 `?msg=`」（裸 socket 最好处理）或「纯文本 body」 |
| 方法 | GET / POST 都行，与数据格式匹配即可 |
| 发送模式 | 自动 / 直连盲发 / 图片信标都可以 |

日志显示「已发出，无法读取响应」是正常的——no-cors 和图片信标本来就不给响应体。

**四个坑**

1. 一个字节都不发直接 `close()` → 客户端报空响应或超时，所以至少回 `204`。
2. no-cors 的 POST 只能是 `text/plain`，选「JSON body」会触发预检，设备不处理 `OPTIONS` 就失败。
3. 每次 `accept` 后都要 `close()`，否则点几十次后端口占满、板子假死。
4. 图片信标模式下 `204` 会让 `<img>` 触发 `onerror`，但这只影响回调，指令已经送达。

---

## 5. 在 ESP32 上跑起来（MicroPython）

### 5.1 接线

| 模块 | GPIO | 说明 |
| --- | --- | --- |
| LED | 4 | 串 220Ω 电阻到 GND |
| 蜂鸣器 | 5 | 有源蜂鸣器直接接，无源的要用 PWM |
| 触摸模块 | 6 | 触摸输出脚，部分型号是 GPIO4/2，按板子改 |

### 5.2 烧固件

用 [Mixly](https://mixly.org/) 或 Thonny 烧 MicroPython 固件（ESP32 通用版即可），保证能进 REPL。

### 5.3 上传代码

1. 把 `python/esp32web.py` 拷到板子根目录
2. 把 `examples/micropython_main.py` 改名成 `main.py` 拷进去
   （想「只收不回」就用 `examples/micropython_minimal.py`，那个连 `esp32web.py` 都不需要）
3. 改里面的 `WIFI_SSID` / `WIFI_PASSWORD`
4. 复位，串口会打印：

```
[wifi] 已连接，IP = 192.168.4.1
[esp32web] 服务已启动 http://192.168.4.1:8080  (esp32-led)
[esp32web] 监听中 http://192.168.4.1:8080  (Ctrl+C 结束)
```

### 5.4 验证

浏览器打开 `http://192.168.4.1:8080/status`，能看到 JSON 就通了。
再回到网页面板，按钮地址填 `http://192.168.4.1:8080/cmd`，按下去板子的 LED 就该亮。

### 5.5 不用库、纯手写也行

`esp32web.py` 只是把下面这些事包装了一下，最小的 ESP32 服务长这样：

```python
import socket

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 8080))
s.listen(5)
while True:
    c, a = s.accept()
    req = c.recv(1024)
    c.send(b"HTTP/1.1 200 OK\r\n"
           b"Access-Control-Allow-Origin: *\r\n"
           b"Content-Length: 2\r\n\r\nok")
    c.close()
```

关键是那行 `Access-Control-Allow-Origin`，少了它网页就报 CORS。

只想收指令、不返回内容的话，把响应换成 `HTTP/1.1 204 No Content` + `Content-Length: 0`，完整代码见 [`examples/micropython_minimal.py`](./examples/micropython_minimal.py)，说明见本文 §4.5。

---

## 6. 常见问题

<details>
<summary><b>按钮点了没反应，日志显示「已发出，无法读取响应」</b></summary>

这是**正常现象**。盲发 / 图片信标通道浏览器不给你响应体，请求其实已经送达。
想看设备返回什么，就切到「直连 CORS」或「本地代理」模式。
</details>

<details>
<summary><b>控制台报 blocked by CORS policy</b></summary>

设备没返回 CORS 头。两个办法：
1. 用本项目的库（自带 CORS 头），或手动在响应里加 `Access-Control-Allow-Origin: *`；
2. 切「本地代理」模式，让电脑替你发，浏览器就不管跨域了。
</details>

<details>
<summary><b>GitHub Pages 上点了没反应</b></summary>

https 页面请求 http 设备会被浏览器判为混合内容，直接拦截。
**最省事：本机双击 `启动转发.bat`（或 `python forward.py --open`），然后从 `http://127.0.0.1:8765` 打开页面。**
如果坚持用线上页面，就在「设置 → 代理地址」填 `http://127.0.0.1:8765` 并切「本地代理」模式（转发器要先启动）。
</details>

<details>
<summary><b>连不上 192.168.4.1</b></summary>

依次排查：
1. 电脑和 ESP32 是否在同一个 WiFi / 网段（`ping 192.168.4.1`）
2. 端口对不对（串口日志里有）
3. 电脑防火墙是否拦了出站 / 网页是否被拦截
4. ESP32 是否掉线重启了（`/status` 的 `uptime` 会归零）
</details>

<details>
<summary><b>Chrome 提示「本地网络访问」/ 代理明明开着却说连不上</b></summary>

Chrome 142 之后，公网 https 页面访问 `127.0.0.1` 需要用户授权。
地址栏左侧会出现一个「允许访问本地设备」的图标，点允许即可；不想折腾就直接从 `http://127.0.0.1:8765` 打开页面，那是同源，不需要授权。
（代理服务端已经带上 `Access-Control-Allow-Private-Network: true`，只是浏览器的权限确认绕不过去。）
</details>

<details>
<summary><b>端口被占用 / 想换端口</b></summary>

```bash
python python/esp32web.py ui --port 9000
```
ESP32 端改 `esp32web.start(port=8081)`，网页按钮地址同步改。
</details>

<details>
<summary><b>局域网里别人也能点我的按钮，安全吗？</b></summary>

这套东西设计给**内网自用**，默认无鉴权。如果在意，可以在 ESP32 端加个简单 token：

```python
def on_msg(m):
    if m["query"].get("token") != "my-secret":
        return "denied"
    ...
```
然后网页按钮的「发送内容」里带上 `token`（JSON 格式最方便）。
</details>

---

## 7. 部署到自己的 GitHub Pages

```bash
git clone https://github.com/lichenyu27/ESP32-Wed.git
cd ESP32-Wed
# 改点东西
git add -A && git commit -m "update"
git push
```

仓库 **Settings → Pages → Source: Deploy from a branch → main / (root)**，等一分钟就能在 `https://<你的用户名>.github.io/ESP32-Wed/` 打开。
根目录的 `.nojekyll` 保证 `assets/` 不被 Jekyll 处理。

---

## 8. 许可

MIT License，随便用，出问题别找我。

---

<p align="center"><sub>Made for ESP32 · 按钮随便加，位置随便拖</sub></p>
