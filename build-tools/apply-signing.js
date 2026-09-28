/**
 * apply-signing.js — 给 CI 中临时生成的 Capacitor 安卓工程注入「固定签名」。
 *
 * 背景：android/ 目录不入库，CI 每次 `npx cap add android` 都会重新生成工程，
 * AGP 会顺手生成一个**全新的 debug.keystore** → 每次构建的 APK 签名都不同 →
 * 用户手机上无法覆盖安装（签名不一致），表现为「下载了新 APK 但应用没变化」。
 *
 * 解决：把仓库里固定的 android-signing/debug.keystore（PKCS12，密码 android，
 * 别名 androiddebugkey）配置为 debug 构建的签名，保证每次 APK 签名一致，
 * 可以直接覆盖安装、保留数据。幂等：重复执行不会重复注入。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const KEYSTORE_REL = '../../android-signing/debug.keystore'; // 相对 android/app/

function main() {
  if (!fs.existsSync(GRADLE)) {
    console.error('[signing] 未找到 ' + GRADLE + '（cap add 尚未执行？）');
    process.exit(1);
  }
  const keystoreAbs = path.join(ROOT, 'android-signing', 'debug.keystore');
  if (!fs.existsSync(keystoreAbs)) {
    console.error('[signing] 未找到签名库 ' + keystoreAbs);
    process.exit(1);
  }

  let g = fs.readFileSync(GRADLE, 'utf8');

  // 版本号打上构建戳（在系统设置里能看出是否装到新版）
  const stamp = process.env.BUILD_STAMP || ('b' + Date.now());
  g = g.replace(/versionName "[^"]*"/, 'versionName "1.0-' + stamp + '"');

  if (g.indexOf('storeFile') !== -1) {
    console.log('[signing] signingConfig 已存在，跳过注入（仅更新 versionName）');
  } else {
    const signingBlock = [
      '',
      '    signingConfigs {',
      '        debug {',
      "            storeFile file('" + KEYSTORE_REL + "')",
      "            storePassword 'android'",
      "            keyAlias 'androiddebugkey'",
      "            keyPassword 'android'",
      "            storeType 'PKCS12'",
      '        }',
      '    }',
      ''
    ].join('\n');

    if (!/\n\s*buildTypes\s*\{/.test(g)) {
      console.error('[signing] build.gradle 中未找到 buildTypes 块，注入失败');
      process.exit(1);
    }
    g = g.replace(/(\n\s*buildTypes\s*\{)/, signingBlock + '$1');
    g = g.replace(/(buildTypes\s*\{)/, '$1\n        debug {\n            signingConfig signingConfigs.debug\n        }');
    console.log('[signing] 已注入固定签名配置（PKCS12, alias=androiddebugkey）');
  }

  fs.writeFileSync(GRADLE, g, 'utf8');

  // 自检：确认注入成功
  const check = fs.readFileSync(GRADLE, 'utf8');
  const okStore = check.indexOf("storeFile file('" + KEYSTORE_REL + "')") !== -1;
  const okUse = /debug\s*\{[\s\S]*?signingConfig signingConfigs\.debug/.test(check);
  console.log('[signing] 自检 storeFile=' + okStore + ' debug使用签名=' + okUse);
  if (!okStore || !okUse) process.exit(1);
}

main();
