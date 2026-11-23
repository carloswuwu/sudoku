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

/* ------------------- 进阶技巧：直接构造候选数表测试 ------------------- */

/* 构造一个 size×size 的候选数表，[] 表示该格已填或与本次技巧无关 */
function candidateGrid(size) {
  const map = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push([]);
    map.push(row);
  }
  return map;
}

function hasElimination(hint, r, c, value) {
  return hint.eliminations.some(function (item) {
    return item.r === r && item.c === c && item.value === value;
  });
}

function testPointingTechnique() {
  const units = Hints.getUnits(9);

  // 区块对：第 1 宫的 5 只出现在第 1 行的两个格子里
  const candidates = candidateGrid(9);
  candidates[0][0] = [2, 5];
  candidates[0][1] = [3, 5];
  candidates[0][3] = [5, 9]; // 第 1 行、宫外，应被排除 5 后只剩 9
  const candidatesBefore = JSON.stringify(candidates);
  const hint = Hints.findPointingHint(units, candidates, 9);
  check(!!hint, '区块排除（对）：应找到提示');
  if (hint) {
    check(hint.type === 'pointing', '区块排除（对）：类型为 pointing');
    check(hint.title === '区块排除', '区块排除（对）：标题正确');
    check(hint.cell[0] === 0 && hint.cell[1] === 3, '区块排除（对）：目标格正确');
    check(hint.value === 9, '区块排除（对）：排除后应填 9');
    check(hasElimination(hint, 0, 3, 5), '区块排除（对）：排除了 r1c4 的候选数 5');
    check(hint.eliminations.length === 1, '区块排除（对）：只排除一个候选数');
    check(hint.pattern.indexOf('0:0') >= 0 && hint.pattern.indexOf('0:1') >= 0, '区块排除（对）：记录区块候选格');
    check(hint.highlights.indexOf('0:0') >= 0 && hint.highlights.indexOf('0:1') >= 0, '区块排除（对）：高亮包含区块候选格');
    check(hint.explanation.indexOf('宫') >= 0 && hint.explanation.indexOf('5') >= 0, '区块排除（对）：说明提到宫和数字');
    check(hint.explanation.indexOf('只剩 9') >= 0, '区块排除（对）：说明给出结论');
    check(JSON.stringify(candidates) === candidatesBefore, '区块排除（对）：不修改候选数表');
  }

  // 区块三：第 1 宫的 5 只出现在第 1 行的三个格子里
  const triple = candidateGrid(9);
  triple[0][0] = [2, 5];
  triple[0][1] = [3, 5];
  triple[0][2] = [4, 5];
  triple[0][4] = [5, 9];
  const tripleHint = Hints.findPointingHint(Hints.getUnits(9), triple, 9);
  check(!!tripleHint, '区块排除（三）：应找到提示');
  if (tripleHint) {
    check(tripleHint.value === 9 && tripleHint.cell[0] === 0 && tripleHint.cell[1] === 4, '区块排除（三）：目标格正确');
    check(hasElimination(tripleHint, 0, 4, 5), '区块排除（三）：排除了 r1c5 的候选数 5');
    check(tripleHint.pattern.length === 3, '区块排除（三）：记录三个区块候选格');
  }
}

function testClaimingTechnique() {
  const units = Hints.getUnits(9);

  // 行列排除：第 6 行的 7 只出现在左下宫内
  const candidates = candidateGrid(9);
  candidates[5][0] = [1, 7];
  candidates[5][2] = [4, 7];
  candidates[3][1] = [7, 8]; // 左下宫、第 6 行之外，应被排除 7 后只剩 8
  const candidatesBefore = JSON.stringify(candidates);
  const hint = Hints.findClaimingHint(units, candidates, 9);
  check(!!hint, '行列排除：应找到提示');
  if (hint) {
    check(hint.type === 'claiming', '行列排除：类型为 claiming');
    check(hint.title === '行列排除', '行列排除：标题正确');
    check(hint.cell[0] === 3 && hint.cell[1] === 1, '行列排除：目标格正确');
    check(hint.value === 8, '行列排除：排除后应填 8');
    check(hasElimination(hint, 3, 1, 7), '行列排除：排除了 r4c2 的候选数 7');
    check(hint.pattern.indexOf('5:0') >= 0 && hint.pattern.indexOf('5:2') >= 0, '行列排除：记录行内候选格');
    check(hint.highlights.indexOf('5:0') >= 0 && hint.highlights.indexOf('5:2') >= 0, '行列排除：高亮包含行内候选格');
    check(hint.explanation.indexOf('行') >= 0 && hint.explanation.indexOf('7') >= 0, '行列排除：说明提到行和数字');
    check(JSON.stringify(candidates) === candidatesBefore, '行列排除：不修改候选数表');
  }
}

function testXWingTechnique() {
  // 行内矩形：数字 4 在第 2、7 行的候选位置都只在第 3、8 列
  const rowMap = candidateGrid(9);
  rowMap[1][2] = [1, 4];
  rowMap[1][7] = [2, 4];
  rowMap[6][2] = [3, 4];
  rowMap[6][7] = [4, 5];
  rowMap[3][2] = [4, 6]; // 第 4 行、第 3 列，应被排除 4 后只剩 6
  const rowBefore = JSON.stringify(rowMap);
  const rowHint = Hints.findXWingHint(Hints.getUnits(9), rowMap, 9);
  check(!!rowHint, '矩形排除（行）：应找到提示');
  if (rowHint) {
    check(rowHint.type === 'x-wing', '矩形排除（行）：类型为 x-wing');
    check(rowHint.title === '矩形排除', '矩形排除（行）：标题正确');
    check(rowHint.cell[0] === 3 && rowHint.cell[1] === 2, '矩形排除（行）：目标格正确');
    check(rowHint.value === 6, '矩形排除（行）：排除后应填 6');
    check(hasElimination(rowHint, 3, 2, 4), '矩形排除（行）：排除了 r4c3 的候选数 4');
    check(rowHint.pattern.length === 4, '矩形排除（行）：矩形四个角都要高亮');
    check(
      ['1:2', '1:7', '6:2', '6:7'].every(function (key) {
        return rowHint.highlights.indexOf(key) >= 0;
      }),
      '矩形排除（行）：高亮包含矩形四角'
    );
    check(rowHint.explanation.indexOf('矩形') >= 0 && rowHint.explanation.indexOf('4') >= 0, '矩形排除（行）：说明提到矩形和数字');
    check(JSON.stringify(rowMap) === rowBefore, '矩形排除（行）：不修改候选数表');
  }

  // 列内矩形：数字 6 在第 2、6 列的候选位置都只在第 3、9 行
  const colMap = candidateGrid(9);
  colMap[2][1] = [1, 6];
  colMap[8][1] = [2, 6];
  colMap[2][5] = [3, 6];
  colMap[8][5] = [6, 7];
  colMap[2][7] = [6, 9]; // 第 3 行、第 8 列，应被排除 6 后只剩 9
  const colBefore = JSON.stringify(colMap);
  const colHint = Hints.findXWingHint(Hints.getUnits(9), colMap, 9);
  check(!!colHint, '矩形排除（列）：应找到提示');
  if (colHint) {
    check(colHint.cell[0] === 2 && colHint.cell[1] === 7, '矩形排除（列）：目标格正确');
    check(colHint.value === 9, '矩形排除（列）：排除后应填 9');
    check(hasElimination(colHint, 2, 7, 6), '矩形排除（列）：排除了 r3c8 的候选数 6');
    check(JSON.stringify(colMap) === colBefore, '矩形排除（列）：不修改候选数表');
  }
}

/* ------------------------- 难度分析（analyzeDifficulty） ------------------------- */

/* 以下三个盘面由固定种子生成的 9×9 唯一解谜题雕刻而来，用于确定性的难度分层测试：
 * TIER2 需要数对排除，TIER3 需要区块排除，TIER4 需要矩形排除。 */
const TIER2_BOARD = [
  [0, 3, 0, 9, 0, 0, 5, 1, 0],
  [0, 0, 0, 8, 2, 0, 9, 0, 0],
  [0, 0, 1, 0, 0, 6, 2, 0, 0],
  [1, 0, 0, 0, 0, 0, 0, 4, 6],
  [0, 0, 2, 7, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 5, 0, 6, 0, 0, 3, 0],
  [3, 0, 4, 2, 0, 0, 0, 0, 0],
  [0, 8, 0, 0, 0, 7, 0, 2, 0],
];

const TIER3_BOARD = [
  [0, 2, 0, 0, 8, 0, 0, 0, 1],
  [5, 0, 0, 7, 0, 0, 0, 6, 0],
  [6, 0, 1, 2, 0, 0, 0, 0, 4],
  [0, 0, 0, 0, 0, 0, 5, 0, 3],
  [8, 1, 0, 0, 0, 5, 0, 0, 0],
  [9, 6, 0, 0, 0, 0, 7, 0, 0],
  [0, 3, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 8, 0, 0, 0, 6, 0, 7],
  [0, 0, 0, 0, 0, 3, 0, 0, 0],
];

const TIER4_BOARD = [
  [0, 8, 0, 0, 0, 0, 3, 0, 9],
  [4, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 7, 8, 0, 2],
  [0, 1, 0, 7, 0, 0, 0, 0, 0],
  [0, 4, 0, 0, 6, 0, 1, 0, 8],
  [0, 0, 3, 0, 0, 5, 2, 0, 0],
  [0, 9, 0, 0, 0, 0, 0, 0, 0],
  [5, 0, 0, 1, 8, 6, 0, 0, 3],
  [7, 0, 0, 0, 0, 0, 0, 8, 0],
];

function testAnalyzeDifficulty() {
  // 1) 接近完成的盘面：只需要单数技巧
  const solution = [
    [1, 2, 3, 4],
    [3, 4, 1, 2],
    [2, 1, 4, 3],
    [4, 3, 2, 1],
  ];
  const easyGrid = clone(solution);
  easyGrid[0][0] = 0;
  easyGrid[3][3] = 0;
  const easyBefore = JSON.stringify(easyGrid);
  const easy = Hints.analyzeDifficulty(easyGrid, 4);
  check(easy.solved, '难度分析：接近完成的盘面应只用逻辑解开');
  check(easy.maxTier === 1, '难度分析：只用单数技巧时 maxTier 为 1');
  check(easy.remaining === 0, '难度分析：解开后剩余 0 格');
  check((easy.techniques['naked-single'] || 0) > 0, '难度分析：统计到唯一候选数');
  check(JSON.stringify(easyGrid) === easyBefore, '难度分析：不修改接近完成的输入棋盘');

  // 2) 需要排除类技巧的盘面：难度层级应提高
  const tiers = [
    { name: '数对', board: TIER2_BOARD, tier: 2, technique: 'naked-pair' },
    { name: '区块', board: TIER3_BOARD, tier: 3, technique: 'pointing' },
    { name: '矩形', board: TIER4_BOARD, tier: 4, technique: 'x-wing' },
  ];
  tiers.forEach(function (item) {
    const before = JSON.stringify(item.board);
    const result = Hints.analyzeDifficulty(item.board, 9);
    check(result.solved, '难度分析：' + item.name + '盘面应能被逻辑解开');
    check(
      result.maxTier === item.tier,
      '难度分析：' + item.name + '盘面 maxTier 应为 ' + item.tier + '（实际 ' + result.maxTier + '）'
    );
    check(result.remaining === 0, '难度分析：' + item.name + '盘面解开后剩余 0 格');
    check(
      (result.techniques[item.technique] || 0) > 0,
      '难度分析：' + item.name + '盘面应使用 ' + item.technique
    );
    check(JSON.stringify(item.board) === before, '难度分析：不修改输入棋盘（' + item.name + '）');
  });

  // 3) 逻辑无法解开的盘面
  const empty = Core.emptyGrid(9);
  const stuck = Hints.analyzeDifficulty(empty, 9);
  check(!stuck.solved, '难度分析：空盘无法只用逻辑解开');
  check(stuck.maxTier === 0, '难度分析：空盘没有用到任何技巧');
  check(stuck.remaining === 81, '难度分析：空盘剩余 81 格');
  check(Object.keys(stuck.techniques).length === 0, '难度分析：空盘技巧统计为空');

  // 4) 确定性：同一盘面重复分析结果一致
  const first = JSON.stringify(Hints.analyzeDifficulty(TIER4_BOARD, 9));
  const second = JSON.stringify(Hints.analyzeDifficulty(TIER4_BOARD, 9));
  check(first === second, '难度分析：同一盘面分析结果确定');
}

console.log('数独逻辑提示引擎测试');
testNakedSingle();
testHiddenSingleRow();
testConflictAndInvalid();
testNakedPairTechnique();
testContradictionTechnique();
testPointingTechnique();
testClaimingTechnique();
testXWingTechnique();
testAnalyzeDifficulty();
testSolveWithHints();
testRandomStates();
console.log('\n全部通过 ✓  (' + checks + ' 项断言)');
