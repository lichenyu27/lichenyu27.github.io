'use strict';

/* ===================== 状态 ===================== */
let quiz = null;          // { title, questions: [...] }（已归一化）
let current = 0;          // 当前题号
let answers = [];         // 用户作答：single->index|null; multiple->[idx]|null; boolean->true/false|null
let graded = [];          // 是否已「批改」：批改后才显示对错与解析、并解锁下一题
let submitted = false;

/* ===================== 工具 ===================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showError(msg) {
  const el = $('#import-error');
  el.textContent = '⚠️ ' + msg;
  el.hidden = false;
}
function clearError() { $('#import-error').hidden = true; }

function decodeBase64(b64) {
  const clean = (b64 || '').replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function letterToIndex(v) {
  if (typeof v === 'string' && /^[a-zA-Z]$/.test(v.trim())) return v.trim().toUpperCase().charCodeAt(0) - 65;
  return null;
}

/* 将各种写法归一化为标准答案，并返回 {ok, value, msg} */
function normalizeAnswer(type, raw, optionsLen) {
  if (type === 'single') {
    if (typeof raw === 'number' && Number.isInteger(raw)) return { ok: true, value: raw };
    if (typeof raw === 'string') {
      const li = letterToIndex(raw);
      if (li !== null) return { ok: true, value: li };
      const n = parseInt(raw, 10);
      if (!isNaN(n)) return { ok: true, value: n };
    }
    return { ok: false, msg: '单选 answer 应为选项下标(0起)或字母(A/B/C…)' };
  }
  if (type === 'multiple') {
    let arr = Array.isArray(raw) ? raw : [raw];
    const idx = arr.map((x) => {
      if (typeof x === 'number' && Number.isInteger(x)) return x;
      if (typeof x === 'string') {
        const li = letterToIndex(x);
        if (li !== null) return li;
        const n = parseInt(x, 10);
        if (!isNaN(n)) return n;
      }
      return null;
    }).filter((x) => x !== null);
    if (idx.length === 0) return { ok: false, msg: '多选 answer 应为正确选项下标数组' };
    return { ok: true, value: Array.from(new Set(idx)).sort((a, b) => a - b) };
  }
  // boolean
  const t = ['true', '对', '是', '正确', 'yes', 'y', '1', 1, true];
  const f = ['false', '错', '否', '错误', 'no', 'n', '0', 0, false];
  if (t.includes(raw)) return { ok: true, value: true };
  if (f.includes(raw)) return { ok: true, value: false };
  return { ok: false, msg: '判断 answer 应为 true/false（也支持“对/错”等）' };
}

/* 解析 + 校验 + 归一化题库 */
function parseQuiz(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
  let questions = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('题库缺少有效的 questions 数组（或顶层不是题目数组）');
  }
  const out = [];
  questions.forEach((q, i) => {
    if (!q || typeof q !== 'object') throw new Error(`第 ${i + 1} 题格式不正确`);
    const type = (q.type || '').toLowerCase();
    if (!['single', 'multiple', 'boolean'].includes(type)) {
      throw new Error(`第 ${i + 1} 题 type 必须是 single/multiple/boolean，当前为「${q.type}」`);
    }
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`第 ${i + 1} 题缺少 question 题干`);
    }
    let options = q.options;
    if (type !== 'boolean') {
      if (!Array.isArray(options) || options.length < 2) {
        throw new Error(`第 ${i + 1} 题需要至少 2 个 options 选项`);
      }
    }
    const norm = normalizeAnswer(type, q.answer, options ? options.length : 0);
    if (!norm.ok) throw new Error(`第 ${i + 1} 题 answer 错误：${norm.msg}`);
    if (type !== 'boolean' && Array.isArray(norm.value)) {
      const max = options.length - 1;
      if (norm.value.some((v) => v < 0 || v > max)) {
        throw new Error(`第 ${i + 1} 题 answer 下标超出选项范围`);
      }
    } else if (type === 'single' && (norm.value < 0 || norm.value > options.length - 1)) {
      throw new Error(`第 ${i + 1} 题 answer 下标超出选项范围`);
    }
    out.push({
      type,
      question: q.question,
      options: type === 'boolean' ? ['错误', '正确'] : options,
      answer: norm.value,
      explanation: q.explanation || '',
    });
  });
  return { title: (data && data.title) || '未命名题库', questions: out };
}

/* ===================== 导入：GitHub（静态直连，令牌仅存浏览器 localStorage） ===================== */
// 纯静态方案：浏览器直接用令牌调 GitHub API（GitHub 支持 CORS）。
// 令牌保存在当前浏览器 localStorage，不上传任何服务器。
// 说明：GitHub 无「轻量列私有库」接口，故本方案按 owner(用户/组织) 列【公开】仓库；
//       私有库可手动输入 owner/repo 后浏览其文件内容。

const GH = 'https://api.github.com';
const gh = { repo: '', branch: '', path: [], selected: null };

// 已保存的令牌：默认【不使用】，必须用户明确点击「使用该令牌」后才生效。
// 这样可避免「偷偷带上失效令牌 → 401」的问题。
let ghTokenApproved = false;
function storedGhToken() { return (localStorage.getItem('gh_token') || '').trim(); }
function ghToken() { return ghTokenApproved ? storedGhToken() : ''; }

function checkStoredToken() {
  const saved = storedGhToken();
  const box = $('#gh-saved');
  if (saved && !ghTokenApproved) {
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

async function ghApi(urlPath, params, _retried) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const t = ghToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(GH + urlPath + qs, { headers });
  } catch (e) {
    throw new Error('网络请求失败：无法访问 GitHub。若在受限预览环境，请改为在本地或部署后打开本页面');
  }
  // 已批准使用的令牌遇 401：说明已失效/被撤销 → 清除并降级为无令牌重试（公开资源仍可读）
  if (res.status === 401 && t && !_retried) {
    localStorage.removeItem('gh_token');
    ghTokenApproved = false;
    const input = document.getElementById('gh-token');
    if (input) input.value = '';
    checkStoredToken();
    return ghApi(urlPath, params, true);
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401) throw new Error('令牌无效或无权限（401）');
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') throw new Error('GitHub 访问频率受限（403，未填令牌时限流更严），请填令牌或稍后再试');
      throw new Error('无权限或受限（403）');
    }
    if (res.status === 404) throw new Error('资源不存在（404）：请检查仓库/分支/路径；若是私有库，需在「高级」中填有效令牌');
    throw new Error('GitHub 返回错误：HTTP ' + res.status);
  }
  return data;
}

// 选择/输入 owner 后连接（可选填令牌）
async function connectGithub() {
  clearError();
  const owner = $('#gh-owner').value.trim();
  const token = $('#gh-token').value.trim();
  if (!owner) { showError('请填写 GitHub 用户名或组织名（owner）'); return; }
  const btn = $('#gh-connect-btn');
  btn.disabled = true; btn.textContent = '连接中…';
  try {
    if (token) { localStorage.setItem('gh_token', token); ghTokenApproved = true; }
    else { localStorage.removeItem('gh_token'); ghTokenApproved = false; }
    $('#gh-saved').hidden = true;
    gh.owner = owner;
    $('#gh-connect').hidden = true;
    $('#gh-browse').hidden = false;
    $('#gh-login').textContent = token ? `已连接：${owner}（含私有库）` : `${owner}（仅公开库）`;
    await loadRepos();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '连接 / 加载仓库';
  }
}

async function loadRepos() {
  const token = ghToken();
  // 公开仓库：始终尝试（无令牌也能列）
  let repos = [];
  try {
    const pub = await ghApi(`/users/${encodeURIComponent(gh.owner)}/repos`, { per_page: 100, sort: 'updated' });
    if (Array.isArray(pub)) repos = pub;
  } catch (_) { /* 账号不存在/无公开库，下面用令牌路径兜底 */ }
  // 带令牌：额外取「当前账号可访问的仓库」（含私有库），再按 owner 过滤并去重合并
  if (token) {
    try {
      const all = await ghApi('/user/repos', { per_page: 100, sort: 'updated' });
      const mine = (Array.isArray(all) ? all : []).filter(
        (r) => (r.owner && r.owner.login || '').toLowerCase() === gh.owner.toLowerCase()
      );
      const seen = new Set(repos.map((r) => r.full_name));
      mine.forEach((r) => { if (!seen.has(r.full_name)) repos.push(r); });
    } catch (_) {}
  }
  repos.sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
  const sel = $('#gh-repo');
  sel.innerHTML = '';
  if (!repos.length) {
    showError(token ? '未找到该账号下你可访问的仓库（含私有库）；若只是查看他人公开库，请留空令牌' : '该 owner 下未找到公开仓库（私有库需填令牌）');
    return;
  }
  repos.forEach((r) => {
    const o = document.createElement('option');
    o.value = r.full_name;
    o.textContent = r.full_name + (r.private ? ' 🔒' : '');
    o.setAttribute('data-default', r.default_branch || 'main');
    sel.appendChild(o);
  });
  await onRepoChange();
}

async function onRepoChange() {
  const opt = $('#gh-repo').selectedOptions[0];
  gh.repo = $('#gh-repo').value;
  gh.path = []; gh.selected = null;
  const def = opt ? opt.getAttribute('data-default') : '';
  await loadBranches(def);
  await loadFiles();
}

async function loadBranches(def) {
  const data = await ghApi(`/repos/${gh.repo}/branches`, { per_page: 100 });
  const sel = $('#gh-branch');
  sel.innerHTML = '';
  (Array.isArray(data) ? data : []).forEach((b) => {
    const o = document.createElement('option');
    o.value = b.name; o.textContent = b.name;
    sel.appendChild(o);
  });
  if (def && sel.querySelector(`option[value="${CSS.escape(def)}"]`)) sel.value = def;
  if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
  gh.branch = sel.value;
}

async function loadFiles() {
  const p = gh.path.join('/');
  const data = await ghApi(`/repos/${gh.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { ref: gh.branch });
  const items = Array.isArray(data) ? data : [data];
  const dirs = items.filter((i) => i.type === 'dir').map((i) => ({ name: i.name, path: i.path, type: 'dir' }));
  const files = items.filter((i) => i.type === 'file').map((i) => ({ name: i.name, path: i.path, type: 'file' }));
  renderBreadcrumb();
  renderTree([...dirs, ...files]);
}

function renderBreadcrumb() {
  const bc = $('#gh-path');
  bc.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb';
  root.textContent = '📁 ' + gh.repo;
  root.addEventListener('click', () => { gh.path = []; loadFiles(); });
  bc.appendChild(root);
  gh.path.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = ' / ';
    bc.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = seg;
    c.addEventListener('click', () => { gh.path = gh.path.slice(0, i + 1); loadFiles(); });
    bc.appendChild(c);
  });
}

function renderTree(items) {
  const tree = $('#gh-tree');
  tree.innerHTML = '';
  if (!items.length) { tree.innerHTML = '<div class="tree-empty">此目录为空</div>'; return; }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (it.type === 'dir' ? 'is-dir' : 'is-file');
    if (it.type !== 'dir' && gh.selected === it.path) row.classList.add('selected');
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = (it.type === 'dir' ? '📁 ' : '📄 ') + it.name;
    row.appendChild(label);
    if (it.type === 'dir') {
      row.addEventListener('click', () => { gh.path.push(it.name); gh.selected = null; loadFiles(); });
    } else {
      row.addEventListener('click', () => { gh.selected = it.path; renderTree(items); });
    }
    tree.appendChild(row);
  });
}

async function readSelected() {
  if (!gh.selected) { showError('请先在文件列表中选一个文件'); return; }
  const btn = $('#gh-load');
  btn.disabled = true; btn.textContent = '读取中…';
  try {
    const data = await ghApi(`/repos/${gh.repo}/contents/${gh.selected.split('/').map(encodeURIComponent).join('/')}`, { ref: gh.branch });
    if (!data.content) throw new Error('该文件内容为空或不是文本文件');
    const clean = (data.content || '').replace(/\s/g, '');
    const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    startQuiz(parseQuiz(new TextDecoder('utf-8').decode(bytes)));
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '读取选中的题库';
  }
}

function logoutGithub() {
  localStorage.removeItem('gh_token');
  ghTokenApproved = false;
  gh.repo = ''; gh.branch = ''; gh.path = []; gh.selected = null;
  $('#gh-browse').hidden = true;
  $('#gh-connect').hidden = false;
  $('#gh-token').value = '';
  checkStoredToken();
  clearError();
}

/* ===================== 直接用名字访问（免令牌，公开库） ===================== */
// 解析 owner/repo[/path][@branch]
function parseRepoRef(str) {
  str = (str || '').trim();
  if (!str) return null;
  let ref = '';
  const at = str.lastIndexOf('@');
  if (at > 0) { ref = str.slice(at + 1).trim(); str = str.slice(0, at); }
  const parts = str.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1], path: parts.slice(2).join('/'), ref };
}

async function readFileDirect(full, path, ref) {
  const data = await ghApi(`/repos/${full}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, ref ? { ref } : {});
  if (!data.content) throw new Error('该文件内容为空或不是文本文件');
  const bytes = Uint8Array.from(atob((data.content || '').replace(/\s/g, '')), (c) => c.charCodeAt(0));
  startQuiz(parseQuiz(new TextDecoder('utf-8').decode(bytes)));
}

// 进入浏览式 UI 并定位到指定仓库/目录（用于目录或根目录多个 JSON 时）
async function enterBrowse(full, ref, path) {
  gh.owner = full.split('/')[0];
  gh.repo = full;
  gh.path = path ? path.split('/') : [];
  $('#gh-connect').hidden = true;
  $('#gh-browse').hidden = false;
  $('#gh-login').textContent = ghToken() ? '已填令牌（可访问私有库）' : '未填令牌（仅公开库）';
  const sel = $('#gh-repo');
  sel.innerHTML = '';
  const o = document.createElement('option');
  o.value = full; o.textContent = full;
  o.setAttribute('data-default', ref || 'main');
  sel.appendChild(o);
  sel.value = full;
  await loadBranches(ref);
  await loadFiles();
}

async function loadByRef() {
  clearError();
  const tok = $('#gh-token').value.trim();
  if (tok) { localStorage.setItem('gh_token', tok); ghTokenApproved = true; $('#gh-saved').hidden = true; }
  const ref = parseRepoRef($('#gh-direct').value);
  if (!ref) { showError('格式应为 owner/repo，例如 lichenyu27/try'); return; }
  const btn = $('#gh-direct-btn');
  btn.disabled = true; btn.textContent = '读取中…';
  const full = `${ref.owner}/${ref.repo}`;
  try {
    if (ref.path && ref.path.toLowerCase().endsWith('.json')) {
      await readFileDirect(full, ref.path, ref.ref);
      return;
    }
    if (ref.path) { // 指向目录：进浏览定位
      await enterBrowse(full, ref.ref, ref.path);
      return;
    }
    // 无 path：列出根目录
    const data = await ghApi(`/repos/${full}/contents`, ref.ref ? { ref: ref.ref } : {});
    const items = Array.isArray(data) ? data : [data];
    const jsons = items.filter((i) => i.type === 'file' && i.name.toLowerCase().endsWith('.json'));
    if (jsons.length === 1) {
      await readFileDirect(full, jsons[0].path, ref.ref);
    } else if (jsons.length > 1) {
      // 多个 JSON：明确列出让用户选，或合并全部
      await showJsonPicker(full, ref.ref, jsons);
    } else {
      // 无 JSON：进完整文件树让用户自行浏览（可能在子目录）
      await enterBrowse(full, ref.ref, '');
      showError('根目录未找到 JSON 文件，请在文件列表中浏览（含子目录）');
    }
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '直接读取';
  }
}

/* 多个 JSON 时：列出题库文件供选择，或合并全部 */
async function showJsonPicker(full, ref, jsons) {
  gh.owner = full.split('/')[0];
  gh.repo = full;
  gh.branch = ref || '';
  $('#gh-primary').hidden = true;
  const adv = document.querySelector('.adv'); if (adv) adv.hidden = true;
  $('#gh-pick').hidden = false;
  $('#gh-pick-hint').textContent = `在 ${full} 根目录发现 ${jsons.length} 个 JSON 题库，点选一个，或合并全部一起答：`;
  const list = $('#gh-pick-list');
  list.innerHTML = '';
  jsons.forEach((j) => {
    const row = document.createElement('div');
    row.className = 'tree-row is-file';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = '📄 ' + j.name;
    row.appendChild(label);
    row.addEventListener('click', () => readFileDirect(full, j.path, ref));
    list.appendChild(row);
  });
}

async function mergeJsonQuiz(full, ref) {
  clearError();
  const btn = $('#gh-merge-btn');
  btn.disabled = true; btn.textContent = '合并中…';
  try {
    const data = await ghApi(`/repos/${full}/contents`, ref ? { ref } : {});
    const items = Array.isArray(data) ? data : [data];
    const jsons = items.filter((i) => i.type === 'file' && i.name.toLowerCase().endsWith('.json'));
    if (!jsons.length) throw new Error('未找到可合并的 JSON 文件');
    const all = [];
    const skipped = [];
    for (const j of jsons) {
      try {
        const d = await ghApi(`/repos/${full}/contents/${j.path.split('/').map(encodeURIComponent).join('/')}`, ref ? { ref } : {});
        if (!d.content) { skipped.push(j.name); continue; }
        const bytes = Uint8Array.from(atob((d.content || '').replace(/\s/g, '')), (c) => c.charCodeAt(0));
        const parsed = parseQuiz(new TextDecoder('utf-8').decode(bytes));
        all.push(...parsed.questions);
      } catch (_) {
        skipped.push(j.name); // 非题库 JSON（如 package.json）跳过
      }
    }
    if (!all.length) throw new Error('没有可合并的题库 JSON（已跳过非题库文件：' + skipped.join('、') + '）');
    const note = skipped.length ? `（已跳过 ${skipped.length} 个非题库文件）` : '';
    startQuiz({ title: `${full}（合并 ${jsons.length} 个题库 · 共 ${all.length} 题）${note}`, questions: all });
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = '合并全部并答题';
  }
}

function resetGhPick() {
  $('#gh-pick').hidden = true;
  $('#gh-primary').hidden = false;
  const adv = document.querySelector('.adv'); if (adv) adv.hidden = false;
}

/* ===================== 渲染：答题 ===================== */
const TYPE_LABEL = { single: '单选', multiple: '多选', boolean: '判断' };

function startQuiz(parsed) {
  quiz = parsed;
  current = 0;
  submitted = false;
  answers = new Array(quiz.questions.length).fill(null);
  graded = new Array(quiz.questions.length).fill(false);

  $('#import-section').hidden = true;
  $('#result-section').hidden = true;
  $('#quiz-section').hidden = false;
  $('#quiz-title').textContent = quiz.title;

  renderNavDots();
  renderQuestion();
  applyExtensionsOnStart();
  scheduleAuto();
  $('#quiz-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderNavDots() {
  const wrap = $('#nav-dots');
  wrap.innerHTML = '';
  quiz.questions.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'nav-dot';
    d.textContent = i + 1;
    d.addEventListener('click', () => { if (!submitted) { current = i; renderQuestion(); } });
    wrap.appendChild(d);
  });
}

function renderQuestion() {
  const q = quiz.questions[current];
  $('#quiz-progress').textContent = `第 ${current + 1} / ${quiz.questions.length} 题`;
  const typeEl = $('#q-type');
  typeEl.textContent = TYPE_LABEL[q.type];
  typeEl.className = 'q-type' + (q.type === 'multiple' ? ' t-multiple' : q.type === 'boolean' ? ' t-boolean' : '');
  $('#q-index').textContent = 'Q' + (current + 1);
  $('#q-text').textContent = q.question;

  const optWrap = $('#q-options');
  optWrap.innerHTML = '';
  const locked = graded[current] || submitted;

  // 批改后才给选项上「对/错」配色
  const markGrade = (el, isUserSel, isCorrectAns) => {
    if (!graded[current] || submitted) return;
    if (isCorrectAns) el.classList.add('correct');
    else if (isUserSel) el.classList.add('wrong');
  };

  if (q.type === 'boolean') {
    const box = document.createElement('div');
    box.className = 'bool-btns';
    [true, false].forEach((val) => {
      const b = document.createElement('button');
      b.className = 'bool-btn';
      b.textContent = val ? '正确' : '错误';
      if (answers[current] === val) b.classList.add('selected');
      markGrade(b, answers[current] === val, q.answer === val);
      b.addEventListener('click', () => {
        if (locked) return;
        answers[current] = val;
        renderQuestion();
      });
      box.appendChild(b);
    });
    optWrap.appendChild(box);
  } else {
    const multiple = q.type === 'multiple';
    q.options.forEach((opt, i) => {
      const el = document.createElement('div');
      el.className = 'opt' + (multiple ? ' checkbox' : '');
      const letter = String.fromCharCode(65 + i);
      const myAns = answers[current];
      const isSel = multiple ? (Array.isArray(myAns) && myAns.includes(i)) : (myAns === i);
      if (isSel) el.classList.add('selected');
      const isCorrectAns = multiple ? q.answer.includes(i) : (q.answer === i);
      markGrade(el, isSel, isCorrectAns);

      const marker = document.createElement('span');
      marker.className = 'marker';
      marker.textContent = letter;
      const txt = document.createElement('span');
      txt.textContent = opt;
      el.appendChild(marker);
      el.appendChild(txt);

      el.addEventListener('click', () => {
        if (locked) return;
        if (multiple) {
          const set = new Set(Array.isArray(answers[current]) ? answers[current] : []);
          set.has(i) ? set.delete(i) : set.add(i);
          answers[current] = Array.from(set).sort((a, b) => a - b);
        } else {
          answers[current] = i;
        }
        renderQuestion();
      });
      optWrap.appendChild(el);
    });
  }

  // 解析：批改（graded）后才显示
  const exp = $('#q-explain');
  const expHint = $('#q-explain-hint');
  if (q.explanation && graded[current] && !submitted) {
    exp.hidden = false;
    exp.innerHTML = '<b>解析：</b>' + escapeHtml(q.explanation);
    if (expHint) expHint.hidden = true;
  } else {
    exp.hidden = true;
    if (expHint) expHint.hidden = !(q.explanation && !graded[current] && !submitted);
  }

  updateNavDots();
  updateQuizActions();
}

/* 控制答题区按钮：批改前只显示「批改」；批改后显示「下一题」（最后一题显示「交卷」） */
function updateQuizActions() {
  const last = current === quiz.questions.length - 1;
  const isGraded = !!graded[current];
  $('#prev-btn').disabled = current === 0;
  $('#grade-btn').style.display = isGraded ? 'none' : '';
  $('#next-btn').style.display = (isGraded && !last) ? '' : 'none';
  $('#submit-btn').style.display = (isGraded && last) ? '' : 'none';
}

/* 批改当前题：显示对错与解析，并解锁「下一题」；自动化模式下安排 N 秒后自动下一题 */
function gradeCurrent() {
  if (submitted || graded[current]) return;
  graded[current] = true;
  renderQuestion();
  if (ext.autoanswer.enabled) {
    clearAuto();
    const n = Math.max(1, ext.autoanswer.next) * 1000;
    autoNextTimer = setTimeout(goNext, n);
  }
}

function updateNavDots() {
  $$('#nav-dots .nav-dot').forEach((d, i) => {
    d.classList.toggle('current', i === current);
    d.classList.toggle('answered', answers[i] !== null);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isCorrect(q, ans) {
  if (ans === null) return false;
  if (q.type === 'multiple') {
    if (!Array.isArray(ans)) return false;
    return ans.length === q.answer.length && ans.every((x) => q.answer.includes(x));
  }
  return ans === q.answer;
}

/* ===================== 交卷 / 结果 ===================== */
function submitQuiz() {
  clearAuto();
  clearMusicExt();
  const unanswered = answers.filter((a) => a === null).length;
  if (unanswered > 0 && !confirm(`还有 ${unanswered} 题未作答，确定交卷吗？`)) return;

  submitted = true;
  let score = 0;
  quiz.questions.forEach((q, i) => { if (isCorrect(q, answers[i])) score++; });

  $('#score-num').textContent = `${score} / ${quiz.questions.length}`;
  $('#score-rate').textContent = `正确率 ${Math.round((score / quiz.questions.length) * 100)}%`;

  renderReview(score);
  $('#quiz-section').hidden = true;
  $('#result-section').hidden = false;
  $('#result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function optionLabelText(q, idx) {
  if (q.type === 'boolean') return idx ? '正确' : '错误';
  return String.fromCharCode(65 + idx) + '. ' + q.options[idx];
}

function renderReview(score) {
  const list = $('#review-list');
  list.innerHTML = '';
  quiz.questions.forEach((q, i) => {
    const ok = isCorrect(q, answers[i]);
    const item = document.createElement('div');
    item.className = 'review-item';

    const head = document.createElement('div');
    head.className = 'rv-head';
    const badge = document.createElement('span');
    badge.className = 'rv-badge ' + (ok ? 'ok' : 'no');
    badge.textContent = ok ? '✅ 正确' : '❌ 错误';
    const qnum = document.createElement('span');
    qnum.className = 'rv-q';
    qnum.textContent = `Q${i + 1}. ${q.question}`;
    head.appendChild(badge);
    head.appendChild(qnum);
    item.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'rv-detail';
    let userTxt;
    if (answers[i] === null) userTxt = '<span class="no">未作答</span>';
    else if (q.type === 'multiple') userTxt = answers[i].map((x) => optionLabelText(q, x)).join('、');
    else userTxt = optionLabelText(q, answers[i]);

    let correctTxt;
    if (q.type === 'multiple') correctTxt = q.answer.map((x) => optionLabelText(q, x)).join('、');
    else correctTxt = optionLabelText(q, q.answer);

    detail.innerHTML = `你的答案：${userTxt}<br>正确答案：<span class="ok">${correctTxt}</span>`;
    item.appendChild(detail);

    if (q.explanation) {
      const ex = document.createElement('div');
      ex.className = 'rv-explain';
      ex.innerHTML = '<b>解析：</b>' + escapeHtml(q.explanation);
      item.appendChild(ex);
    }
    list.appendChild(item);
  });
}

/* ===================== 重置 ===================== */
function resetToImport() {
  quiz = null; submitted = false; answers = [];
  teardownExtensions();
  resetGhPick();
  $('#quiz-section').hidden = true;
  $('#result-section').hidden = true;
  $('#import-section').hidden = false;
  $('#import-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function retry() {
  answers = new Array(quiz.questions.length).fill(null);
  graded = new Array(quiz.questions.length).fill(false);
  submitted = false;
  current = 0;
  if (ext.rollcall.enabled) { drawnIds.clear(); renderDrawnList(); }
  $('#result-section').hidden = true;
  $('#quiz-section').hidden = false;
  renderNavDots();
  renderQuestion();
  scheduleAuto();
  $('#quiz-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===================== 扩展商店 ===================== */
const EXT_KEY = 'quiz_ext';
const EXT_DEFAULT = {
  bg:        { enabled: false, mode: 'image', color: '#c2a04c', website: '', interactive: false, source: null },
  music:     { enabled: false, mode: 'single', source: null },
  lcd:       { enabled: false, speed: 7, opacity: 90, source: null },
  rollcall:  { enabled: false, exclude: '', source: null },
  autoanswer:{ enabled: false, answer: 15, next: 3 },
};
function mergeDeep(a, b) {
  const o = JSON.parse(JSON.stringify(a));
  for (const k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) o[k] = mergeDeep(a[k] || {}, b[k]);
    else o[k] = b[k];
  }
  return o;
}
function loadExtState() {
  try {
    const s = JSON.parse(localStorage.getItem(EXT_KEY));
    if (s && typeof s === 'object') return mergeDeep(EXT_DEFAULT, s);
  } catch (_) {}
  return JSON.parse(JSON.stringify(EXT_DEFAULT));
}
function saveExtState() { localStorage.setItem(EXT_KEY, JSON.stringify(ext)); }
let ext = loadExtState();

/* ===================== 全局仓库（一次设置，全站复用 + 文件缓存） ===================== */
const GLOBAL_REPO_KEY = 'quiz_global_repo';
const REPO_FILES_KEY = 'quiz_repo_files_cache';
function tokenSig(t) { t = (t || '').trim(); return t ? 'T' + t.slice(0, 8) : 'anon'; }
function loadGlobalRepo() {
  try { const s = JSON.parse(localStorage.getItem(GLOBAL_REPO_KEY)); if (s && s.repo) return s; } catch (_) {}
  return { repo: '', branch: '', token: '' };
}
function saveGlobalRepo() { localStorage.setItem(GLOBAL_REPO_KEY, JSON.stringify(globalRepo)); }
let globalRepo = loadGlobalRepo();

function loadRepoFileCache() { try { return JSON.parse(localStorage.getItem(REPO_FILES_KEY)) || null; } catch (_) { return null; } }
function saveRepoFileCache(c) { try { localStorage.setItem(REPO_FILES_KEY, JSON.stringify(c)); } catch (_) {} }

/* 列出仓库内全部文件（递归），带缓存：同 repo+branch+令牌 不重复请求 */
async function listAllRepoFiles(repo, branch, force) {
  const tok = ghToken();
  const cached = !force ? loadRepoFileCache() : null;
  if (cached && cached.repo === repo && cached.branch === (branch || '') && cached.tokSig === tokenSig(tok)) {
    return cached.files;
  }
  const collected = [];
  const queue = [''];
  let dirs = 0; const MAX_DIRS = 100, MAX_FILES = 1000;
  while (queue.length && dirs < MAX_DIRS && collected.length < MAX_FILES) {
    const p = queue.shift();
    const data = await ghApi(`/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { ref: branch });
    const items = Array.isArray(data) ? data : [data];
    for (const it of items) {
      if (it.type === 'dir') { if (dirs < MAX_DIRS) { queue.push(it.path); dirs++; } }
      else if (it.type === 'file') { collected.push({ name: it.name, path: it.path }); if (collected.length >= MAX_FILES) break; }
    }
  }
  collected.sort((a, b) => a.path.localeCompare(b.path));
  saveRepoFileCache({ repo, branch: branch || '', tokSig: tokenSig(tok), files: collected, ts: Date.now() });
  return collected;
}

async function grConnect(force) {
  const repoStr = $('#gr-repo').value.trim();
  const branch = $('#gr-branch').value.trim();
  const token = $('#gr-token').value.trim();
  if (!repoStr) { showError('请填写全局仓库 owner/repo'); return; }
  const parts = repoStr.split('/').filter(Boolean);
  if (parts.length < 2) { showError('格式应为 owner/repo，例如 lichenyu27/try'); return; }
  globalRepo = { repo: parts.slice(0, 2).join('/'), branch: branch || 'main', token };
  saveGlobalRepo();
  if (token) { localStorage.setItem('gh_token', token); ghTokenApproved = true; }
  else { localStorage.removeItem('gh_token'); ghTokenApproved = false; }
  const btn = $('#gr-connect'); btn.disabled = true; btn.textContent = '连接中…';
  $('#gr-refresh').hidden = false;
  try {
    const files = await listAllRepoFiles(globalRepo.repo, globalRepo.branch, force);
    $('#gr-status').textContent = `✅ 已连接 ${globalRepo.repo}@${globalRepo.branch}：缓存 ${files.length} 个文件（${new Date().toLocaleTimeString()}）${force ? '（已刷新）' : ''}`;
  } catch (e) {
    $('#gr-status').textContent = '⚠️ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '连接并列出全部文件';
  }
}

async function grImport() {
  if (!globalRepo.repo) { showError('请先在上方设置并连接全局仓库'); return; }
  const btn = $('#gr-import'); btn.disabled = true; btn.textContent = '列出中…';
  try {
    const files = await listAllRepoFiles(globalRepo.repo, globalRepo.branch, false);
    const jsons = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
    if (!jsons.length) { showError('全局仓库中未找到 JSON 文件'); return; }
    await showJsonPicker(globalRepo.repo, globalRepo.branch, jsons);
  } catch (e) { showError(e.message); }
  finally { btn.disabled = false; btn.textContent = '📂 用全局仓库导入题库'; }
}

function renderGlobalRepoUI() {
  $('#gr-repo').value = globalRepo.repo || '';
  $('#gr-branch').value = globalRepo.branch || 'main';
  $('#gr-token').value = globalRepo.token || '';
  if (!globalRepo.repo) { $('#gr-status').textContent = '尚未设置全局仓库。'; $('#gr-refresh').hidden = true; return; }
  const c = loadRepoFileCache();
  if (c && c.repo === globalRepo.repo && c.branch === (globalRepo.branch || '') && c.tokSig === tokenSig(ghToken())) {
    $('#gr-refresh').hidden = false;
    $('#gr-status').textContent = `已缓存 ${c.files.length} 个文件（${new Date(c.ts).toLocaleTimeString()}），可直接用全局仓库导入或选资源。`;
  } else {
    $('#gr-refresh').hidden = false;
    $('#gr-status').textContent = '已设置全局仓库，点击「连接并列出全部文件」以加载（或导入题库）。';
  }
}

/* ---- 资源直链 / 文本读取 ---- */
function rawUrl(repo, branch, path) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
async function fetchJsonText(repo, branch, path) {
  const data = await ghApi(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { ref: branch });
  if (!data.content) throw new Error('文件内容为空');
  return decodeBase64(data.content);
}

/* 从 JSON 文本中提取一个网址（支持 url / website / link / src / href 字段，或纯字符串） */
function websiteUrlFromJson(txt) {
  let data;
  try { data = JSON.parse(txt); } catch (_) { return null; }
  if (typeof data === 'string') { const t = data.trim(); return /^https?:\/\//i.test(t) ? t : null; }
  if (data && typeof data === 'object') {
    for (const k of ['url', 'website', 'link', 'src', 'href']) {
      if (typeof data[k] === 'string') { const t = data[k].trim(); if (/^https?:\/\//i.test(t)) return t; }
    }
  }
  return null;
}
/* 从仓库 JSON 读取网址并设为背景网站（与「应用」按钮效果一致） */
async function applyWebsiteFromJson(repo, branch, path, name) {
  try {
    const txt = await fetchJsonText(repo, branch, path);
    const url = websiteUrlFromJson(txt);
    if (!url) { showError('该 JSON 未包含网址（需要 url / website / link 字段，或纯字符串网址）'); return; }
    ext.bg.website = url;
    setExtField('bg-website', url);
    const src = $('[data-ext-src="bg-website"]'); if (src) src.textContent = name || '已选择';
    saveExtState();
    if (ext.bg.enabled) applyBgExt();
  } catch (e) { showError('网站 JSON 加载失败：' + e.message); }
}

/* ---- 渲染扩展 UI ---- */
function renderExtUI() {
  Object.keys(ext).forEach((key) => {
    const cfg = ext[key];
    const toggle = $(`[data-ext-toggle="${key}"]`); if (toggle) toggle.checked = !!cfg.enabled;
    const body = $(`.ext-card[data-ext="${key}"] .ext-body`); if (body) body.hidden = !cfg.enabled;
    setExtField('bg-mode', cfg.mode);
    setExtField('bg-color', cfg.color);
    setExtField('bg-website', cfg.website || '');
    const bi = $('[data-ext-field="bg-interactive"]'); if (bi) bi.checked = !!cfg.interactive;
    setExtField('music-mode', cfg.mode);
    setExtField('lcd-speed', cfg.speed);
    setExtField('lcd-opacity', cfg.opacity);
    setExtField('rollcall-exclude', cfg.exclude);
    setExtField('autoanswer-answer', cfg.answer);
    setExtField('autoanswer-next', cfg.next);
    updateSrcText(key);
    const sl = $(`[data-ext-val="lcd-speed"]`); if (sl) sl.textContent = cfg.speed + ' 秒/轮';
    const osl = $(`[data-ext-val="lcd-opacity"]`); if (osl) osl.textContent = cfg.opacity + '%';
    });
  syncBgBlocks();
}
function setExtField(name, val) { const el = $(`[data-ext-field="${name}"]`); if (el) el.value = val; }
function updateSrcText(key) {
  const el = $(`[data-ext-src="${key}"]`); if (!el) return;
  const src = ext[key].source;
  el.textContent = src ? (src.name || '已选择') : '未选择';
}
function syncBgBlocks() {
  const mode = ext.bg.mode;
  const srcBlock = $('[data-ext-block="bg-source"]');
  const colorBlock = $('[data-ext-block="bg-color"]');
  const webBlock = $('[data-ext-block="bg-website"]');
  if (srcBlock) srcBlock.hidden = (mode === 'color' || mode === 'website');
  if (colorBlock) colorBlock.hidden = (mode !== 'color');
  if (webBlock) webBlock.hidden = (mode !== 'website');
}

/* 展示模式：隐藏所有答题相关内容，只留顶部按钮与扩展浮层（背景 / LCD / 音乐 / 点名） */
function toggleDisplayMode() {
  const on = document.body.classList.toggle('display-mode');
  $('#display-btn').textContent = on ? '✕ 退出展示' : '🖥 展示模式';
}

/* ---- 背景与主题色 ---- */
let bgTimer = null;
let bgIframe = null;
let bgApplied = { mode: '', url: '', interactive: '', color: '', filesKey: '' };
function setBodyBg(url) {
  document.body.style.background = `#f6efdd url("${url}") center / cover no-repeat fixed`;
}
function removeWebsiteBg() {
  if (bgIframe) { bgIframe.remove(); bgIframe = null; }
  document.body.classList.remove('bg-interactive', 'bg-website');
}
function applyWebsiteBg(url) {
  const interactive = !!ext.bg.interactive;
  const sig = { mode: 'website', url, interactive: String(interactive) };
  // 若当前背景已是同一个网站且交互设置未变，直接复用，避免整块 iframe 重新加载
  if (bgIframe && bgApplied.mode === 'website' && bgApplied.url === url
      && bgApplied.interactive === String(interactive) && bgIframe.isConnected) {
    document.body.classList.add('bg-website');
    if (interactive) document.body.classList.add('bg-interactive');
    return;
  }
  removeWebsiteBg();
  bgApplied = { ...sig };
  if (!url) { showError('网站背景已开启，但未填写网址'); return; }
  bgIframe = document.createElement('iframe');
  bgIframe.src = url;
  bgIframe.className = 'bg-website-frame' + (interactive ? ' interactive' : '');
  // 关键：沙箱内绝不能放 allow-top-navigation（否则网站可 top.location 把整页带走）。
  // 但仍要“可跳转、能搜索”：允许 iframe 在自身内部导航，并允许在新标签打开
  // （搜索结果常以新标签弹出），因此加上 allow-popups / allow-presentation。
  // 这样既能在背景网站里正常搜索/翻页，又永远不会把整个答题页面顶掉。
  bgIframe.setAttribute('sandbox', interactive
    ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation'
    : 'allow-same-origin allow-popups');
  bgIframe.setAttribute('referrerpolicy', 'no-referrer');
  bgIframe.setAttribute('loading', 'lazy');
  bgIframe.setAttribute('allow', 'autoplay; fullscreen');
  document.body.appendChild(bgIframe);
  document.body.classList.add('bg-website');
  if (interactive) document.body.classList.add('bg-interactive');
}

/* 兜底：记录本站入口，若被背景页顶掉跳走，浏览器后退/刷新可回到本站；
   同时把已配置的网站背景暂存，返回后自动恢复。 */
function guardTopNavigation() {
  if (window.__bgNavGuard) return;
  window.__bgNavGuard = true;
  try {
    sessionStorage.setItem('quiz_home', location.href);
    if (ext.bg.enabled && ext.bg.mode === 'website') {
      sessionStorage.setItem('quiz_bg_pending', ext.bg.website || '');
    }
  } catch (_) {}
}
function clearBgExt() {
  if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
  document.body.style.background = '';
  removeWebsiteBg();
  bgApplied = { mode: '', url: '', interactive: '', color: '', filesKey: '' };
}
function applyBgExt() {
  const c = ext.bg; if (!c.enabled) { clearBgExt(); return; }

  // 纯色：无变化就不重置
  if (c.mode === 'color') {
    if (bgApplied.mode === 'color' && bgApplied.color === c.color) return;
    clearBgExt();
    bgApplied = { mode: 'color', url: '', interactive: '', color: c.color, filesKey: '' };
    document.body.style.background = c.color;
    return;
  }

  // 网站：由 applyWebsiteBg 内部做签名比较，重复调用不会重建 iframe
  if (c.mode === 'website') { applyWebsiteBg(c.website); return; }

  const src = c.source;
  if (!src || !src.files || !src.files.length) { clearBgExt(); showError('背景扩展已开启，但未选择图片资源'); return; }
  const urls = src.files.map((f) => rawUrl(src.repo, src.branch, f.path));
  const filesKey = c.mode + '|' + urls.join(',');
  // 图片：同一组资源且定时器还在，说明背景未变，保持现状（避免闪一下）
  if (bgApplied.mode !== 'color' && bgApplied.mode !== 'website'
      && bgApplied.filesKey === filesKey && (c.mode === 'image' || bgTimer)) return;

  clearBgExt();
  bgApplied = { mode: c.mode, url: '', interactive: '', color: '', filesKey };
  if (c.mode === 'image' || urls.length === 1) {
    setBodyBg(urls[0]);
  } else {
    let i = 0; setBodyBg(urls[0]);
    bgTimer = setInterval(() => { i = (i + 1) % urls.length; setBodyBg(urls[i]); }, 30000);
  }
}

/* ---- 背景音乐 ---- */
let audioEl = null, musicList = [], musicIdx = 0;
function updateMusicName() {
  const n = $('#music-name'); if (n) n.textContent = musicList.length ? musicList[musicIdx].name : '背景音乐';
}
function playMusic() {
  if (!musicList.length) return;
  if (audioEl) audioEl.pause();
  audioEl = new Audio(musicList[musicIdx].url);
  audioEl.loop = (ext.music.mode === 'single');
  audioEl.addEventListener('ended', () => {
    if (ext.music.mode === 'folder') { musicIdx = (musicIdx + 1) % musicList.length; playMusic(); }
  });
  audioEl.play().catch(() => { /* 自动播放被拦截，可点“播放” */ });
  updateMusicName();
}
function clearMusicExt() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  musicList = []; musicIdx = 0;
  const b = $('#music-bar'); if (b) b.hidden = true;
  document.body.classList.remove('music-on');
}
function applyMusicExt() {
  clearMusicExt();
  const c = ext.music; if (!c.enabled) return;
  const src = c.source;
  if (!src || !src.files || !src.files.length) { showError('背景音乐已开启，但未选择音乐资源'); return; }
  musicList = src.files.map((f) => ({ url: rawUrl(src.repo, src.branch, f.path), name: f.name }));
  if (c.mode === 'single') musicList = musicList.slice(0, 1);
  musicIdx = 0;
  $('#music-bar').hidden = false;
  document.body.classList.add('music-on');
  playMusic();
}

/* ---- LCD 像素屏 ---- */
let lcdLines = [];        // 当前滚动的各行文本
let lcdLineIdx = 0;       // 当前显示到第几行
let lcdAnimHandler = null;

/* 把 JSON 内容归一化为「行数组」：content/text 按换行拆分，lines/items 直接作为多行；逐行分开滚动 */
function lcdToLines(data) {
  if (typeof data === 'string') return data ? [data] : [];
  if (Array.isArray(data)) return data.filter((x) => x != null).map((x) => String(x));
  if (data && typeof data === 'object') {
    if (typeof data.content === 'string') return data.content.split('\n').map((s) => s.trim()).filter(Boolean);
    if (typeof data.text === 'string') return data.text.split('\n').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(data.lines)) return data.lines.filter((x) => x != null).map((x) => String(x));
    if (Array.isArray(data.items)) return data.items.filter((x) => x != null).map((x) => String(x));
  }
  return [];
}

/* 显示某一行并重启从右向左的滚动动画（一行滚完再切下一行） */
function lcdShowLine(i) {
  const t = $('#lcd-text'); if (!t) return;
  t.textContent = lcdLines[i];
  t.style.animation = 'none';
  void t.offsetHeight; // 强制回流，使动画可重新触发
  const dur = Math.max(3, ext.lcd.speed || 7);
  t.style.animation = `lcd-scroll linear ${dur}s 1`;
}
function lcdNextLine() {
  lcdLineIdx = (lcdLineIdx + 1) % lcdLines.length;
  lcdShowLine(lcdLineIdx);
}
function startLcdScroll() {
  const t = $('#lcd-text'); if (!t || !lcdLines.length) return;
  lcdLineIdx = 0;
  lcdShowLine(lcdLineIdx);
  if (lcdAnimHandler) t.removeEventListener('animationend', lcdAnimHandler);
  lcdAnimHandler = lcdNextLine;
  t.addEventListener('animationend', lcdNextLine);
}
function stopLcdScroll() {
  const t = $('#lcd-text');
  if (t && lcdAnimHandler) { t.removeEventListener('animationend', lcdAnimHandler); lcdAnimHandler = null; }
  if (t) t.style.animation = '';
}

function clearLcdExt() { stopLcdScroll(); const el = $('#lcd-panel'); if (el) el.hidden = true; document.body.classList.remove('lcd-on'); }
async function applyLcdExt() {
  clearLcdExt();
  const c = ext.lcd; if (!c.enabled) return;
  const src = c.source;
  if (!src || !src.files || !src.files.length) { showError('LCD 已开启，但未选择 JSON 资源'); return; }
  try {
    const txt = await fetchJsonText(src.repo, src.branch, src.files[0].path);
    lcdLines = lcdToLines(JSON.parse(txt));
    if (!lcdLines.length) { showError('LCD JSON 无有效滚动内容'); return; }
    const el = $('#lcd-panel'); el.hidden = false;
    el.style.opacity = Math.max(0, Math.min(100, c.opacity || 90)) / 100;
    document.body.classList.add('lcd-on');
    startLcdScroll();
  } catch (e) { showError('LCD 加载失败：' + e.message); }
}

/* ---- 抽取学号 ---- */
let studentIds = [];      // 学号标签列表
let drawnIds = new Set();  // 已抽取的学号（自动排除）
function loadStudentIds() {
  studentIds = []; drawnIds = new Set();
  const c = ext.rollcall;
  renderDrawnList();
  if (!c.enabled || !c.source) return;
  (async () => {
    try {
      const txt = await fetchJsonText(c.source.repo, c.source.branch, c.source.files[0].path);
      const data = JSON.parse(txt);
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (Array.isArray(data.ids)) list = data.ids;
      else if (Array.isArray(data.names)) list = data.names;
      else if (Array.isArray(data.rows)) {
        const names = Array.isArray(data.names) ? data.names : [];
        let idx = 0;
        data.rows.forEach((row, r) => {
          const n = row.count || 0;
          for (let s = 1; s <= n; s++) { list.push(names[idx] || `第${r + 1}排-座${s}`); idx++; }
        });
      }
      studentIds = list.filter((x) => x != null).map((x) => String(x));
      drawnIds = new Set();
      renderDrawnList();
    } catch (e) { showError('学号 JSON 加载失败：' + e.message); }
  })();
}
function renderDrawnList() {
  const el = $('#rc-drawn-list'); if (!el) return;
  if (!studentIds.length) { el.innerHTML = ''; const c = $('#rc-drawn-count'); if (c) c.textContent = ''; return; }
  const c = $('#rc-drawn-count'); if (c) c.textContent = `已抽取 ${drawnIds.size} / ${studentIds.length}`;
  const drawn = [...drawnIds];
  el.innerHTML = drawn.length
    ? drawn.map((d) => `<span class="drawn-chip">${escapeHtml(d)}</span>`).join('')
    : '<span class="muted">尚未抽取</span>';
}
function doRollCall(cb) {
  if (!ext.rollcall.enabled || !studentIds.length) { if (cb) cb(); return; }
  const exclude = (ext.rollcall.exclude || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  let pool = studentIds.filter((s) => !drawnIds.has(s) && !exclude.includes(s));
  if (!pool.length) { // 全部抽完：开启新一轮
    drawnIds.clear(); renderDrawnList();
    pool = studentIds.filter((s) => !exclude.includes(s));
  }
  if (!pool.length) { if (cb) cb(); return; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  drawnIds.add(pick);
  const ov = $('#rollcall-overlay');
  const label = $('#rc-label'), roll = $('#rc-roll'), result = $('#rc-result'), nameEl = $('#rc-name'), sub = $('#rc-sub');
  ov.hidden = false;
  label.textContent = '🎲 抽取中…'; roll.hidden = false; roll.textContent = ''; result.hidden = true;
  let i = 0; const N = 18;
  const ticker = setInterval(() => {
    roll.textContent = pool[Math.floor(Math.random() * pool.length)];
    roll.classList.toggle('tick', i % 2 === 0);
    if (++i >= N) {
      clearInterval(ticker);
      roll.hidden = true; result.hidden = false;
      nameEl.textContent = pick; sub.textContent = `已抽取 ${drawnIds.size}/${studentIds.length}（不再重复）`;
      label.textContent = '🎲 本次抽到';
      renderDrawnList();
    }
  }, 70);
  setTimeout(() => { ov.hidden = true; if (cb) cb(); }, 1900 + N * 70);
}

/* ---- 自动化答题 ---- */
let autoSelectTimer = null, autoNextTimer = null;
function clearAuto() {
  if (autoSelectTimer) { clearTimeout(autoSelectTimer); autoSelectTimer = null; }
  if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
}
function scheduleAuto() {
  clearAuto();
  if (!ext.autoanswer.enabled || submitted) return;
  const a = Math.max(1, ext.autoanswer.answer) * 1000;
  // 到点自动批改：若未作答则先选正确答案，再批改（批改内会安排 N 秒后下一题）
  autoSelectTimer = setTimeout(() => {
    if (submitted || graded[current]) return;
    if (answers[current] === null) answers[current] = quiz.questions[current].answer;
    gradeCurrent();
  }, a);
}

/* ---- 进入下一题（含自动点名） ---- */
function goNext() {
  if (submitted) return;
  clearAuto(); // 防止手动翻页与自动计时重复触发
  doRollCall(() => {
    if (submitted) return;
    if (current < quiz.questions.length - 1) {
      current++; renderQuestion(); scheduleAuto();
    } else {
      submitQuiz();
    }
  });
}

/* ---- 应用 / 清理扩展 ---- */
async function applyExtensionsOnStart() {
  applyBgExt();
  applyMusicExt();
  await applyLcdExt();
  await loadStudentIds();
}
function teardownExtensions() {
  clearBgExt(); clearMusicExt(); clearLcdExt(); clearAuto();
}

/* ===================== GitHub 资源选择器（扩展用） ===================== */
const asset = { repo: '', owner: '', branch: '', path: [], selected: null, selectedName: '', folderChosen: false, allowFolder: false, allowedExt: [], onConfirm: null, title: '' };

function openAssetPicker(key, opts) {
  asset.repo = ''; asset.owner = ''; asset.branch = ''; asset.path = [];
  asset.selected = null; asset.selectedName = ''; asset.folderChosen = false;
  asset.allowFolder = !!opts.allowFolder;
  asset.allowedExt = opts.allowedExt || [];
  asset.onConfirm = opts.onConfirm;
  $('#asset-title').textContent = opts.title || '选择资源';
  $('#asset-browse').hidden = true;
  $('#asset-error').hidden = true;
  $('#asset-token').value = ''; $('#asset-repo').value = '';
  $('#asset-confirm').disabled = true;
  $('#asset-pick-folder').style.display = asset.allowFolder ? '' : 'none';
  $('#asset-modal').hidden = false;
  // 若已设置全局仓库：自动填好并列出全部文件（走缓存，不重复请求）
  if (globalRepo.repo) {
    asset.repo = globalRepo.repo; asset.owner = globalRepo.repo.split('/')[0];
    $('#asset-repo').value = globalRepo.repo;
    $('#asset-token').value = globalRepo.token || '';
    (async () => {
      try {
        await assetLoadBranches(globalRepo.branch || '');
        if (globalRepo.branch && $('#asset-branch').querySelector(`option[value="${CSS.escape(globalRepo.branch)}"]`)) {
          $('#asset-branch').value = globalRepo.branch; asset.branch = globalRepo.branch;
        } else { asset.branch = $('#asset-branch').value; }
        $('#asset-browse').hidden = false;
        await assetListAll();
      } catch (e) { assetError(e.message); }
    })();
  }
}
function closeAssetPicker() { $('#asset-modal').hidden = true; asset.onConfirm = null; }
function assetError(m) { const e = $('#asset-error'); e.textContent = '⚠️ ' + m; e.hidden = false; }
function matchExt(name) {
  if (!asset.allowedExt.length) return true;
  const l = name.toLowerCase();
  return asset.allowedExt.some((x) => l.endsWith(x));
}
async function assetConnect() {
  const repoStr = $('#asset-repo').value.trim();
  const tok = $('#asset-token').value.trim();
  if (tok) { localStorage.setItem('gh_token', tok); ghTokenApproved = true; }
  const parts = repoStr.split('/').filter(Boolean);
  if (parts.length < 2) { assetError('请填写 owner/repo，例如 lichenyu27/try'); return; }
  asset.owner = parts[0]; asset.repo = parts.slice(0, 2).join('/');
  $('#asset-error').hidden = true;
  const btn = $('#asset-connect'); btn.disabled = true; btn.textContent = '连接中…';
  try {
    await assetLoadBranches('');
    await assetLoadFiles();
    $('#asset-browse').hidden = false;
  } catch (e) { assetError(e.message); }
  finally { btn.disabled = false; btn.textContent = '连接'; }
}
async function assetLoadBranches(def) {
  const data = await ghApi(`/repos/${asset.repo}/branches`, { per_page: 100 });
  const sel = $('#asset-branch'); sel.innerHTML = '';
  (Array.isArray(data) ? data : []).forEach((b) => {
    const o = document.createElement('option'); o.value = b.name; o.textContent = b.name; sel.appendChild(o);
  });
  if (def && sel.querySelector(`option[value="${CSS.escape(def)}"]`)) sel.value = def;
  if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
  asset.branch = sel.value;
}
async function assetLoadFiles() {
  const p = asset.path.join('/');
  const data = await ghApi(`/repos/${asset.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { ref: asset.branch });
  const items = Array.isArray(data) ? data : [data];
  const dirs = items.filter((i) => i.type === 'dir').map((i) => ({ name: i.name, path: i.path, type: 'dir' }));
  const files = items.filter((i) => i.type === 'file' && matchExt(i.name)).map((i) => ({ name: i.name, path: i.path, type: 'file' }));
  assetRenderBreadcrumb();
  assetRenderTree([...dirs, ...files]);
  asset.selected = null; asset.selectedName = ''; asset.folderChosen = false;
  $('#asset-confirm').disabled = true;
}
function assetRenderBreadcrumb() {
  const bc = $('#asset-path'); bc.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb'; root.textContent = '📁 ' + asset.repo;
  root.addEventListener('click', () => { asset.path = []; assetLoadFiles(); });
  bc.appendChild(root);
  asset.path.forEach((seg, i) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = ' / '; bc.appendChild(sep);
    const c = document.createElement('span'); c.className = 'crumb'; c.textContent = seg;
    c.addEventListener('click', () => { asset.path = asset.path.slice(0, i + 1); assetLoadFiles(); });
    bc.appendChild(c);
  });
}
function assetRenderTree(items) {
  const tree = $('#asset-tree'); tree.innerHTML = '';
  if (!items.length) { tree.innerHTML = '<div class="tree-empty">此目录无匹配文件</div>'; return; }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'tree-row ' + (it.type === 'dir' ? 'is-dir' : 'is-file');
    if (it.type !== 'dir' && asset.selected === it.path) row.classList.add('selected');
    const label = document.createElement('span'); label.className = 'tree-label';
    label.textContent = (it.type === 'dir' ? '📁 ' : '📄 ') + it.name;
    row.appendChild(label);
    if (it.type === 'dir') {
      row.addEventListener('click', () => { asset.path.push(it.name); assetLoadFiles(); });
    } else {
      row.addEventListener('click', () => {
        asset.selected = it.path; asset.selectedName = it.name; asset.folderChosen = false;
        assetRenderTree(items); $('#asset-confirm').disabled = false;
      });
    }
    tree.appendChild(row);
  });
}
/* 列出仓库内全部匹配文件，扁平展示（像选题库一样直接点选）；同仓库走缓存 */
async function assetListAll() {
  const tree = $('#asset-tree');
  tree.innerHTML = '<div class="tree-empty">正在列出全部文件…</div>';
  try {
    const files = await listAllRepoFiles(asset.repo, asset.branch, false);
    const filtered = files.filter((f) => matchExt(f.name));
    assetRenderFlat(filtered);
  } catch (e) { assetError(e.message); }
}
function assetRenderFlat(files) {
  const tree = $('#asset-tree'); tree.innerHTML = '';
  if (!files.length) { tree.innerHTML = '<div class="tree-empty">仓库中无匹配的文件（' + (asset.allowedExt.join('/') || '全部') + '）</div>'; return; }
  files.sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => {
    const row = document.createElement('div');
    row.className = 'tree-row is-file' + (asset.selected === f.path ? ' selected' : '');
    const label = document.createElement('span'); label.className = 'tree-label';
    label.textContent = '📄 ' + f.path;
    row.appendChild(label);
    row.addEventListener('click', () => {
      asset.selected = f.path; asset.selectedName = f.name; asset.folderChosen = false;
      assetRenderFlat(files); $('#asset-confirm').disabled = false;
    });
    tree.appendChild(row);
  });
}
async function assetConfirm() {
  if (!asset.selected && !asset.folderChosen) return;
  const cb = asset.onConfirm;
  try {
    let files;
    if (asset.folderChosen) {
      const p = asset.path.join('/');
      const data = await ghApi(`/repos/${asset.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { ref: asset.branch });
      const items = Array.isArray(data) ? data : [data];
      files = items.filter((i) => i.type === 'file' && matchExt(i.name)).map((i) => ({ path: i.path, name: i.name }));
      if (!files.length) { assetError('该文件夹下没有匹配的文件'); return; }
    } else {
      files = [{ path: asset.selected, name: asset.selectedName }];
    }
    const result = {
      repo: asset.repo, branch: asset.branch, isDir: asset.folderChosen, files,
      name: asset.folderChosen ? (asset.path.join('/') || '(根目录)') : asset.selectedName,
    };
    closeAssetPicker();
    if (cb) cb(result);
  } catch (e) { assetError(e.message); }
}

/* ===================== 事件绑定 ===================== */
function bindUI() {
  // tabs
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
      clearError();
    });
  });

  // GitHub 浏览
  $('#gh-direct-btn').addEventListener('click', loadByRef);
  $('#gh-direct').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadByRef(); });
  $('#gh-merge-btn').addEventListener('click', () => mergeJsonQuiz(gh.repo, gh.branch));
  $('#gh-browse-all').addEventListener('click', () => { resetGhPick(); enterBrowse(gh.repo, gh.branch, ''); });
  $('#gh-connect-btn').addEventListener('click', connectGithub);
  $('#gh-logout').addEventListener('click', logoutGithub);
  // 已保存令牌：先询问再使用 / 可删除
  $('#gh-use-token').addEventListener('click', () => {
    ghTokenApproved = true;
    $('#gh-saved').hidden = true;
    const input = $('#gh-token');
    if (input) input.value = storedGhToken();
    if (!$('#gh-browse').hidden) $('#gh-login').textContent = '已填令牌（可访问私有库）';
  });
  $('#gh-del-token').addEventListener('click', () => {
    localStorage.removeItem('gh_token');
    ghTokenApproved = false;
    const input = $('#gh-token');
    if (input) input.value = '';
    $('#gh-saved').hidden = true;
    clearError();
  });
  $('#gh-repo').addEventListener('change', onRepoChange);
  $('#gh-branch').addEventListener('change', () => { gh.branch = $('#gh-branch').value; loadFiles(); });
  $('#gh-load').addEventListener('click', readSelected);

  // 本地文件
  $('#file-load').addEventListener('click', () => {
    clearError();
    const file = $('#file-input').files[0];
    if (!file) { showError('请先选择一个 JSON 文件'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try { startQuiz(parseQuiz(reader.result)); }
      catch (e) { showError(e.message); }
    };
    reader.onerror = () => showError('文件读取失败');
    reader.readAsText(file);
  });

  // 粘贴
  $('#paste-load').addEventListener('click', () => {
    clearError();
    const text = $('#paste-input').value.trim();
    if (!text) { showError('请粘贴题库 JSON 内容'); return; }
    try { startQuiz(parseQuiz(text)); }
    catch (e) { showError(e.message); }
  });

  // 示例题库
  const loadSample = async () => {
    clearError();
    try {
      const res = await fetch('sample-quiz.json');
      if (!res.ok) throw new Error('找不到示例题库文件');
      startQuiz(parseQuiz(await res.text()));
    } catch (e) { showError(e.message); }
  };
  $('#gh-sample').addEventListener('click', loadSample);
  $('#file-sample').addEventListener('click', loadSample);

  // 答题导航
  $('#prev-btn').addEventListener('click', () => { if (current > 0) { current--; renderQuestion(); scheduleAuto(); } });
  $('#grade-btn').addEventListener('click', gradeCurrent);
  $('#next-btn').addEventListener('click', goNext);
  $('#submit-btn').addEventListener('click', submitQuiz);

  // 结果区
  $('#retry-btn').addEventListener('click', retry);
  $('#change-btn').addEventListener('click', resetToImport);

  /* ---- 扩展商店：开关 / 字段 ---- */
  $$('[data-ext-toggle]').forEach((t) => {
    t.addEventListener('change', () => {
      const key = t.dataset.extToggle;
      ext[key].enabled = t.checked;
      const body = $(`.ext-card[data-ext="${key}"] .ext-body`);
      if (body) body.hidden = !t.checked;
      saveExtState();
      if (key === 'bg') { if (t.checked) applyBgExt(); else clearBgExt(); }
      if (key === 'lcd') { if (t.checked) applyLcdExt(); else clearLcdExt(); }
      if (key === 'music') { if (t.checked) applyMusicExt(); else clearMusicExt(); }
    });
  });
  $$('[data-ext-field]').forEach((f) => {
    f.addEventListener('change', () => {
      const name = f.dataset.extField; const v = f.value;
      if (name === 'bg-mode') { ext.bg.mode = v; syncBgBlocks(); if (ext.bg.enabled) applyBgExt(); }
      else if (name === 'bg-color') { ext.bg.color = v; if (ext.bg.enabled && ext.bg.mode === 'color') applyBgExt(); }
      else if (name === 'bg-interactive') { ext.bg.interactive = $(`[data-ext-field="${name}"]`).checked; saveExtState(); if (ext.bg.enabled && ext.bg.mode === 'website') applyBgExt(); }
      else if (name === 'bg-website') { ext.bg.website = v.trim(); saveExtState(); }
      else if (name === 'music-mode') { ext.music.mode = v; if (ext.music.enabled) applyMusicExt(); }
      else if (name === 'lcd-speed') { ext.lcd.speed = parseInt(v, 10) || 7; const sl = $('[data-ext-val="lcd-speed"]'); if (sl) sl.textContent = ext.lcd.speed + ' 秒/轮'; if (ext.lcd.enabled) applyLcdExt(); }
      else if (name === 'lcd-opacity') { ext.lcd.opacity = parseInt(v, 10) || 90; const sl = $('[data-ext-val="lcd-opacity"]'); if (sl) sl.textContent = ext.lcd.opacity + '%'; if (ext.lcd.enabled) applyLcdExt(); }
      else if (name === 'rollcall-exclude') { ext.rollcall.exclude = v; }
      else if (name === 'autoanswer-answer') { ext.autoanswer.answer = parseInt(v, 10) || 15; }
      else if (name === 'autoanswer-next') { ext.autoanswer.next = parseInt(v, 10) || 5; }
      saveExtState();
    });
  });

  /* ---- 扩展商店：从仓库选择资源 ---- */
  const pickMap = {
    bg:       { title: '选择背景图片', allowFolder: true,  allowedExt: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], onConfirm: (r) => { ext.bg.source = r; updateSrcText('bg'); saveExtState(); if (ext.bg.enabled) applyBgExt(); } },
    music:    { title: '选择背景音乐', allowFolder: true,  allowedExt: ['.mp3', '.wav', '.ogg', '.m4a'],         onConfirm: (r) => { ext.music.source = r; updateSrcText('music'); saveExtState(); if (ext.music.enabled) applyMusicExt(); } },
    lcd:      { title: '选择 LCD 文本 JSON', allowFolder: false, allowedExt: ['.json'], onConfirm: (r) => { ext.lcd.source = r; updateSrcText('lcd'); saveExtState(); if (ext.lcd.enabled) applyLcdExt(); } },
    rollcall: { title: '选择学号 JSON', allowFolder: false, allowedExt: ['.json'], onConfirm: (r) => { ext.rollcall.source = r; updateSrcText('rollcall'); saveExtState(); loadStudentIds(); } },
    'bg-website': { title: '选择含网址的 JSON', allowFolder: false, allowedExt: ['.json'], onConfirm: (r) => { applyWebsiteFromJson(r.repo, r.branch, r.files[0].path, r.files[0].name); } },
  };
  $$('[data-ext-pick]').forEach((b) => {
    b.addEventListener('click', () => { const o = pickMap[b.dataset.extPick]; if (o) openAssetPicker(b.dataset.extPick, o); });
  });

  /* ---- 背景音乐条 ---- */
  $('#music-toggle').addEventListener('click', () => {
    if (!audioEl) return;
    if (audioEl.paused) { audioEl.play(); $('#music-toggle').textContent = '暂停'; }
    else { audioEl.pause(); $('#music-toggle').textContent = '播放'; }
  });
  $('#music-stop').addEventListener('click', clearMusicExt);

  /* ---- 全局仓库 ---- */
  $('#gr-connect').addEventListener('click', () => grConnect(false));
  $('#gr-refresh').addEventListener('click', () => grConnect(true));
  $('#gr-import').addEventListener('click', grImport);

  /* ---- 顶部：扩展商店浮层 / 展示模式 ---- */
  $('#open-ext-btn').addEventListener('click', () => { $('#ext-overlay').hidden = false; });
  $$('[data-ext-close]').forEach((el) => el.addEventListener('click', () => { $('#ext-overlay').hidden = true; }));
  $('#display-btn').addEventListener('click', toggleDisplayMode);
  $('#rc-draw-btn').addEventListener('click', () => doRollCall(null));
  $('[data-ext-apply="bg-website"]').addEventListener('click', () => {
    ext.bg.website = $('[data-ext-field="bg-website"]').value.trim();
    saveExtState();
    if (ext.bg.enabled) applyBgExt();
  });
  // 本地 JSON 文件上传网址（含 url / website / link 字段，或纯字符串网址）
  $('#bg-website-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const url = websiteUrlFromJson(await file.text());
      if (!url) { showError('该 JSON 未包含网址（需要 url / website / link 字段，或纯字符串网址）'); e.target.value = ''; return; }
      ext.bg.website = url;
      setExtField('bg-website', url);
      const src = $('[data-ext-src="bg-website"]'); if (src) src.textContent = file.name;
      saveExtState();
      if (ext.bg.enabled) applyBgExt();
    } catch (err) { showError('读取文件失败：' + err.message); }
  });

  /* ---- 资源选择器模态框 ---- */
  $$('[data-modal-close]').forEach((el) => el.addEventListener('click', closeAssetPicker));
  $('#asset-connect').addEventListener('click', assetConnect);
  $('#asset-repo').addEventListener('keydown', (e) => { if (e.key === 'Enter') assetConnect(); });
  $('#asset-branch').addEventListener('change', () => { asset.branch = $('#asset-branch').value; assetLoadFiles(); });
  $('#asset-pick-folder').addEventListener('click', () => { if (!asset.allowFolder) return; asset.folderChosen = true; asset.selected = null; $('#asset-confirm').disabled = false; });
  $('#asset-list-all').addEventListener('click', assetListAll);
  $('#asset-confirm').addEventListener('click', assetConfirm);
}

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  renderExtUI();     // 还原已保存的扩展配置
  renderGlobalRepoUI(); // 还原全局仓库设置与缓存状态
  checkStoredToken(); // 若本机存过令牌，先询问是否使用，默认不带令牌请求
  guardTopNavigation(); // 记录本站入口，便于被背景页跳出后返回恢复
  // 支持分享链接 ?repo=owner/repo[/path][@branch] 直接打开并加载题库
  const repoParam = new URLSearchParams(location.search).get('repo');
  if (repoParam) { $('#gh-direct').value = repoParam; loadByRef(); }
});
