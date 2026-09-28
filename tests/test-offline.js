/**
 * test-offline.js —— 离线能力 / PWA / CI 配置 最终回归验证套件
 *
 * 只针对 dist/ 产物做「怀疑式」验证：
 *   A. 离线可用性：外链资源逐条落盘核对、sw precache 清单核对、tesseract 拼接规则模拟
 *   C. 新增内容正确性：manifest / sw.js / 图标 / 两个 workflow / package.json / capacitor
 *   D. 真实风险排查：缓存配额、零缓存断网首开、Pages 子路径、绝对路径隐患
 *
 * 用法： node tests/test-offline.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const results = [];
function ok(id, name, cond, detail) {
  results.push({ id, name, pass: !!cond, detail: detail || '' });
}
function eq(id, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(id, name, a === e, '期望 ' + e + ' / 实际 ' + a);
}
function sizeOf(rel) {
  try { return fs.statSync(path.join(DIST, rel)).size; } catch (e) { return -1; }
}
function existsFile(rel) {
  try { return fs.statSync(path.join(DIST, rel)).isFile(); } catch (e) { return false; }
}
function existsDir(rel) {
  try { return fs.statSync(path.join(DIST, rel)).isDirectory(); } catch (e) { return false; }
}

/* ================================================================
 * A. 离线可用性
 * ================================================================ */

const indexPath = path.join(DIST, 'index.html');
ok('A00', 'dist/index.html 存在且非空', existsFile('index.html') && sizeOf('index.html') > 0,
  'size=' + sizeOf('index.html'));
const html = existsFile('index.html') ? fs.readFileSync(indexPath, 'utf8') : '';

/* ---- A01~A0n：解析 HTML 引用的全部外部资源，逐条断言落盘 ---- */
const refs = [];
function pushRef(kind, raw) {
  if (!raw) return;
  if (/^(https?:|#|data:|javascript:|mailto:)/i.test(raw)) return;   // 远程/锚点/内联不参与离线核对
  refs.push({ kind: kind, raw: raw.replace(/^\.\//, '') });
}
{
  const tagRe = /<(script|link|img|source|audio|video|iframe)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src) pushRef(tag + '[src]', src[1]);
    if (href) pushRef(tag + '[href]', href[1]);
  }
  // 内联 <style> / style 属性里的 url()
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(html)) !== null) {
    const u = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    let n;
    while ((n = u.exec(m[1])) !== null) pushRef('css url()', n[1]);
  }
  // JS 里显式引用的 sw / manifest
  const swReg = /register\(\s*['"]([^'"]+)['"]/i.exec(html);
  if (swReg) pushRef('serviceWorker.register', swReg[1]);
}

eq('A01', 'dist/index.html 解析出的本地资源引用数量（应为 6：2 script + manifest + 2 icon + sw.js）',
  refs.length, 6);
ok('A01b', '资源引用清单可完整枚举', refs.length > 0,
  refs.map(function (r) { return r.kind + ' → ' + r.raw; }).join(' | '));

refs.forEach(function (r, i) {
  ok('A02.' + (i + 1), '资源存在且非空：' + r.kind + ' → ' + r.raw,
    existsFile(r.raw) && sizeOf(r.raw) > 0, 'size=' + sizeOf(r.raw));
});

/* ---- A10：剥离注释后不得残留任何 http(s) 外链资源引用 ---- */
{
  const noHtmlComment = html.replace(/<!--[\s\S]*?-->/g, '');
  // 属性型外链
  const attrRemote = noHtmlComment.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/gi) || [];
  ok('A10', '剥离 HTML 注释后无任何 http(s) 属性型外链（src/href）',
    attrRemote.length === 0, '残留: ' + attrRemote.join(', '));

  // 注释里的 URL 单独统计（允许存在，但必须可区分）
  const inComment = (html.match(/<!--[\s\S]*?-->/g) || [])
    .join('').match(/https?:\/\/[^\s"'<>]+/g) || [];
  ok('A10b', '（信息）注释中出现的 http(s) URL 仅作说明，不参与加载 —— 共 ' +
    inComment.length + ' 处', true, inComment.slice(0, 5).join(' | '));

  const anyRemote = noHtmlComment.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  ok('A10c', '剥离注释后正文中不存在任何 http(s) URL（含 JS 字符串）',
    anyRemote.length === 0, '残留: ' + anyRemote.slice(0, 6).join(', '));

  const cdn = /jsdelivr|unpkg\.com|cdnjs|cdn\.|googleapis/i.test(noHtmlComment);
  ok('A10d', '无 CDN 域名痕迹（jsdelivr / unpkg / cdnjs / googleapis）', !cdn);
}

/* ---- A20~A2n：sw.js precache 清单 vs 磁盘逐一对应 ---- */
const swText = existsFile('sw.js') ? fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8') : '';
const precache = (function () {
  const m = /const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/i.exec(swText);
  if (!m) return [];
  return (m[1].match(/['"]([^'"]+)['"]/g) || []).map(function (s) { return s.slice(1, -1); });
})();

ok('A20', 'sw.js 可解析出 PRECACHE_URLS 清单', precache.length > 0,
  precache.length + ' 项: ' + precache.join(', '));

precache.forEach(function (u, i) {
  const rel = u.replace(/^\.\//, '');
  if (rel === '' || rel === './' ) {
    ok('A21.' + (i + 1), 'precache 条目命中磁盘：' + u, existsFile('index.html'), '→ index.html');
    return;
  }
  ok('A21.' + (i + 1), 'precache 条目命中磁盘：' + u,
    existsFile(rel) && sizeOf(rel) > 0, 'size=' + sizeOf(rel));
});

/* 反向核对：磁盘上 dist 的每个文件（除 sw.js 自身）都应被 precache 覆盖 */
{
  const walk = function (dir, base) {
    let out = [];
    fs.readdirSync(dir).forEach(function (name) {
      const abs = path.join(dir, name);
      const rel = base ? base + '/' + name : name;
      if (fs.statSync(abs).isDirectory()) out = out.concat(walk(abs, rel));
      else out.push(rel);
    });
    return out;
  };
  const diskFiles = walk(DIST, '').filter(function (f) { return f !== 'sw.js'; });
  const covered = precache.map(function (u) { return u.replace(/^\.\//, '') || 'index.html'; });
  const notCovered = diskFiles.filter(function (f) { return covered.indexOf(f) === -1; });
  ok('A22', '磁盘 dist 文件全部被 precache 覆盖（共 ' + diskFiles.length + ' 个文件）',
    notCovered.length === 0, '未覆盖: ' + notCovered.join(', '));

  const ghost = covered.filter(function (c) { return diskFiles.indexOf(c) === -1; });
  ok('A23', 'precache 清单无「幽灵路径」（清单里有、磁盘上没有）',
    ghost.length === 0, '幽灵: ' + ghost.join(', '));
}

/* ---- A30~A3n：createWorker 三个路径参数真实存在 ---- */
const workerPath = (/workerPath:\s*['"]([^'"]+)['"]/i.exec(html) || [])[1] || '';
const corePath = (/corePath:\s*['"]([^'"]+)['"]/i.exec(html) || [])[1] || '';
const langPath = (/langPath:\s*['"]([^'"]+)['"]/i.exec(html) || [])[1] || '';

ok('A30', 'index.html 中显式声明 workerPath / corePath / langPath',
  !!workerPath && !!corePath && !!langPath,
  'workerPath=' + workerPath + ' corePath=' + corePath + ' langPath=' + langPath);
ok('A31', 'workerPath 指向的文件真实存在且非空',
  existsFile(workerPath) && sizeOf(workerPath) > 0, 'size=' + sizeOf(workerPath));
ok('A32', 'corePath 是一个真实目录', existsDir(corePath));
ok('A33', 'langPath 是一个真实目录', existsDir(langPath));
ok('A34', 'langPath 目录下存在 chi_sim.traineddata.gz 且非空',
  existsFile(langPath + '/chi_sim.traineddata.gz') &&
  sizeOf(langPath + '/chi_sim.traineddata.gz') > 0,
  'size=' + sizeOf(langPath + '/chi_sim.traineddata.gz'));

/* 模拟 tesseract 的拼接规则 */
eq('A35', "模拟 langPath 拼接规则 `${langPath}/chi_sim.traineddata.gz` 命中真实文件",
  true, existsFile(langPath + '/' + 'chi_sim' + '.traineddata.gz'));

/* corePath 拼接：tesseract.js 内部 corePath.replace(/\/$/,'') + '/tesseract-core-XXX-lstm.wasm.js' */
['tesseract-core-simd-lstm.wasm.js',
 'tesseract-core-relaxedsimd-lstm.wasm.js',
 'tesseract-core-lstm.wasm.js'].forEach(function (name, i) {
  const joined = corePath.replace(/\/$/, '') + '/' + name;
  ok('A36.' + (i + 1), '模拟 corePath 拼接命中：' + joined,
    existsFile(joined) && sizeOf(joined) > 1000000, 'size=' + sizeOf(joined));
});

/* ---- A40：tesseract.min.js 会把三个相对路径按 window.location 绝对化 ----
 * 证据：tesseract.min.js 内含 ["corePath","workerPath","langPath"].forEach(... new URL(t, window.location.href))
 * 若没有这层绝对化，worker 内 importScripts('vendor/...') 会相对 worker.min.js 解析而 404。 */
{
  const tess = existsFile('vendor/tesseract/tesseract.min.js')
    ? fs.readFileSync(path.join(DIST, 'vendor/tesseract/tesseract.min.js'), 'utf8') : '';
  ok('A40', 'tesseract.min.js 会对 corePath/workerPath/langPath 做 URL 绝对化（相对路径安全）',
    /new URL\([^)]*location\.href\)/.test(tess) &&
    /\["corePath","workerPath","langPath"\]/.test(tess),
    '未找到绝对化特征 → 相对路径会在 worker 内解析错误');
  // 实测模拟：以 Pages 子路径为 base 解析三个相对路径，映射回磁盘都存在
  const bases = ['https://u.github.io/repo/', 'https://u.github.io/repo/sub/'];
  let allHit = true;
  const miss = [];
  bases.forEach(function (base) {
    const absWorker = new global.URL(workerPath, base).href;
    const absCore = new global.URL(corePath, base).href;
    const absLang = new global.URL(langPath, base).href;
    if (!/\/vendor\/tesseract\/worker\.min\.js$/.test(absWorker)) { allHit = false; miss.push(absWorker); }
    if (!/\/vendor\/tesseract\/core$/.test(absCore)) { allHit = false; miss.push(absCore); }
    if (!/\/vendor\/tessdata$/.test(absLang)) { allHit = false; miss.push(absLang); }
  });
  ok('A41', '以 Pages 子路径为 base 模拟解析，三个路径均解析到 vendor 下正确位置', allHit,
    miss.join(', '));
}

/* ---- A50：gzip 默认值决定请求的文件名；必须是 .gz ---- */
{
  const workerJs = existsFile('vendor/tesseract/worker.min.js')
    ? fs.readFileSync(path.join(DIST, 'vendor/tesseract/worker.min.js'), 'utf8') : '';
  // 源码特征： b=a.gzip, w = void 0===b || b   → 缺省 true
  ok('A50', 'worker 中 gzip 选项缺省为 true（因此会请求 .traineddata.gz）',
    /void 0===b\|\|b/.test(workerJs) || /gzip:\s*!0/.test(workerJs),
    '未找到 gzip 缺省为 true 的特征');
  ok('A51', 'langPath 拼接后缀为 .traineddata.gz（与磁盘文件名一致）',
    /\.traineddata"\)\.concat\(w\?"\.gz":""\)/.test(workerJs),
    '未找到 .gz 后缀拼接逻辑');
  ok('A52', 'chi_sim.traineddata.gz 是合法 gzip 流（魔数 1f 8b）', (function () {
    try {
      const b = fs.readFileSync(path.join(DIST, 'vendor/tessdata/chi_sim.traineddata.gz'));
      return b[0] === 0x1f && b[1] === 0x8b;
    } catch (e) { return false; }
  })());
  ok('A53', 'chi_sim.traineddata.gz 可被真实解压（zlib 不报错）', (function () {
    try {
      const b = fs.readFileSync(path.join(DIST, 'vendor/tessdata/chi_sim.traineddata.gz'));
      const out = zlib.gunzipSync(b);
      return out.length > 1000000;
    } catch (e) { return false; }
  })(), '解压后应 >1MB');
}

/* ---- A60：wasm core 自包含（不依赖外部 .wasm 下载） ---- */
{
  const core = existsFile('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js')
    ? fs.readFileSync(path.join(DIST, 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'), 'utf8') : '';
  ok('A60', 'wasm core 为 JS 封装（含 WebAssembly 初始化，二进制内联）',
    /WebAssembly/.test(core) && sizeOf('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js') > 1000000,
    'size=' + sizeOf('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'));
  ok('A61', 'dist 下不存在需要单独下载的 .wasm 裸文件（避免 MIME/缓存坑）', (function () {
    const walk = function (dir, base) {
      let out = [];
      fs.readdirSync(dir).forEach(function (name) {
        const abs = path.join(dir, name);
        const rel = base ? base + '/' + name : name;
        if (fs.statSync(abs).isDirectory()) out = out.concat(walk(abs, rel));
        else out.push(rel);
      });
      return out;
    };
    return walk(DIST, '').filter(function (f) { return /\.wasm$/i.test(f); }).length === 0;
  })());
}

/* ---- A70：tesseract 版本与 LSTM-only OEM 组合 ---- */
{
  const tess = existsFile('vendor/tesseract/tesseract.min.js')
    ? fs.readFileSync(path.join(DIST, 'vendor/tesseract/tesseract.min.js'), 'utf8') : '';
  ok('A70', '内置 tesseract.js 主版本为 7.x', /"7\.\d+\.\d+"/.test(tess), '版本串未匹配');
  ok('A71', 'createWorker 使用 OEM=1（LSTM_ONLY）→ 只会请求 -lstm 变体 core',
    /createWorker\(\s*['"]chi_sim['"]\s*,\s*1\s*,/.test(html));
}

/* ================================================================
 * C. 新增内容正确性
 * ================================================================ */

/* ---- C10：manifest ---- */
{
  let mf = null, err = '';
  try { mf = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8')); }
  catch (e) { err = e.message; }
  ok('C10', 'manifest.webmanifest 是合法 JSON', !!mf, err);
  if (mf) {
    ok('C11', 'start_url 为相对路径（适配 Pages 子路径，不以 / 或 http 开头）',
      typeof mf.start_url === 'string' && !/^([/]|https?:)/.test(mf.start_url),
      'start_url=' + mf.start_url);
    ok('C12', 'scope 为相对路径', typeof mf.scope === 'string' && !/^([/]|https?:)/.test(mf.scope),
      'scope=' + mf.scope);
    eq('C13', 'display = standalone', mf.display, 'standalone');
    ok('C14', 'manifest 含 name / short_name', !!mf.name && !!mf.short_name);
    ok('C15', 'icons 至少 2 项', Array.isArray(mf.icons) && mf.icons.length >= 2,
      'count=' + (mf.icons || []).length);
    (mf.icons || []).forEach(function (ic, i) {
      ok('C16.' + (i + 1), 'icon src 指向的文件存在：' + ic.src,
        existsFile(ic.src) && sizeOf(ic.src) > 0, 'size=' + sizeOf(ic.src));
      // sizes 声明必须和 PNG 真实尺寸一致
      const png = existsFile(ic.src) ? fs.readFileSync(path.join(DIST, ic.src)) : null;
      const real = png ? (png.readUInt32BE(16) + 'x' + png.readUInt32BE(20)) : 'N/A';
      eq('C17.' + (i + 1), 'icon sizes 声明与 PNG 真实尺寸一致：' + ic.src, real, ic.sizes);
    });
    ok('C18', 'icons 全部使用相对路径（无 / 开头）',
      (mf.icons || []).every(function (ic) { return !/^([/]|https?:)/.test(ic.src); }),
      (mf.icons || []).map(function (i) { return i.src; }).join(', '));
  }
}

/* ---- C20：sw.js ---- */
{
  ok('C20', 'sw.js 存在且非空', existsFile('sw.js') && sizeOf('sw.js') > 0, 'size=' + sizeOf('sw.js'));
  let err = '';
  try { execFileSync(process.execPath, ['--check', path.join(DIST, 'sw.js')], { stdio: 'pipe' }); }
  catch (e) { err = (e.stderr || '').toString().trim(); }
  ok('C21', 'sw.js 通过 node --check 语法校验', !err, err);

  ok('C22', 'sw.js 含 install 预缓存逻辑', /addEventListener\(\s*['"]install['"]/.test(swText));
  ok('C23', 'sw.js 含 skipWaiting', /skipWaiting\s*\(/.test(swText));
  ok('C24', 'sw.js 含 clients.claim', /clients\.claim\s*\(/.test(swText));
  ok('C25', 'sw.js 对导航请求有离线兜底（navigate → index.html）',
    /mode\s*===\s*['"]navigate['"]/.test(swText) &&
    /caches\.match\(\s*['"]\.\/index\.html['"]\s*\)/.test(swText));
  ok('C26', 'sw.js 使用相对路径（兼容 Pages 子路径），无绝对路径',
    !/['"]\/[A-Za-z0-9]/.test(swText.replace(/\/\*[\s\S]*?\*\//g, '')),
    '发现疑似绝对路径');
  ok('C27', 'sw.js activate 会清理旧版本缓存',
    /addEventListener\(\s*['"]activate['"]/.test(swText) && /caches\.delete/.test(swText));

  const need = ['index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
    'vendor/xlsx.full.min.js', 'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tessdata/chi_sim.traineddata.gz'];
  const flat = precache.map(function (u) { return u.replace(/^\.\//, ''); }).join('|');
  const missing = need.filter(function (n) { return flat.indexOf(n) === -1; });
  ok('C28', 'precache 覆盖 11 项关键离线资源（index/manifest/2图标/xlsx/tesseract/worker/3 wasm/chi_sim）',
    missing.length === 0, '缺失: ' + missing.join(', '));
}

/* ---- C30：PNG 图标字节级校验 ---- */
{
  const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
    return t;
  })();
  const crc32 = function (b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  [['icons/icon-192.png', 192], ['icons/icon-512.png', 512]].forEach(function (pair, i) {
    const rel = pair[0], want = pair[1];
    if (!existsFile(rel)) { ok('C31.' + (i + 1), rel + ' 存在', false); return; }
    const b = fs.readFileSync(path.join(DIST, rel));
    const sigOk = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    // 逐 chunk 校验 CRC
    let off = 8, bad = [], idat = [], sawIend = false;
    while (off + 8 <= b.length) {
      const len = b.readUInt32BE(off);
      const type = b.slice(off + 4, off + 8).toString('ascii');
      const data = b.slice(off + 8, off + 8 + len);
      const stored = b.readUInt32BE(off + 8 + len);
      if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== stored) bad.push(type);
      if (type === 'IDAT') idat.push(data);
      off += 12 + len;
      if (type === 'IEND') { sawIend = true; break; }
    }
    let inflateOk = false;
    try {
      const raw = zlib.inflateSync(Buffer.concat(idat));
      inflateOk = raw.length === (w * 4 + 1) * h;
    } catch (e) { inflateOk = false; }
    ok('C31.' + (i + 1), rel + ' 是合法 PNG：签名/尺寸 ' + want + 'x' + want + '/CRC/可解压',
      sigOk && w === want && h === want && bad.length === 0 && inflateOk && sawIend,
      'sig=' + sigOk + ' w=' + w + ' h=' + h + ' badCRC=' + (bad.join(',') || 'none') + ' inflateOk=' + inflateOk + ' IEND=' + sawIend);
  });
}

/* ---- C40：workflow YAML 真实解析 ---- */
function parseYaml(text) {
  const lines = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach(function (line, i) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    lines.push({ indent: line.length - line.trimStart().length, text: t, no: i + 1 });
  });
  let idx = 0;
  const scalar = function (s) {
    s = s.trim();
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
    return s;
  };
  const isKey = function (s) { return /^[A-Za-z0-9_.$-]+:(\s|$)/.test(s); };
  const isItem = function (s) { return s === '-' || s.startsWith('- '); };
  function consumeBlockScalar(indent) {
    const out = [];
    while (idx < lines.length && lines[idx].indent > indent) { out.push(lines[idx].text); idx++; }
    return out.join('\n');
  }
  function setFromKey(m, key, val) {
    val = (val || '').trim();
    if (/^[|>][-+]?$/.test(val)) { m[key] = consumeBlockScalar(arguments[3]); return; }
    if (val === '') {
      const nxt = lines[idx];
      if (nxt && nxt.indent > arguments[3] && (isItem(nxt.text) || isKey(nxt.text))) {
        m[key] = parseNode(nxt.indent);
      } else { m[key] = null; }
      return;
    }
    m[key] = scalar(val);
  }
  function parseMap(indent) {
    const m = {};
    while (idx < lines.length) {
      const l = lines[idx];
      if (l.indent !== indent || isItem(l.text)) break;
      const c = l.text.indexOf(':');
      if (c < 0) { idx++; continue; }
      const key = l.text.slice(0, c).trim();
      const val = l.text.slice(c + 1);
      idx++;
      setFromKey(m, key, val, indent);
    }
    return m;
  }
  function parseSeq(indent) {
    const arr = [];
    while (idx < lines.length) {
      const l = lines[idx];
      if (l.indent !== indent || !isItem(l.text)) break;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      idx++;
      if (rest === '') {
        arr.push((lines[idx] && lines[idx].indent > indent) ? parseNode(lines[idx].indent) : null);
        continue;
      }
      const km = /^([A-Za-z0-9_.$-]+):(\s*)([\s\S]*)$/.exec(rest);
      if (km) {
        const childIndent = indent + 2;
        const m = {};
        setFromKey(m, km[1], km[3], childIndent);
        while (idx < lines.length && lines[idx].indent === childIndent && !isItem(lines[idx].text)) {
          const l2 = lines[idx];
          const c2 = l2.text.indexOf(':');
          const k2 = l2.text.slice(0, c2).trim();
          const v2 = l2.text.slice(c2 + 1);
          idx++;
          setFromKey(m, k2, v2, childIndent);
        }
        arr.push(m);
      } else {
        arr.push(scalar(rest));
      }
    }
    return arr;
  }
  function parseNode(indent) {
    if (idx >= lines.length) return null;
    if (isItem(lines[idx].text)) return parseSeq(lines[idx].indent);
    return parseMap(lines[idx].indent);
  }
  return parseNode(0);
}

function stepsOfJob(job) {
  return (job && Array.isArray(job.steps)) ? job.steps : [];
}
function findStep(job, usesPrefix) {
  return stepsOfJob(job).find(function (s) {
    return s && typeof s.uses === 'string' && s.uses.indexOf(usesPrefix) === 0;
  });
}

const WF_DIR = path.join(ROOT, '.github', 'workflows');
let apk = null, pages = null;
let apkErr = '', pagesErr = '';
try { apk = parseYaml(fs.readFileSync(path.join(WF_DIR, 'build-apk.yml'), 'utf8')); }
catch (e) { apkErr = e.message; }
try { pages = parseYaml(fs.readFileSync(path.join(WF_DIR, 'deploy-pages.yml'), 'utf8')); }
catch (e) { pagesErr = e.message; }

ok('C40', 'build-apk.yml 可被解析为结构化对象', !!apk && !!apk.jobs, apkErr);
ok('C41', 'deploy-pages.yml 可被解析为结构化对象', !!pages && !!pages.jobs, pagesErr);

if (apk && apk.jobs) {
  const job = apk.jobs['build-apk'];
  ok('C42', 'build-apk 存在 build-apk job 且 runs-on=ubuntu-latest',
    !!job && job['runs-on'] === 'ubuntu-latest', 'runs-on=' + (job && job['runs-on']));
  const j = findStep(job, 'actions/setup-java@');
  ok('C43', '使用 actions/setup-java 且 distribution=temurin / java-version=17',
    !!j && j.with && j.with.distribution === 'temurin' && String(j.with['java-version']) === '17',
    j ? JSON.stringify(j.with) : '未找到 setup-java');
  const co = findStep(job, 'actions/checkout@');
  ok('C44', '含 actions/checkout', !!co);
  const sa = findStep(job, 'android-actions/setup-android@');
  ok('C45', '含 android-actions/setup-android', !!sa);
  const ua = findStep(job, 'actions/upload-artifact@');
  ok('C46', '含 actions/upload-artifact 且 path 指向 APK 产物',
    !!ua && ua.with && /attendance-helper-debug\.apk$/.test(String(ua.with.path)),
    ua ? JSON.stringify(ua.with) : '未找到');

  const allSteps = stepsOfJob(job);
  const addStep = allSteps.find(function (s) { return s && /cap add android/.test(String(s.run || '')); });
  const addIdem = !!addStep && /if\s+\[\s*-d\s+android\s+\]/.test(String(addStep.run)) &&
    /\bnpx cap add android\b/.test(String(addStep.run));
  ok('C47', 'cap add android 幂等（先判断 android/ 目录是否存在）', addIdem,
    addIdem ? '' : (addStep ? '存在 cap add 但缺少幂等判断' : '未找到 cap add android 步骤'));

  const camStep = allSteps.find(function (s) {
    return s && /android\.permission\.CAMERA/.test(String(s.run || ''));
  });
  const camIdem = !!camStep && /grep\s+-q\s+['"]android\.permission\.CAMERA['"]/.test(String(camStep.run)) &&
    /exit\s+0/.test(String(camStep.run));
  ok('C48', '相机权限注入幂等（grep -q CAMERA 命中即跳过）', camIdem,
    camIdem ? '' : (camStep ? '缺少判重逻辑' : '未找到权限注入步骤'));

  const syncStep = allSteps.find(function (s) { return s && /cap sync/.test(String(s.run || '')); });
  ok('C49', '含 npx cap sync android', !!syncStep && /npx cap sync android/.test(String(syncStep.run)));
  ok('C50', 'build-apk permissions 含 contents: read',
    !!apk.permissions && apk.permissions['contents'] === 'read',
    JSON.stringify(apk.permissions));
  const gradle = allSteps.find(function (s) { return s && /gradlew assembleDebug/.test(String(s.run || '')); });
  ok('C51', '含 ./gradlew assembleDebug 编译步骤', !!gradle);
  ok('C52', 'npm 安装显式指定官方源 registry.npmjs.org',
    /registry=https:\/\/registry\.npmjs\.org/.test(
      allSteps.map(function (s) { return String(s.run || ''); }).join('\n')));
}

if (pages && pages.jobs) {
  const build = pages.jobs['build'];
  const deploy = pages.jobs['deploy'];
  ok('C60', 'deploy-pages 含 build / deploy 两个 job', !!build && !!deploy);
  ok('C61', 'permissions 齐备：contents:read + pages:write + id-token:write',
    !!pages.permissions && pages.permissions['contents'] === 'read' &&
    pages.permissions['pages'] === 'write' && pages.permissions['id-token'] === 'write',
    JSON.stringify(pages.permissions));
  const up = findStep(build, 'actions/upload-pages-artifact@');
  ok('C62', 'upload-pages-artifact 的 path === dist',
    !!up && up.with && String(up.with.path) === 'dist', up ? JSON.stringify(up.with) : '未找到');
  const cp = findStep(build, 'actions/configure-pages@');
  ok('C63', '含 actions/configure-pages', !!cp);
  const dp = findStep(deploy, 'actions/deploy-pages@');
  ok('C64', 'deploy job 使用 actions/deploy-pages', !!dp);
  ok('C65', 'deploy job 声明 environment.name = github-pages',
    !!deploy && deploy.environment && deploy.environment.name === 'github-pages',
    JSON.stringify(deploy && deploy.environment));
  const buildStep = stepsOfJob(build).find(function (s) { return s && /npm run build/.test(String(s.run || '')); });
  ok('C66', 'build job 会执行 npm run build 产出 dist', !!buildStep);
  ok('C67', 'deploy job 依赖 build（needs）', !!deploy && deploy.needs === 'build',
    'needs=' + (deploy && deploy.needs));
}

/* ---- C70：package.json / capacitor.config.json / package-lock ---- */
{
  let pkg = null, cfg = null, perr = '', cerr = '';
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { perr = e.message; }
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8')); } catch (e) { cerr = e.message; }
  ok('C70', 'package.json 合法 JSON', !!pkg, perr);
  ok('C71', 'capacitor.config.json 合法 JSON', !!cfg, cerr);
  if (cfg) {
    eq('C72', 'capacitor appId = cn.edu.gzmu.attendance', cfg.appId, 'cn.edu.gzmu.attendance');
    eq('C73', 'capacitor appName = 考勤助手', cfg.appName, '考勤助手');
    eq('C74', 'capacitor webDir = dist（打包的是离线产物）', cfg.webDir, 'dist');
  }
  if (pkg) {
    ok('C75', 'package.json 声明 @capacitor/core / cli / android 且版本 ^7.0.0', (function () {
      const d = pkg.devDependencies || {};
      return d['@capacitor/core'] === '^7.0.0' && d['@capacitor/cli'] === '^7.0.0' &&
        d['@capacitor/android'] === '^7.0.0';
    })(), JSON.stringify(pkg.devDependencies));
    ok('C76', 'package.json 含 build / sync 脚本',
      !!(pkg.scripts && pkg.scripts.build && pkg.scripts.sync), JSON.stringify(pkg.scripts));
    ok('C77', 'npm test 指向 tests/run-tests.js',
      !!(pkg.scripts && /tests\/run-tests\.js/.test(pkg.scripts.test || '')));
  }
  {
    let lock = null, lerr = '';
    try { lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')); } catch (e) { lerr = e.message; }
    ok('C78', 'package-lock.json 合法 JSON 且 lockfileVersion=3', !!lock && lock.lockfileVersion === 3, lerr);
    if (lock) {
      const txt = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
      const hosts = (txt.match(/"resolved":\s*"https?:\/\/([^/]+)/g) || [])
        .map(function (s) { return s.replace(/"resolved":\s*"https?:\/\//, '').split('/')[0]; });
      const uniq = Array.from(new Set(hosts));
      ok('C79', 'package-lock 全部 resolved 指向 registry.npmjs.org（无 npmmirror/taobao/cnpm 残留）',
        uniq.length > 0 && uniq.every(function (h) { return h === 'registry.npmjs.org'; }),
        '实际源: ' + uniq.join(', '));
      ok('C80', 'package-lock 中无 npmmirror / taobao / cnpm / 腾讯镜像 字样',
        !/npmmirror|registry\.npm\.taobao|cnpmjs|mirrors\.cloud\.tencent|mirrors\.aliyun/i.test(txt));
    }
  }
}

/* ================================================================
 * D. 真实风险排查
 * ================================================================ */

/* D10：缓存总量 */
let totalBytes = 0;
const precacheSizes = precache.map(function (u) {
  const rel = u.replace(/^\.\//, '') || 'index.html';
  const s = Math.max(0, sizeOf(rel));
  totalBytes += s;
  return { rel: rel, size: s };
});
const totalMB = (totalBytes / 1024 / 1024);
ok('D10', 'precache 总量在 iOS Safari 可接受区间（< 50MB）', totalMB < 50,
  totalMB.toFixed(2) + 'MB');
ok('D11', '（信息）precache 明细已统计', true,
  precacheSizes.map(function (p) { return p.rel + '=' + (p.size / 1024 / 1024).toFixed(2) + 'MB'; }).join(' | '));
{
  const wasmTotal = precacheSizes.filter(function (p) { return /wasm\.js$/.test(p.rel); })
    .reduce(function (a, b) { return a + b.size; }, 0) / 1024 / 1024;
  ok('D12', '（风险量化）3 个 wasm 变体合计 ' + wasmTotal.toFixed(2) + 'MB，占 precache ' +
    (wasmTotal / totalMB * 100).toFixed(1) + '%', true,
    '结论：不能裁剪。tesseract.js 的 core 加载器是「单次硬选择、无回退」，见 D13');
}
{
  /* 关键结论实测：tesseract.js v7 依据 simd / relaxedSimd 两个同步探测布尔值
     在 3 个 -lstm 变体中**只挑一个** importScripts，且没有 try/catch 回退。
     任一变体缺失 → importScripts 抛错 → "Failed to load TesseractCore" → OCR 完全不可用。
     因此「砍掉某个 wasm 变体省流量」是危险优化，必须禁止。 */
  const workerJs = fs.readFileSync(path.join(DIST, 'vendor/tesseract/worker.min.js'), 'utf8');
  const singleChoice = /relaxedsimd-lstm\.wasm\.js/.test(workerJs) &&
    /simd-lstm\.wasm\.js/.test(workerJs) &&
    /\/tesseract-core-lstm\.wasm\.js/.test(workerJs);
  const noFallback = /Failed to load TesseractCore/.test(workerJs);
  ok('D13', '实测确认：core 加载器为「三选一、无回退」，故 3 个 wasm 变体必须全部保留',
    singleChoice && noFallback,
    'singleChoice=' + singleChoice + ' noFallback=' + noFallback);
}

/* D20：零缓存断网首开 */
ok('D20', '（结论验证）sw.js 自身无法被预缓存 —— 必须先联网打开一次才能注册 SW',
  precache.indexOf('./sw.js') === -1 && precache.indexOf('sw.js') === -1,
  '这是 Service Worker 的固有约束，不是缺陷');
const readmeOk = (function () {
  try {
    const r = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    return /第一次打开时浏览器会把 OCR 引擎和数据缓存到本地/.test(r) &&
      /之后断网也能用|之后.*没信号/.test(r);
  } catch (e) { return false; }
})();
ok('D21', 'README 已明确告知「首次需联网、之后断网可用」', readmeOk,
  readmeOk ? '' : 'README 未说明首次联网要求');

/* D30：Pages 子路径 / 绝对路径隐患 */
{
  const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
  const absRefs = htmlNoComment.match(/(?:src|href)\s*=\s*["']\/[^"']*["']/gi) || [];
  ok('D30', 'index.html 无绝对路径资源引用（/xxx 在 Pages 子路径下会失效）',
    absRefs.length === 0, '绝对路径: ' + absRefs.join(', '));
  const mfTxt = existsFile('manifest.webmanifest') ? fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8') : '';
  ok('D31', 'manifest 中无绝对路径 src/start_url/scope',
    !/"(src|start_url|scope)"\s*:\s*"\//.test(mfTxt));
  ok('D32', 'sw.js 中无绝对路径（全部 ./ 相对）',
    !/['"]\/[A-Za-z0-9][^'"]*['"]/.test(swText.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('D33', 'index.html 注册 SW 使用相对路径 ./sw.js',
    /register\(\s*['"]\.\/sw\.js['"]/.test(html));
  ok('D34', '无混合内容隐患（页面本身无 http:// 资源引用）',
    !/(?:src|href)\s*=\s*["']http:\/\//i.test(htmlNoComment));
}

/* D40：iOS 拍照入口改造 */
{
  ok('D40', '存在「拍照」入口 #btnCam', /id=["']btnCam["']/.test(html));
  ok('D41', '存在「从相册」入口 #btnPick 与 #filePick',
    /id=["']btnPick["']/.test(html) && /id=["']filePick["']/.test(html));
  ok('D42', '相机 input 带 capture=environment（后置摄像头）',
    /id=["']fileCam["'][^>]*capture=["']environment["']/i.test(html) ||
    /capture=["']environment["'][^>]*id=["']fileCam["']/i.test(html));
  ok('D43', '相机 input 不再是 display:none（避免 iOS 直接弹相册的问题）',
    !/id=["']fileCam["'][^>]*style=["'][^"']*display\s*:\s*none/i.test(html));
  ok('D44', 'runOcr 的四段错误提示都存在（引擎未加载/加载失败/识别失败/过程异常/无文字）',
    /OCR 引擎未加载/.test(html) && /OCR 引擎\/模型加载失败/.test(html) &&
    /识别失败/.test(html) && /识别过程异常/.test(html) && /识别结束但未读到文字/.test(html));
  ok('D45', '存在 PSM 与预处理开关', /id=["']setPsm["']/.test(html) && /id=["']setPreproc["']/.test(html));
}

/* ================================================================
 * E. 预缓存失败策略加固（关键资源失败 → install 作废 + 可主动重下）
 * ================================================================ */
{
  ok('E00', 'sw.js 定义 OPTIONAL_URLS（图标等非关键资源）',
    /const\s+OPTIONAL_URLS\s*=/.test(swText));
  ok('E01', 'CRITICAL_URLS 由 PRECACHE_URLS 派生（filter），避免路径写两遍导致清单漂移',
    /CRITICAL_URLS\s*=\s*PRECACHE_URLS\.filter/.test(swText));

  const optionalRe = /const\s+OPTIONAL_URLS\s*=\s*\[([\s\S]*?)\]/i.exec(swText);
  const optional = optionalRe ? (optionalRe[1].match(/['"]([^'"]+)['"]/g) || [])
    .map(function (s) { return s.slice(1, -1); }) : [];
  eq('E02', '非关键资源恰好是 2 个图标',
    optional.map(function (u) { return u.replace(/^\.\//, ''); }).sort(),
    ['icons/icon-192.png', 'icons/icon-512.png']);

  const critical = precache.filter(function (u) { return optional.indexOf(u) === -1; });
  eq('E03', '关键资源数量 = 全部 12 项 - 2 个图标 = 10 项', critical.length, 10);
  ok('E04', '3 个 wasm 变体全部属于关键资源（不能划为可选，否则 D13 的三选一无回退会炸）',
    ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js',
      'tesseract-core-lstm.wasm.js'].every(function (n) {
      return critical.some(function (u) { return u.indexOf(n) !== -1; });
    }));
  ok('E05', 'chi_sim 语言包与 xlsx、首页均属于关键资源',
    critical.some(function (u) { return u.indexOf('chi_sim.traineddata.gz') !== -1; }) &&
    critical.some(function (u) { return u.indexOf('xlsx.full.min.js') !== -1; }) &&
    critical.some(function (u) { return /index\.html$|^\.\/$/.test(u); }));

  /* install 失败路径：必须「抛错让 install 作废」，而不是「照常 skipWaiting」 */
  const installRe = /addEventListener\(\s*['"]install['"][\s\S]*?\n\}\);/.exec(swText);
  /* 必须剥掉块注释再统计：注释里「不调用 skipWaiting」这句话本身含该词，会污染计数 */
  const installBody = installRe ? installRe[0].replace(/\/\*[\s\S]*?\*\//g, '') : '';
  ok('E06', '可定位 install 处理器', installBody.length > 0);
  ok('E07', '关键资源失败时抛出错误 → 本次 install 作废、新 SW 被丢弃',
    /throw new Error\(/.test(installBody));
  ok('E08', '失败路径先抛错、成功路径才 skipWaiting（源码顺序可见）',
    installBody.indexOf('throw new Error') !== -1 &&
    installBody.indexOf('skipWaiting') !== -1 &&
    installBody.indexOf('throw new Error') < installBody.indexOf('skipWaiting'),
    'throw@' + installBody.indexOf('throw new Error') + ' skipWaiting@' + installBody.indexOf('skipWaiting'));
  eq('E09', 'install 处理器内 skipWaiting 只出现 1 次（仅在成功分支）',
    (installBody.match(/skipWaiting/g) || []).length, 1);
  ok('E10', '失败时向页面广播 PRECACHE_FAILED（用户可见告警的数据来源）',
    /PRECACHE_FAILED/.test(installBody));

  /* 主动重下：RELOAD_CACHE */
  ok('E11', 'sw.js 处理 RELOAD_CACHE 消息并重跑预缓存',
    /type\s*===\s*['"]RELOAD_CACHE['"]/.test(swText) && /precacheInto/.test(swText));
  ok('E12', 'RELOAD_CACHE 会优先回执给发起页面（event.source.postMessage）',
    /event\.source\.postMessage/.test(swText));
  ok('E13', 'RELOAD_CACHE 成功/失败都会回执 PRECACHE_OK / PRECACHE_FAILED',
    /PRECACHE_OK/.test(swText) && /PRECACHE_FAILED/.test(swText));

  /* 兜底补缓存 */
  ok('E14', 'fetch 拿到网络响应后会补写缓存（关键资源失败再退回 cache.add 重抓）',
    /warmUpCache/.test(swText) && /cache\.add\(req\)/.test(swText));
  ok('E15', '离线且关键资源未命中时广播 CACHE_MISS_OFFLINE',
    /CACHE_MISS_OFFLINE/.test(swText));

  ok('E16', '（信息）CACHE_VERSION 仍为 v1 —— 刻意保留旧缓存兜底，未在发版时清空',
    /CACHE_VERSION\s*=\s*['"]v1['"]/.test(swText),
    '若需强制全网刷新缓存，应递增版本号并经 QA 复验');
}

/* ================================================================
 * 输出
 * ================================================================ */
const pass = results.filter(function (r) { return r.pass; }).length;
const fail = results.filter(function (r) { return !r.pass; });

console.log('\n================ 离线 / PWA / CI 回归验证 ================');
results.forEach(function (r) {
  console.log((r.pass ? 'PASS ' : 'FAIL ') + r.id + ' | ' + r.name +
    (r.detail ? '\n         · ' + r.detail : ''));
});
console.log('\n----------------------------------------------------------');
console.log('通过率: ' + pass + '/' + results.length + ' PASS (' +
  (pass / results.length * 100).toFixed(1) + '%)');
if (fail.length) {
  console.log('\n失败项 (' + fail.length + '):');
  fail.forEach(function (r) {
    console.log('  - [' + r.id + '] ' + r.name + '\n      期望/实际: ' + r.detail);
  });
}
console.log('\n[预缓存体积] ' + totalMB.toFixed(2) + 'MB / ' + precache.length + ' 项');
console.log('\nIS_PASS=' + (fail.length === 0 ? 'PASS' : 'FAIL'));
process.exit(fail.length === 0 ? 0 : 1);
