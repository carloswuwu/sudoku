/*
 * 数独核心逻辑（纯函数，无 DOM 依赖）
 * 支持 4×4（2×2 宫）、6×6（2×3 宫）、9×9（3×3 宫）
 * 浏览器中挂载为 window.SudokuCore，Node 中通过 module.exports 导出。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SudokuCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONFIG = {
    4: { size: 4, boxRows: 2, boxCols: 2 },
    6: { size: 6, boxRows: 2, boxCols: 3 },
    9: { size: 9, boxRows: 3, boxCols: 3 },
  };

  var DIFFICULTIES = ['easy', 'medium', 'hard'];

  /* 每种尺寸在不同难度下期望保留的提示数字数量（越少越难） */
  var TARGET_CLUES = {
    4: { easy: 9, medium: 7, hard: 5 },
    6: { easy: 22, medium: 18, hard: 14 },
    9: { easy: 42, medium: 34, hard: 28 },
  };

  function getConfig(size) {
    var cfg = CONFIG[size];
    if (!cfg) throw new Error('不支持的棋盘尺寸: ' + size);
    return cfg;
  }

  function emptyGrid(size) {
    var grid = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(0);
      grid.push(row);
    }
    return grid;
  }

  function cloneGrid(grid) {
    return grid.map(function (row) { return row.slice(); });
  }

  function boxIndex(r, c, size) {
    var cfg = getConfig(size);
    return Math.floor(r / cfg.boxRows) * (size / cfg.boxCols) + Math.floor(c / cfg.boxCols);
  }

  /* 预计算每个格子的宫编号，加速求解器 */
  function boxMap(size) {
    var map = new Array(size * size);
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) map[r * size + c] = boxIndex(r, c, size);
    }
    return map;
  }

  function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >> 24;
  }

  function bitToDigit(bit) {
    return 32 - Math.clz32(bit);
  }

  function seedRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  /* 检查一个已完成棋盘是否合法（每行/列/宫 1..n 各一次） */
  function isValidSolution(grid, size) {
    var cfg = getConfig(size);
    var full = (1 << size) - 1;
    if (!Array.isArray(grid) || grid.length !== size) return false;
    var rows = new Array(size).fill(0);
    var cols = new Array(size).fill(0);
    var boxes = new Array(size).fill(0);
    for (var r = 0; r < size; r++) {
      if (!Array.isArray(grid[r]) || grid[r].length !== size) return false;
      for (var c = 0; c < size; c++) {
        var v = grid[r][c];
        if (!Number.isInteger(v) || v < 1 || v > size) return false;
        var bit = 1 << (v - 1);
        var bi = boxIndex(r, c, size);
        if ((rows[r] & bit) || (cols[c] & bit) || (boxes[bi] & bit)) return false;
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[bi] |= bit;
      }
    }
    for (var i = 0; i < size; i++) {
      if (rows[i] !== full || cols[i] !== full || boxes[i] !== full) return false;
    }
    return true;
  }

  /* 使用通用桶（bitmask）初始化，返回 null 表示已有冲突 */
  function initMasks(grid, size) {
    var n = size;
    var boxOf = boxMap(n);
    var rows = new Array(n).fill(0);
    var cols = new Array(n).fill(0);
    var boxes = new Array(n).fill(0);
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var v = grid[r][c] | 0;
        if (v === 0) continue;
        if (v < 1 || v > n) return null;
        var bit = 1 << (v - 1);
        var bi = boxOf[r * n + c];
        if ((rows[r] & bit) || (cols[c] & bit) || (boxes[bi] & bit)) return null;
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[bi] |= bit;
      }
    }
    return { rows: rows, cols: cols, boxes: boxes, boxOf: boxOf };
  }

  /*
   * 找出所有冲突格：同一行、同一列或同一宫内出现重复数字的格子。
   * 返回 "r:c" 形式的 Set；没有冲突时返回空 Set。
   * 只依据行/列/宫规则，不依赖题目答案。
   */
  function findConflicts(grid, size) {
    var n = size;
    var cfg = getConfig(n);
    var conflicts = new Set();

    function markUnit(cells) {
      var byValue = {};
      for (var i = 0; i < cells.length; i++) {
        var r = cells[i][0];
        var c = cells[i][1];
        var v = grid[r][c];
        if (!v) continue;
        if (!byValue[v]) byValue[v] = [];
        byValue[v].push([r, c]);
      }
      Object.keys(byValue).forEach(function (value) {
        var positions = byValue[value];
        if (positions.length > 1) {
          positions.forEach(function (pos) {
            conflicts.add(pos[0] + ':' + pos[1]);
          });
        }
      });
    }

    var r;
    var c;
    for (r = 0; r < n; r++) {
      var rowCells = [];
      for (c = 0; c < n; c++) rowCells.push([r, c]);
      markUnit(rowCells);
    }
    for (c = 0; c < n; c++) {
      var colCells = [];
      for (r = 0; r < n; r++) colCells.push([r, c]);
      markUnit(colCells);
    }
    for (var boxR = 0; boxR < n; boxR += cfg.boxRows) {
      for (var boxC = 0; boxC < n; boxC += cfg.boxCols) {
        var boxCells = [];
        for (r = boxR; r < boxR + cfg.boxRows; r++) {
          for (c = boxC; c < boxC + cfg.boxCols; c++) boxCells.push([r, c]);
        }
        markUnit(boxCells);
      }
    }
    return conflicts;
  }

  /*
   * 统计解的个数，最多数到 limit 个就停止。
   * 采用 MRV（每次选择候选最少的空格）+ 位运算，速度足够生成 9×9。
   */
  function countSolutions(grid, size, limit) {
    var n = size;
    limit = limit || 2;
    var masks = initMasks(grid, n);
    if (!masks) return 0;
    var rows = masks.rows;
    var cols = masks.cols;
    var boxes = masks.boxes;
    var boxOf = masks.boxOf;
    var full = (1 << n) - 1;
    var count = 0;

    function search() {
      if (count >= limit) return;
      var bestR = -1;
      var bestC = -1;
      var bestMask = 0;
      var bestCount = n + 1;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (grid[r][c]) continue;
          var bi = boxOf[r * n + c];
          var mask = full & ~(rows[r] | cols[c] | boxes[bi]);
          if (mask === 0) return;
          var cnt = popcount(mask);
          if (cnt < bestCount) {
            bestCount = cnt;
            bestR = r;
            bestC = c;
            bestMask = mask;
            if (cnt === 1) { r = n; break; }
          }
        }
      }
      if (bestR === -1) {
        count++;
        return;
      }
      var bi2 = boxOf[bestR * n + bestC];
      var remaining = bestMask;
      while (remaining) {
        var bit = remaining & -remaining;
        remaining ^= bit;
        var v = bitToDigit(bit);
        grid[bestR][bestC] = v;
        rows[bestR] |= bit;
        cols[bestC] |= bit;
        boxes[bi2] |= bit;
        search();
        grid[bestR][bestC] = 0;
        rows[bestR] &= ~bit;
        cols[bestC] &= ~bit;
        boxes[bi2] &= ~bit;
        if (count >= limit) return;
      }
    }

    search();
    return count;
  }

  /* 求出一个解，无解返回 null（不修改入参） */
  function solveGrid(grid, size) {
    var n = size;
    var work = cloneGrid(grid);
    var masks = initMasks(work, n);
    if (!masks) return null;
    var rows = masks.rows;
    var cols = masks.cols;
    var boxes = masks.boxes;
    var boxOf = masks.boxOf;
    var full = (1 << n) - 1;

    function search() {
      var bestR = -1;
      var bestC = -1;
      var bestMask = 0;
      var bestCount = n + 1;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (work[r][c]) continue;
          var bi = boxOf[r * n + c];
          var mask = full & ~(rows[r] | cols[c] | boxes[bi]);
          if (mask === 0) return false;
          var cnt = popcount(mask);
          if (cnt < bestCount) {
            bestCount = cnt;
            bestR = r;
            bestC = c;
            bestMask = mask;
            if (cnt === 1) { r = n; break; }
          }
        }
      }
      if (bestR === -1) return true;
      var bi2 = boxOf[bestR * n + bestC];
      var remaining = bestMask;
      while (remaining) {
        var bit = remaining & -remaining;
        remaining ^= bit;
        var v = bitToDigit(bit);
        work[bestR][bestC] = v;
        rows[bestR] |= bit;
        cols[bestC] |= bit;
        boxes[bi2] |= bit;
        if (search()) return true;
        work[bestR][bestC] = 0;
        rows[bestR] &= ~bit;
        cols[bestC] &= ~bit;
        boxes[bi2] &= ~bit;
      }
      return false;
    }

    return search() ? work : null;
  }

  /* 随机生成一个完整合法的终盘 */
  function generateSolved(size, rng) {
    rng = rng || Math.random;
    var n = size;
    var full = (1 << n) - 1;
    var boxOf = boxMap(n);
    var grid = emptyGrid(n);
    var rows = new Array(n).fill(0);
    var cols = new Array(n).fill(0);
    var boxes = new Array(n).fill(0);

    function fill() {
      var bestR = -1;
      var bestC = -1;
      var bestMask = 0;
      var bestCount = n + 1;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (grid[r][c]) continue;
          var bi = boxOf[r * n + c];
          var mask = full & ~(rows[r] | cols[c] | boxes[bi]);
          if (mask === 0) return false;
          var cnt = popcount(mask);
          if (cnt < bestCount) {
            bestCount = cnt;
            bestR = r;
            bestC = c;
            bestMask = mask;
            if (cnt === 1) { r = n; break; }
          }
        }
      }
      if (bestR === -1) return true;
      var candidates = [];
      var remaining = bestMask;
      while (remaining) {
        var bit = remaining & -remaining;
        remaining ^= bit;
        candidates.push(bitToDigit(bit));
      }
      shuffle(candidates, rng);
      var bi2 = boxOf[bestR * n + bestC];
      for (var i = 0; i < candidates.length; i++) {
        var v = candidates[i];
        var bit2 = 1 << (v - 1);
        grid[bestR][bestC] = v;
        rows[bestR] |= bit2;
        cols[bestC] |= bit2;
        boxes[bi2] |= bit2;
        if (fill()) return true;
        grid[bestR][bestC] = 0;
        rows[bestR] &= ~bit2;
        cols[bestC] &= ~bit2;
        boxes[bi2] &= ~bit2;
      }
      return false;
    }

    if (!fill()) throw new Error('生成终盘失败');
    return grid;
  }

  /*
   * 生成一局游戏：先造终盘，再随机挖空（保持唯一解）。
   * 返回 { size, difficulty, puzzle, solution, clues }
   */
  function generatePuzzle(size, difficulty, rng) {
    getConfig(size);
    rng = rng || Math.random;
    difficulty = DIFFICULTIES.indexOf(difficulty) >= 0 ? difficulty : 'medium';
    var n = size;
    var solution = generateSolved(n, rng);
    var puzzle = cloneGrid(solution);
    var target = TARGET_CLUES[n][difficulty];
    var clueCount = n * n;
    var cells = [];
    for (var i = 0; i < n * n; i++) cells.push(i);
    shuffle(cells, rng);

    for (var k = 0; k < cells.length && clueCount > target; k++) {
      var idx = cells[k];
      var r = Math.floor(idx / n);
      var c = idx % n;
      if (puzzle[r][c] === 0) continue;
      var backup = puzzle[r][c];
      puzzle[r][c] = 0;
      if (countSolutions(puzzle, n, 2) !== 1) {
        puzzle[r][c] = backup;
      } else {
        clueCount--;
      }
    }

    return {
      size: n,
      difficulty: difficulty,
      puzzle: puzzle,
      solution: solution,
      clues: clueCount,
    };
  }

  return {
    CONFIG: CONFIG,
    DIFFICULTIES: DIFFICULTIES,
    TARGET_CLUES: TARGET_CLUES,
    getConfig: getConfig,
    emptyGrid: emptyGrid,
    cloneGrid: cloneGrid,
    boxIndex: boxIndex,
    boxMap: boxMap,
    popcount: popcount,
    seedRandom: seedRandom,
    isValidSolution: isValidSolution,
    findConflicts: findConflicts,
    countSolutions: countSolutions,
    solveGrid: solveGrid,
    generateSolved: generateSolved,
    generatePuzzle: generatePuzzle,
  };
});
