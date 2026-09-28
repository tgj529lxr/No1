/**
 * gen-icons.js — 用 Node 内置 zlib 手写最小 PNG 编码器，生成 PWA 图标。
 *
 * 输出：dist/icons/icon-192.png、dist/icons/icon-512.png
 * 图形：#1d4ed8 满幅圆角底 + 白色对勾（纯几何绘制，3x3 超采样抗锯齿）。
 * 不依赖任何第三方库，不联网。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- CRC32（PNG 分块校验） ---------------- */
const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- PNG 分块构造 ---------------- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素缓冲编码为 PNG 二进制。
 * @param {Buffer} rgba  长度 = w*h*4 的 RGBA 像素（行优先，无行过滤）
 * @param {number} w     宽
 * @param {number} h     高
 * @returns {Buffer}     PNG 文件字节
 */
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;                                   // filter type: None
    rgba.copy(raw, p, y * w * 4, (y + 1) * w * 4);
    p += w * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 几何绘制 ---------------- */
const BG = [0x1d, 0x4e, 0xd8];   // 品牌蓝
const FG = [0xff, 0xff, 0xff];   // 白色对勾

// 对勾折线顶点（归一化坐标：以图标中心为原点，范围 ±0.5）
// 收在半径 0.40 的可视安全区内，保证 purpose:"maskable" 裁圆后仍完整
const CHECK_POINTS = [
  [-0.30, 0.02],
  [-0.08, 0.24],
  [0.32, -0.22]
];
const CHECK_HALF_WIDTH = 0.055;   // 线宽半径（归一化）
const SUPER = 3;                  // 每轴超采样倍数

/** 点到线段的最短距离。 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 采样点是否落在对勾笔画内。 */
function inCheck(x, y) {
  for (let i = 0; i < CHECK_POINTS.length - 1; i++) {
    const a = CHECK_POINTS[i], b = CHECK_POINTS[i + 1];
    if (distToSegment(x, y, a[0], a[1], b[0], b[1]) <= CHECK_HALF_WIDTH) return true;
  }
  return false;
}

/**
 * 生成指定尺寸图标的 RGBA 像素。
 * @param {number} size 边长（px）
 * @returns {Buffer}    RGBA 像素缓冲
 */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const inv = 1 / size;
  const sub = 1 / SUPER;
  const half = 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0, accG = 0, accB = 0, accA = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          // 子采样点 → 归一化坐标（y 轴向下为正）
          const nx = (x + (sx + 0.5) * sub) * inv - half;
          const ny = (y + (sy + 0.5) * sub) * inv - half;
          if (inCheck(nx, ny)) { accR += FG[0]; accG += FG[1]; accB += FG[2]; accA += 255; }
          else { accR += BG[0]; accG += BG[1]; accB += BG[2]; accA += 255; }
        }
      }
      const n = SUPER * SUPER;
      const o = (y * size + x) * 4;
      px[o]     = Math.round(accR / n);
      px[o + 1] = Math.round(accG / n);
      px[o + 2] = Math.round(accB / n);
      px[o + 3] = Math.round(accA / n);
    }
  }
  return px;
}

/* ---------------- 主流程 ---------------- */
function main() {
  const outDir = path.join(__dirname, '..', 'dist', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  [192, 512].forEach(function (size) {
    const file = path.join(outDir, 'icon-' + size + '.png');
    const png = encodePNG(renderIcon(size), size, size);
    fs.writeFileSync(file, png);
    console.log('generated ' + file + ' (' + png.length + ' bytes, ' + size + 'x' + size + ')');
  });
}

main();
