/*
 * 界面逻辑测试（jsdom）：node tests/ui.test.js
 * 需要先在 tests/ 下安装 jsdom：npm install --prefix tests jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fileUrl = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/');

const consoleErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => consoleErrors.push('jsdomError: ' + (err && err.message)));
virtualConsole.on('error', (...args) => consoleErrors.push('console.error: ' + args.join(' ')));

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

async function main() {
  const dom = new JSDOM(html, {
    url: fileUrl,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('页面加载超时')), 8000);
    window.addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(120);

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

  console.log('\n[2] 点击选择 + 数字键盘填入 / 擦除');
  let empty = firstEmptyCell();
  click(empty);
  ok(empty.classList.contains('selected'), '点击格子后进入选中状态');
  ok(empty.classList.contains('peer') === false, '选中格不应带有 peer 样式');
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

  console.log('\n[3] 提示 + 撤销');
  const beforeHint = hintsCount();
  click($('hintBtn'));
  eq(hintsCount(), beforeHint + 1, '提示计数加 1');
  ok(numOf(empty) !== '', '提示填入了一个数字');
  click($('undoBtn'));
  eq(numOf(empty), '', '撤销后数字被还原');
  eq(hintsCount(), beforeHint, '撤销后提示计数还原');

  console.log('\n[4] 笔记模式');
  const noteCell = firstEmptyCell();
  click(noteCell);
  click($('notesBtn'));
  eq($('notesBtn').getAttribute('aria-pressed'), 'true', '笔记模式已开启');
  press('5');
  ok(noteCell.querySelector('.notes').classList.contains('show'), '笔记层显示');
  ok(Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), '笔记包含数字 5');
  press('5');
  ok(!Array.from(noteCell.querySelectorAll('.note')).some((n) => n.textContent === '5'), '再次按 5 移除笔记');
  click($('notesBtn'));
  eq($('notesBtn').getAttribute('aria-pressed'), 'false', '笔记模式已关闭');

  console.log('\n[5] 暂停 / 继续');
  click($('pauseBtn'));
  ok(!$('pauseOverlay').hidden, '暂停遮罩显示');
  ok($('board').classList.contains('blurred'), '暂停时棋盘模糊');
  click($('resumeBtn'));
  ok($('pauseOverlay').hidden, '继续后遮罩隐藏');
  ok(!$('board').classList.contains('blurred'), '继续后棋盘恢复');

  console.log('\n[6] 计时器');
  await sleep(1250);
  ok($('timer').textContent !== '00:00', '计时器在走动：' + $('timer').textContent);

  console.log('\n[7] 新游戏：4×4 简单');
  click($('newGameBtn'));
  ok(!$('newGameModal').hidden, '新游戏弹窗打开');
  click(document.querySelector('.size-card[data-size="4"]'));
  click(document.querySelector('.diff-btn[data-difficulty="easy"]'));
  click($('startGameBtn'));
  await sleep(400);
  eq(cells().length, 16, '切换为 4×4 棋盘（16 格）');
  eq(badge(), '4×4 · 简单', '模式徽章更新为 4×4 简单');
  eq($('timer').textContent, '00:00', '新游戏计时器归零');
  eq($('mistakes').textContent, '0', '新游戏错误数归零');
  eq($('hints').textContent, '0', '新游戏提示数归零');

  console.log('\n[8] 键盘方向键移动选中格');
  click(cellAt(0, 0));
  press('ArrowRight');
  ok(cellAt(0, 1).classList.contains('selected'), '按 → 后选中格右移');

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
  let storageOk = true;
  try {
    const saved = window.localStorage.getItem('sudoku-save-v1');
    ok(!!saved, '游戏进度已写入 localStorage');
    if (saved) {
      const data = JSON.parse(saved);
      eq(data.size, 6, '保存的棋盘尺寸为 6');
      ok(Array.isArray(data.puzzle) && data.puzzle.length === 6, '保存的题目数据完整');
    }
  } catch (err) {
    storageOk = false;
    console.log('  ! jsdom localStorage 不可用，跳过：' + err.message);
  }

  if (consoleErrors.length) {
    console.log('\n控制台错误：');
    consoleErrors.forEach((e) => console.log('  ' + e));
  }
  ok(consoleErrors.filter((e) => !/Not implemented: window.confirm/.test(e)).length === 0, '页面无脚本运行错误');

  console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
  dom.window.close();
  if (failures.length) {
    console.log('\n失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n测试异常终止：', err);
  process.exitCode = 1;
});
