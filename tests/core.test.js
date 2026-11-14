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

  // 求解器应能解出「挖空终盘」
  for (const size of SIZES) {
    const solution = Core.generateSolved(size);
    const puzzle = Core.cloneGrid(solution);
    for (let i = 0; i < Math.floor(size * size * 0.55); i++) {
      puzzle[(i * 7) % size][(i * 5) % size] = 0;
    }
    const solved = Core.solveGrid(puzzle, size);
    check(solved !== null, `${size}×${size} solveGrid 求解失败`);
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

function testDifficultyOrdering() {
  for (const size of SIZES) {
    const clues = {};
    for (let i = 0; i < 3; i++) {
      for (const d of DIFFICULTIES) {
        const g = Core.generatePuzzle(size, d);
        (clues[d] = clues[d] || []).push(g.clues);
      }
    }
    const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
    check(
      avg(clues.easy) >= avg(clues.medium) && avg(clues.medium) >= avg(clues.hard),
      `${size}×${size}: 提示数未随难度递减 (${JSON.stringify(
        Object.fromEntries(Object.entries(clues).map(([k, v]) => [k, avg(v)]))
      )})`
    );
  }
}

console.log('Sudoku 核心逻辑测试');
testUnsolvedUniquenessBasics();
testGeneration();
testDeterministicSeed();
testDifficultyOrdering();
console.log(`\n全部通过 ✓  (${checks} 项断言)`);
