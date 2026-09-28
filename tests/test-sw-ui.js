/**
 * test-sw-ui.js —— 「离线包下载不完整」告警条 + 「重新下载离线包」按钮 行为验证
 *
 * 背景：工程师新增了一处动态 DOM 告警（无新增静态标签、无新增 CSS、未改 bindEvents），
 * 静态断言（数 id、正则匹配）证不出它真的能用，所以这里自建最小 DOM，
 * 把 index.html 末尾的 PWA IIFE 抠出来在 vm 里真跑一遍，验证真实行为。
 *
 * 不修改 harness，不影响 run-tests.js 与 test-offline.js 的既有基线。
 *
 * 用法： node tests/test-sw-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'dist', 'index.html');

const results = [];
function ok(id, name, cond, detail) {
  results.push({ id, name, pass: !!cond, detail: detail || '' });
}
function eq(id, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(id, name, a === e, '期望 ' + e + ' / 实际 ' + a);
}

/* ---------------- 从 dist/index.html 抠出 PWA IIFE ---------------- */
const html = fs.readFileSync(HTML, 'utf8');
/* 静态结构断言只看「标签层」，必须先把内联 <script> 剥掉，
   否则 JS 字符串里的 id="btnSwRetry" 会被误判成静态标签。 */
const htmlTagsOnly = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const blockMatch = /\/\* 必须用相对路径[\s\S]*?(?=<\/script>)/.exec(html);
ok('U00', '能从 dist/index.html 中定位并抠出 PWA 注册/告警代码块', !!blockMatch);
const block = blockMatch ? blockMatch[0] : '';
if (!block) {
  console.log('无法继续：未找到 PWA 代码块');
  process.exit(1);
}

/* ---------------- 最小 DOM ---------------- */
function makeEl(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    style: {},
    className: '',
    children: [],
    parentNode: null,
    onclick: null,
    _text: '',
    _html: '',
    addEventListener() {}, removeEventListener() {},
    getAttribute() { return null; }, setAttribute() {},
    querySelector() { return null; },
    click() { if (typeof this.onclick === 'function') this.onclick(); }
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this.children.length = 0; this._html = ''; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this._text = String(v).replace(/<[^>]*>/g, '');
      this.children.length = 0;
      // 从片段里抽出 id，注册成子节点，让 getElementById 能找到动态按钮
      const re = /id=["']([^"']+)["']/g;
      let m;
      while ((m = re.exec(this._html)) !== null) {
        const child = makeEl('button', m[1]);
        child.parentNode = this;
        this.children.push(child);
      }
    }
  });
  el.appendChild = function (c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  };
  el.insertBefore = function (c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  };
  el.removeChild = function (c) {
    const i = this.children.indexOf(c);
    if (i !== -1) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  };
  return el;
}

function findById(node, id) {
  if (node.id === id) return node;
  for (let i = 0; i < node.children.length; i++) {
    const hit = findById(node.children[i], id);
    if (hit) return hit;
  }
  return null;
}

/**
 * 构造一次运行环境并执行 PWA 代码块。
 * @param {Object} opt 环境开关
 * @returns {Object} 可观测的运行结果
 */
function runBlock(opt) {
  const body = makeEl('body', 'body');
  const depWarn = makeEl('div', 'depWarn');
  body.appendChild(depWarn);

  const document = {
    body: body,
    createElement: function (t) { return makeEl(t); },
    getElementById: function (id) { return findById(body, id); },
    querySelector: function () { return null; },
    addEventListener: function () {}
  };

  const calls = { register: [], messages: [], update: 0, workerPost: [], toasts: [] };

  const reg = {
    active: { postMessage: function (m) { calls.workerPost.push(m); } },
    waiting: null,
    installing: null,
    update: function () { calls.update += 1; return Promise.resolve(); }
  };

  const navigator = opt.noServiceWorker ? {} : {
    serviceWorker: {
      addEventListener: function (type, fn) {
        if (type === 'message') calls.messageHandler = fn;
      },
      register: function (url, opts) {
        calls.register.push({ url: url, opts: opts });
        return Promise.resolve(reg);
      },
      ready: Promise.resolve(reg)
    }
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: document,
    window: null,
    setTimeout: function (fn, ms) { calls.timerMs = ms; return 0; },
    clearTimeout: function () {},
    Promise: Promise,
    Date: Date,
    toast: function (msg) { calls.toasts.push(msg); },
    location: { protocol: opt.protocol || 'https:', href: 'https://x.github.io/repo/index.html' },
    navigator: navigator
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function (type, fn) {
    if (type === 'load') calls.loadHandler = fn;
  };
  if (opt.noNavigator) delete sandbox.navigator;

  let threw = null;
  try {
    const ctx = vm.createContext(sandbox);
    vm.runInContext(block, ctx, { filename: 'index.html:pwa-block' });
    if (calls.loadHandler) calls.loadHandler();       // 模拟 window load
  } catch (e) {
    threw = e;
  }
  return { document: document, body: body, depWarn: depWarn, calls: calls, threw: threw };
}

async function main() {

/* ================= 1. 基本注册行为 ================= */
{
  const r = runBlock({});
  ok('U01', 'PWA 代码块在真实 DOM 环境下执行不抛异常', !r.threw,
    r.threw ? r.threw.message : '');
  eq('U02', 'SW 注册路径与 scope 均为相对路径', r.calls.register,
    [{ url: './sw.js', opts: { scope: './' } }]);
  ok('U03', '已注册 serviceWorker 的 message 监听', typeof r.calls.messageHandler === 'function');
}

/* ================= 2. 关键资源失败 → 告警条出现 ================= */
{
  const r = runBlock({});
  r.calls.messageHandler({
    data: { type: 'PRECACHE_FAILED', failed: ['vendor/tessdata/chi_sim.traineddata.gz'] }
  });
  const box = findById(r.body, 'swCacheWarn');
  ok('U10', '收到 PRECACHE_FAILED 后动态插入告警条 #swCacheWarn', !!box);
  ok('U11', '告警条文案包含失败的具体资源名',
    !!box && box.innerHTML.indexOf('chi_sim.traineddata.gz') !== -1,
    box ? box.textContent.slice(0, 60) : '无告警条');
  ok('U12', '告警条包含「重新下载离线包」按钮 #btnSwRetry',
    !!findById(r.body, 'btnSwRetry'));

  /* 关键回归：.dep-warn 在 CSS 里是 display:none，
     动态盒子必须靠内联 style.display='block' 才能被看见。 */
  ok('U13', '告警条用内联 style.display=block 覆盖了 .dep-warn 的 display:none（否则用户看不见）',
    !!box && box.style.display === 'block',
    box ? 'style.display=' + box.style.display : '无告警条');
  ok('U14', '告警条复用 .dep-warn 样式类（未新增 CSS）',
    !!box && box.className === 'dep-warn', box ? box.className : '无告警条');

  /* 位置：应插在 #depWarn 之前（页面顶部告警区），不是 append 到 body 末尾 */
  const idxBox = r.body.children.indexOf(box);
  const idxDep = r.body.children.indexOf(r.depWarn);
  ok('U15', '告警条插在 #depWarn 之前（顶部可见），而非追加到页面末尾',
    idxBox !== -1 && idxDep !== -1 && idxBox < idxDep,
    'box@' + idxBox + ' depWarn@' + idxDep);
}

/* ================= 3. 点击重试按钮的真实行为 ================= */
{
  const r = runBlock({});
  r.calls.messageHandler({
    data: { type: 'PRECACHE_FAILED', failed: ['vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'] }
  });
  const btn = findById(r.body, 'btnSwRetry');
  ok('U20', '告警条中的重试按钮存在', !!btn);
  const box0 = findById(r.body, 'swCacheWarn');
  ok('U21', '点击前告警条显示失败清单',
    !!box0 && box0.innerHTML.indexOf('tesseract-core-simd-lstm') !== -1);

  if (btn) btn.click();
  /* ready.then(...) 是微任务，必须让出一次事件循环才能观察到 postMessage / update。
     同步断言在这里必然为空 —— 这是测试写法问题，不是源码问题。 */
  await new Promise(function (resolve) { setImmediate(resolve); });

  const box1 = findById(r.body, 'swCacheWarn');
  ok('U22', '点击后立刻给出「正在重新下载」的反馈（不是按了没反应）',
    !!box1 && /正在重新下载离线包/.test(box1.textContent), box1 ? box1.textContent : '');
  eq('U23', '点击后向 active worker 发送 RELOAD_CACHE',
    r.calls.workerPost, [{ type: 'RELOAD_CACHE' }]);
  /* 关键资源失败会让 install 作废、新 SW 被丢弃，
     所以必须同时 reg.update() 才会重新触发 install —— 只 postMessage 是不够的。 */
  eq('U24', '点击后同时调用 reg.update() 以重新触发 install（否则永远补不上）',
    r.calls.update, 1);
  ok('U25', '设置了「ready 一直挂着」的兜底提示定时器',
    typeof r.calls.timerMs === 'number' && r.calls.timerMs > 0, 'ms=' + r.calls.timerMs);
}

/* ================= 4. 成功 → 告警消失 + toast ================= */
{
  const r = runBlock({});
  r.calls.messageHandler({ data: { type: 'PRECACHE_FAILED', failed: ['index.html'] } });
  ok('U30', '先造出告警条', !!findById(r.body, 'swCacheWarn'));
  r.calls.messageHandler({ data: { type: 'PRECACHE_OK', count: 12 } });
  ok('U31', '收到 PRECACHE_OK 后告警条被移除', !findById(r.body, 'swCacheWarn'));
  ok('U32', '收到 PRECACHE_OK 后给出 toast 提示',
    r.calls.toasts.length === 1 && /离线包已就绪/.test(r.calls.toasts[0]),
    JSON.stringify(r.calls.toasts));
}

/* ================= 5. 其它消息类型 / 降级路径 ================= */
{
  const r = runBlock({});
  r.calls.messageHandler({ data: { type: 'CACHE_INCOMPLETE', failed: ['vendor/xlsx.full.min.js'] } });
  ok('U40', 'CACHE_INCOMPLETE 也会触发告警条', !!findById(r.body, 'swCacheWarn'));
}
{
  const r = runBlock({});
  r.calls.messageHandler({ data: { type: 'CACHE_MISS_OFFLINE', failed: ['vendor/tessdata/chi_sim.traineddata.gz'] } });
  ok('U41', 'CACHE_MISS_OFFLINE 也会触发告警条', !!findById(r.body, 'swCacheWarn'));
}
{
  const r = runBlock({});
  r.calls.messageHandler({ data: { type: 'UNKNOWN_TYPE' } });
  ok('U42', '未知消息类型不误弹告警条', !findById(r.body, 'swCacheWarn'));
  r.calls.messageHandler({});
  ok('U43', '空消息体不抛异常也不误弹', !r.threw && !findById(r.body, 'swCacheWarn'),
    r.threw ? r.threw.message : '');
}
{
  const r = runBlock({ protocol: 'file:' });
  ok('U50', 'file:// 协议下不注册 SW（本地直接打开不报错）',
    !r.threw && r.calls.register.length === 0);
}
{
  const r = runBlock({ noServiceWorker: true });
  ok('U51', '浏览器不支持 serviceWorker 时静默降级、不抛异常',
    !r.threw && r.calls.register.length === 0, r.threw ? r.threw.message : '');
}
{
  const r = runBlock({ noNavigator: true });
  ok('U52', 'navigator 完全不存在（Node/老环境）时静默降级、不抛异常', !r.threw,
    r.threw ? r.threw.message : '');
}

/* ================= 6. 与既有断言的一致性（不能破坏 A01） ================= */
{
  ok('U60', '告警条为纯动态 DOM：静态 HTML 标签中不存在 id="swCacheWarn"',
    !/id=["']swCacheWarn["']/.test(htmlTagsOnly));
  ok('U61', '按钮为纯动态 DOM：静态 HTML 标签中不存在 id="btnSwRetry"',
    !/id=["']btnSwRetry["']/.test(htmlTagsOnly));
  eq('U62', '静态 HTML 中 .dep-warn 仍只有 1 处（#depWarn），未新增标签',
    (html.match(/class=["']dep-warn["']/g) || []).length, 1);
  ok('U63', '未新增 CSS 规则（.dep-warn 的 display:none 仍是唯一定义）',
    (html.match(/\.dep-warn\s*\{/g) || []).length === 1);
}

/* ================= 输出 ================= */
const pass = results.filter(function (r) { return r.pass; }).length;
const fail = results.filter(function (r) { return !r.pass; });
console.log('\n============ 离线包告警 UI 行为验证 ============');
results.forEach(function (r) {
  console.log((r.pass ? 'PASS ' : 'FAIL ') + r.id + ' | ' + r.name +
    (r.pass ? '' : '\n        >>> ' + r.detail));
});
console.log('\n------------------------------------------------');
console.log('通过率: ' + pass + '/' + results.length + ' PASS (' +
  (pass / results.length * 100).toFixed(1) + '%)');
if (fail.length) {
  console.log('\n失败项 (' + fail.length + '):');
  fail.forEach(function (r) {
    console.log('  - [' + r.id + '] ' + r.name + '\n      期望/实际: ' + r.detail);
  });
}
console.log('\nIS_PASS=' + (fail.length === 0 ? 'PASS' : 'FAIL'));
process.exitCode = (fail.length === 0 ? 0 : 1);
}

main();
