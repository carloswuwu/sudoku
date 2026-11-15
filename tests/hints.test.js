/* 逻辑提示引擎测试：node tests/hints.test.js */
'use strict';

const assert = require('assert');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'sudoku-core.js'));
const Hints = require(path.join(__dirname, '..', 'sudoku-hints.js'));

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

function clone(grid) {
  return grid.map(function (row) {
    return row.slice();
  });
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

function emptyCells(grid) {
  const cells = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) {
      if (!grid[r][c]) cells.push([r, c]);
    }
  }
  return cells;
}

function testNakedSingle() {
  const solution = [
    [1, 2, 3, 4],
    [3, 4, 1, 2],
    [2, 1, 4, 3],
    [4, 3, 2, 1],
  ];
  const grid = clone(solution);
  grid[0][0] = 0;
  const hint = Hints.findHint(grid, 4, solution, { r: 0, c: 0 });
  check(hint.ok, '唯一候选数：应给出提示');
  check(hint.type === 'naked-single', '唯一候选数：类型正确');
  check(hint.cell.r === 0 && hint.cell.c === 0, '唯一候选数：目标格正确');
  check(hint.value === 1, '唯一候选数：数字正确');
  check(hint.explanation.indexOf('只剩一个候选数 1') >= 0, '唯一候选数：说明包含推理');
  check(hint.highlights.length > 0, '唯一候选数：提供高亮格子');
}

function testHiddenSingleRow() {
  const grid = Core.emptyGrid(9);
  // 第 1–8 列各放一个 5，且互不同行、不同宫；行 0 的 5 只能放在第 1 列
  const positions = [
    [3, 1],
    [6, 2],
    [1, 3],
    [4, 4],
    [7, 5],
    [2, 6],
    [5, 7],
    [8, 8],
  ];
  positions.forEach(function (pos) {
    grid[pos[0]][pos[1]] = 5;
  });
  check(Core.findConflicts(grid, 9).size === 0, '行内唯一：构造盘面无冲突');
  check(Hints.computeCandidates(grid, 9)[0][0].length > 1, '行内唯一：目标格不是唯一候选数');
  const hint = Hints.findHint(grid, 9, null, null);
  check(hint.ok, '行内唯一：应给出提示');
  check(hint.type === 'hidden-single', '行内唯一：类型正确');
  check(hint.cell.r === 0 && hint.cell.c === 0, '行内唯一：目标格正确');
  check(hint.value === 5, '行内唯一：数字正确');
  check(hint.explanation.indexOf('行') >= 0 && hint.explanation.indexOf('5') >= 0, '行内唯一：说明包含行与数字');
}

function testConflictAndInvalid() {
  const grid = Core.emptyGrid(4);
  grid[0][0] = 1;
  grid[0][1] = 1;
  const conflict = Hints.findHint(grid, 4, null, null);
  check(!conflict.ok && conflict.reason === 'conflict', '冲突盘面：拒绝给出提示');
  check(conflict.explanation.indexOf('冲突') >= 0, '冲突盘面：说明提示先修正冲突');

  const solved = [
    [1, 2, 3, 4],
    [3, 4, 1, 2],
    [2, 1, 4, 3],
    [4, 3, 2, 1],
  ];
  const wrongGrid = Core.emptyGrid(4);
  wrongGrid[0][0] = 3; // 与唯一解不一致
  const invalid = Hints.findHint(wrongGrid, 4, solved, null);
  check(!invalid.ok && invalid.reason === 'invalid', '错误填写：拒绝给出提示');

  const complete = Hints.findHint(solved, 4, solved, null);
  check(!complete.ok && complete.reason === 'complete', '填满棋盘：提示已经完成');
}

function testNakedPairTechnique() {
  const units = Hints.getUnits(9);
  const candidates = [];
  for (let r = 0; r < 9; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) row.push([]);
    candidates.push(row);
  }
  candidates[0][1] = [4, 7];
  candidates[0][2] = [4, 7];
  candidates[0][3] = [1, 4, 7];
  const pair = Hints.findNakedPairHint(units, candidates, 9);
  check(!!pair, '数对排除：应找到数对');
  check(pair.cell[0] === 0 && pair.cell[1] === 3, '数对排除：目标格正确');
  check(pair.value === 1, '数对排除：排除后候选数正确');
  check(pair.explanation.indexOf('4、7') >= 0, '数对排除：说明包含数对');
}

function testContradictionTechnique() {
  const game = Core.generatePuzzle(9, 'medium', Core.seedRandom(424242));
  const candidates = Hints.computeCandidates(game.puzzle, 9);
  let target = null;
  for (let r = 0; r < 9 && !target; r++) {
    for (let c = 0; c < 9 && !target; c++) {
      if (candidates[r][c].length >= 2) target = { r: r, c: c };
    }
  }
  check(!!target, '反证法：找到多候选格');
  if (target) {
    const result = Hints.findContradictionHint(game.puzzle, 9, candidates);
    check(!!result, '反证法：应能找到唯一可行候选数');
    if (result) {
      check(result.value === game.solution[result.cell[0]][result.cell[1]], '反证法：结果与唯一解一致');
    }
  }
}

function testSolveWithHints() {
  let seed = 777;
  for (const size of [4, 6, 9]) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const rng = Core.seedRandom(seed++);
      const game = Core.generatePuzzle(size, difficulty, rng);
      const grid = clone(game.puzzle);
      let hints = 0;
      let failed = false;
      while (hints < size * size + 5) {
        const hint = Hints.findHint(grid, size, game.solution, null);
        if (!hint.ok) {
          failed = hint.reason !== 'complete';
          break;
        }
        grid[hint.cell.r][hint.cell.c] = hint.value;
        hints++;
      }
      check(!failed, size + '×' + size + '/' + difficulty + '：提示过程中不应失败');
      check(JSON.stringify(grid) === JSON.stringify(game.solution), size + '×' + size + '/' + difficulty + '：全部提示应完成棋盘');
      check(hints <= size * size, size + '×' + size + '/' + difficulty + '：提示次数合理（' + hints + '）');
      console.log('  ' + size + '×' + size + ' ' + difficulty + '：' + hints + ' 次提示完成');
    }
  }
}

function testRandomStates() {
  const sizes = [4, 6, 9];
  const difficulties = ['easy', 'medium', 'hard'];
  let seed = 20261115;
  let hintCount = 0;
  const techniques = {};

  for (const size of sizes) {
    for (const difficulty of difficulties) {
      for (let round = 0; round < 2; round++) {
        const rng = Core.seedRandom(seed++);
        const game = Core.generatePuzzle(size, difficulty, rng);
        const fractions = [0, 0.35, 0.7];
        for (const fraction of fractions) {
          const grid = clone(game.puzzle);
          const empties = shuffle(emptyCells(grid), rng);
          const fillCount = Math.floor(empties.length * fraction);
          for (let i = 0; i < fillCount; i++) {
            const r = empties[i][0];
            const c = empties[i][1];
            grid[r][c] = game.solution[r][c];
          }
          const hint = Hints.findHint(grid, size, game.solution, null);
          const label = size + '×' + size + '/' + difficulty + ' 填充 ' + fraction;
          check(hint.ok, label + '：应能给出逻辑提示');
          if (!hint.ok) continue;
          hintCount++;
          techniques[hint.type] = (techniques[hint.type] || 0) + 1;
          check(hint.value === game.solution[hint.cell.r][hint.cell.c], label + '：提示数字与解一致');
          check(grid[hint.cell.r][hint.cell.c] === 0, label + '：提示格应为空');
          check(typeof hint.explanation === 'string' && hint.explanation.length > 10, label + '：说明文字足够详细');
          check(typeof hint.title === 'string' && hint.title.length > 0, label + '：包含提示标题');
          check(Array.isArray(hint.highlights), label + '：包含高亮列表');

          grid[hint.cell.r][hint.cell.c] = hint.value;
          check(Core.findConflicts(grid, size).size === 0, label + '：填入提示后没有冲突');
        }
      }
    }
  }
  check(hintCount > 0, '随机盘面：产生了提示');
  console.log('  随机盘面提示统计：' + JSON.stringify(techniques));
}

console.log('数独逻辑提示引擎测试');
testNakedSingle();
testHiddenSingleRow();
testConflictAndInvalid();
testNakedPairTechnique();
testContradictionTechnique();
testSolveWithHints();
testRandomStates();
console.log('\n全部通过 ✓  (' + checks + ' 项断言)');
