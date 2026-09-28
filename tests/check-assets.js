/**
 * check-assets.js —— 交付物自检：dist 资产完备性 + 体积断言 + 配置一致性
 *
 * 关注点：
 *   1. dist 下每个离线 OCR / Excel / PWA 资产必须存在且体积在合理区间（防止误删或上传了空文件）
 *   2. 单文件不得超过 GitHub 的 50MB 警告阈值（本项目最大 3.9MB，无需 Git LFS）
 *   3. dist 总体积不得超过 25MB（防止有人往里塞了无关大文件）
 *   4. .gitignore 绝不能把 dist/ 排除掉（否则 Pages 白屏、APK 缺 OCR 引擎——这是最容易翻车的点）
 *   5. capacitor.config.json 的 webDir 必须等于构建输出目录 dist
 *   6. package.json 的关键字段与 sync 脚本存在
 *
 * 用法：node tests/check-assets.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const KB = 1024;
const MB = 1024 * KB;

/** GitHub 单文件警告阈值（超过 50MB 会告警，100MB 直接拒绝）。 */
const MAX_SINGLE_FILE = 50 * MB;
/** dist 总体积上限，留出冗余但能拦住误塞的大文件。 */
const MAX_TOTAL_SIZE = 25 * MB;

/**
 * 必须存在的资产及其最小体积（bytes）。最小体积用于识别"下载了一半的空壳文件"。
 * 体积数据来自 2025 版离线依赖：tesseract.js 5.x core + chi_sim 字典 + SheetJS。
 */
const REQUIRED_ASSETS = [
  { rel: 'index.html', min: 60 * KB },
  { rel: 'manifest.webmanifest', min: 200 },
  { rel: 'sw.js', min: 1000 },
  { rel: 'icons/icon-192.png', min: 500 },
  { rel: 'icons/icon-512.png', min: 2000 },
  { rel: 'vendor/xlsx.full.min.js', min: 800 * KB },
  { rel: 'vendor/tesseract/tesseract.min.js', min: 40 * KB },
  { rel: 'vendor/tesseract/worker.min.js', min: 80 * KB },
  { rel: 'vendor/tesseract/core/tesseract-core-lstm.wasm.js', min: 3 * MB },
  { rel: 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js', min: 3 * MB },
  { rel: 'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js', min: 3 * MB },
  { rel: 'vendor/tessdata/chi_sim.traineddata.gz', min: 1.5 * MB }
];

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const infos = [];

/**
 * 读取 dist 下所有文件的体积（递归）。
 * @param {string} dir 目录
 * @returns {Array<{rel: string, size: number}>} 文件清单
 */
function walk(dir) {
  /** @type {Array<{rel: string, size: number}>} */
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  fs.readdirSync(dir).forEach(function (entry) {
    const abs = path.join(dir, entry);
    if (fs.statSync(abs).isDirectory()) {
      walk(abs).forEach(function (item) {
        out.push({ rel: entry + '/' + item.rel, size: item.size });
      });
    } else {
      out.push({ rel: entry, size: fs.statSync(abs).size });
    }
  });
  return out;
}

/**
 * 格式化字节数。
 * @param {number} bytes 字节
 * @returns {string} 人类可读字符串
 */
function human(bytes) {
  if (bytes >= MB) {
    return (bytes / MB).toFixed(2) + ' MB';
  }
  return (bytes / KB).toFixed(1) + ' KB';
}

console.log('=== 1. dist 资产完备性与体积 ===');
const files = walk(DIST);
if (!files.length) {
  errors.push('dist/ 为空或不存在，请先执行 npm run build');
} else {
  REQUIRED_ASSETS.forEach(function (asset) {
    const abs = path.join(DIST, asset.rel);
    if (!fs.existsSync(abs)) {
      errors.push('缺失必需资产：' + asset.rel);
      return;
    }
    const size = fs.statSync(abs).size;
    if (size === 0) {
      errors.push('资产为空文件（0 字节）：' + asset.rel);
      return;
    }
    if (size < asset.min) {
      errors.push('资产体积异常偏小（疑似不完整）：' + asset.rel +
        ' 实际 ' + human(size) + '，期望 ≥ ' + human(asset.min));
      return;
    }
    console.log('  ✓ ' + asset.rel + ' — ' + human(size));
  });
}

console.log('\n=== 2. 体积上限断言 ===');
const total = files.reduce(function (sum, f) { return sum + f.size; }, 0);
const biggest = files.slice().sort(function (a, b) { return b.size - a.size; })[0];
console.log('dist 文件数：' + files.length);
console.log('dist 总体积：' + human(total) + '（上限 ' + human(MAX_TOTAL_SIZE) + '）');
files.forEach(function (f) {
  if (f.size > MAX_SINGLE_FILE) {
    errors.push('单文件超过 50MB：' + f.rel + ' — ' + human(f.size));
  }
});
if (total > MAX_TOTAL_SIZE) {
  errors.push('dist 总体积 ' + human(total) + ' 超过上限 ' + human(MAX_TOTAL_SIZE));
}
if (biggest) {
  console.log('最大单文件：' + biggest.rel + ' — ' + human(biggest.size));
  infos.push('最大单文件 ' + human(biggest.size) + '，远低于 GitHub 100MB 限制，无需 Git LFS');
}

console.log('\n=== 3. .gitignore 不得排除 dist ===');
const gitignorePath = path.join(ROOT, '.gitignore');
if (!fs.existsSync(gitignorePath)) {
  errors.push('缺少 .gitignore');
} else {
  const dangerous = ['dist', 'dist/', '/dist', 'dist/**', '**/dist', '**/dist/'];
  fs.readFileSync(gitignorePath, 'utf8').split('\n').forEach(function (rawLine) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    if (dangerous.indexOf(line) !== -1) {
      errors.push('.gitignore 第「' + line + '」行会把 dist/ 排除出版本库，' +
        '将导致 Pages 白屏、APK 缺少 OCR 引擎');
    }
  });
  if (!errors.length) {
    console.log('  ✓ dist/ 未被忽略（首次 push 必须带上 dist，约 ' + human(total) + '）');
  }
}

console.log('\n=== 4. 构建与打包配置一致性 ===');
const capPath = path.join(ROOT, 'capacitor.config.json');
if (!fs.existsSync(capPath)) {
  errors.push('缺少 capacitor.config.json');
} else {
  const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  if (cap.webDir !== 'dist') {
    errors.push('capacitor.config.json 的 webDir 应为 dist，实际为 ' + cap.webDir);
  } else {
    console.log('  ✓ webDir = ' + cap.webDir + '，与构建输出目录一致');
  }
  ['appId', 'appName'].forEach(function (key) {
    if (!cap[key]) {
      errors.push('capacitor.config.json 缺少 ' + key);
    }
  });
  console.log('  ✓ appId = ' + cap.appId + '，appName = ' + cap.appName);
}

const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) {
  errors.push('缺少 package.json');
} else {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.private !== true) {
    errors.push('package.json 的 private 必须为 true');
  }
  if (!pkg.scripts || pkg.scripts.sync !== 'cap sync android') {
    errors.push('package.json 缺少 scripts.sync = "cap sync android"');
  }
  ['@capacitor/cli', '@capacitor/core', '@capacitor/android'].forEach(function (dep) {
    if (!pkg.devDependencies || !pkg.devDependencies[dep]) {
      errors.push('package.json 的 devDependencies 缺少 ' + dep);
    }
  });
  console.log('  ✓ package.json：' + pkg.name + '@' + pkg.version +
    '，private=true，sync 脚本与 Capacitor 依赖齐备');
}

const workflowDir = path.join(ROOT, '.github', 'workflows');
['build-apk.yml', 'deploy-pages.yml'].forEach(function (file) {
  if (!fs.existsSync(path.join(workflowDir, file))) {
    errors.push('缺少工作流：.github/workflows/' + file);
  }
});
console.log('  ✓ 两个 GitHub Actions 工作流就位');

console.log('\n----------------------------------------');
if (errors.length) {
  console.log('FAIL —— 发现 ' + errors.length + ' 个问题：');
  errors.forEach(function (e) { console.log('  ✗ ' + e); });
  console.log('\nIS_PASS=FAIL');
  process.exit(1);
}
infos.forEach(function (i) { console.log('  ℹ ' + i); });
console.log('全部断言通过：dist 资产齐全、体积合规、配置一致');
console.log('IS_PASS=PASS');
