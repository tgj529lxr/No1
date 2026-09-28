/**
 * harness.js —— 从 dist/index.html 抽取内联 JS，在 Node 的 vm 沙箱中运行，
 * 注入最小 DOM / localStorage / XLSX 桩，暴露纯逻辑 API 供测试调用。
 * 本文件不修改 index.html。
 *
 * 注意：默认被测对象始终是**构建产物** dist/index.html。
 * 仓库根目录过去遗留过一份旧版 index.html，导致「改了 src，测试却依然全绿」的假象，
 * 现已删除。若确需测其它文件，请用下面两种显式方式覆盖，不要改默认值。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');

/**
 * 被测 HTML 路径解析优先级：
 *   1. loadApp({ htmlPath }) / loadApp('path')  显式传参
 *   2. 环境变量 APP_HTML（相对路径以仓库根目录为基准）
 *   3. 默认：dist/index.html —— 构建产物，与线上 Pages / APK 内的文件完全一致。
 *      注意：修改 src/index.html 后必须先 `npm run build`，否则测试仍测旧产物。
 */
const DEFAULT_HTML_PATH = path.resolve(__dirname, '..', 'dist', 'index.html');

function resolveHtmlPath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.APP_HTML) {
    return path.isAbsolute(process.env.APP_HTML)
      ? process.env.APP_HTML
      : path.resolve(__dirname, '..', process.env.APP_HTML);
  }
  return DEFAULT_HTML_PATH;
}

/** 读取 index.html 中的内联 <script>（无 src 属性的那一个）。 */
function extractInlineScript(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/.test(m[1])) continue;   // 跳过 CDN 引入
    blocks.push({ attrs: m[1], code: m[2] });
  }
  if (blocks.length !== 1) {
    throw new Error('期望恰好 1 段内联 script，实际 ' + blocks.length + ' 段');
  }
  return blocks[0].code;
}

/** 制造一个够用的 DOM 元素桩。 */
function makeEl(id) {
  const el = {
    id: id || '',
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    files: null,
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {},
    removeEventListener() {},
    getAttribute() { return null; },
    setAttribute() {},
    appendChild() {},
    click() {},
    focus() {},
    closest() { return null; }
  };
  el.firstElementChild = { style: {} };
  return el;
}

/** 构建沙箱全局对象。 */
function createSandbox() {
  const elCache = new Map();
  const store = new Map();

  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    key(i) { return Array.from(store.keys())[i] || null; },
    get length() { return store.size; }
  };

  const document = {
    _els: elCache,
    querySelector(sel) {
      if (!elCache.has(sel)) elCache.set(sel, makeEl(sel));
      return elCache.get(sel);
    },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    addEventListener() {},
    getElementById(id) { return document.querySelector('#' + id); },
    body: makeEl('body')
  };

  const sandbox = {
    console,
    document,
    localStorage,
    XLSX,
    Tesseract: undefined,                 // 模拟 CDN 未加载
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, RegExp, Number, String, Array, Object, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function () {},
    confirm: () => true,
    alert: () => {},
    encodeURIComponent, decodeURIComponent
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.scrollTo = () => {};
  sandbox.window.print = () => {};

  return { sandbox, elCache, store, localStorage, document };
}

/** 加载 index.html 内联脚本并返回测试 API。 */
function loadApp(opts) {
  const HTML_PATH = resolveHtmlPath(typeof opts === 'string' ? opts : (opts && opts.htmlPath));
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const code = extractInlineScript(html);

  const { sandbox, elCache, store, localStorage, document } = createSandbox();

  // 追加导出尾缀：把 let/const 作用域内的函数与 state 暴露出来
  const exportNames = [
    'clone', 'defaultPeriods', 'defaultSchedule', 'defaultHolidays', 'defaultState',
    'pad2', 'fmtDate', 'parseDate', 'addDays', 'toDateTime', 'dayOfWeek', 'esc', 'toast',
    'parsePeriods', 'loadState', 'normalizeState', 'saveState', 'weekMarks',
    'weekMonday', 'weekDays', 'weekOfDate', 'currentWeek', 'holidayOf',
    'buildScheduleMap', 'periodInfo', 'hasClass',
    'findStudentIndex', 'computeAutoMarks', 'getMark', 'cycleMark',
    'renderWeekSelect', 'renderSheet',
    'normalizeText', 'grab', 'extractFields', 'parseLeaveRange', 'runOcr',
    'openConfirmForm', 'closeConfirmForm', 'saveLeaveFromForm', 'renderLeaves',
    'exportExcel', 'renderSettings', 'renderHolidayEditor', 'renderPeriodEditor',
    'renderScheduleEditor', 'deleteStudentRow', 'switchTab', 'bindEvents',
    'renderAll', 'init',
    'STORAGE_KEY', 'WEEKDAY_LABELS', 'SYMBOLS', 'SYMBOL_CLASS', 'SYMBOL_NAME', 'PERIOD_COUNT',
    '$', '$$'
  ];
  const epilogue =
    '\n;globalThis.__api = {' +
    exportNames.map(function (n) { return n + ': (typeof ' + n + ' !== "undefined") ? ' + n + ' : undefined'; }).join(', ') +
    ', _getState: function(){ return state; }' +
    ', _setState: function(v){ state = v; }' +
    '};\n';

  const ctx = vm.createContext(sandbox);
  vm.runInContext(code + epilogue, ctx, { filename: 'index.html:inline-script' });

  const api = sandbox.__api;
  if (!api) throw new Error('未能导出 __api，内联脚本执行异常');

  return { api, html, code, elCache, store, localStorage, document, sandbox, XLSX, htmlPath: HTML_PATH };
}

/** 便捷：读取某个选择器桩元素的内容。 */
function el(elCache, sel) {
  return elCache.get(sel);
}

module.exports = { loadApp, extractInlineScript, el, HTML_PATH: DEFAULT_HTML_PATH, resolveHtmlPath };
