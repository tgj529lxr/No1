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
  fs.writeFileSync(OUT, html, 'utf8');

  const srcSize = fs.statSync(SRC).size;
  const outSize = fs.statSync(OUT).size;
  if (srcSize !== outSize) {
    console.error('[build] 复制后体积不一致：src=' + srcSize + ' dist=' + outSize);
    process.exit(1);
  }
  console.log('[build] src/index.html → dist/index.html (' + outSize + ' bytes)');

  // 关键产物存在性检查：离线 OCR 与 PWA 资源
  const required = [
    'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tessdata/chi_sim.traineddata.gz',
    'vendor/xlsx.full.min.js',
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
