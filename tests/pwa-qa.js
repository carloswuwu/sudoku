/*
 * PWA 线上检查：node tests/pwa-qa.js
 * 默认检查 https://carloswuwu.github.io/sudoku/ ，可用 PWA_URL 覆盖。
 * 需要：tests/ 下安装 ws；本机 Edge；网络可访问目标站点。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const TARGET_URL = process.env.PWA_URL || 'https://carloswuwu.github.io/sudoku/';
const outDir = path.join(process.env.TEMP || '.', 'sudoku-qa');
fs.mkdirSync(outDir, { recursive: true });

const failures = [];
let passed = 0;
function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failures.push(message);
    console.log('  ✗ ' + message);
  }
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const userDataDir = path.join(outDir, 'pwa-profile-' + Date.now());
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 100; i++) {
      try {
        const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = targets.find((t) => t.type === 'page');
        if (target) break;
      } catch (err) {
        /* 继续等待 */
      }
      await wait(150);
    }
    if (!target) throw new Error('无法连接 Edge DevTools');

    ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    let messageId = 0;
    const pending = new Map();
    const eventWaiters = [];
    const pageErrors = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params.exceptionDetails;
        pageErrors.push(
          'exception: ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text)
        );
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        if (eventWaiters[i].method === msg.method) {
          const waiter = eventWaiters.splice(i, 1)[0];
          waiter.resolve(msg.params);
        }
      }
    });

    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    }

    function waitEvent(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeoutMs || 20000);
        eventWaiters.push({
          method: method,
          resolve: (params) => {
            clearTimeout(timer);
            resolve(params);
          },
        });
      });
    }

    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails;
        throw new Error(
          '页面脚本错误: ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text)
        );
      }
      return result.result.value;
    }

    async function waitFor(expression, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < (timeoutMs || 15000)) {
        try {
          if (await evaluate(expression)) return true;
        } catch (err) {
          /* 页面正在导航时忽略 */
        }
        await wait(120);
      }
      return false;
    }

    async function screenshot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(outDir, name);
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
      return file;
    }

    async function loadPage() {
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url: TARGET_URL });
      await loaded;
      await waitFor("document.querySelectorAll('#board .cell').length > 0", 15000);
      await wait(300);
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');

    console.log('检查地址：' + TARGET_URL);

    console.log('\n[页面与 Manifest]');
    await loadPage();
    ok(await evaluate("document.title.indexOf('数独') >= 0"), '页面标题包含「数独」');

    console.log('\n[逻辑提示]');
    const hintInfo = await evaluate(`(() => {
      document.getElementById('hintBtn').click();
      const card = document.getElementById('hintCard');
      return {
        cardVisible: !card.hidden,
        title: document.getElementById('hintTitle').textContent,
        text: document.getElementById('hintText').textContent,
        hints: Number(document.getElementById('hints').textContent),
        target: document.querySelectorAll('#board .cell.hint-target').length
      };
    })()`);
    ok(hintInfo.cardVisible, '提示卡片可见');
    ok(hintInfo.title.length > 0 && hintInfo.text.length > 10, '提示包含技巧与说明');
    ok(hintInfo.hints === 1, '提示计数为 1');
    ok(hintInfo.target === 1, '目标格有提示动画标记');
    await evaluate("document.getElementById('hintClose').click(); document.getElementById('undoBtn').click();");
    ok(await evaluate('document.getElementById("hintCard").hidden'), '关闭提示后卡片隐藏');
    ok(await evaluate('Number(document.getElementById("hints").textContent) === 0'), '撤销后提示计数还原');

    const manifestLink = await evaluate("(document.querySelector('link[rel=\"manifest\"]') || {}).href || ''");
    ok(/manifest\.webmanifest$/.test(manifestLink), '页面包含 manifest 链接：' + manifestLink);

    const appManifest = await send('Page.getAppManifest');
    ok(!!appManifest && appManifest.url, '浏览器成功解析 Web App Manifest');
    const manifestErrors = (appManifest && appManifest.errors) || [];
    ok(manifestErrors.length === 0, 'Manifest 无解析错误' + (manifestErrors.length ? '：' + JSON.stringify(manifestErrors) : ''));
    let manifestData = null;
    try {
      manifestData = JSON.parse(appManifest.data);
    } catch (err) {
      manifestData = null;
    }
    ok(!!manifestData, 'Manifest 数据为合法 JSON');
    if (manifestData) {
      ok(manifestData.display === 'standalone', 'display 为 standalone');
      ok(String(manifestData.start_url || '').length > 0, '包含 start_url：' + manifestData.start_url);
      const sizes = (manifestData.icons || []).map((icon) => icon.sizes);
      ok(sizes.indexOf('192x192') >= 0, '包含 192×192 图标');
      ok(sizes.indexOf('512x512') >= 0, '包含 512×512 图标');
      ok(
        (manifestData.icons || []).some((icon) => String(icon.purpose || '').indexOf('maskable') >= 0),
        '包含 maskable 图标'
      );
    }

    console.log('\n[Service Worker]');
    const swInfo = await evaluate(`(async () => {
      if (!('serviceWorker' in navigator)) return null;
      const reg = await navigator.serviceWorker.ready;
      return {
        scope: reg.scope,
        active: reg.active ? reg.active.scriptURL : '',
        controller: !!navigator.serviceWorker.controller
      };
    })()`);
    ok(!!swInfo && /sw\.js$/.test(swInfo.active), 'Service Worker 已激活：' + (swInfo && swInfo.active));
    ok(!!swInfo && swInfo.scope.length > 0, 'Service Worker 作用域：' + (swInfo && swInfo.scope));

    const reloaded = waitEvent('Page.loadEventFired', 20000);
    await send('Page.reload', { ignoreCache: false });
    await reloaded;
    await waitFor("document.querySelectorAll('#board .cell').length > 0", 15000);
    await wait(500);
    const controlled = await evaluate('!!navigator.serviceWorker.controller');
    ok(controlled, '刷新后页面受 Service Worker 控制');

    const cacheInfo = await evaluate(`(async () => {
      const keys = await caches.keys();
      const result = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        result.push({ name: key, count: requests.length });
      }
      return result;
    })()`);
    const totalCached = cacheInfo.reduce((sum, entry) => sum + entry.count, 0);
    ok(cacheInfo.length > 0 && totalCached >= 8, '离线缓存已写入（' + totalCached + ' 个资源）');

    console.log('\n[可安装性]');
    let installability = null;
    for (let i = 0; i < 10; i++) {
      installability = await send('Page.getInstallabilityErrors');
      if (installability && installability.installabilityErrors && installability.installabilityErrors.length === 0) break;
      await wait(500);
    }
    const installErrors = (installability && installability.installabilityErrors) || [];
    ok(installErrors.length === 0, '满足安装条件' + (installErrors.length ? '：' + JSON.stringify(installErrors) : ''));
    const installBtnVisible = await evaluate(`(() => {
      const btn = document.getElementById('installBtn');
      return btn ? !btn.hidden : false;
    })()`);
    console.log('  installBtn 可见：' + installBtnVisible + '（Headless 环境不一定触发 beforeinstallprompt）');

    console.log('\n[离线加载]');
    const offlineShotBefore = pageErrors.length;
    await send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: 'none',
    });
    const offlineLoaded = waitEvent('Page.loadEventFired', 20000);
    await send('Page.reload', { ignoreCache: false });
    try {
      await offlineLoaded;
    } catch (err) {
      console.log('  ! 离线 load 事件超时，继续检查 DOM');
    }
    const offlineRendered = await waitFor("document.querySelectorAll('#board .cell').length === 81", 15000);
    ok(offlineRendered, '断网后重新加载仍能显示 9×9 棋盘');
    ok(await evaluate("document.querySelectorAll('#board .cell').length > 0"), '离线状态下游戏界面可用');
    const offlineShot = await screenshot('pwa-offline.png');
    console.log('  离线截图：' + offlineShot);
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    });
    await wait(500);

    const newErrors = pageErrors.slice(offlineShotBefore);
    ok(newErrors.length === 0, '离线切换过程中没有脚本错误' + (newErrors.length ? '：' + newErrors.slice(0, 3).join(' | ') : ''));
    ok(pageErrors.length === 0, '全程没有脚本错误' + (pageErrors.length ? '：' + pageErrors.slice(0, 3).join(' | ') : ''));

    console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
    if (failures.length) {
      console.log('\n失败项：\n- ' + failures.join('\n- '));
      process.exitCode = 1;
    }
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch (err) {
      /* 忽略 */
    }
    try {
      execFileSync('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (err) {
      /* 忽略 */
    }
  }
}

main().catch((err) => {
  console.error('\nPWA 检查异常终止：', err);
  process.exitCode = 1;
});
