/*
 * 真实浏览器端到端检查（Edge headless + Chrome DevTools Protocol）
 * 用法：node tests/browser-qa.js
 * 需要 tests/ 下安装 ws：npm install --prefix tests ws
 * 说明：脚本会启动一个带 --remote-debugging-port 的 Edge 实例，截图到 %TEMP%\sudoku-qa。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const root = path.join(__dirname, '..');
const fileUrl = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/');
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

const helper = `
window.__qa = {
  click: function (el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); },
  key: function (k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); },
  cells: function () { return document.querySelectorAll('#board .cell'); },
  cell: function (r, c) { return document.querySelector('#board .cell[data-r="' + r + '"][data-c="' + c + '"]'); },
  firstEmpty: function () { return document.querySelector('#board .cell:not(.given)'); },
  pad: function (d) { return document.querySelector('#pad .pad-btn[data-d="' + d + '"]'); },
  num: function (el) { return el ? el.querySelector('.num').textContent : null; },
  givenCount: function () { return document.querySelectorAll('#board .cell.given').length; }
};
`;

const metricsExpr = `(() => {
  var vw = window.innerWidth;
  var rects = {};
  var selectors = {
    app: '.app', topbar: '.topbar', brand: '.brand', newBtn: '#newGameBtn',
    layout: '.layout', meta: '.meta-row', board: '.board-shell', panel: '.panel',
    pad: '#pad', toolbar: '.toolbar', hint: '.hint-text', modal: '.modal'
  };
  Object.keys(selectors).forEach(function (key) {
    var el = document.querySelector(selectors[key]);
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    rects[key] = { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), h: Math.round(r.height) };
  });
  var offenders = [];
  document.querySelectorAll('body *').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    if (r.right > vw + 1 || r.left < -1) {
      var cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: String(cls || '').slice(0, 60),
        x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right)
      });
    }
  });
  return {
    vw: vw, vh: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    rects: rects,
    offenders: offenders.slice(0, 12),
    offenderCount: offenders.length
  };
})()`;

async function main() {
  const userDataDir = path.join(outDir, 'browser-profile-' + Date.now());
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-extensions',
      '--mute-audio',
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
  let target = null;
  try {
    /* 等待 DevTools 端口就绪 */
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
        pageErrors.push('exception: ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        pageErrors.push('log: ' + msg.params.entry.text);
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
        const timer = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeoutMs || 15000);
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
        throw new Error('页面脚本错误: ' + (detail.exception && detail.exception.description ? detail.exception.description : detail.text));
      }
      return result.result.value;
    }

    async function waitFor(expression, timeoutMs) {
      const start = Date.now();
      let lastError = null;
      while (Date.now() - start < (timeoutMs || 10000)) {
        try {
          if (await evaluate(expression)) return true;
        } catch (err) {
          lastError = err;
        }
        await wait(120);
      }
      throw new Error('waitFor 超时: ' + expression + (lastError ? ' / ' + lastError.message : ''));
    }

    async function setViewport(width, height, mobile) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: width,
        height: height,
        deviceScaleFactor: 1,
        mobile: !!mobile,
        screenWidth: width,
        screenHeight: height,
      });
      await wait(200);
    }

    async function loadPage(width, height, mobile) {
      await setViewport(width, height, mobile);
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url: fileUrl });
      await loaded;
      await waitFor("document.querySelectorAll('#board .cell').length > 0", 15000);
      await wait(350);
      await evaluate(helper);
    }

    async function screenshot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(outDir, name);
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
      return file;
    }

    async function metrics() {
      return evaluate(metricsExpr);
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    const report = { screenshots: [], views: {}, pageErrors: pageErrors };

    /* ---------------- 桌面 1440 × 1000 ---------------- */
    console.log('\n[桌面 1440×1000]');
    await loadPage(1440, 1000, false);
    let m = await metrics();
    report.views.desktop = m;
    ok(m.vw === 1440, '视口宽度为 1440（实际 ' + m.vw + '）');
    ok(m.docScrollW <= m.vw + 1, '桌面端没有横向溢出（scrollWidth=' + m.docScrollW + '）');
    ok(await evaluate("document.querySelectorAll('#board .cell').length === 81"), '9×9 棋盘已渲染 81 格');
    ok((await evaluate("document.querySelectorAll('#board .cell.given').length")) > 0, '题目数字已渲染');
    report.screenshots.push(await screenshot('browser-desktop.png'));

    console.log('\n[新游戏弹窗]');
    await evaluate('__qa.click(document.getElementById("newGameBtn"))');
    await waitFor('!document.getElementById("newGameModal").hidden', 4000);
    await wait(300);
    const modalInfo = await evaluate(`(() => {
      const modal = document.querySelector('.modal');
      const r = modal.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), visible: !document.getElementById('newGameModal').hidden };
    })()`);
    ok(modalInfo.visible && modalInfo.w > 300, '新游戏弹窗可见且尺寸正常（' + modalInfo.w + '×' + modalInfo.h + '）');
    report.screenshots.push(await screenshot('browser-modal.png'));

    console.log('\n[4×4 简单 与 键盘/输入交互]');
    await evaluate('__qa.click(document.querySelector(\'.size-card[data-size="4"]\'))');
    await evaluate('__qa.click(document.querySelector(\'.diff-btn[data-difficulty="easy"]\'))');
    await evaluate('__qa.click(document.getElementById("startGameBtn"))');
    await waitFor("document.querySelectorAll('#board .cell').length === 16", 8000);
    await waitFor('document.getElementById("loadingOverlay").hidden', 4000);
    await wait(250);
    ok((await evaluate('__qa.givenCount()')) < 16, '4×4 棋盘提示数少于总格数');
    const inputResult = await evaluate(`(() => {
      const c = __qa.firstEmpty();
      if (!c) return null;
      __qa.click(c);
      __qa.click(__qa.pad(1));
      return { r: Number(c.dataset.r), c: Number(c.dataset.c), text: __qa.num(c), conflict: c.classList.contains('conflict'), mistakes: Number(document.getElementById('mistakes').textContent) };
    })()`);
    ok(!!inputResult && inputResult.text === '1', '浏览器中点击数字键盘可填入数字');
    ok(!!inputResult && (inputResult.conflict ? inputResult.mistakes === 1 : inputResult.mistakes === 0), '冲突标红与错误计数一致');
    await evaluate('__qa.key("Backspace")');
    ok((await evaluate('__qa.cell(' + inputResult.r + ',' + inputResult.c + ').querySelector(".num").textContent')) === '', 'Backspace 可擦除填入的数字');

    console.log('\n[4×4 冲突标红]');
    const conflictInfo = await evaluate(`(() => {
      const all = Array.from(document.querySelectorAll('#board .cell'));
      const empty = all.find(function (c) { return !c.classList.contains('given') && !c.querySelector('.num').textContent; });
      if (!empty) return null;
      const er = Number(empty.dataset.r);
      const ec = Number(empty.dataset.c);
      const boxR = Math.floor(er / 2) * 2;
      const boxC = Math.floor(ec / 2) * 2;
      const peers = [];
      for (let i = 0; i < 4; i++) { peers.push([er, i]); peers.push([i, ec]); }
      for (let r = boxR; r < boxR + 2; r++) for (let c = boxC; c < boxC + 2; c++) peers.push([r, c]);
      for (let i = 0; i < peers.length; i++) {
        const pr = peers[i][0];
        const pc = peers[i][1];
        if (pr === er && pc === ec) continue;
        const cell = __qa.cell(pr, pc);
        const value = cell && cell.querySelector('.num').textContent;
        if (value) {
          __qa.click(empty);
          __qa.click(__qa.pad(Number(value)));
          return {
            r: er, c: ec,
            emptyConflict: empty.classList.contains('conflict'),
            peerConflict: cell.classList.contains('conflict'),
            mistakes: Number(document.getElementById('mistakes').textContent)
          };
        }
      }
      return null;
    })()`);
    if (conflictInfo) {
      ok(conflictInfo.emptyConflict && conflictInfo.peerConflict, '冲突时新填格与已有数字格都标红');
      ok(conflictInfo.mistakes === 1, '冲突错误计数为 1');
      report.screenshots.push(await screenshot('browser-conflict.png'));
      await evaluate('__qa.key("Backspace")');
      const conflictAfterErase = await evaluate(
        '(() => { const c = __qa.cell(' + conflictInfo.r + ',' + conflictInfo.c + '); return c.classList.contains("conflict"); })()'
      );
      ok(!conflictAfterErase, '擦除后冲突标红消失');
    } else {
      ok(false, '未能构造 4×4 冲突场景');
    }
    report.screenshots.push(await screenshot('browser-4x4.png'));

    console.log('\n[暂停浮层]');
    await evaluate('__qa.click(document.getElementById("pauseBtn"))');
    await waitFor('!document.getElementById("pauseOverlay").hidden', 4000);
    await wait(250);
    ok(!(await evaluate('document.getElementById("pauseOverlay").hidden')), '暂停浮层显示');
    report.screenshots.push(await screenshot('browser-pause.png'));
    await evaluate('__qa.click(document.getElementById("resumeBtn"))');
    await waitFor('document.getElementById("pauseOverlay").hidden', 4000);
    ok(await evaluate('document.getElementById("pauseOverlay").hidden'), '继续后暂停浮层关闭');

    console.log('\n[完成一局：提示填满 → 胜利弹窗]');
    const winResult = await evaluate(`(() => {
      const btn = document.getElementById('hintBtn');
      const before = Number(document.getElementById('hints').textContent);
      let clicks = 0;
      while (document.getElementById('winOverlay').hidden && clicks < 40) {
        __qa.click(btn);
        clicks++;
      }
      return {
        clicks: clicks,
        win: !document.getElementById('winOverlay').hidden,
        hints: Number(document.getElementById('hints').textContent),
        before: before,
        winHints: document.getElementById('winHints').textContent,
        winDifficulty: document.getElementById('winDifficulty').textContent
      };
    })()`);
    ok(winResult.win, '提示按钮填满棋盘后出现胜利弹窗（点击 ' + winResult.clicks + ' 次）');
    ok(winResult.hints === winResult.before + winResult.clicks, '提示计数正确累加');
    ok(winResult.winHints === String(winResult.hints), '胜利弹窗提示数与面板一致');
    ok(winResult.winDifficulty.indexOf('4×4') === 0, '胜利弹窗显示 4×4 模式');
    await wait(500);
    report.screenshots.push(await screenshot('browser-win.png'));

    console.log('\n[胜利弹窗 → 换个难度 → 取消]');
    await evaluate('__qa.click(document.getElementById("changeSettingsBtn"))');
    await waitFor('!document.getElementById("newGameModal").hidden', 4000);
    ok(!(await evaluate('document.getElementById("newGameModal").hidden')), '胜利后能打开新游戏弹窗');
    await evaluate('__qa.click(document.querySelector(".js-cancel-new"))');
    await waitFor('document.getElementById("newGameModal").hidden', 4000);
    ok(!(await evaluate('document.getElementById("winOverlay").hidden')), '取消后重新显示胜利弹窗');

    console.log('\n[更换难度回 9×9]');
    await evaluate('__qa.click(document.getElementById("changeSettingsBtn"))');
    await waitFor('!document.getElementById("newGameModal").hidden', 4000);
    await evaluate('__qa.click(document.querySelector(\'.size-card[data-size="9"]\'))');
    await evaluate('__qa.click(document.querySelector(\'.diff-btn[data-difficulty="medium"]\'))');
    await evaluate('__qa.click(document.getElementById("startGameBtn"))');
    await waitFor("document.querySelectorAll('#board .cell').length === 81", 8000);
    await waitFor('document.getElementById("loadingOverlay").hidden', 4000);
    await wait(400);
    ok((await evaluate('document.getElementById("modeBadge").textContent')) === '9×9 · 中等', '模式徽章为 9×9 · 中等');
    report.screenshots.push(await screenshot('browser-9x9.png'));

    console.log('\n[真实浏览器：刷新后恢复进度]');
    const savedCell = await evaluate(`(() => {
      const c = __qa.firstEmpty();
      if (!c) return null;
      __qa.click(c);
      __qa.click(__qa.pad(1));
      return { r: Number(c.dataset.r), c: Number(c.dataset.c), text: __qa.num(c), storage: (function(){ try { return !!localStorage.getItem('sudoku-save-v1'); } catch (e) { return false; } })() };
    })()`);
    ok(!!savedCell && savedCell.text === '1', '刷新前填入数字');
    const reloaded = waitEvent('Page.loadEventFired', 20000);
    await send('Page.reload', { ignoreCache: false });
    await reloaded;
    await waitFor("document.querySelectorAll('#board .cell').length === 81", 12000);
    await wait(700);
    await evaluate(helper);
    const restoredText = await evaluate('__qa.cell(' + savedCell.r + ',' + savedCell.c + ').querySelector(".num").textContent');
    if (savedCell.storage) {
      ok(restoredText === '1', '刷新后 localStorage 恢复填入的数字');
    } else {
      console.log('  ! 当前浏览器 file:// 环境不支持 localStorage，已跳过恢复测试');
    }
    ok((await evaluate('document.getElementById("modeBadge").textContent')) === '9×9 · 中等', '恢复后模式徽章正确');
    const restoredErrors = pageErrors.length;

    /* ---------------- 平板 900 × 900 ---------------- */
    console.log('\n[平板 900×900]');
    await loadPage(900, 900, false);
    m = await metrics();
    report.views.tablet = m;
    ok(m.vw === 900, '视口宽度为 900（实际 ' + m.vw + '）');
    ok(m.docScrollW <= m.vw + 1, '平板端没有横向溢出（scrollWidth=' + m.docScrollW + '）');
    await wait(300);
    report.screenshots.push(await screenshot('browser-tablet.png'));

    /* ---------------- 手机 420 × 960 ---------------- */
    console.log('\n[手机 420×960]');
    await loadPage(420, 960, true);
    m = await metrics();
    report.views.mobile420 = m;
    ok(m.vw === 420, '视口宽度为 420（实际 ' + m.vw + '）');
    ok(m.docScrollW <= m.vw + 1, '手机端没有横向溢出（scrollWidth=' + m.docScrollW + '）');
    const boardRect = m.rects.board;
    ok(!!boardRect && boardRect.w > 300 && boardRect.right <= m.vw, '棋盘完整显示在手机宽度内（宽 ' + (boardRect && boardRect.w) + '）');
    if (m.offenders.length) {
      console.log('  溢出元素：' + JSON.stringify(m.offenders));
    }
    report.screenshots.push(await screenshot('browser-mobile.png'));

    console.log('\n[手机端新游戏弹窗]');
    await evaluate('__qa.click(document.getElementById("newGameBtn"))');
    await waitFor('!document.getElementById("newGameModal").hidden', 4000);
    await wait(300);
    const modalMobile = await evaluate(`(() => {
      const modal = document.querySelector('.modal');
      const r = modal.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
    })()`);
    ok(modalMobile.left >= 0 && modalMobile.right <= modalMobile.vw + 1, '手机端弹窗不超出屏幕');
    report.screenshots.push(await screenshot('browser-mobile-modal.png'));
    await evaluate('__qa.click(document.querySelector(".js-cancel-new"))');
    await waitFor('document.getElementById("newGameModal").hidden', 4000);

    /* ---------------- 小屏 360 × 800 ---------------- */
    console.log('\n[手机 360×800]');
    await loadPage(360, 800, true);
    m = await metrics();
    report.views.mobile360 = m;
    ok(m.vw === 360, '视口宽度为 360（实际 ' + m.vw + '）');
    ok(m.docScrollW <= m.vw + 1, '小屏没有横向溢出（scrollWidth=' + m.docScrollW + '）');
    report.screenshots.push(await screenshot('browser-mobile-small.png'));

    console.log('\n[页面脚本错误]');
    ok(pageErrors.length === 0, '全程没有脚本错误' + (pageErrors.length ? '：' + pageErrors.slice(0, 5).join(' | ') : ''));

    report.pageErrors = pageErrors;
    report.summary = { passed: passed, failed: failures.length };
    fs.writeFileSync(path.join(outDir, 'browser-report.json'), JSON.stringify(report, null, 2));

    console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
    if (failures.length) {
      console.log('\n失败项：\n- ' + failures.join('\n- '));
      process.exitCode = 1;
    }
    console.log('\n截图目录：' + outDir);
    console.log('报告：' + path.join(outDir, 'browser-report.json'));
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch (err) {
      /* 忽略 */
    }
    try {
      const { execFileSync } = require('child_process');
      execFileSync('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (err) {
      /* 忽略 */
    }
  }
}

main().catch((err) => {
  console.error('\n浏览器检查异常终止：', err);
  process.exitCode = 1;
});
