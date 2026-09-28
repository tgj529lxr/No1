/**
 * sw.js — 考勤助手 Service Worker（离线优先 / cache-first + 后台更新）
 *
 * 目标：首次加载后，vendor 下的 tesseract.js 引擎、wasm 核心、
 * chi_sim 语言包（合计约 12MB）全部落缓存，之后完全离线可用。
 * 所有路径使用相对路径，兼容 GitHub Pages 子路径部署与 Capacitor 的 http://localhost。
 *
 * 预缓存策略（v2）：
 *   - 资源分为「关键资源」与「非关键资源（图标）」两档；
 *   - 关键资源只要有一条没缓存成功，install 即视为失败：
 *       不调用 skipWaiting，新 SW 被丢弃，旧缓存继续服役；
 *       浏览器下次导航会自动重试 install（相当于自动补缓存）；
 *       同时向所有页面 postMessage PRECACHE_FAILED，由页面给出用户可见提示。
 *   - 页面可 postMessage { type: 'RELOAD_CACHE' } 主动重跑预缓存（「重新下载离线包」）；
 *   - fetch 兜底分支（缓存未命中→走网络）拿到响应后会把关键资源补写回缓存，
 *     失败再退回 cache.add(req) 重抓一次，尽量让「下次离线」可用。
 *   - 旧缓存兜底：某条资源本次网络抓取失败时，先回查本地是否已有旧副本，
 *     有则视为成功（不触发 PRECACHE_FAILED），避免「缓存明明是好的却误报告警」。
 */
'use strict';

/* 每次发布改动请递增此版本号，以触发旧缓存清理 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'attendance-' + CACHE_VERSION;

/* 非关键资源：缺失只影响桌面图标，不影响离线识别，允许失败 */
const OPTIONAL_URLS = [
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* install 时预缓存的「轻量必需资源」清单（保持与磁盘文件一一对应）。
 * 注意：3 个 wasm 引擎(~12MB) + 语言包(~2MB) 故意不放在 install 里——
 * 一次性预缓存约 14MB 在 iOS Safari / Capacitor WebView 里极易超时，
 * 导致整批 install 作废、旧缓存被丢弃，页面持续误报「离线包下载不完整」。
 * 这些重资源改由页面「应用内离线包预载器」(attendance-offline-v1) 在联网时
 * 渐进下载并写入缓存，SW 的 caches.match 会跨所有缓存查找，离线照样命中。 */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/xlsx.full.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 「重资源」：由页面预载器在联网时下载并写入 attendance-offline-v1，
 * 不阻塞 SW install。清单与 src/index.html 的 OFFLINE_ASSETS 保持一致。 */
const LAZY_ASSETS = [
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tessdata/chi_sim.traineddata.gz'
];

/* 应用内预载器写入的缓存名（页面与 SW 共用，便于离线命中） */
const OFFLINE_CACHE = 'attendance-offline-v1';

/* 关键资源：缺任何一条都会导致「离线可用」承诺失效（OCR 引擎 / 语言包 / 离线首页 / Excel） */
const CRITICAL_URLS = PRECACHE_URLS.filter(function (u) {
  return OPTIONAL_URLS.indexOf(u) === -1;
});

/* 归一化后的关键资源清单，便于用请求 URL 反查 */
const CRITICAL_RELS = CRITICAL_URLS.map(function (u) {
  return u.replace(/^\.\//, '') || 'index.html';
});

/**
 * 把任意 URL 转成「相对于 SW 作用域」的路径，用于关键资源比对。
 * @param {string} url 绝对或相对 URL
 * @returns {string} 形如 'vendor/tessdata/chi_sim.traineddata.gz' 的相对路径
 */
function toRelPath(url) {
  try {
    const abs = new URL(String(url), self.location.href);
    const base = new URL('./', self.location.href);
    if (abs.href.indexOf(base.href) === 0) {
      return abs.href.slice(base.href.length) || 'index.html';
    }
    return abs.href;
  } catch (e) {
    return String(url).replace(/^\.\//, '');
  }
}

/**
 * 判断某个请求是否属于关键资源。
 * @param {string} url 请求 URL
 * @returns {boolean} true 表示不允许缓存失败
 */
function isCritical(url) {
  return CRITICAL_RELS.indexOf(toRelPath(url)) !== -1;
}

/**
 * 向所有已打开的页面广播消息（失败不影响主流程）。
 * @param {Object} payload 消息体
 * @returns {Promise<void>} 广播完成
 */
function notifyClients(payload) {
  if (!self.clients || typeof self.clients.matchAll !== 'function') {
    return Promise.resolve();
  }
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then(function (list) {
      list.forEach(function (client) {
        try { client.postMessage(payload); } catch (e) { /* 页面已销毁则忽略 */ }
      });
    })
    .catch(function () { /* 忽略广播失败 */ });
}

/**
 * 判断一个缓存响应是否可用（可当作「已有副本」）。
 * 说明：status 为 0 的 opaque 响应（无 CORS 头）同样可用于离线展示，故一并接受。
 * @param {Response|undefined|null} res 缓存响应
 * @returns {boolean} true 表示可用
 */
function isUsableResponse(res) {
  if (!res) return false;
  return res.ok === true || res.status === 0;
}

/**
 * 执行一次完整预缓存，返回分类后的结果。
 * 逐条 add：任一资源失败都不会中断其余资源的缓存。
 * 抓取失败时会回查本地旧副本：命中即视为成功（fromOldCache），
 * 这样「本次下载失败但旧缓存完好」不会被误判为关键资源缺失。
 * @param {Cache} cache 目标缓存
 * @returns {Promise<{failedCritical: Array<string>, failedOptional: Array<string>, okCount: number, fromOldCount: number}>} 结果
 */
function precacheInto(cache) {
  return Promise.all(PRECACHE_URLS.map(function (url) {
    return cache.add(new Request(url, { cache: 'reload' }))
      .then(function () { return { url: url, ok: true, error: '', fromOldCache: false }; })
      .catch(function (err) {
        /* 旧缓存兜底：网络失败不代表离线不可用，先看本地有没有上一版留下的副本 */
        return cache.match(url)
          .then(function (old) {
            if (isUsableResponse(old)) {
              return { url: url, ok: true, error: '', fromOldCache: true };
            }
            return { url: url, ok: false, error: (err && err.message) || String(err), fromOldCache: false };
          })
          .catch(function () {
            return { url: url, ok: false, error: (err && err.message) || String(err), fromOldCache: false };
          });
      });
  })).then(function (results) {
    const failedCritical = [];
    const failedOptional = [];
    let okCount = 0;
    let fromOldCount = 0;
    results.forEach(function (r) {
      if (r.ok) {
        okCount += 1;
        if (r.fromOldCache) fromOldCount += 1;
        return;
      }
      if (isCritical(r.url)) failedCritical.push(r.url);
      else failedOptional.push(r.url + ' (' + r.error + ')');
    });
    return {
      failedCritical: failedCritical,
      failedOptional: failedOptional,
      okCount: okCount,
      fromOldCount: fromOldCount
    };
  });
}

/**
 * 把响应写进缓存；若写入失败，关键资源再退回 cache.add(req) 重抓一次。
 * 目的是让「这次联网拿到、下次离线可用」尽量成立。
 * @param {Request} req 原始请求
 * @param {Response|null} res 网络响应（可为 null，此时强制重抓）
 * @returns {Promise<boolean>} 是否补缓存成功
 */
function warmUpCache(req, res) {
  const rel = toRelPath(req.url);
  return caches.open(CACHE_NAME)
    .then(function (cache) {
      if (res) {
        // put 使用的是克隆体，原始响应仍可返回给页面
        return cache.put(req, res.clone()).catch(function () {
          return cache.add(req);
        });
      }
      return cache.add(req);
    })
    .then(function () { return true; })
    .catch(function (err) {
      if (isCritical(req.url)) {
        console.warn('[sw] 关键资源补缓存失败，离线可能不可用：' + rel +
          ' ' + (err && err.message));
        notifyClients({ type: 'CACHE_INCOMPLETE', failed: [rel], cacheName: CACHE_NAME });
      }
      return false;
    });
}

/* ---------- install：预缓存（关键资源失败即作废本次安装） ---------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return precacheInto(cache);
      })
      .then(function (r) {
        r.failedOptional.forEach(function (item) {
          console.warn('[sw] 非关键资源预缓存失败（可忽略）：' + item);
        });

        if (r.failedCritical.length) {
          /* 关键资源缺失 → 宁可不接管，也不要让「假离线」骗用户：
             不调用 skipWaiting，同时抛错使本次 install 失败、新 SW 被丢弃，
             正在服役的旧 SW 与旧缓存继续工作；浏览器下次导航会自动重试。 */
          console.error('[sw] 关键资源预缓存失败，本次 install 作废，旧缓存继续服役：');
          r.failedCritical.forEach(function (url) {
            console.error('[sw]   ✗ ' + url);
          });
          notifyClients({
            type: 'PRECACHE_FAILED',
            failed: r.failedCritical,
            cacheName: CACHE_NAME
          });
          throw new Error('[sw] precache critical failed: ' + r.failedCritical.join(', '));
        }

        console.log('[sw] 预缓存完成：成功 ' + r.okCount + '/' + PRECACHE_URLS.length +
          '（其中复用旧缓存 ' + r.fromOldCount + ' 条），关键资源 ' +
          CRITICAL_URLS.length + ' 项全部就位');
        return notifyClients({ type: 'PRECACHE_OK', count: r.okCount, cacheName: CACHE_NAME })
          .then(function () { return self.skipWaiting(); });
      })
  );
});

/* ---------- activate：清理旧版本缓存 ---------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          /* 保留 OFFLINE_CACHE：这是页面预载器写入的重资源缓存（wasm/语言包），
             不能因 SW 版本更替被清掉，否则离线识别资源全丢 */
          if (key !== CACHE_NAME && key !== OFFLINE_CACHE) return caches.delete(key);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ---------- fetch：缓存优先 + 后台更新 + 关键资源补缓存 ---------- */
self.addEventListener('fetch', function (event) {
  const req = event.request;

  // 只处理 GET；非 GET（如可能的 POST）直接放行
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域资源（CDN 等）：尝试缓存，失败则放行网络
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          return res;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  // 同源：cache-first，命中后立即后台拉取更新，下次访问生效
  event.respondWith(
    caches.match(req).then(function (hit) {
      const networkFetch = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          /* 兜底分支：缓存里本来没有（或正在后台刷新）→ 拿到后立刻补写，
             关键资源写入失败会再退回 cache.add 重抓，并进行可见告警。 */
          event.waitUntil(warmUpCache(req, res));
        }
        return res;
      }).catch(function () {
        // 离线且无缓存：返回 null，交由下面的兜底处理
        return null;
      });

      // 命中缓存时，若命中的正是关键资源缺失场景无需处理；直接返回响应
      if (hit) {
        // 命中缓存：先用缓存响应，同时后台更新（不阻塞渲染）
        event.waitUntil(networkFetch);
        return hit;
      }

      return networkFetch.then(function (res) {
        if (res) return res;

        // 离线且未缓存
        if (isCritical(req.url)) {
          // 缺的就是关键资源 → 告知页面「离线功能不完整」，便于给出用户可见提示
          notifyClients({
            type: 'CACHE_MISS_OFFLINE',
            failed: [toRelPath(req.url)],
            cacheName: CACHE_NAME
          });
        }

        // 导航请求回退到首页（SPA 兜底）
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then(function (fallback) {
            return fallback || new Response('离线且无缓存内容', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
          });
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});

/* ---------- 页面消息：立即接管 / 重新下载离线包 ---------- */
self.addEventListener('message', function (event) {
  const data = (event && event.data) || {};
  const type = data.type;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'RELOAD_CACHE') {
    /** 优先回给发起请求的页面，拿不到就用广播兜底。 */
    const reply = function (payload) {
      if (event.source && typeof event.source.postMessage === 'function') {
        try { event.source.postMessage(payload); return; } catch (e) { /* 继续走广播 */ }
      }
      notifyClients(payload);
    };

    event.waitUntil(
      caches.open(CACHE_NAME)
        .then(function (cache) { return precacheInto(cache); })
        .then(function (r) {
          r.failedOptional.forEach(function (item) {
            console.warn('[sw] 非关键资源重新缓存失败（可忽略）：' + item);
          });
          if (r.failedCritical.length) {
            console.error('[sw] 重新下载离线包失败：' + r.failedCritical.join(', '));
            reply({
              type: 'PRECACHE_FAILED',
              failed: r.failedCritical,
              cacheName: CACHE_NAME
            });
            return;
          }
          console.log('[sw] 重新下载离线包完成：成功 ' + r.okCount + '/' + PRECACHE_URLS.length +
            '（其中复用旧缓存 ' + r.fromOldCount + ' 条）');
          reply({ type: 'PRECACHE_OK', count: r.okCount, cacheName: CACHE_NAME });
        })
        .catch(function (err) {
          reply({
            type: 'PRECACHE_FAILED',
            failed: [String((err && err.message) || err)],
            cacheName: CACHE_NAME
          });
        })
    );
  }
});
