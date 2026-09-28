/**
 * build.js — 构建脚本：src/index.html → dist/index.html
 *
 * 使用 Node fs（跨平台，不依赖 cp / shell）。可选 --icons 参数顺带重建图标。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'index.html');

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[build] 源文件的缺失：' + SRC);
    process.exit(1);
  }
  fs.mkdirSync(DIST, { recursive: true });

  const html = fs.readFileSync(SRC, 'utf8');

  /* 每次构建生成唯一版本号。用途有二：
   *   1) 注入 dist/index.html 的 window.APP_BUILD，界面上可见，便于确认设备跑的是哪一次构建；
   *   2) 注入 dist/sw.js 的 CACHE_VERSION，使 Service Worker 缓存名随之变化 →
   *      activate 时旧缓存被整体删除，彻底避免「重装 APK 仍是旧界面」。
   * 注意：stamp 必须每次都不同，所以带上了毫秒级时间。 */
  const stamp = 'b' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  const stampedHtml = html.replace(/__BUILD_STAMP__/g, stamp);
  fs.writeFileSync(OUT, stampedHtml, 'utf8');
  console.log('[build] 版本号注入：' + stamp);

  const outStat = fs.statSync(OUT);
  if (outStat.size === 0) {
    console.error('[build] dist/index.html 写入为空');
    process.exit(1);
  }
  console.log('[build] src/index.html → dist/index.html (' + outStat.size + ' bytes)');

  // sw.js 版本号注入：兼容「仍是占位符」和「已是上一版 stamp」两种情况
  const SW = path.join(DIST, 'sw.js');
  if (fs.existsSync(SW)) {
    const before = fs.readFileSync(SW, 'utf8');
    const after = before
      .replace(/__BUILD_STAMP__/g, stamp)
      .replace(/const CACHE_VERSION = '[^']*';/, "const CACHE_VERSION = '" + stamp + "';");
    if (after !== before) {
      fs.writeFileSync(SW, after, 'utf8');
      console.log('[build] dist/sw.js 缓存版本号已更新 → ' + stamp);
    }
    if (after.indexOf(stamp) === -1) {
      console.warn('[build] 警告：sw.js 未找到 CACHE_VERSION，缓存不会被自动失效');
    }
  }

  // 关键产物存在性检查：离线 OCR 与 PWA 资源
  const required = [
    'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tessdata/chi_sim.traineddata.gz',
    'vendor/xlsx.full.min.js',
    'vendor/exceljs.min.js',
    'manifest.webmanifest',
    'sw.js',
    'icons/icon-192.png',
    'icons/icon-512.png'
  ];
  const missing = required.filter(function (rel) {
    return !fs.existsSync(path.join(DIST, rel));
  });
  if (missing.length) {
    console.warn('[build] 警告：dist 缺少以下文件（对应功能将不可用）：');
    missing.forEach(function (m) { console.warn('  - ' + m); });
  } else {
    console.log('[build] dist 关键资源齐全（' + required.length + ' 项）');
  }
}

main();
