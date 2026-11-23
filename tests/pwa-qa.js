/*
 * PWA 检查：node tests/pwa-qa.js
 *
 * 默认行为：自动在本地启动测试服务器（tests/serve.js，端口可用 SUDOKU_PORT 覆盖，默认 8099），
 * 目标为 http://127.0.0.1:<port>/sudoku/ ，不依赖公网。
 * 也可用 PWA_URL 指向任意已部署地址（此时不会启动本地服务器）。
 * 需要：tests/ 下安装 ws；本机 Edge。
 *
 * 失败时不会静默挂起：加载、Service Worker 注册均有超时；整轮检查有 180s 总超时；
 * 未找到 / 无法启动 Edge 会打印明确错误并以非零码退出。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
].filter(Boolean);

const PORT = Number(process.env.CDP_PORT || 9334); // DevTools 调试端口
const SERVER_PORT = Number(process.env.SUDOKU_PORT || 8099); // 本地测试服务器端口
const PWA_URL = process.env.PWA_URL || '';
const TARGET_URL = PWA_URL || 'http://127.0.0.1:' + SERVER_PORT + '/sudoku/';
const RUN_TIMEOUT_MS = 180000;
const SW_READY_TIMEOUT_MS = 15000;
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
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
  });
}

function probeStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(5000, () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
  });
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      /* 忽略无权限路径 */
    }
  }
  return null;
}

/* ---- 进程清理：浏览器与本地服务器都必须被回收 ---- */
let edge = null;
let server = null;
let ws = null;
let overallTimer = null;
let cleanedUp = false;

function killProcessTree(child) {
  if (!child || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    /* Windows：连同子进程一起结束 */
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (err) {
    try {
      child.kill('SIGKILL');
    } catch (killErr) {
      /* 进程可能已经退出 */
    }
  }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (overallTimer) {
    clearTimeout(overallTimer);
    overallTimer = null;
  }
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  } catch (err) {
    /* 忽略 */
  }
  killProcessTree(edge);
  killProcessTree(server);
}

function startLocalServer() {
  const serveJs = path.join(__dirname, 'serve.js');
  if (!fs.existsSync(serveJs)) {
    throw new Error('找不到本地测试服务器脚本：' + serveJs);
  }
  return spawn(process.execPath, [serveJs], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { SUDOKU_PORT: String(SERVER_PORT) }),
    stdio: 'ignore',
  });
}

async function waitForServer(child, url, timeoutMs) {
  let exitInfo = null;
  child.once('error', (err) => {
    exitInfo = '无法启动：' + err.message;
  });
  child.once('exit', (code, signal) => {
    exitInfo = '已退出（code=' + code + (signal ? ', signal=' + signal : '') + '）';
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new Error(
        '本地测试服务器启动失败：' + exitInfo + '；端口 ' + SERVER_PORT + ' 可能已被占用，可用 SUDOKU_PORT 指定其他端口'
      );
    }
    try {
      const status = await probeStatus(url);
      if (status === 200) return;
    } catch (err) {
      /* 服务器还没就绪，继续等待 */
    }
    await wait(150);
  }
  throw new Error(
    '本地测试服务器在 ' +
      Math.round(timeoutMs / 1000) +
      's 内未就绪：' +
      url +
      '（端口 ' +
      SERVER_PORT +
      ' 可能已被占用，可用 SUDOKU_PORT 覆盖）'
  );
}

async function connectEdgeDevTools() {
  const deadline = Date.now() + 15000;
  let startError = null;
  let exited = null;
  edge.once('error', (err) => {
    startError = err;
  });
  edge.once('exit', (code, signal) => {
    exited = { code: code, signal: signal };
  });

  while (Date.now() < deadline) {
    if (startError) {
      throw new Error(
        '无法启动 Microsoft Edge：' + startError.message + '（已尝试 ' + edge.spawnfile + '）'
      );
    }
    if (exited) {
      throw new Error('Microsoft Edge 启动后立即退出（code=' + exited.code + '），无法连接 DevTools');
    }
    try {
      const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      const target = targets.find((t) => t.type === 'page');
      if (target) return target;
    } catch (err) {
      /* DevTools 还没起来，继续等待 */
    }
    await wait(150);
  }
  throw new Error('无法连接 Edge DevTools（http://127.0.0.1:' + PORT + '/json/list，15s 超时）');
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时（' + timeoutMs + 'ms）')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function main() {
  armRunTimeout();

  console.log('检查地址：' + TARGET_URL);
  if (!PWA_URL) {
    console.log('（未设置 PWA_URL：启动本地测试服务器 tests/serve.js，端口 ' + SERVER_PORT + '）');
    server = startLocalServer();
    await waitForServer(server, TARGET_URL, 15000);
    console.log('本地测试服务器已就绪：' + TARGET_URL);
  } else {
    console.log('（使用 PWA_URL 指定地址，不启动本地测试服务器）');
  }

  const edgePath = findEdge();
  if (!edgePath) {
    throw new Error(
      '未找到 Microsoft Edge，无法运行 PWA 检查。已尝试：\n  - ' +
        EDGE_CANDIDATES.join('\n  - ') +
        '\n请安装 Edge，或修改 tests/pwa-qa.js 中的 EDGE_CANDIDATES。'
    );
  }

  const userDataDir = path.join(outDir, 'pwa-profile-' + Date.now());
  edge = spawn(
    edgePath,
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

  try {
    const target = await connectEdgeDevTools();

    ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
      15000,
      '连接 Edge DevTools WebSocket'
    );

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
        const timer = setTimeout(() => {
          const index = eventWaiters.findIndex((waiter) => waiter.method === method && waiter.timer === timer);
          if (index >= 0) eventWaiters.splice(index, 1);
          reject(new Error('等待事件超时: ' + method));
        }, timeoutMs || 20000);
        eventWaiters.push({
          method: method,
          timer: timer,
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

    async function evaluateWithTimeout(expression, timeoutMs, label) {
      return withTimeout(evaluate(expression), timeoutMs, label || '页面脚本执行');
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

    async function waitForBoard(timeoutMs) {
      return waitFor("document.querySelectorAll('#board .cell').length > 0", timeoutMs || 15000);
    }

    /* 加载页面：等待棋盘渲染；失败时重试一次，仍失败则抛出明确错误（不再继续空引用操作） */
    async function loadPage() {
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url: TARGET_URL });
      await loaded;

      let rendered = await waitForBoard(15000);
      if (!rendered) {
        console.log('  ! 页面首次加载未渲染棋盘，重新加载一次…');
        const retryLoaded = waitEvent('Page.loadEventFired', 20000);
        await send('Page.reload', { ignoreCache: false });
        await retryLoaded;
        rendered = await waitForBoard(15000);
      }
      if (!rendered) {
        throw new Error('页面加载失败：等待 #board .cell 渲染超时（目标：' + TARGET_URL + '）');
      }
      await wait(300);
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');

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
    /* data 为原始 manifest 文本；新版浏览器也可能只给 resolved 的 parsed */
    let manifestData = null;
    let manifestIsRaw = false;
    if (appManifest && typeof appManifest.data === 'string' && appManifest.data.length) {
      try {
        manifestData = JSON.parse(appManifest.data);
        manifestIsRaw = true;
      } catch (err) {
        manifestData = null;
      }
    }
    if (!manifestData && appManifest && appManifest.parsed) {
      manifestData = appManifest.parsed;
    }
    ok(!!manifestData, 'Manifest 数据为合法 JSON');
    if (manifestData) {
      ok(manifestData.display === 'standalone', 'display 为 standalone');
      ok(String(manifestData.start_url || '').length > 0, '包含 start_url：' + manifestData.start_url);
      if (manifestIsRaw) {
        ok(manifestData.id === './', 'id 为相对路径 "./"（相对 start_url，便于子路径部署）');
      }
      const iconSources = (manifestData.icons || []).map((icon) => String(icon.src || ''));
      const sizes = (manifestData.icons || []).map((icon) => icon.sizes);
      ok(sizes.indexOf('192x192') >= 0, '包含 192×192 图标');
      ok(sizes.indexOf('512x512') >= 0, '包含 512×512 图标');
      ok(
        (manifestData.icons || []).some((icon) => String(icon.purpose || '').indexOf('maskable') >= 0),
        '包含 maskable 图标'
      );
      ok(
        iconSources.some((src) => src.indexOf('icon-maskable-512.png') >= 0),
        'maskable 图标指向 icon-maskable-512.png'
      );
      const screenshots = manifestData.screenshots || [];
      ok(
        screenshots.length === 2 &&
          screenshots.every(
            (shot) =>
              shot.sizes === '1440x1000' &&
              shot.type === 'image/png' &&
              shot.form_factor === 'wide' &&
              String(shot.src || '').length > 0
          ),
        '包含 2 张 1440×1000 宽屏截图（screenshot.png / hint-screenshot.png）'
      );
    }

    console.log('\n[Service Worker]');
    let swInfo = null;
    try {
      swInfo = await evaluateWithTimeout(
        `(async () => {
          if (!('serviceWorker' in navigator)) return null;
          const ready = Promise.race([
            navigator.serviceWorker.ready,
            new Promise((resolve) => setTimeout(() => resolve('timeout'), ${SW_READY_TIMEOUT_MS}))
          ]);
          const reg = await ready;
          if (!reg || reg === 'timeout') return { timeout: true, scope: '', active: '' };
          return {
            scope: reg.scope,
            active: reg.active ? reg.active.scriptURL : '',
            controller: !!navigator.serviceWorker.controller
          };
        })()`,
        SW_READY_TIMEOUT_MS + 5000,
        'Service Worker 注册/激活'
      );
    } catch (err) {
      ok(false, 'Service Worker 注册/激活失败：' + err.message);
    }
    if (swInfo && swInfo.timeout) {
      ok(false, 'Service Worker 注册/激活超时（' + SW_READY_TIMEOUT_MS / 1000 + 's 内未 ready）');
    }
    ok(!!swInfo && !swInfo.timeout && /sw\.js$/.test(swInfo.active), 'Service Worker 已激活：' + (swInfo && swInfo.active));
    ok(
      !!swInfo && !swInfo.timeout && swInfo.scope.length > 0,
      'Service Worker 作用域：' + (swInfo && swInfo.scope)
    );

    const reloaded = waitEvent('Page.loadEventFired', 20000);
    await send('Page.reload', { ignoreCache: false });
    await reloaded;
    if (!(await waitForBoard(15000))) {
      throw new Error('刷新后页面加载失败：等待 #board .cell 渲染超时');
    }
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
    ok(cacheInfo.length > 0 && totalCached >= 12, '离线缓存已写入（' + totalCached + ' 个资源，期望至少 12 个）');

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
    cleanup();
  }
}

function armRunTimeout() {
  overallTimer = setTimeout(() => {
    console.error(
      '\nPWA 检查总超时：超过 ' +
        RUN_TIMEOUT_MS / 1000 +
        ' 秒仍未完成，判定失败并清理浏览器 / 本地测试服务器。'
    );
    cleanup();
    process.exit(1);
  }, RUN_TIMEOUT_MS);
}

main()
  .catch((err) => {
    console.error('\nPWA 检查异常终止：', err && err.message ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    /* 兜底：确保没有残留句柄（ws / 子进程）阻止进程退出 */
    setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
  });
