/*
 * 界面逻辑测试（jsdom）：node tests/ui.test.js
 * 需要先在 tests/ 下安装 jsdom：npm install --prefix tests
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const APP_URL = 'http://localhost/';

/* 用 http:// 源运行，jsdom 才会提供 localStorage（file:// 是 opaque origin）。
 * 资源从本地磁盘读取，测试不依赖网络。 */
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

async function createDom(seedSave) {
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
      if (seedSave) window.localStorage.setItem('sudoku-save-v1', seedSave);
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
  await sleep(120);
  return { dom, window, document: window.document, consoleErrors };
}

async function main() {
  const primary = await createDom();
  const { window, document } = primary;
  try {
    const $ = (id) => document.getElementById(id);
    const click = (el) => {
      if (!el) throw new Error('click: 元素不存在');
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    const press = (key, options) => {
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, options || {}))
      );
    };
    const cells = () => Array.from(document.querySelectorAll('#board .cell'));
    const cellAt = (r, c) => document.querySelector('#board .cell[data-r="' + r + '"][data-c="' + c + '"]');
    const numOf = (cell) => cell.querySelector('.num').textContent;
    const firstEmptyCell = () => document.querySelector('#board .cell:not(.given)');
    const hintsCount = () => Number($('hints').textContent);
    const mistakesCount = () => Number($('mistakes').textContent);
    const badge = () => $('modeBadge').textContent;

    console.log('\n[1] 初始化');
    ok(typeof window.SudokuCore === 'object' && typeof window.SudokuCore.generatePuzzle === 'function', 'SudokuCore 已加载');
    eq(cells().length, 81, '默认生成 9×9 棋盘');
    ok(document.querySelectorAll('#board .cell.given').length > 0, '棋盘包含题目数字');
    eq(badge(), '9×9 · 中等', '模式徽章显示 9×9 中等');
    eq($('timer').textContent, '00:00', '初始计时器为 00:00');
    eq($('mistakes').textContent, '0', '初始错误数为 0');
    eq($('notesBtn').getAttribute('aria-pressed'), 'false', '笔记模式默认关闭');
    eq(document.querySelectorAll('#board .board-row[role="row"]').length, 9, '棋盘包含 9 个 ARIA 行容器');
    eq($('board').getAttribute('aria-rowcount'), '9', '棋盘声明行数');
    eq(document.querySelectorAll('#board .cell[role="gridcell"]').length, 81, '每个格子暴露 gridcell 角色');
    eq(document.querySelectorAll('#board .cell[tabindex="0"]').length, 1, '棋盘只有一个 Tab 停留点（roving tabindex）');

    console.log('\n[2] 点击选择 + 数字键盘填入 / 擦除');
    let empty = firstEmptyCell();
    click(empty);
    ok(empty.classList.contains('selected'), '点击格子后进入选中状态');
    ok(empty.classList.contains('peer') === false, '选中格不应带有 peer 样式');
    eq(empty.getAttribute('aria-selected'), 'true', '选中格 aria-selected=true');
    eq(empty.getAttribute('tabindex'), '0', '选中格成为棋盘焦点');
    click(document.querySelector('#pad .pad-btn[data-d="1"]'));
    eq(numOf(empty), '1', '点击数字键盘后填入数字 1');
    press('Backspace');
    eq(numOf(empty), '', 'Backspace 擦除数字');

    console.log('\n[2b] 冲突标红只依据行/列/宫的重复数字');
    const valueOf = (cell) => Number(numOf(cell) || 0);
    const boxOf9 = (r, c) => Math.floor(r / 3) * 3 + Math.floor(c / 3);
    let conflictCase = null;
    for (const givenCell of Array.from(document.querySelectorAll('#board .cell.given'))) {
      const givenValue = valueOf(givenCell);
      const gr = Number(givenCell.dataset.r);
      const gc = Number(givenCell.dataset.c);
      for (const candidate of Array.from(document.querySelectorAll('#board .cell:not(.given)'))) {
        if (valueOf(candidate)) continue;
        const cr = Number(candidate.dataset.r);
        const cc = Number(candidate.dataset.c);
        if (cr === gr || cc === gc || boxOf9(cr, cc) === boxOf9(gr, gc)) {
          conflictCase = { givenCell, givenValue, cell: candidate };
          break;
        }
      }
      if (conflictCase) break;
    }
    ok(!!conflictCase, '找到与题目数字同行/列/宫的空格');
    if (conflictCase) {
      const mistakesBefore = mistakesCount();
      click(conflictCase.cell);
      click(document.querySelector('#pad .pad-btn[data-d="' + conflictCase.givenValue + '"]'));
      ok(conflictCase.cell.classList.contains('conflict'), '与同行/列/宫已有数字重复的新格子标红');
      ok(conflictCase.givenCell.classList.contains('conflict'), '发生冲突的题目格子也标红');
      eq(mistakesCount(), mistakesBefore + 1, '冲突时错误计数 +1');
      press('Backspace');
      ok(!conflictCase.cell.classList.contains('conflict') && !conflictCase.givenCell.classList.contains('conflict'), '擦除后冲突标红消失');
    }

    const usedDigitsAt = (r, c) => {
      const used = new Set();
      for (let i = 0; i < 9; i++) {
        const rowValue = valueOf(cellAt(r, i));
        const colValue = valueOf(cellAt(i, c));
        if (rowValue) used.add(rowValue);
        if (colValue) used.add(colValue);
      }
      const br = Math.floor(r / 3) * 3;
      const bc = Math.floor(c / 3) * 3;
      for (let rr = br; rr < br + 3; rr++) {
        for (let cc = bc; cc < bc + 3; cc++) {
          const v = valueOf(cellAt(rr, cc));
          if (v) used.add(v);
        }
      }
      return used;
    };
    let freePlacement = null;
    for (const candidate of Array.from(document.querySelectorAll('#board .cell:not(.given)'))) {
      if (valueOf(candidate)) continue;
      const used = usedDigitsAt(Number(candidate.dataset.r), Number(candidate.dataset.c));
      for (let d = 1; d <= 9; d++) {
        if (!used.has(d)) {
          freePlacement = { cell: candidate, digit: d };
          break;
        }
      }
      if (freePlacement) break;
    }
    ok(!!freePlacement, '找到不会产生冲突的空格与数字');
    if (freePlacement) {
      click(freePlacement.cell);
      click(document.querySelector('#pad .pad-btn[data-d="' + freePlacement.digit + '"]'));
      ok(!freePlacement.cell.classList.contains('conflict'), '不冲突的数字不会被标红');
      press('Backspace');
      eq(numOf(freePlacement.cell), '', '测试后擦除数字');
    }

    console.log('\n[3] 逻辑提示 + 撤销');
    const userFilledCount = () =>
      Array.from(document.querySelectorAll('#board .cell:not(.given)')).filter(
        (cell) => cell.querySelector('.num').textContent !== ''
      ).length;
    const beforeHint = hintsCount();
    const beforeFilled = userFilledCount();
    click($('hintBtn'));
    eq(hintsCount(), beforeHint + 1, '提示计数加 1');
    eq(userFilledCount(), beforeFilled + 1, '提示填入了一个数字');
    ok(!$('hintCard').hidden, '提示说明卡片显示');
    ok($('hintTitle').textContent.length > 0, '提示包含技巧标题：' + $('hintTitle').textContent);
    ok($('hintText').textContent.length > 10, '提示包含推理说明');
    eq(document.querySelectorAll('#board .cell.hint-target').length, 1, '目标格有提示动画标记');
    ok(document.querySelectorAll('#board .cell.hint-glow').length > 0, '相关格子有提示高亮');
    click($('hintClose'));
    ok($('hintCard').hidden, '关闭按钮可隐藏提示卡片');
    click($('undoBtn'));
    eq(hintsCount(), beforeHint, '撤销后提示计数还原');
    eq(userFilledCount(), beforeFilled, '撤销后盘面还原');
    ok(!document.querySelector('#board .cell.hint-target'), '撤销后目标高亮清除');
    ok($('hintCard').hidden, '撤销后提示卡片隐藏');
    eq($('undoBtn').disabled, false, '撤销后仍有历史，撤销按钮可用');

    console.log('\n[4] 笔记模式');
    const noteCell = firstEmptyCell();
    click(noteCell);
    click($('notesBtn'));
    eq($('notesBtn').getAttribute('aria-pressed'), 'true', '笔记模式已开启');
    press('5');
    ok(noteCell.querySelector('.notes').classList.contains('show'), '笔记层显示');
    ok(Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), '笔记包含数字 5');
    ok(noteCell.getAttribute('aria-label').indexOf('笔记 5') >= 0, '笔记写入无障碍标签');
    eq($('undoBtn').disabled, false, '记笔记后撤销按钮可用');
    press('z', { ctrlKey: true });
    ok(!Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), 'Ctrl+Z 撤销笔记');
    eq($('notesBtn').getAttribute('aria-pressed'), 'true', '撤销不应关闭笔记模式');
    press('5');
    ok(Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), '重新添加笔记 5');
    press('5');
    ok(!Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), '再次按 5 移除笔记');
    click($('notesBtn'));
    eq($('notesBtn').getAttribute('aria-pressed'), 'false', '笔记模式已关闭');

    console.log('\n[5] 暂停 / 继续');
    click($('pauseBtn'));
    ok(!$('pauseOverlay').hidden, '暂停遮罩显示');
    ok($('board').classList.contains('blurred'), '暂停时棋盘模糊');
    ok($('pauseOverlay').getAttribute('role') === 'dialog', '暂停遮罩具有 dialog 语义');
    await sleep(40);
    eq(document.activeElement, $('resumeBtn'), '暂停后焦点移到继续按钮');
    const pausedTimer = $('timer').textContent;
    await sleep(1200);
    eq($('timer').textContent, pausedTimer, '暂停时计时器停止');
    click($('resumeBtn'));
    ok($('pauseOverlay').hidden, '继续后遮罩隐藏');
    ok(!$('board').classList.contains('blurred'), '继续后棋盘恢复');

    console.log('\n[6] 计时器');
    await sleep(1250);
    ok($('timer').textContent !== '00:00', '计时器在走动：' + $('timer').textContent);

    console.log('\n[6b] 重玩本局确认弹窗');
    const restartCell = firstEmptyCell();
    click(restartCell);
    click(document.querySelector('#pad .pad-btn[data-d="1"]'));
    const filledBeforeRestart = userFilledCount();
    ok(filledBeforeRestart > 0, '重玩前盘面有填入数字');
    click($('restartBtn'));
    ok(!$('restartModal').hidden, '重玩确认弹窗打开');
    ok(!!$('restartModal').querySelector('[role="dialog"]'), '重玩弹窗具有 dialog 语义');
    await sleep(20);
    eq(document.activeElement, $('restartCancelBtn'), '默认焦点在取消按钮');
    press('Escape');
    ok($('restartModal').hidden, 'Esc 取消重玩');
    eq(userFilledCount(), filledBeforeRestart, '取消后盘面保持不变');
    click($('restartBtn'));
    await sleep(20);
    click($('restartConfirmBtn'));
    await sleep(20);
    ok($('restartModal').hidden, '确认后关闭重玩弹窗');
    eq(userFilledCount(), 0, '确认后清空玩家填入');
    eq(mistakesCount(), 0, '重玩后错误数归零');
    eq($('hints').textContent, '0', '重玩后提示数归零');
    eq($('timer').textContent, '00:00', '重玩后计时器归零');
    eq($('undoBtn').disabled, true, '重玩后撤销历史清空');

    console.log('\n[7] 新游戏：4×4 简单');
    click($('newGameBtn'));
    ok(!$('newGameModal').hidden, '新游戏弹窗打开');
    await sleep(20);
    eq(document.activeElement, $('startGameBtn'), '弹窗打开后焦点进入弹窗');
    press('Escape');
    ok($('newGameModal').hidden, 'Esc 可关闭新游戏弹窗');
    click($('newGameBtn'));
    await sleep(20);
    click(document.querySelector('.size-card[data-size="4"]'));
    click(document.querySelector('.diff-btn[data-difficulty="easy"]'));
    click($('startGameBtn'));
    await sleep(400);
    eq(cells().length, 16, '切换为 4×4 棋盘（16 格）');
    eq(badge(), '4×4 · 简单', '模式徽章更新为 4×4 简单');
    /* 计时器每秒 +1，异步生成结束后可能已经跨过 1 秒，允许 00:00 / 00:01 */
    ok($('timer').textContent === '00:00' || $('timer').textContent === '00:01', '新游戏计时器已归零：' + $('timer').textContent);
    eq($('mistakes').textContent, '0', '新游戏错误数归零');
    eq($('hints').textContent, '0', '新游戏提示数归零');

    console.log('\n[8] 键盘方向键移动选中格');
    click(cellAt(0, 0));
    press('ArrowRight');
    ok(cellAt(0, 1).classList.contains('selected'), '按 → 后选中格右移');
    eq(document.activeElement, cellAt(0, 1), '按 → 后键盘焦点跟随选中格');
    eq(cellAt(0, 1).getAttribute('aria-selected'), 'true', '选中格 aria-selected=true');
    eq(cellAt(0, 0).getAttribute('aria-selected'), 'false', '旧选中格 aria-selected=false');

    console.log('\n[9] 通过反复提示完成一局（验证胜利流程）');
    let guard = 0;
    while ($('winOverlay').hidden && guard < 30) {
      click($('hintBtn'));
      guard++;
      await sleep(30);
    }
    ok(!$('winOverlay').hidden, '完成棋盘后显示胜利弹窗');
    eq($('winOverlay').hidden, false, '胜利弹窗可见');
    ok($('winTime').textContent.length > 0, '胜利弹窗显示用时：' + $('winTime').textContent);
    ok($('winDifficulty').textContent.indexOf('4×4') === 0, '胜利弹窗显示模式：' + $('winDifficulty').textContent);
    eq($('winHints').textContent, String(hintsCount()), '胜利弹窗提示数与面板一致');
    await sleep(20);
    eq(document.activeElement, $('playAgainBtn'), '胜利弹窗打开后焦点进入弹窗');

    console.log('\n[10] 胜利弹窗 → 换个难度 → 取消，应回到胜利弹窗');
    click($('changeSettingsBtn'));
    ok(!$('newGameModal').hidden, '胜利后可以打开新游戏弹窗');
    click(document.querySelector('.js-cancel-new'));
    await sleep(50);
    ok(!$('winOverlay').hidden, '取消新游戏后重新显示胜利弹窗');

    console.log('\n[11] 再来一局');
    click($('playAgainBtn'));
    await sleep(400);
    ok($('winOverlay').hidden, '胜利弹窗关闭');
    eq(cells().length, 16, '再来一局仍是 4×4');

    console.log('\n[12] 6×6 模式');
    click($('newGameBtn'));
    click(document.querySelector('.size-card[data-size="6"]'));
    click(document.querySelector('.diff-btn[data-difficulty="medium"]'));
    click($('startGameBtn'));
    await sleep(400);
    eq(cells().length, 36, '切换为 6×6 棋盘（36 格）');
    eq(badge(), '6×6 · 中等', '模式徽章更新为 6×6 中等');
    const given6 = document.querySelectorAll('#board .cell.given').length;
    ok(given6 > 0 && given6 < 36, '6×6 题目提示数合理：' + given6);

    console.log('\n[13] 刷新后恢复进度（localStorage）');
    const saved = window.localStorage.getItem('sudoku-save-v1');
    ok(!!saved, '游戏进度已写入 localStorage');
    ok(saved && JSON.parse(saved).size === 6, '保存的棋盘尺寸为 6');
    if (saved) {
      const data = JSON.parse(saved);
      ok(Array.isArray(data.puzzle) && data.puzzle.length === 6, '保存的题目数据完整');
      const restored = await createDom(saved);
      try {
        const rdoc = restored.document;
        eq(rdoc.querySelectorAll('#board .cell').length, 36, '重新加载后恢复 6×6 棋盘');
        eq(rdoc.getElementById('modeBadge').textContent, '6×6 · 中等', '重新加载后恢复模式徽章');
        eq(rdoc.getElementById('mistakes').textContent, String(data.mistakes), '重新加载后恢复错误数');
        eq(rdoc.getElementById('hints').textContent, String(data.hints), '重新加载后恢复提示数');
        eq(rdoc.querySelectorAll('#board .cell.given').length, given6, '重新加载后题目数字一致');
      } finally {
        restored.dom.window.close();
      }
    }

    const consoleErrors = primary.consoleErrors;
    if (consoleErrors.length) {
      console.log('\n控制台错误：');
      consoleErrors.forEach((e) => console.log('  ' + e));
    }
    ok(consoleErrors.filter((e) => !/Not implemented: window.confirm/.test(e)).length === 0, '页面无脚本运行错误');

    console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
  } finally {
    primary.dom.window.close();
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
