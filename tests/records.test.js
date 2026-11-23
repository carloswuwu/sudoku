/*
 * 外观设置与“我的记录”测试（jsdom）：node tests/records.test.js
 * 需要先在 tests/ 下安装 jsdom：npm install --prefix tests
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const APP_URL = 'http://localhost/';

/* 从本地磁盘加载资源，并使用 http:// 源以获得可用的 localStorage */
class LocalFileLoader extends ResourceLoader {
  fetch(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return null;
    }
    if (parsed.origin !== 'http://localhost') return null;
    let rel = decodeURIComponent(parsed.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel.replace(/^\/+/, ''));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    try {
      return Promise.resolve(fs.readFileSync(file));
    } catch (err) {
      return null;
    }
  }
}

let passed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed++;
  } else {
    failures.push(message);
    console.log('  ✗ ' + message);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, message + '  (期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createDom(seed) {
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => consoleErrors.push('jsdomError: ' + (err && err.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push('console.error: ' + args.join(' ')));

  const dom = new JSDOM(html, {
    url: APP_URL,
    runScripts: 'dangerously',
    resources: new LocalFileLoader(),
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      /* 可控的 prefers-color-scheme 桩，便于测试“跟随系统” */
      window.__themeMedia = { matches: false, listeners: [] };
      window.matchMedia = function (query) {
        return {
          get matches() {
            return window.__themeMedia.matches;
          },
          media: query,
          addEventListener(type, listener) {
            if (type === 'change') window.__themeMedia.listeners.push(listener);
          },
          removeEventListener() {},
          addListener(listener) {
            window.__themeMedia.listeners.push(listener);
          },
          removeListener() {},
        };
      };
      window.__setSystemDark = function (dark) {
        window.__themeMedia.matches = dark;
        window.__themeMedia.listeners.forEach((listener) => listener({ matches: dark }));
      };
      if (seed && typeof seed === 'object') {
        if (seed.theme) window.localStorage.setItem('sudoku-theme-v1', seed.theme);
        if (seed.records !== undefined) {
          window.localStorage.setItem('sudoku-records-v1', seed.records);
        }
      }
    },
  });
  const { window } = dom;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('页面加载超时')), 8000);
    window.addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(150);
  return { dom, window, document: window.document, consoleErrors };
}

function readRecords(window) {
  var raw = window.localStorage.getItem('sudoku-records-v1');
  return raw ? JSON.parse(raw) : null;
}

async function main() {
  let current = await createDom();
  try {
    const $ = (id) => current.document.getElementById(id);
    const click = (el) => {
      if (!el) throw new Error('click: 元素不存在');
      el.dispatchEvent(new current.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    const press = (key) => {
      current.document.dispatchEvent(
        new current.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    };

    console.log('\n[1] 设置弹窗与主题切换');
    eq(current.document.documentElement.getAttribute('data-theme'), 'light', '默认主题为浅色（系统浅色）');
    eq(current.document.documentElement.getAttribute('data-theme-mode'), 'auto', '默认模式为跟随系统');
    click($('settingsBtn'));
    ok(!$('settingsModal').hidden, '设置弹窗打开');
    await sleep(20);
    const selectedCard = current.document.querySelector('.theme-card.selected');
    eq(selectedCard && selectedCard.getAttribute('data-theme-mode'), 'auto', '设置弹窗默认选中跟随系统');
    eq(current.document.activeElement, selectedCard, '焦点进入当前选中的主题卡片');
    eq(selectedCard.getAttribute('aria-pressed'), 'true', '当前主题 aria-pressed=true');

    click(current.document.querySelector('.theme-card[data-theme-mode="dark"]'));
    eq(current.document.documentElement.getAttribute('data-theme'), 'dark', '选择深色后立即生效');
    eq(current.window.localStorage.getItem('sudoku-theme-v1'), 'dark', '深色选择写入 localStorage');
    eq(current.document.querySelector('.theme-card[data-theme-mode="dark"]').getAttribute('aria-pressed'), 'true', '深色卡片 aria-pressed=true');
    eq(current.document.querySelector('.theme-card[data-theme-mode="auto"]').getAttribute('aria-pressed'), 'false', '其他卡片 aria-pressed=false');

    click(current.document.querySelector('.theme-card[data-theme-mode="light"]'));
    eq(current.document.documentElement.getAttribute('data-theme'), 'light', '选择浅色后立即生效');
    eq(current.window.localStorage.getItem('sudoku-theme-v1'), 'light', '浅色选择写入 localStorage');

    click(current.document.querySelector('.theme-card[data-theme-mode="auto"]'));
    eq(current.document.documentElement.getAttribute('data-theme-mode'), 'auto', '可以切回跟随系统');
    eq(current.document.documentElement.getAttribute('data-theme'), 'light', '跟随系统时按当前系统偏好解析');

    current.window.__setSystemDark(true);
    await sleep(20);
    eq(current.document.documentElement.getAttribute('data-theme'), 'dark', '跟随系统模式下响应系统切换到深色');
    current.window.__setSystemDark(false);
    await sleep(20);
    eq(current.document.documentElement.getAttribute('data-theme'), 'light', '跟随系统模式下响应系统切换回浅色');

    press('Escape');
    ok($('settingsModal').hidden, 'Esc 关闭设置弹窗');
    eq(current.document.activeElement, $('settingsBtn'), '关闭后焦点回到设置按钮');

    console.log('\n[2] 主题设置持久化');
    const persisted = await createDom({ theme: 'dark' });
    try {
      eq(persisted.document.documentElement.getAttribute('data-theme'), 'dark', '重新打开后恢复深色主题');
      eq(persisted.document.documentElement.getAttribute('data-theme-mode'), 'dark', '重新打开后恢复主题模式');
      persisted.document.getElementById('settingsBtn').dispatchEvent(
        new persisted.window.MouseEvent('click', { bubbles: true })
      );
      ok(
        persisted.document.querySelector('.theme-card[data-theme-mode="dark"]').classList.contains('selected'),
        '设置弹窗中深色卡片为选中状态'
      );
    } finally {
      persisted.dom.window.close();
    }

    console.log('\n[3] 完成一局后写入记录');
    current.dom.window.close();
    current = await createDom();
    const $2 = (id) => current.document.getElementById(id);
    const click2 = (el) => {
      if (!el) throw new Error('click: 元素不存在');
      el.dispatchEvent(new current.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    const press2 = (key) => {
      current.document.dispatchEvent(
        new current.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    };

    click2($2('newGameBtn'));
    await sleep(20);
    click2(current.document.querySelector('.size-card[data-size="4"]'));
    click2(current.document.querySelector('.diff-btn[data-difficulty="easy"]'));
    click2($2('startGameBtn'));
    await sleep(450);
    eq(current.document.querySelectorAll('#board .cell').length, 16, '开始 4×4 简单局');

    let guard = 0;
    while ($2('winOverlay').hidden && guard < 30) {
      click2($2('hintBtn'));
      guard++;
      await sleep(25);
    }
    ok(!$2('winOverlay').hidden, '提示填满后出现胜利弹窗');

    const saved = readRecords(current.window);
    ok(Array.isArray(saved), '记录已写入 localStorage');
    eq(saved && saved.length, 1, '完成一局后只写入一条记录');
    const record = saved && saved[0];
    ok(!!record, '记录内容存在');
    if (record) {
      eq(record.size, 4, '记录棋盘尺寸为 4');
      eq(record.difficulty, 'easy', '记录难度为简单');
      ok(Number.isFinite(record.elapsed) && record.elapsed >= 0, '记录用时有效');
      ok(Number.isInteger(record.mistakes) && record.mistakes >= 0, '记录错误数有效');
      ok(Number.isInteger(record.hints) && record.hints >= 0, '记录提示数有效');
      ok(Number.isFinite(record.completedAt) && record.completedAt > 0, '记录完成时间有效');
    }

    press2('Escape');
    ok($2('winOverlay').hidden, 'Esc 关闭胜利弹窗');

    click2($2('recordsBtn'));
    ok(!$2('recordsModal').hidden, '我的记录弹窗打开');
    await sleep(20);
    eq(current.document.querySelectorAll('#recordSummary .record-stat').length, 4, '记录概览包含 4 项统计');
    eq(current.document.querySelectorAll('#recordList .record-item').length, 1, '最近完成列表包含 1 局');
    ok($2('recordList').textContent.indexOf('4×4 · 简单') >= 0, '记录条目显示模式');
    ok($2('recordBestSection').hidden === false, '有记录时显示最佳成绩');
    const bestTimeCells = current.document.querySelectorAll('#recordBests .record-best-row:not(.record-best-head) span.is-best');
    ok(bestTimeCells.length >= 1, '最佳成绩至少有一项时间');
    eq($2('clearRecordsBtn').disabled, false, '有记录时清空按钮可用');
    const dialogFocused = current.document.activeElement;
    ok(!!dialogFocused, '记录弹窗打开后焦点在弹窗内');
    ok($2('recordsModal').contains(dialogFocused), '焦点位于记录弹窗内');

    console.log('\n[4] 两步确认清空记录');
    click2($2('clearRecordsBtn'));
    eq($2('clearRecordsBtn').textContent, '再点一次清空', '第一次点击进入确认状态');
    eq(readRecords(current.window).length, 1, '第一次点击不会删除记录');
    click2($2('clearRecordsBtn'));
    eq(readRecords(current.window).length, 0, '第二次点击清空记录');
    ok(!$2('recordEmpty').hidden, '无记录时显示空状态');
    eq($2('recordBestSection').hidden, true, '无记录时隐藏最佳成绩');
    eq($2('recordListSection').hidden, true, '无记录时隐藏最近完成');
    eq($2('clearRecordsBtn').disabled, true, '无记录时清空按钮禁用');
    click2(current.document.querySelector('#recordsModal .js-cancel-records'));
    ok($2('recordsModal').hidden, '完成按钮关闭记录弹窗');

    console.log('\n[5] 损坏记录数据容错');
    const broken = await createDom({ records: '{not valid json' });
    try {
      const bdoc = broken.document;
      bdoc.getElementById('recordsBtn').dispatchEvent(new broken.window.MouseEvent('click', { bubbles: true }));
      const bwindow = broken.window;
      await sleep(20);
      ok(!bdoc.getElementById('recordsModal').hidden, '损坏数据时仍可打开记录弹窗');
      eq(bdoc.querySelectorAll('#recordList .record-item').length, 0, '损坏数据被安全忽略');
      ok(!bdoc.getElementById('recordEmpty').hidden, '损坏数据时显示空状态');
      ok(
        broken.consoleErrors.filter((e) => !/Not implemented: window.confirm/.test(e)).length === 0,
        '损坏数据不会产生脚本错误'
      );
      bwindow.close();
    } finally {
      /* 已在 try 内关闭 */
    }

    console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
  } finally {
    try {
      current.dom.window.close();
    } catch (err) {
      /* 已关闭 */
    }
  }
  if (failures.length) {
    console.log('\n失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n测试异常终止：', err);
  process.exitCode = 1;
});
