/**
 * test-sw-fallback.js —— sw.js「旧缓存兜底」行为验证
 *
 * 背景（QA 提出的 P2 refinement）：
 *   老用户缓存完整 → 我们发布新 sw.js → 用户弱网打开 → install 起跑 →
 *   某条资源下载中途失败。此时旧缓存其实是好的、离线完全可用，
 *   若直接判定「关键资源缺失」就会误报「离线包下载不完整」告警，
 *   还会诱导用户去重新下载 14MB。
 *
 * 本套件把 dist/sw.js 用 vm 真跑进沙箱，直接调用 precacheInto / install 处理器：
 *   F01~F02 源码结构（兜底逻辑必须写在 catch 分支里）
 *   F03~F06 单元行为：命中旧副本算成功 / 无副本仍算失败 / 统计正确 / match 抛错不崩
 *   F07~F08 端到端：install 在「add 全失败但旧缓存完好」时不抛错、照常 skipWaiting
 *                   且广播 PRECACHE_OK；反之（旧缓存也没有）才 PRECACHE_FAILED
 *
 * 用法： node tests/test-sw-fallback.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW_PATH = path.join(ROOT, 'dist', 'sw.js');
const swText = fs.readFileSync(SW_PATH, 'utf8');

const results = [];
function ok(id, name, cond, detail) {
  results.push({ id: id, name: name, pass: !!cond, detail: detail || '' });
}
function eq(id, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(id, name, a === e, '期望 ' + e + ' / 实际 ' + a);
}

/* ------------------------------------------------------------------
 * 沙箱：把 sw.js 跑起来，拿到内部函数与 install 处理器
 * ------------------------------------------------------------------ */

/** 最小 Request 替身：只保留 precacheInto 会用到的 url 字段。 */
function FakeRequest(url, init) {
  this.url = String(url);
  this.init = init || {};
}

/**
 * 构造可控的 Cache 替身。
 * @param {{failAdd: Array<string>, oldHit: Array<string>, matchThrows: boolean}} opts 行为编排
 * @returns {Object} Cache 替身
 */
function makeCache(opts) {
  return {
    add: function (req) {
      const url = req && req.url;
      if (opts.failAdd.indexOf(url) !== -1) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve();
    },
    match: function (url) {
      if (opts.matchThrows === true) {
        return Promise.reject(new Error('match boom'));
      }
      if (opts.oldHit.indexOf(String(url)) !== -1) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.resolve(undefined);
    },
    put: function () { return Promise.resolve(); }
  };
}

/**
 * 在 vm 沙箱中执行 sw.js，返回其内部函数与运行时状态。
 * @param {Object} cache Cache 替身
 * @returns {{api: Object, state: Object, listeners: Object}} 沙箱产物
 */
function loadSw(cache) {
  const state = { skipWaiting: 0, messages: [], logs: [] };
  const listeners = {};

  const self = {
    location: { href: 'https://example.com/attendance/', origin: 'https://example.com' },
    addEventListener: function (type, fn) { listeners[type] = fn; },
    skipWaiting: function () { state.skipWaiting += 1; },
    clients: {
      matchAll: function () {
        return Promise.resolve([
          { postMessage: function (m) { state.messages.push(m); } }
        ]);
      },
      claim: function () { return Promise.resolve(); }
    }
  };

  const silentConsole = {
    log: function () {},
    warn: function () {},
    error: function () {}
  };

  const ctx = vm.createContext({
    self: self,
    console: silentConsole,
    Request: FakeRequest,
    URL: URL,
    Promise: Promise,
    setTimeout: setTimeout,
    Response: function () {},
    caches: {
      open: function () { return Promise.resolve(cache); },
      keys: function () { return Promise.resolve([]); },
      match: function () { return Promise.resolve(undefined); },
      delete: function () { return Promise.resolve(true); }
    }
  });

  vm.runInContext(swText, ctx, { filename: 'dist/sw.js' });
  const api = vm.runInContext(
    '({' +
    'precacheInto: precacheInto,' +
    'isUsableResponse: isUsableResponse,' +
    'PRECACHE_URLS: PRECACHE_URLS,' +
    'CRITICAL_URLS: CRITICAL_URLS,' +
    'OPTIONAL_URLS: OPTIONAL_URLS' +
    '})',
    ctx
  );
  return { api: api, state: state, listeners: listeners };
}

/**
 * 触发一次真实 install：返回 { rejected, skipWaiting, messages }。
 * @param {Object} cache Cache 替身
 * @returns {Promise<{rejected: boolean, skipWaiting: number, messages: Array<Object>}>} 结果
 */
async function runInstall(cache) {
  const box = loadSw(cache);
  const waits = [];
  box.listeners.install({ waitUntil: function (p) { waits.push(p); } });
  let rejected = false;
  for (const p of waits) {
    try { await p; } catch (e) { rejected = true; }
  }
  return { rejected: rejected, skipWaiting: box.state.skipWaiting, messages: box.state.messages };
}

/* ------------------------------------------------------------------
 * F. 断言
 * ------------------------------------------------------------------ */

async function main() {
  const ALL = loadSw(makeCache({ failAdd: [], oldHit: [], matchThrows: false })).api.PRECACHE_URLS;
  const CRITICAL = loadSw(makeCache({ failAdd: [], oldHit: [], matchThrows: false })).api.CRITICAL_URLS;
  const CRITICAL_WASM = './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js';
  const CRITICAL_DATA = './vendor/tessdata/chi_sim.traineddata.gz';
  const ICON_192 = './icons/icon-192.png';

  /* ---- F01~F02：源码结构（兜底写在 catch 里，且位于失败分支之前） ---- */
  const precacheSrc = /function precacheInto[\s\S]*?\n\}/.exec(swText);
  const precacheBody = precacheSrc ? precacheSrc[0] : '';
  ok('F01', '可定位 precacheInto 源码', precacheBody.length > 0);
  ok('F02', '网络失败分支会先回查旧缓存：catch 中出现 cache.match(url)',
    /\.catch\([\s\S]*?cache\.match\(url\)/.test(precacheBody));

  /* ---- F03：add 全失败 + 旧缓存全命中 → 判定成功，不进 failedCritical ---- */
  {
    const cache = makeCache({ failAdd: ALL.slice(), oldHit: ALL.slice(), matchThrows: false });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F03', '全部走旧缓存兜底：okCount = 12（12 条资源）', r.okCount, ALL.length);
    eq('F04', '全部走旧缓存兜底：fromOldCount = 12', r.fromOldCount, ALL.length);
    eq('F05', '旧缓存完好时不产生关键资源失败（不再误报告警）', r.failedCritical, []);
    eq('F06', '旧缓存完好时不产生可选资源失败', r.failedOptional, []);
  }

  /* ---- F07~F09：add 失败 + 无旧副本 → 仍必须判失败（兜底不能吞掉真失败） ---- */
  {
    const cache = makeCache({ failAdd: [CRITICAL_DATA], oldHit: [], matchThrows: false });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F07', '关键资源既下载失败又无旧副本 → 仍列入 failedCritical',
      r.failedCritical, [CRITICAL_DATA]);
    eq('F08', '该场景 okCount = 11（12 - 1）', r.okCount, ALL.length - 1);
    eq('F09', '该场景 fromOldCount = 0', r.fromOldCount, 0);
  }

  /* ---- F10~F12：混合场景统计正确（图标走旧缓存，关键资源真失败） ---- */
  {
    const cache = makeCache({
      failAdd: [CRITICAL_DATA, './icons/icon-192.png', './icons/icon-512.png'],
      oldHit: ['./icons/icon-192.png', './icons/icon-512.png'],
      matchThrows: false
    });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F10', '混合场景：okCount = 11', r.okCount, ALL.length - 1);
    eq('F11', '混合场景：fromOldCount = 2（两个图标复用旧缓存）', r.fromOldCount, 2);
    eq('F12', '混合场景：只有真正缺失的关键资源被记为失败', r.failedCritical, [CRITICAL_DATA]);
    eq('F13', '混合场景：命中旧缓存的图标不算可选资源失败', r.failedOptional, []);
  }

  /* ---- F14~F15：cache.match 自身抛错时不得崩溃、且不得误判为成功 ---- */
  {
    const cache = makeCache({ failAdd: [CRITICAL_WASM], oldHit: [], matchThrows: true });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F14', 'cache.match 抛错时退化为「失败」，不误判成功',
      r.failedCritical, [CRITICAL_WASM]);
    ok('F15', 'cache.match 抛错不影响其余资源（总数仍可统计）',
      r.okCount === ALL.length - 1, 'okCount=' + r.okCount);
  }

  /* ---- F16~F19：isUsableResponse 判定边界 ---- */
  {
    const api = loadSw(makeCache({ failAdd: [], oldHit: [], matchThrows: false })).api;
    const f = api.isUsableResponse;
    ok('F16', 'isUsableResponse: 200 响应可用', f({ ok: true, status: 200 }) === true);
    ok('F17', 'isUsableResponse: status 0（opaque 响应）也算可用',
      f({ ok: false, status: 0 }) === true);
    ok('F18', 'isUsableResponse: 404 响应不可用', f({ ok: false, status: 404 }) === false);
    ok('F19', 'isUsableResponse: undefined / null 不可用',
      f(undefined) === false && f(null) === false);
  }

  /* ---- F20~F21：分类未被兜底逻辑污染 ---- */
  eq('F20', '关键资源仍为 10 项（12 - 2 图标）', CRITICAL.length, 10);
  ok('F21', '图标仍属于可选资源', CRITICAL.indexOf(ICON_192) === -1);

  /* ---- F22~F24：端到端 install —— 旧缓存完好时不得作废本次安装 ---- */
  {
    const cache = makeCache({ failAdd: ALL.slice(), oldHit: ALL.slice(), matchThrows: false });
    const out = await runInstall(cache);
    ok('F22', 'E2E：add 全失败但旧缓存完好 → install 不抛错（新 SW 正常接管）',
      out.rejected === false);
    eq('F23', 'E2E：该场景照常调用 skipWaiting 一次', out.skipWaiting, 1);
    eq('F24', 'E2E：广播 PRECACHE_OK 而非 PRECACHE_FAILED（用户不再看到误报告警）',
      out.messages.filter(function (m) { return m.type === 'PRECACHE_OK'; }).length, 1);
    eq('F25', 'E2E：未广播 PRECACHE_FAILED',
      out.messages.filter(function (m) { return m.type === 'PRECACHE_FAILED'; }).length, 0);
  }

  /* ---- F26~F28：端到端 install —— 旧缓存也缺失时才允许作废 ---- */
  {
    const cache = makeCache({ failAdd: [CRITICAL_DATA], oldHit: [], matchThrows: false });
    const out = await runInstall(cache);
    ok('F26', 'E2E：关键资源下载失败且无旧副本 → install 抛错作废（旧 SW 继续服役）',
      out.rejected === true);
    eq('F27', 'E2E：该场景不调用 skipWaiting', out.skipWaiting, 0);
    eq('F28', 'E2E：仍会广播 PRECACHE_FAILED（真失败必须让用户看见）',
      out.messages.filter(function (m) { return m.type === 'PRECACHE_FAILED'; }).length, 1);
  }

  /* ---- F29~F32：兜底不得反过来「削弱」真失败的检测（QA 补充） ----
     旧缓存兜底最危险的反面是：把「首次访问、压根没有旧副本」也判成成功，
     那样关键资源永远不会被发现缺失。这里把首次访问场景钉死。 */
  {
    const cache = makeCache({ failAdd: ALL.slice(), oldHit: [], matchThrows: false });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F29', '首次访问（零旧缓存）全失败 → 10 项关键资源全部记为失败，兜底不得吞掉',
      r.failedCritical.length, CRITICAL.length);
    eq('F30', '首次访问（零旧缓存）全失败 → 2 项可选资源记为失败',
      r.failedOptional.length, 2);
    eq('F31', '首次访问（零旧缓存）fromOldCount = 0（确实没有旧副本可复用）',
      r.fromOldCount, 0);

    const out = await runInstall(makeCache({ failAdd: ALL.slice(), oldHit: [], matchThrows: false }));
    ok('F32', 'E2E：首次访问零旧缓存 → install 仍作废（不能因为加了兜底就不报错）',
      out.rejected === true);
    eq('F33', 'E2E：首次访问零旧缓存 → 不调用 skipWaiting', out.skipWaiting, 0);
    eq('F34', 'E2E：首次访问零旧缓存 → 照常广播 PRECACHE_FAILED',
      out.messages.filter(function (m) { return m.type === 'PRECACHE_FAILED'; }).length, 1);
  }

  /* ---- F35~F36：部分命中旧副本时，未命中的关键资源仍须判失败 ---- */
  {
    const wasmOnly = ALL.filter(function (u) { return /wasm\.js$/.test(u); });
    const cache = makeCache({ failAdd: ALL.slice(), oldHit: wasmOnly, matchThrows: false });
    const api = loadSw(cache).api;
    const r = await api.precacheInto(cache);
    eq('F35', '只有 3 个 wasm 命中旧副本 → fromOldCount = 3', r.fromOldCount, wasmOnly.length);
    ok('F36', '未命中旧副本的 7 项关键资源仍全部记为失败',
      r.failedCritical.length === CRITICAL.length - wasmOnly.length,
      'failedCritical=' + r.failedCritical.length + ' 期望=' + (CRITICAL.length - wasmOnly.length));

    const out = await runInstall(makeCache({ failAdd: ALL.slice(), oldHit: wasmOnly, matchThrows: false }));
    ok('F37', 'E2E：部分命中旧缓存但仍有真缺失 → install 照样作废', out.rejected === true);
  }

  /* ---------- 输出 ---------- */
  const pass = results.filter(function (r) { return r.pass; }).length;
  const fail = results.filter(function (r) { return !r.pass; });

  console.log('\n============ sw.js 旧缓存兜底 行为验证 ============');
  results.forEach(function (r) {
    console.log((r.pass ? 'PASS ' : 'FAIL ') + r.id + ' | ' + r.name +
      (r.detail ? '\n         · ' + r.detail : ''));
  });
  console.log('\n----------------------------------------------------');
  console.log('通过率: ' + pass + '/' + results.length + ' PASS (' +
    (pass / results.length * 100).toFixed(1) + '%)');
  if (fail.length) {
    console.log('\n失败项 (' + fail.length + '):');
    fail.forEach(function (r) {
      console.log('  - [' + r.id + '] ' + r.name + '\n      期望/实际: ' + r.detail);
    });
  }
  console.log('\nIS_PASS=' + (fail.length === 0 ? 'PASS' : 'FAIL'));
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error('[test-sw-fallback] 运行异常：', err);
  process.exit(1);
});
