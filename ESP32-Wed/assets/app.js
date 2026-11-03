/* =========================================================
   ESP32 按钮控制台
   - 按钮可拖动、可改色、可自定义目标地址
   - 四种发送方式：CORS / no-cors / 图片信标 / 本地代理
   - 配置存 localStorage
   ========================================================= */
(() => {
  "use strict";

  const STORE_KEY = "esp32web.panel.v1";
  const SWATCHES = [
    "#22d3ee", "#34d399", "#a78bfa", "#f472b6",
    "#fbbf24", "#fb7185", "#60a5fa", "#f97316",
    "#e2e8f0", "#94a3b8",
  ];

  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

  /* ---------------- 状态 ---------------- */
  const defaultState = () => ({
    settings: {
      mode: "auto",
      defaultTarget: "http://192.168.4.1:8080/cmd",
      proxyBase: "",
      from: "web",
    },
    buttons: [],
    layoutMode: false,
  });

  let S = load();
  let editingId = null;
  let logs = [];

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const data = JSON.parse(raw);
      const base = defaultState();
      return {
        settings: { ...base.settings, ...(data.settings || {}) },
        buttons: Array.isArray(data.buttons) ? data.buttons : [],
        layoutMode: !!data.layoutMode,
      };
    } catch (e) {
      console.warn("读取本地配置失败", e);
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
    } catch (e) {
      toast("保存失败：localStorage 不可用", true);
    }
  }

  /* ---------------- 通用 UI ---------------- */
  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function shortUrl(u) {
    if (!u) return "未设置地址";
    try {
      const x = new URL(u);
      return x.host + (x.pathname === "/" ? "" : x.pathname);
    } catch {
      return u;
    }
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /* ---------------- 画布渲染 ---------------- */
  const stage = $("stage");

  function stageSize() {
    const r = stage.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function render() {
    // 清掉旧的 fab
    stage.querySelectorAll(".fab").forEach((n) => n.remove());

    const { w, h } = stageSize();
    S.buttons.forEach((b) => {
      const el = document.createElement("button");
      el.className = "fab";
      el.dataset.id = b.id;
      el.style.left = clamp(b.x, 4, Math.max(4, w - b.w - 4)) + "px";
      el.style.top = clamp(b.y, 4, Math.max(4, h - b.h - 4)) + "px";
      el.style.width = b.w + "px";
      el.style.height = b.h + "px";
      el.style.background = b.color;
      el.style.boxShadow = `0 10px 30px ${hexA(b.color, 0.28)}, 0 2px 0 ${hexA("#000", 0.25)} inset`;
      el.style.fontSize = (b.h < 64 ? 12 : 14) + "px";
      el.title = `${b.label}\n${b.method} ${b.target || S.settings.defaultTarget}`;
      el.innerHTML = `<span class="fab-label">${escapeHtml(b.label)}</span>
        <span class="fab-sub">${escapeHtml(shortUrl(b.target || S.settings.defaultTarget))}</span>`;
      el.addEventListener("pointerdown", (ev) => onFabPointerDown(ev, b, el));
      el.addEventListener("dblclick", (ev) => { ev.preventDefault(); openEditor(b.id); });
      el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); openEditor(b.id); });
      stage.appendChild(el);
    });

    $("stageEmpty").style.display = S.buttons.length ? "none" : "grid";
    renderList();
    updateChips();
    save();
  }

  function renderList() {
    const ul = $("btnList");
    ul.innerHTML = "";
    $("btnListEmpty").style.display = S.buttons.length ? "none" : "block";
    $("btnStat").textContent = S.buttons.length;
    S.buttons.forEach((b) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="dot" style="background:${b.color};color:${b.color}"></span>
        <span class="name">${escapeHtml(b.label)}</span>
        <span class="go">发送 →</span>`;
      li.querySelector(".go").addEventListener("click", (e) => { e.stopPropagation(); fire(b.id); });
      li.addEventListener("click", () => openEditor(b.id));
      ul.appendChild(li);
    });
  }

  function updateChips() {
    const modeName = {
      auto: "自动", cors: "直连 CORS", text: "直连盲发",
      beacon: "图片信标", proxy: "本地代理",
    }[S.settings.mode] || S.settings.mode;
    $("chipMode").textContent = "模式：" + modeName;
    $("chipCount").textContent = S.buttons.length + " 个按钮";
    $("chipProto").textContent = "页面：" + location.protocol.replace(":", "");
    $("chipMode").classList.add("on");
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /* ---------------- 拖动 ---------------- */
  let drag = null;
  let longTimer = null;

  function onFabPointerDown(ev, b, el) {
    if (ev.button !== 0) return;
    const rect = stage.getBoundingClientRect();
    drag = {
      id: b.id,
      el,
      moved: false,
      active: false,
      startX: ev.clientX,
      startY: ev.clientY,
      originX: parseFloat(el.style.left) || 0,
      originY: parseFloat(el.style.top) || 0,
      stageRect: rect,
      pointerId: ev.pointerId,
    };
    el.setPointerCapture?.(ev.pointerId);

    // 布局模式：立即进入拖动；运行模式：按住 350ms 才进入拖动
    if (S.layoutMode) {
      startDrag();
    } else {
      longTimer = setTimeout(() => { if (drag && !drag.moved) startDrag(); }, 350);
    }

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
  }

  function startDrag() {
    if (!drag) return;
    drag.active = true;
    drag.el.classList.add("dragging");
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        // 运行模式下移动超过阈值也算拖动
        startDrag();
      } else {
        return;
      }
    }
    drag.moved = true;
    clearTimeout(longTimer);
    const b = S.buttons.find((x) => x.id === drag.id);
    if (!b) return;
    const maxX = Math.max(4, drag.stageRect.width - b.w - 4);
    const maxY = Math.max(4, drag.stageRect.height - b.h - 4);
    b.x = clamp(drag.originX + dx, 4, maxX);
    b.y = clamp(drag.originY + dy, 4, maxY);
    drag.el.style.left = b.x + "px";
    drag.el.style.top = b.y + "px";
  }

  function onPointerUp(ev) {
    clearTimeout(longTimer);
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove("dragging");
    d.el.removeEventListener("pointermove", onPointerMove);
    d.el.removeEventListener("pointerup", onPointerUp);
    d.el.removeEventListener("pointercancel", onPointerUp);

    if (d.active || d.moved) {
      save();
      return; // 拖动结束，不触发发送
    }
    // 未拖动 → 点击
    if (S.layoutMode) openEditor(d.id);
    else fire(d.id);
  }

  window.addEventListener("resize", () => {
    const { w, h } = stageSize();
    let changed = false;
    S.buttons.forEach((b) => {
      const nx = clamp(b.x, 4, Math.max(4, w - b.w - 4));
      const ny = clamp(b.y, 4, Math.max(4, h - b.h - 4));
      if (nx !== b.x || ny !== b.y) { b.x = nx; b.y = ny; changed = true; }
    });
    if (changed) render();
  });

  /* =========================================================
     发送核心
     ========================================================= */

  function buildRequest(b) {
    const raw = (b.target || S.settings.defaultTarget || "").trim();
    if (!raw) throw new Error("未设置目标地址");
    const url = new URL(/^[a-zA-Z]+:\/\//.test(raw) ? raw : "http://" + raw);
    const msg = b.msg == null ? "" : String(b.msg);
    const from = S.settings.from || "web";
    const method = (b.method || "POST").toUpperCase();
    const format = b.format || "text";

    let finalUrl = url.toString();
    let body = null;
    let headers = {};

    if (format === "query" || method === "GET") {
      if (msg) url.searchParams.set("msg", msg);
      url.searchParams.set("from", from);
      finalUrl = url.toString();
      return { url: finalUrl, method: "GET", body: null, headers, format };
    }
    if (format === "json") {
      body = JSON.stringify({ msg, from, ts: Date.now() });
      headers["Content-Type"] = "application/json";
    } else if (format === "form") {
      body = new URLSearchParams({ msg, from }).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = msg;
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    }
    return { url: finalUrl, method, body, headers, format };
  }

  function proxyUrlFor(target) {
    const base = (S.settings.proxyBase || "").trim().replace(/\/$/, "");
    return `${base}/proxy?url=${encodeURIComponent(target)}`;
  }

  // 带超时的 fetch
  async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendCors(req, ms) {
    const res = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      mode: "cors",
      cache: "no-store",
      redirect: "follow",
    }, ms);
    let text = "";
    try { text = await res.text(); } catch { /* 忽略 */ }
    return { ok: res.ok, status: res.status, body: text, channel: "cors" };
  }

  async function sendNoCors(req, ms) {
    // 简单请求：不触发预检；POST 时只能使用 text/plain 等安全类型
    const opts = { method: req.method, mode: "no-cors", cache: "no-store" };
    if (req.body && req.method !== "GET") {
      opts.body = req.body;
      opts.headers = { "Content-Type": "text/plain;charset=UTF-8" };
    }
    await fetchWithTimeout(req.url, opts, ms);
    return { ok: true, status: 0, body: "", channel: "no-cors" };
  }

  function sendBeaconImg(req) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const u = new URL(req.url);
      u.searchParams.set("_t", Date.now());
      const timer = setTimeout(() => {
        img.src = "";
        resolve({ ok: true, status: 0, body: "", channel: "img", timeout: true });
      }, 3000);
      img.onload = () => { clearTimeout(timer); resolve({ ok: true, status: 0, body: "", channel: "img" }); };
      img.onerror = () => { clearTimeout(timer); resolve({ ok: true, status: 0, body: "", channel: "img" }); };
      img.src = u.toString();
    });
  }

  async function sendProxy(req, ms) {
    const res = await fetchWithTimeout(proxyUrlFor(req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeout: Math.max(1, ms / 1000),
      }),
    }, ms + 2500);
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    return {
      ok: data.status >= 200 && data.status < 400,
      status: data.status,
      body: data.body || "",
      channel: "proxy",
      ms: data.ms,
    };
  }

  async function dispatch(req, mode, ms) {
    if (mode === "cors") return sendCors(req, ms);
    if (mode === "text") return sendNoCors(req, ms);
    if (mode === "beacon") return sendBeaconImg(req, ms);
    if (mode === "proxy") return sendProxy(req, ms);

    // auto
    const mixed = location.protocol === "https:" && req.url.startsWith("http://");
    const isLocalHostTarget = /^http:\/\/(127\.0\.0\.1|localhost)/i.test(req.url);
    if (mixed && !isLocalHostTarget && isProxyReachable()) {
      try { return await sendProxy(req, ms); } catch (e) { /* 落到直连 */ }
    }
    try {
      return await sendCors(req, ms);
    } catch (e1) {
      try {
        const r = await sendNoCors(req, ms);
        r.fallback = true;
        return r;
      } catch (e2) {
        if (req.method === "GET") {
          const r = await sendBeaconImg(req, ms);
          r.fallback = true;
          return r;
        }
        throw new Error(mixed
          ? "HTTPS 页面无法直接请求 http:// 设备（混合内容被拦截）。请用「本地代理」模式。"
          : "请求失败：" + (e2.message || e2));
      }
    }
  }

  let proxyOK = null;
  function isProxyReachable() {
    return proxyOK !== false;
  }
  async function probeProxy() {
    const base = (S.settings.proxyBase || "").trim().replace(/\/$/, "");
    if (!base && location.protocol === "file:") { proxyOK = false; return; }
    try {
      const r = await fetchWithTimeout(`${base}/proxy?ping=1`, { method: "GET" }, 1500);
      proxyOK = r.ok;
    } catch {
      proxyOK = false;
    }
    updateProxyChip();
  }
  function updateProxyChip() {
    const el = $("modeHint");
    if (!el) return;
    if (location.protocol === "https:" && proxyOK === false) {
      el.className = "hint warn";
      el.innerHTML = "检测不到本地代理。HTTPS 页面请求 <code>http://</code> 设备会被浏览器拦截，建议本地运行 <code>python esp32web.py ui</code> 后从 http://127.0.0.1:8765 打开页面。";
    } else if (location.protocol === "https:") {
      el.className = "hint";
      el.innerHTML = "已检测到本地代理，HTTPS 页面会自动走代理转发。";
    } else {
      el.className = "hint";
      el.innerHTML = "当前页面可直接请求局域网地址；若设备未开 CORS，会自动降级为盲发。";
    }
  }

  /* ---------------- 触发按钮 ---------------- */
  async function fire(id) {
    const b = S.buttons.find((x) => x.id === id);
    if (!b) return;
    const el = stage.querySelector(`.fab[data-id="${id}"]`);
    const ms = Number(b.timeout) || 4000;

    let req;
    try {
      req = buildRequest(b);
    } catch (e) {
      toast(e.message, true);
      addLog("err", b.label, e.message);
      return;
    }

    el?.classList.add("busy");
    const t0 = performance.now();
    const mode = S.settings.mode || "auto";

    try {
      const r = await dispatch(req, mode, ms);
      const dt = Math.round(performance.now() - t0);
      el?.classList.remove("busy");
      el?.classList.add(r.ok ? "ok" : "fail");
      setTimeout(() => el?.classList.remove("ok", "fail"), 900);

      const tag = { cors: "直连", "no-cors": r.fallback ? "盲发(降级)" : "盲发", img: "信标", proxy: "代理" }[r.channel] || r.channel;
      const bodyNote = r.body ? " · " + r.body.slice(0, 90).replace(/\s+/g, " ") : "";
      if (r.channel === "cors" || r.channel === "proxy") {
        addLog(r.ok ? "ok" : "err", b.label, `${tag} ${r.status} · ${req.method} ${req.url}${bodyNote}`, dt);
        toast(r.ok ? `✓ ${b.label} 已发送（${tag} ${r.status}）` : `⚠ ${b.label} 返回 ${r.status}`, !r.ok);
      } else {
        addLog("warn", b.label, `${tag} · ${req.method} ${req.url}（无法读取响应，属正常）`, dt);
        toast(`✓ ${b.label} 已发送（${tag}，无法读取响应）`);
      }
    } catch (e) {
      el?.classList.remove("busy");
      el?.classList.add("fail");
      setTimeout(() => el?.classList.remove("fail"), 1200);
      const dt = Math.round(performance.now() - t0);
      addLog("err", b.label, e.message || String(e), dt);
      toast(e.message || "发送失败", true);
    }
  }

  /* ---------------- 日志 ---------------- */
  function addLog(kind, label, msg, ms) {
    const now = new Date();
    const t = now.toTimeString().slice(0, 8);
    logs.unshift({ t, kind, label, msg, ms });
    if (logs.length > 200) logs.pop();
    renderLogs();
    $("logCount").textContent = logs.length;
  }

  function renderLogs() {
    const box = $("consoleBody");
    if (!logs.length) {
      box.innerHTML = `<div class="log-empty">暂无日志</div>`;
      return;
    }
    box.innerHTML = logs.map((l) => `
      <div class="log-row">
        <span class="t">${l.t}</span>
        <span class="tag ${l.kind}">${l.kind === "ok" ? "✓ 成功" : l.kind === "err" ? "✕ 失败" : "· 已发"}</span>
        <span class="m"><b>${escapeHtml(l.label)}</b> · ${escapeHtml(l.msg)}</span>
        <span class="ms">${l.ms != null ? l.ms + "ms" : ""}</span>
      </div>`).join("");
  }

  /* ---------------- 弹窗：按钮属性 ---------------- */
  const modal = $("modal");

  function openEditor(id) {
    const b = S.buttons.find((x) => x.id === id);
    if (!b) return;
    editingId = id;
    $("modalTitle").textContent = "编辑按钮";
    $("fLabel").value = b.label;
    $("fColor").value = b.color;
    $("fTarget").value = b.target || "";
    $("fMethod").value = b.method || "POST";
    $("fFormat").value = b.format || "text";
    $("fTimeout").value = b.timeout || 4000;
    $("fMsg").value = b.msg || "";
    $("fW").value = b.w;
    $("fH").value = b.h;
    $("fX").value = Math.round(b.x);
    $("fY").value = Math.round(b.y);
    modal.classList.remove("hidden");
    setTimeout(() => $("fLabel").focus(), 60);
  }

  function openNew() {
    const { w, h } = stageSize();
    const bw = 152, bh = 78;
    const n = S.buttons.length;
    const b = {
      id: uid(),
      label: "按钮 " + (n + 1),
      color: SWATCHES[n % SWATCHES.length],
      target: "",
      method: "POST",
      format: "text",
      msg: "on",
      timeout: 4000,
      w: bw,
      h: bh,
      x: 24 + (n % 4) * (bw + 18),
      y: 24 + Math.floor(n / 4) * (bh + 18),
    };
    b.x = clamp(b.x, 8, Math.max(8, w - bw - 8));
    b.y = clamp(b.y, 8, Math.max(8, h - bh - 8));
    S.buttons.push(b);
    save();
    render();
    openEditor(b.id);
  }

  function closeEditor() {
    editingId = null;
    modal.classList.add("hidden");
  }

  function saveEditor() {
    const b = S.buttons.find((x) => x.id === editingId);
    if (!b) return closeEditor();
    const label = $("fLabel").value.trim() || "未命名";
    const target = $("fTarget").value.trim();
    if (target && !/^[a-zA-Z]+:\/\//.test(target)) {
      toast("目标地址需要带 http:// 前缀", true);
      return;
    }
    Object.assign(b, {
      label,
      color: $("fColor").value,
      target,
      method: $("fMethod").value,
      format: $("fFormat").value,
      timeout: clamp(Number($("fTimeout").value) || 4000, 200, 20000),
      msg: $("fMsg").value,
      w: clamp(Number($("fW").value) || 152, 90, 420),
      h: clamp(Number($("fH").value) || 78, 56, 280),
      x: Number($("fX").value) || 0,
      y: Number($("fY").value) || 0,
    });
    closeEditor();
    render();
    toast("已保存");
  }

  function deleteButton() {
    if (!editingId) return;
    if (!confirm("确定删除这个按钮？")) return;
    S.buttons = S.buttons.filter((x) => x.id !== editingId);
    closeEditor();
    render();
    toast("已删除");
  }

  /* ---------------- 设置 ---------------- */
  const settingsModal = $("settingsModal");
  function openSettings() {
    $("sTarget").value = S.settings.defaultTarget || "";
    $("sMode").value = S.settings.mode || "auto";
    $("sProxy").value = S.settings.proxyBase || "";
    $("sFrom").value = S.settings.from || "web";
    settingsModal.classList.remove("hidden");
  }
  function saveSettings() {
    S.settings.defaultTarget = $("sTarget").value.trim();
    S.settings.mode = $("sMode").value;
    S.settings.proxyBase = $("sProxy").value.trim();
    S.settings.from = $("sFrom").value.trim() || "web";
    settingsModal.classList.add("hidden");
    syncSettingsUI();
    render();
    probeProxy();
    toast("设置已保存");
  }

  function syncSettingsUI() {
    $("modeSelect").value = S.settings.mode;
    $("defaultTarget").value = S.settings.defaultTarget;
    $("proxyBase").value = S.settings.proxyBase;
    $("layoutMode").checked = !!S.layoutMode;
    stage.classList.toggle("layout-on", !!S.layoutMode);
  }

  /* ---------------- 导入导出 ---------------- */
  function exportConfig() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `esp32-panel-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.buttons)) throw new Error("格式不正确");
        S.buttons = data.buttons.map((b) => ({ ...b, id: b.id || uid() }));
        if (data.settings) S.settings = { ...S.settings, ...data.settings };
        syncSettingsUI();
        render();
        toast(`已导入 ${S.buttons.length} 个按钮`);
      } catch (e) {
        toast("导入失败：" + e.message, true);
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 连通测试 ---------------- */
  async function testConnection() {
    const raw = (S.settings.defaultTarget || "").trim();
    if (!raw) return toast("请先在左侧填写默认目标地址", true);
    let base;
    try {
      const u = new URL(/^[a-zA-Z]+:\/\//.test(raw) ? raw : "http://" + raw);
      base = `${u.protocol}//${u.host}`;
    } catch {
      return toast("地址格式不对", true);
    }
    const url = base + "/status";
    toast("正在测试 " + url + " …");
    try {
      const r = await dispatch(
        { url, method: "GET", headers: {}, body: null },
        S.settings.mode,
        3500
      );
      if (r.channel === "cors" || r.channel === "proxy") {
        addLog(r.ok ? "ok" : "err", "连通测试", `${r.channel} ${r.status} ${url} ${(r.body || "").slice(0, 120)}`, r.ms);
        toast(r.ok ? `✓ 设备在线（${r.status}）` : `设备返回 ${r.status}`, !r.ok);
      } else {
        addLog("warn", "连通测试", `${r.channel} 已发出，无法读取响应`, null);
        toast("请求已发出，但当前通道读不到响应（正常）");
      }
    } catch (e) {
      addLog("err", "连通测试", e.message || String(e), null);
      toast(e.message || "测试失败", true);
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $("addBtn").addEventListener("click", openNew);
    $("emptyAdd").addEventListener("click", openNew);
    $("exportBtn").addEventListener("click", exportConfig);
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => {
      if (e.target.files[0]) importConfig(e.target.files[0]);
      e.target.value = "";
    });

    $("layoutMode").addEventListener("change", (e) => {
      S.layoutMode = e.target.checked;
      stage.classList.toggle("layout-on", S.layoutMode);
      save();
      toast(S.layoutMode ? "布局模式：拖动按钮调整位置" : "运行模式：点击按钮发送");
    });

    $("modeSelect").addEventListener("change", (e) => {
      S.settings.mode = e.target.value;
      save();
      updateChips();
      probeProxy();
    });
    $("defaultTarget").addEventListener("change", (e) => {
      S.settings.defaultTarget = e.target.value.trim();
      save(); renderList();
    });
    $("proxyBase").addEventListener("change", (e) => {
      S.settings.proxyBase = e.target.value.trim();
      save(); probeProxy();
    });

    $("settingsBtn").addEventListener("click", openSettings);
    $("settingsClose").addEventListener("click", () => settingsModal.classList.add("hidden"));
    $("settingsSave").addEventListener("click", saveSettings);

    $("modalClose").addEventListener("click", closeEditor);
    $("fCancel").addEventListener("click", closeEditor);
    $("fSave").addEventListener("click", saveEditor);
    $("fDelete").addEventListener("click", deleteButton);

    // 色板
    const sw = $("swatches");
    SWATCHES.forEach((c) => {
      const b = document.createElement("button");
      b.style.background = c;
      b.type = "button";
      b.addEventListener("click", () => { $("fColor").value = c; });
      sw.appendChild(b);
    });

    $("logBtn").addEventListener("click", () => {
      $("console").classList.toggle("open");
      renderLogs();
    });
    $("closeLog").addEventListener("click", () => $("console").classList.remove("open"));
    $("clearLog").addEventListener("click", () => { logs = []; renderLogs(); $("logCount").textContent = 0; });
    $("testBtn").addEventListener("click", testConnection);

    $("clearBtn").addEventListener("click", () => {
      if (!S.buttons.length) return;
      if (!confirm("清空全部按钮？此操作不可撤销。")) return;
      S.buttons = [];
      render();
      toast("已清空");
    });

    // 快捷键
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeEditor(); settingsModal.classList.add("hidden"); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); openNew(); }
    });

    // 点击遮罩关闭
    [modal, settingsModal].forEach((m) => {
      m.addEventListener("mousedown", (e) => { if (e.target === m) m.classList.add("hidden"); });
    });

    // banner
    $("bannerClose").addEventListener("click", () => $("mixedBanner").classList.add("hidden"));
    $("bannerProxy").addEventListener("click", () => {
      if (!S.settings.proxyBase) S.settings.proxyBase = "http://127.0.0.1:8765";
      S.settings.mode = "proxy";
      syncSettingsUI();
      save();
      updateChips();
      toast("已切换为代理模式，请确认已运行 python esp32web.py ui");
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    syncSettingsUI();
    bind();
    render();

    const mixed = location.protocol === "https:";
    $("mixedBanner").classList.toggle("hidden", !mixed);
    if (mixed && !S.settings.proxyBase) {
      $("mixedBanner").classList.remove("hidden");
    }
    probeProxy();
    if (!S.settings.defaultTarget && !S.buttons.length) {
      // 首次访问的友好提示
      setTimeout(() => toast("先点「设置」填 ESP32 地址，再新建按钮"), 700);
    }
    if (location.protocol === "file:") {
      $("mixedBanner").classList.remove("hidden");
      $("mixedBanner").querySelector("span").innerHTML =
        "⚠️ 当前以 <code>file://</code> 打开，浏览器会限制跨域请求。建议运行 <code>python esp32web.py ui</code> 后用 http://127.0.0.1:8765 访问。";
    }
  }

  boot();
})();
