/* 核心逻辑测试：node tests/core.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'sudoku-core.js'));

const SIZES = [4, 6, 9];
const DIFFICULTIES = Core.DIFFICULTIES;
let checks = 0;

function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

function checkValidSolution(grid, size, label) {
  check(Core.isValidSolution(grid, size), `${label}: 终盘不合法`);
  for (let r = 0; r < size; r++) {
    const seen = new Set();
    for (let c = 0; c < size; c++) {
      assert.ok(!seen.has(grid[r][c]), `${label}: 行 ${r} 重复 ${grid[r][c]}`);
      seen.add(grid[r][c]);
    }
  }
}

function checkPuzzle(p, label) {
  const { size, puzzle, solution } = p;
  check(Array.isArray(puzzle) && puzzle.length === size, `${label}: 棋盘尺寸错误`);
  checkValidSolution(solution, size, label);

  let clues = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = puzzle[r][c];
      check(Number.isInteger(v) && v >= 0 && v <= size, `${label}: 非法数字 ${v}`);
      if (v !== 0) {
        clues++;
        check(v === solution[r][c], `${label}: 提示数字与解不一致 (${r},${c})`);
      }
    }
  }
  check(clues === p.clues, `${label}: clues 计数不一致 ${clues} vs ${p.clues}`);
  check(clues > 0 && clues < size * size, `${label}: 提示数量异常 ${clues}`);
  check(Core.countSolutions(puzzle, size, 2) === 1, `${label}: 解不唯一 (提示数 ${clues})`);

  const solved = Core.solveGrid(puzzle, size);
  check(solved !== null, `${label}: solveGrid 无解`);
  check(JSON.stringify(solved) === JSON.stringify(solution), `${label}: solveGrid 与生成解不符`);
}

function testUnsolvedUniquenessBasics() {
  const empty9 = Core.emptyGrid(9);
  check(Core.countSolutions(empty9, 9, 2) === 2, '空 9×9 至少有两个解');
  check(Core.countSolutions(empty9, 9, 1) === 1, 'limit=1 应提前停止');
  const empty4 = Core.emptyGrid(4);
  check(Core.countSolutions(empty4, 4, 2) === 2, '空 4×4 应有多个解');

  const conflict = Core.emptyGrid(4);
  conflict[0][0] = 1;
  conflict[0][1] = 1;
  check(Core.countSolutions(conflict, 4, 2) === 0, '冲突棋盘应无解');
  check(Core.solveGrid(conflict, 4) === null, '冲突棋盘 solveGrid 应为 null');
  check(!Core.isValidSolution(conflict, 4), '冲突棋盘不应通过完成校验');

  // 求解器应能解出「挖空终盘」（这里用保证唯一解的题目，空格足够多）
  for (const size of SIZES) {
    const game = Core.generatePuzzle(size, 'medium', Core.seedRandom(1234 + size));
    let cleared = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (game.puzzle[r][c] === 0) cleared++;
      }
    }
    check(cleared >= Math.floor(size * size * 0.4), `${size}×${size} 空格数量不足（${cleared}）`);
    const solved = Core.solveGrid(game.puzzle, size);
    check(solved !== null, `${size}×${size} solveGrid 求解失败`);
    check(solved && JSON.stringify(solved) === JSON.stringify(game.solution), `${size}×${size} 求解结果应与原终盘一致`);
  }
}

function testConflictDetection() {
  // 行冲突
  let grid = Core.emptyGrid(9);
  grid[0][0] = 5;
  grid[0][7] = 5;
  let conflicts = Core.findConflicts(grid, 9);
  check(conflicts.has('0:0') && conflicts.has('0:7'), '同行重复应标记两个格子');
  check(conflicts.size === 2, '同行重复只影响这两个格子');

  // 列冲突
  grid = Core.emptyGrid(9);
  grid[2][3] = 7;
  grid[7][3] = 7;
  conflicts = Core.findConflicts(grid, 9);
  check(conflicts.has('2:3') && conflicts.has('7:3'), '同列重复应标记两个格子');

  // 宫冲突（9×9：3×3 宫）
  grid = Core.emptyGrid(9);
  grid[0][0] = 4;
  grid[2][2] = 4;
  conflicts = Core.findConflicts(grid, 9);
  check(conflicts.has('0:0') && conflicts.has('2:2'), '同宫重复应标记两个格子');

  // 6×6 宫是 2 行 × 3 列：(0,0) 与 (1,2) 同宫
  grid = Core.emptyGrid(6);
  grid[0][0] = 2;
  grid[1][2] = 2;
  conflicts = Core.findConflicts(grid, 6);
  check(conflicts.has('0:0') && conflicts.has('1:2'), '6×6 同宫重复应标记');

  // 4×4 宫是 2×2：(0,0) 与 (1,1) 同宫
  grid = Core.emptyGrid(4);
  grid[0][0] = 3;
  grid[1][1] = 3;
  conflicts = Core.findConflicts(grid, 4);
  check(conflicts.has('0:0') && conflicts.has('1:1'), '4×4 同宫重复应标记');

  // 三个重复数字应全部标记
  grid = Core.emptyGrid(9);
  grid[4][0] = 8;
  grid[4][3] = 8;
  grid[4][8] = 8;
  conflicts = Core.findConflicts(grid, 9);
  check(conflicts.size === 3, '一行三个重复数字应全部标记');

  // 一行里各不相同的数字不算冲突
  grid = Core.emptyGrid(9);
  for (let c = 0; c < 9; c++) grid[0][c] = c + 1;
  check(Core.findConflicts(grid, 9).size === 0, '一行数字各不相同时没有冲突');

  // 完整合法终盘和合法残局都没有冲突
  for (const size of SIZES) {
    const solution = Core.generateSolved(size);
    check(Core.findConflicts(solution, size).size === 0, `${size}×${size} 合法终盘没有冲突`);
    const partial = Core.cloneGrid(solution);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if ((r + c) % 3 !== 0) partial[r][c] = 0;
      }
    }
    check(Core.findConflicts(partial, size).size === 0, `${size}×${size} 合法残局没有冲突`);
  }
}

function testGeneration() {
  for (const size of SIZES) {
    for (const difficulty of DIFFICULTIES) {
      const rounds = size === 9 ? 3 : 4;
      const times = [];
      for (let i = 0; i < rounds; i++) {
        const label = `${size}×${size}/${difficulty}#${i + 1}`;
        const t0 = Date.now();
        const game = Core.generatePuzzle(size, difficulty);
        times.push(Date.now() - t0);
        checkPuzzle(game, label);
        check(game.size === size, `${label}: size 字段错误`);
        check(game.difficulty === difficulty, `${label}: difficulty 字段错误`);
      }
      times.sort((a, b) => a - b);
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      console.log(
        `  ${size}×${size} ${difficulty.padEnd(6)} 用时 平均 ${String(avg).padStart(4)}ms  最慢 ${String(times[times.length - 1]).padStart(4)}ms`
      );
    }
  }
}

function testDeterministicSeed() {
  const a = Core.generatePuzzle(9, 'medium', Core.seedRandom(12345));
  const b = Core.generatePuzzle(9, 'medium', Core.seedRandom(12345));
  check(JSON.stringify(a.puzzle) === JSON.stringify(b.puzzle), '相同种子应生成相同题目');
  const c = Core.generatePuzzle(9, 'medium', Core.seedRandom(999));
  check(JSON.stringify(a.puzzle) !== JSON.stringify(c.puzzle), '不同种子应生成不同题目');
}

function testDifficultyTargets() {
  for (const size of SIZES) {
    const targets = Core.TARGET_CLUES[size];
    check(
      targets.easy > targets.medium && targets.medium > targets.hard,
      `${size}×${size}: 难度目标提示数应递增递减`
    );
    for (const difficulty of DIFFICULTIES) {
      /* 固定种子 → 生成结果可复现，避免偶发失败无法重放 */
      const seed = 1000 + size * 10 + DIFFICULTIES.indexOf(difficulty);
      const game = Core.generatePuzzle(size, difficulty, Core.seedRandom(seed));
      check(
        game.clues === targets[difficulty],
        `${size}×${size}/${difficulty}: 实际提示数 ${game.clues}，目标 ${targets[difficulty]}`
      );
    }
  }
  /* 未知难度回退到 medium */
  const fallback = Core.generatePuzzle(4, 'impossible', Core.seedRandom(7));
  check(fallback.difficulty === 'medium', '未知难度应回退为 medium');
  const emptyFallback = Core.generatePuzzle(4, '', Core.seedRandom(8));
  check(emptyFallback.difficulty === 'medium', '空难度应回退为 medium');
}

console.log('Sudoku 核心逻辑测试');
testUnsolvedUniquenessBasics();
testConflictDetection();
testGeneration();
testDeterministicSeed();
testDifficultyTargets();
console.log(`\n全部通过 ✓  (${checks} 项断言)`);
