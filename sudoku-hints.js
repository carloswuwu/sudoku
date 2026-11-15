/*
 * 数独逻辑提示引擎（纯逻辑，无 DOM 依赖）
 *
 * 查找顺序：
 *   1. 唯一候选数（Naked Single）
 *   2. 行/列/宫唯一（Hidden Single）
 *   3. 数对排除（Naked Pair）后得到唯一候选
 *   4. 反证法：逐个尝试候选数，只有能让盘面继续完成的那个才填入
 *
 * 返回值：
 *   成功：{ ok: true, type, title, explanation, cell: {r,c}, value, highlights: ["r:c", ...] }
 *   失败：{ ok: false, reason, title, explanation }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sudoku-core.js'));
  } else {
    root.SudokuHints = factory(root.SudokuCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var BAD_BOARD_MESSAGE = '当前盘面无法继续推理，可能有填错的数字，先检查一下已填的数字吧。';

  function cellKey(r, c) {
    return r + ':' + c;
  }

  function formatDigits(digits) {
    return digits.join('、');
  }

  function failure(reason, title, explanation, highlights) {
    return {
      ok: false,
      reason: reason,
      title: title,
      explanation: explanation,
      highlights: highlights || [],
    };
  }

  function getUnits(size) {
    var cfg = Core.getConfig(size);
    var n = size;
    var units = [];
    var r;
    var c;

    for (r = 0; r < n; r++) {
      var row = [];
      for (c = 0; c < n; c++) row.push([r, c]);
      units.push({ type: 'row', index: r, cells: row });
    }
    for (c = 0; c < n; c++) {
      var col = [];
      for (r = 0; r < n; r++) col.push([r, c]);
      units.push({ type: 'col', index: c, cells: col });
    }
    for (var boxR = 0; boxR < n; boxR += cfg.boxRows) {
      for (var boxC = 0; boxC < n; boxC += cfg.boxCols) {
        var box = [];
        for (r = boxR; r < boxR + cfg.boxRows; r++) {
          for (c = boxC; c < boxC + cfg.boxCols; c++) box.push([r, c]);
        }
        units.push({ type: 'box', boxR: boxR, boxC: boxC, cells: box });
      }
    }
    return units;
  }

  /* 为每个空格计算候选数列表（升序） */
  function computeCandidates(grid, size) {
    var n = size;
    var full = (1 << n) - 1;
    var boxOf = Core.boxMap(n);
    var rows = new Array(n).fill(0);
    var cols = new Array(n).fill(0);
    var boxes = new Array(n).fill(0);
    var r;
    var c;

    for (r = 0; r < n; r++) {
      for (c = 0; c < n; c++) {
        var value = grid[r][c];
        if (!value) continue;
        var bit = 1 << (value - 1);
        var bi = boxOf[r * n + c];
        rows[r] |= bit;
        cols[c] |= bit;
        boxes[bi] |= bit;
      }
    }

    var candidates = [];
    for (r = 0; r < n; r++) {
      var rowCandidates = [];
      for (c = 0; c < n; c++) {
        if (grid[r][c]) {
          rowCandidates.push([]);
          continue;
        }
        var mask = full & ~(rows[r] | cols[c] | boxes[boxOf[r * n + c]]);
        var list = [];
        while (mask) {
          var bit2 = mask & -mask;
          mask ^= bit2;
          list.push(32 - Math.clz32(bit2));
        }
        rowCandidates.push(list);
      }
      candidates.push(rowCandidates);
    }
    return candidates;
  }

  /* 同一行、同一列、同一宫中已经出现的数字（升序） */
  function usedDigitsInPeers(grid, size, r, c) {
    var cfg = Core.getConfig(size);
    var used = {};
    var i;

    for (i = 0; i < size; i++) {
      if (i !== c && grid[r][i]) used[grid[r][i]] = true;
      if (i !== r && grid[i][c]) used[grid[i][c]] = true;
    }
    var boxR = Math.floor(r / cfg.boxRows) * cfg.boxRows;
    var boxC = Math.floor(c / cfg.boxCols) * cfg.boxCols;
    for (var rr = boxR; rr < boxR + cfg.boxRows; rr++) {
      for (var cc = boxC; cc < boxC + cfg.boxCols; cc++) {
        if ((rr !== r || cc !== c) && grid[rr][cc]) used[grid[rr][cc]] = true;
      }
    }
    return Object.keys(used)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
  }

  function mismatchWithSolution(grid, size, solution) {
    if (!solution) return false;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (grid[r][c] && grid[r][c] !== solution[r][c]) return true;
      }
    }
    return false;
  }

  function success(type, title, cell, value, explanation, highlights) {
    return {
      ok: true,
      type: type,
      title: title,
      cell: { r: cell[0], c: cell[1] },
      value: value,
      explanation: explanation,
      highlights: highlights || [],
    };
  }

  /* 1. 唯一候选数 */
  function findNakedSingle(candidates, preferred) {
    var r;
    var c;
    if (preferred && candidates[preferred.r] && candidates[preferred.r][preferred.c].length === 1) {
      return { cell: [preferred.r, preferred.c], value: candidates[preferred.r][preferred.c][0] };
    }
    for (r = 0; r < candidates.length; r++) {
      for (c = 0; c < candidates.length; c++) {
        if (candidates[r][c].length === 1) {
          return { cell: [r, c], value: candidates[r][c][0] };
        }
      }
    }
    return null;
  }

  /* 2. 行/列/宫唯一 */
  function findHiddenSingles(units, candidates, size) {
    var results = [];
    var n = size;

    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      for (var value = 1; value <= n; value++) {
        var positions = [];
        for (var i = 0; i < unit.cells.length; i++) {
          var r = unit.cells[i][0];
          var c = unit.cells[i][1];
          if (!candidates[r][c]) continue;
          if (candidates[r][c].indexOf(value) >= 0) positions.push([r, c]);
        }
        if (positions.length === 1) {
          results.push({ cell: positions[0], value: value, unit: unit });
        }
      }
    }
    return results;
  }

  function unitLabel(unit) {
    if (unit.type === 'row') return '第 ' + (unit.index + 1) + ' 行';
    if (unit.type === 'col') return '第 ' + (unit.index + 1) + ' 列';
    return '这个宫';
  }

  function hiddenSingleExplanation(unit, r, c, value) {
    var position = '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列';
    if (unit.type === 'row') {
      return (
        '第 ' + (unit.index + 1) + ' 行里，数字 ' + value + ' 只有' + position +
        '这一个空格能填（该行其他空格所在的列或宫已经有 ' + value + '），所以这里应填 ' + value + '。'
      );
    }
    if (unit.type === 'col') {
      return (
        '第 ' + (unit.index + 1) + ' 列里，数字 ' + value + ' 只有' + position +
        '这一个空格能填（该列其他空格所在的行或宫已经有 ' + value + '），所以这里应填 ' + value + '。'
      );
    }
    return (
      position + '所在的宫里，数字 ' + value + ' 只有这一个空格能填（该宫其他空格所在的行或列已经有 ' +
      value + '），所以这里应填 ' + value + '。'
    );
  }

  /* 3. 数对排除：一行/列/宫里两个格子的候选数完全相同且只有两个 */
  function findNakedPairHint(units, candidates, size) {
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      var empties = [];
      for (var i = 0; i < unit.cells.length; i++) {
        var r = unit.cells[i][0];
        var c = unit.cells[i][1];
        if (candidates[r][c] && candidates[r][c].length === 2) empties.push([r, c]);
      }
      for (var a = 0; a < empties.length; a++) {
        for (var b = a + 1; b < empties.length; b++) {
          var ca = candidates[empties[a][0]][empties[a][1]];
          var cb = candidates[empties[b][0]][empties[b][1]];
          if (ca[0] !== cb[0] || ca[1] !== cb[1]) continue;

          var reduced = {};
          var changed = false;
          for (var k = 0; k < unit.cells.length; k++) {
            var pos = unit.cells[k];
            if ((pos[0] === empties[a][0] && pos[1] === empties[a][1]) ||
                (pos[0] === empties[b][0] && pos[1] === empties[b][1])) {
              continue;
            }
            var list = candidates[pos[0]][pos[1]];
            if (!list || list.length === 0) continue;
            var next = [];
            for (var j = 0; j < list.length; j++) {
              if (list[j] !== ca[0] && list[j] !== ca[1]) next.push(list[j]);
            }
            if (next.length !== list.length) {
              changed = true;
              reduced[cellKey(pos[0], pos[1])] = next;
            }
          }
          if (!changed) continue;

          var keys = Object.keys(reduced);
          for (var kk = 0; kk < keys.length; kk++) {
            var target = keys[kk];
            var nextList = reduced[target];
            if (nextList.length === 0) continue;
            if (nextList.length !== 1) continue;
            var parts = target.split(':');
            var tr = Number(parts[0]);
            var tc = Number(parts[1]);
            var value = nextList[0];
            var explanation =
              '在' + unitLabel(unit) + '中，第 ' + (empties[a][0] + 1) + ' 行第 ' + (empties[a][1] + 1) +
              ' 列和第 ' + (empties[b][0] + 1) + ' 行第 ' + (empties[b][1] + 1) +
              ' 列都只有候选数 ' + formatDigits(ca) + '。这两个数字一定分别占据这两个格子，其他格子可以排除它们。' +
              '排除后，第 ' + (tr + 1) + ' 行第 ' + (tc + 1) + ' 列只剩 ' + value + '，所以这里应填 ' + value + '。';
            return {
              cell: [tr, tc],
              value: value,
              explanation: explanation,
              highlights: [
                cellKey(empties[a][0], empties[a][1]),
                cellKey(empties[b][0], empties[b][1]),
              ],
            };
          }
        }
      }
    }
    return null;
  }

  /* 4. 反证法：逐个尝试候选数，只有能让盘面继续完成的候选数才成立 */
  function findContradictionHint(grid, size, candidates) {
    var target = null;
    var r;
    var c;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        var list = candidates[r][c];
        if (!list || list.length < 2) continue;
        if (!target || list.length < target.list.length) target = { r: r, c: c, list: list };
      }
    }
    if (!target) return null;

    var board = Core.cloneGrid(grid);
    var solvable = [];
    for (var i = 0; i < target.list.length; i++) {
      var value = target.list[i];
      board[target.r][target.c] = value;
      if (Core.countSolutions(board, size, 1) > 0) solvable.push(value);
      board[target.r][target.c] = 0;
    }

    if (solvable.length === 0) return null;
    if (solvable.length > 1) return null;

    var answer = solvable[0];
    var explanation =
      '这一步需要一点反证推理：第 ' + (target.r + 1) + ' 行第 ' + (target.c + 1) + ' 列还有候选数 ' +
      formatDigits(target.list) + '。逐一尝试后，只有 ' + answer +
      ' 能让盘面继续完成，所以这里应填 ' + answer + '。';

    return {
      cell: [target.r, target.c],
      value: answer,
      explanation: explanation,
      highlights: [],
    };
  }

  function findHint(grid, size, solution, preferredCell) {
    Core.getConfig(size);
    var conflicts = Core.findConflicts(grid, size);
    if (conflicts.size > 0) {
      return failure(
        'conflict',
        '先修正冲突',
        '盘面上有标红的冲突数字。先把同一行、同一列或同一宫中重复的数字改掉，再来请求提示吧。',
        Array.from(conflicts)
      );
    }

    if (mismatchWithSolution(grid, size, solution)) {
      return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
    }

    var candidates = computeCandidates(grid, size);
    var r;
    var c;
    var hasEmpty = false;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (grid[r][c]) continue;
        hasEmpty = true;
        if (candidates[r][c].length === 0) {
          return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
        }
      }
    }
    if (!hasEmpty) {
      return failure('complete', '已经填完', '整盘已经填满，检查一下有没有冲突吧。');
    }

    var preferred = null;
    if (preferredCell && preferredCell.r >= 0 && preferredCell.r < size &&
        preferredCell.c >= 0 && preferredCell.c < size && !grid[preferredCell.r][preferredCell.c]) {
      preferred = { r: preferredCell.r, c: preferredCell.c };
    }

    /* 1. 唯一候选数 */
    var naked = findNakedSingle(candidates, preferred);
    if (naked) {
      var nr = naked.cell[0];
      var nc = naked.cell[1];
      var nv = naked.value;
      if (solution && solution[nr][nc] !== nv) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      var used = usedDigitsInPeers(grid, size, nr, nc);
      var nakedExplanation =
        '第 ' + (nr + 1) + ' 行第 ' + (nc + 1) + ' 列只剩一个候选数 ' + nv + '。' +
        '同一行、同一列、同一宫已经出现了 ' + formatDigits(used) + '，所以这里应填 ' + nv + '。';
      var nakedHighlights = [];
      for (r = 0; r < size; r++) {
        for (c = 0; c < size; c++) {
          if ((r === nr && c === nc) || !grid[r][c]) continue;
          if (r === nr || c === nc || Core.boxIndex(r, c, size) === Core.boxIndex(nr, nc, size)) {
            nakedHighlights.push(cellKey(r, c));
          }
        }
      }
      return success('naked-single', '唯一候选数', naked.cell, nv, nakedExplanation, nakedHighlights);
    }

    /* 2. 行/列/宫唯一 */
    var hiddenSingles = findHiddenSingles(getUnits(size), candidates, size);
    if (hiddenSingles.length > 0) {
      var chosen = hiddenSingles[0];
      if (preferred) {
        for (var h = 0; h < hiddenSingles.length; h++) {
          if (hiddenSingles[h].cell[0] === preferred.r && hiddenSingles[h].cell[1] === preferred.c) {
            chosen = hiddenSingles[h];
            break;
          }
        }
      }
      var hr = chosen.cell[0];
      var hc = chosen.cell[1];
      var hv = chosen.value;
      if (solution && solution[hr][hc] !== hv) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      var typeTitle = chosen.unit.type === 'row' ? '行内唯一' : chosen.unit.type === 'col' ? '列内唯一' : '宫内唯一';
      var hiddenHighlights = [];
      for (var u = 0; u < chosen.unit.cells.length; u++) {
        var pos = chosen.unit.cells[u];
        if (pos[0] === hr && pos[1] === hc) continue;
        hiddenHighlights.push(cellKey(pos[0], pos[1]));
      }
      return success(
        'hidden-single',
        typeTitle,
        chosen.cell,
        hv,
        hiddenSingleExplanation(chosen.unit, hr, hc, hv),
        hiddenHighlights
      );
    }

    /* 3. 数对排除 */
    var pair = findNakedPairHint(getUnits(size), candidates, size);
    if (pair) {
      if (solution && solution[pair.cell[0]][pair.cell[1]] !== pair.value) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      return success('naked-pair', '数对排除', pair.cell, pair.value, pair.explanation, pair.highlights);
    }

    /* 4. 反证法 */
    var contradiction = findContradictionHint(grid, size, candidates);
    if (contradiction) {
      if (solution && solution[contradiction.cell[0]][contradiction.cell[1]] !== contradiction.value) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      return success(
        'contradiction',
        '反证法',
        contradiction.cell,
        contradiction.value,
        contradiction.explanation,
        contradiction.highlights
      );
    }

    return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
  }

  return {
    findHint: findHint,
    computeCandidates: computeCandidates,
    getUnits: getUnits,
    usedDigitsInPeers: usedDigitsInPeers,
    findNakedPairHint: findNakedPairHint,
    findContradictionHint: findContradictionHint,
  };
});
