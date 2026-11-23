/*
 * 数独逻辑提示引擎（纯逻辑，无 DOM 依赖）
 *
 * 查找顺序：
 *   1. 唯一候选数（Naked Single）
 *   2. 行/列/宫唯一（Hidden Single）
 *   3. 数对排除（Naked Pair）
 *   4. 区块排除（Pointing Pair/Triple）
 *   5. 行列排除（Claiming / Box-Line Reduction）
 *   6. 矩形排除（X-Wing）
 *   7. 反证法：逐个尝试候选数，只有能让盘面继续完成的那个才填入
 *
 * 排除类技巧（数对/区块/行列/矩形）都先在候选数表上做排除，再重新运行
 * “唯一候选数 + 行/列/宫唯一”；只有确实得出可落子的格子和数字时才作为
 * 提示返回，保证 UI 始终能直接填入。
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

  /* ------------------------------ 候选数表工具 ------------------------------ */

  function cloneCandidateMap(candidates) {
    var copy = [];
    for (var r = 0; r < candidates.length; r++) {
      var source = candidates[r] || [];
      var row = [];
      for (var c = 0; c < source.length; c++) {
        row.push(source[c] ? source[c].slice() : []);
      }
      copy.push(row);
    }
    return copy;
  }

  function candidateListAt(candidates, r, c) {
    var row = candidates[r];
    if (!row) return null;
    return row[c] || null;
  }

  function hasCandidate(candidates, r, c, value) {
    var list = candidateListAt(candidates, r, c);
    if (!list) return false;
    return list.indexOf(value) >= 0;
  }

  function removeCandidateValue(candidates, r, c, value) {
    var list = candidateListAt(candidates, r, c);
    if (!list) return false;
    var index = list.indexOf(value);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  function candidatesInUnit(unit, candidates, value) {
    var positions = [];
    for (var i = 0; i < unit.cells.length; i++) {
      var r = unit.cells[i][0];
      var c = unit.cells[i][1];
      if (hasCandidate(candidates, r, c, value)) positions.push([r, c]);
    }
    return positions;
  }

  function findUnit(units, type, index) {
    for (var i = 0; i < units.length; i++) {
      if (units[i].type === type && units[i].index === index) return units[i];
    }
    return null;
  }

  function cellBelongsToUnit(unit, r, c, size) {
    if (unit.type === 'row') return r === unit.index;
    if (unit.type === 'col') return c === unit.index;
    var cfg = Core.getConfig(size);
    return r >= unit.boxR && r < unit.boxR + cfg.boxRows &&
      c >= unit.boxC && c < unit.boxC + cfg.boxCols;
  }

  function findBoxUnit(units, cell, size) {
    for (var i = 0; i < units.length; i++) {
      if (units[i].type !== 'box') continue;
      if (cellBelongsToUnit(units[i], cell[0], cell[1], size)) return units[i];
    }
    return null;
  }

  function eliminationsOutsideUnit(target, excluded, candidates, value, size) {
    var result = [];
    for (var i = 0; i < target.cells.length; i++) {
      var r = target.cells[i][0];
      var c = target.cells[i][1];
      if (cellBelongsToUnit(excluded, r, c, size)) continue;
      if (hasCandidate(candidates, r, c, value)) result.push({ r: r, c: c, value: value });
    }
    return result;
  }

  /*
   * 在候选数表副本上执行排除。不会修改传入的候选数表。
   * 返回 { candidates, removed, invalid }；removed 为实际被删除的候选数。
   */
  function applyEliminations(candidates, eliminations) {
    var work = cloneCandidateMap(candidates);
    var removed = [];
    var invalid = false;
    for (var i = 0; i < eliminations.length; i++) {
      var item = eliminations[i];
      var list = candidateListAt(work, item.r, item.c);
      if (!list) continue;
      var index = list.indexOf(item.value);
      if (index < 0) continue;
      list.splice(index, 1);
      removed.push({ r: item.r, c: item.c, value: item.value });
      if (list.length === 0) invalid = true;
    }
    return { candidates: work, removed: removed, invalid: invalid };
  }

  /* 重新运行唯一候选数：只认“因为这次排除才变成唯一”的格子 */
  function findFreshNakedSingle(original, reduced) {
    for (var r = 0; r < reduced.length; r++) {
      for (var c = 0; c < reduced[r].length; c++) {
        var before = candidateListAt(original, r, c);
        var after = candidateListAt(reduced, r, c);
        if (!before || !after) continue;
        if (before.length > 1 && after.length === 1) {
          return { cell: [r, c], value: after[0], kind: 'naked' };
        }
      }
    }
    return null;
  }

  /* 重新运行行/列/宫唯一：只认“因为这次排除才出现”的唯一位置 */
  function findFreshHiddenSingle(units, original, reduced, size) {
    var results = findHiddenSingles(units, reduced, size);
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      var beforeCount = 0;
      for (var k = 0; k < result.unit.cells.length; k++) {
        var r = result.unit.cells[k][0];
        var c = result.unit.cells[k][1];
        if (hasCandidate(original, r, c, result.value)) beforeCount++;
      }
      if (beforeCount > 1) {
        return { cell: result.cell, value: result.value, kind: 'hidden', unit: result.unit };
      }
    }
    return null;
  }

  /* ------------------------------ 基础技巧 ------------------------------ */

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

  function findAnyNakedSingle(candidates) {
    for (var r = 0; r < candidates.length; r++) {
      for (var c = 0; c < candidates[r].length; c++) {
        var list = candidateListAt(candidates, r, c);
        if (list && list.length === 1) return { cell: [r, c], value: list[0] };
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

  function boxLabel(unit, size) {
    var cfg = Core.getConfig(size);
    return '第 ' + (unit.boxR + 1) + ' 至 ' + (unit.boxR + cfg.boxRows) + ' 行、第 ' +
      (unit.boxC + 1) + ' 至 ' + (unit.boxC + cfg.boxCols) + ' 列的宫';
  }

  function positionLabel(cell) {
    return '第 ' + (cell[0] + 1) + ' 行第 ' + (cell[1] + 1) + ' 列';
  }

  function positionsLabel(cells) {
    var parts = [];
    for (var i = 0; i < cells.length; i++) parts.push(positionLabel(cells[i]));
    return parts.join('、');
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

  /* 排除后重新运行单数技巧，得到可落子的格子；没有则返回 null */
  function resolveFillAfterElimination(original, reduced, size) {
    var fill = findFreshNakedSingle(original, reduced);
    if (fill) return fill;
    return findFreshHiddenSingle(getUnits(size), original, reduced, size);
  }

  function fillSuffix(fill) {
    var r = fill.cell[0];
    var c = fill.cell[1];
    if (fill.kind === 'naked') {
      return '排除后，第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列只剩 ' + fill.value +
        '，所以这里应填 ' + fill.value + '。';
    }
    if (fill.unit.type === 'box') {
      return '排除后，' + positionLabel(fill.cell) + '所在的宫里，数字 ' + fill.value +
        ' 只有这一个空格能填，所以这里应填 ' + fill.value + '。';
    }
    return '排除后，' + unitLabel(fill.unit) + '里数字 ' + fill.value + ' 只有' + positionLabel(fill.cell) +
      '能填，所以这里应填 ' + fill.value + '。';
  }

  /* ------------------------------ 排除类技巧 ------------------------------ */

  /*
   * 3. 数对排除：一行/列/宫里两个格子的候选数完全相同且只有两个。
   * 返回排除方案（不改动候选数表），没有可排除项时返回 null。
   */
  function findNakedPairEliminations(units, candidates, size) {
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      var pairCells = [];
      for (var i = 0; i < unit.cells.length; i++) {
        var r = unit.cells[i][0];
        var c = unit.cells[i][1];
        var list = candidateListAt(candidates, r, c);
        if (list && list.length === 2) pairCells.push([r, c]);
      }
      for (var a = 0; a < pairCells.length; a++) {
        for (var b = a + 1; b < pairCells.length; b++) {
          var ca = candidates[pairCells[a][0]][pairCells[a][1]];
          var cb = candidates[pairCells[b][0]][pairCells[b][1]];
          if (ca[0] !== cb[0] || ca[1] !== cb[1]) continue;

          var values = ca.slice().sort(function (x, y) {
            return x - y;
          });
          var eliminations = [];
          for (var k = 0; k < unit.cells.length; k++) {
            var pr = unit.cells[k][0];
            var pc = unit.cells[k][1];
            var isPair =
              (pr === pairCells[a][0] && pc === pairCells[a][1]) ||
              (pr === pairCells[b][0] && pc === pairCells[b][1]);
            if (isPair) continue;
            var target = candidateListAt(candidates, pr, pc);
            if (!target) continue;
            for (var v = 0; v < values.length; v++) {
              if (target.indexOf(values[v]) >= 0) eliminations.push({ r: pr, c: pc, value: values[v] });
            }
          }
          if (eliminations.length === 0) continue;

          return {
            kind: 'naked-pair',
            unit: unit,
            pair: [pairCells[a], pairCells[b]],
            values: values,
            pattern: [pairCells[a], pairCells[b]],
            eliminations: eliminations,
          };
        }
      }
    }
    return null;
  }

  /*
   * 4. 区块排除：某个数字在一个宫里的候选位置全部落在同一行/同一列上，
   * 则该行/列在这个宫以外的格子不能再填这个数字。
   */
  function findPointingEliminations(units, candidates, size) {
    for (var u = 0; u < units.length; u++) {
      var box = units[u];
      if (box.type !== 'box') continue;
      for (var value = 1; value <= size; value++) {
        var positions = candidatesInUnit(box, candidates, value);
        if (positions.length < 2 || positions.length > 3) continue;

        var sameRow = true;
        var sameCol = true;
        for (var i = 1; i < positions.length; i++) {
          if (positions[i][0] !== positions[0][0]) sameRow = false;
          if (positions[i][1] !== positions[0][1]) sameCol = false;
        }
        var line = null;
        if (sameRow) line = findUnit(units, 'row', positions[0][0]);
        else if (sameCol) line = findUnit(units, 'col', positions[0][1]);
        if (!line) continue;

        var eliminations = eliminationsOutsideUnit(line, box, candidates, value, size);
        if (eliminations.length === 0) continue;

        return {
          kind: 'pointing',
          box: box,
          line: line,
          value: value,
          pattern: positions,
          eliminations: eliminations,
        };
      }
    }
    return null;
  }

  /*
   * 5. 行列排除：某个数字在一行/一列里的候选位置全部落在同一个宫中，
   * 则该宫在这一行/列以外的格子不能再填这个数字。
   */
  function findClaimingEliminations(units, candidates, size) {
    for (var u = 0; u < units.length; u++) {
      var line = units[u];
      if (line.type !== 'row' && line.type !== 'col') continue;
      for (var value = 1; value <= size; value++) {
        var positions = candidatesInUnit(line, candidates, value);
        if (positions.length < 2) continue;

        var boxIndexValue = Core.boxIndex(positions[0][0], positions[0][1], size);
        var sameBox = true;
        for (var i = 1; i < positions.length; i++) {
          if (Core.boxIndex(positions[i][0], positions[i][1], size) !== boxIndexValue) {
            sameBox = false;
            break;
          }
        }
        if (!sameBox) continue;

        var box = findBoxUnit(units, positions[0], size);
        if (!box) continue;
        var eliminations = eliminationsOutsideUnit(box, line, candidates, value, size);
        if (eliminations.length === 0) continue;

        return {
          kind: 'claiming',
          line: line,
          box: box,
          value: value,
          pattern: positions,
          eliminations: eliminations,
        };
      }
    }
    return null;
  }

  /*
   * 6. 矩形排除：某个数字在两行中的候选位置恰好是相同的两列（或两列中
   * 的候选位置恰好是相同的两行），则这两列（行）的其他格子不能再填它。
   */
  function findXWingEliminations(units, candidates, size) {
    var orientations = [
      { lineType: 'row' },
      { lineType: 'col' },
    ];

    for (var o = 0; o < orientations.length; o++) {
      var orientation = orientations[o];
      for (var value = 1; value <= size; value++) {
        var lines = [];
        for (var index = 0; index < size; index++) {
          var unit = findUnit(units, orientation.lineType, index);
          if (!unit) continue;
          var positions = candidatesInUnit(unit, candidates, value);
          if (positions.length !== 2) continue;
          var cross = [];
          for (var p = 0; p < positions.length; p++) {
            cross.push(orientation.lineType === 'row' ? positions[p][1] : positions[p][0]);
          }
          cross.sort(function (x, y) {
            return x - y;
          });
          lines.push({ unit: unit, positions: positions, cross: cross });
        }

        for (var a = 0; a < lines.length; a++) {
          for (var b = a + 1; b < lines.length; b++) {
            if (lines[a].cross[0] !== lines[b].cross[0] || lines[a].cross[1] !== lines[b].cross[1]) {
              continue;
            }
            var eliminations = [];
            for (var lineIndex = 0; lineIndex < size; lineIndex++) {
              if (lineIndex === lines[a].unit.index || lineIndex === lines[b].unit.index) continue;
              for (var q = 0; q < lines[a].cross.length; q++) {
                var crossIndex = lines[a].cross[q];
                var r = orientation.lineType === 'row' ? lineIndex : crossIndex;
                var c = orientation.lineType === 'row' ? crossIndex : lineIndex;
                if (hasCandidate(candidates, r, c, value)) {
                  eliminations.push({ r: r, c: c, value: value });
                }
              }
            }
            if (eliminations.length === 0) continue;

            return {
              kind: 'x-wing',
              orientation: orientation.lineType,
              lines: [lines[a], lines[b]],
              cross: lines[a].cross,
              value: value,
              pattern: [
                lines[a].positions[0],
                lines[a].positions[1],
                lines[b].positions[0],
                lines[b].positions[1],
              ],
              eliminations: eliminations,
            };
          }
        }
      }
    }
    return null;
  }

  /* ------------------------------ 排除 → 提示 ------------------------------ */

  function buildEliminationHint(type, title, detail, candidates, size, headBuilder) {
    if (!detail) return null;

    var applied = applyEliminations(candidates, detail.eliminations);
    if (applied.invalid || applied.removed.length === 0) return null;

    var fill = resolveFillAfterElimination(candidates, applied.candidates, size);
    if (!fill) return null;

    var highlights = [];
    var seen = {};
    var pattern = [];
    var i;
    for (i = 0; i < detail.pattern.length; i++) {
      var key = cellKey(detail.pattern[i][0], detail.pattern[i][1]);
      pattern.push(key);
      if (!seen[key]) {
        seen[key] = true;
        highlights.push(key);
      }
    }
    if (type !== 'naked-pair') {
      for (i = 0; i < applied.removed.length; i++) {
        var removedKey = cellKey(applied.removed[i].r, applied.removed[i].c);
        if (!seen[removedKey]) {
          seen[removedKey] = true;
          highlights.push(removedKey);
        }
      }
    }

    var explanation = headBuilder(detail, fill, size);
    return {
      type: type,
      title: title,
      cell: fill.cell,
      value: fill.value,
      explanation: explanation,
      highlights: highlights,
      pattern: pattern,
      eliminations: applied.removed,
    };
  }

  function nakedPairHead(detail, fill, size) {
    var a = detail.pair[0];
    var b = detail.pair[1];
    return (
      '在' + unitLabel(detail.unit) + '中，第 ' + (a[0] + 1) + ' 行第 ' + (a[1] + 1) +
      ' 列和第 ' + (b[0] + 1) + ' 行第 ' + (b[1] + 1) + ' 列都只有候选数 ' + formatDigits(detail.values) +
      '。这两个数字一定分别占据这两个格子，其他格子可以排除它们。' + fillSuffix(fill)
    );
  }

  function pointingHead(detail, fill, size) {
    return (
      '数字 ' + detail.value + ' 在' + boxLabel(detail.box, size) + '里的候选位置只有 ' +
      positionsLabel(detail.pattern) + '，全部落在' + unitLabel(detail.line) + '上，所以' +
      unitLabel(detail.line) + '里这个宫以外的格子都不能填 ' + detail.value + '。' +
      fillSuffix(fill)
    );
  }

  function claimingHead(detail, fill, size) {
    return (
      unitLabel(detail.line) + '里数字 ' + detail.value + ' 的候选位置只有 ' +
      positionsLabel(detail.pattern) + '，全部落在' + boxLabel(detail.box, size) + '内，所以这个宫里' +
      unitLabel(detail.line) + '以外的格子都不能填 ' + detail.value + '。' + fillSuffix(fill)
    );
  }

  function xWingHead(detail, fill, size) {
    var crossLabels;
    if (detail.orientation === 'row') {
      crossLabels = '第 ' + (detail.cross[0] + 1) + ' 列和第 ' + (detail.cross[1] + 1) + ' 列';
    } else {
      crossLabels = '第 ' + (detail.cross[0] + 1) + ' 行和第 ' + (detail.cross[1] + 1) + ' 行';
    }
    var lineLabels = unitLabel(detail.lines[0].unit) + '和' + unitLabel(detail.lines[1].unit);
    return (
      '数字 ' + detail.value + ' 在' + lineLabels + '的候选位置都分别只在' + crossLabels +
      '，四个格子恰好组成矩形。因此' + crossLabels + '的其他格子都不能填 ' + detail.value +
      '。' + fillSuffix(fill)
    );
  }

  /* 3. 数对排除（保留原有返回结构：cell/value/explanation/highlights） */
  function findNakedPairHint(units, candidates, size) {
    return buildEliminationHint(
      'naked-pair',
      '数对排除',
      findNakedPairEliminations(units, candidates, size),
      candidates,
      size,
      nakedPairHead
    );
  }

  /* 4. 区块排除（Pointing Pair/Triple） */
  function findPointingHint(units, candidates, size) {
    return buildEliminationHint(
      'pointing',
      '区块排除',
      findPointingEliminations(units, candidates, size),
      candidates,
      size,
      pointingHead
    );
  }

  /* 5. 行列排除（Claiming / Box-Line Reduction） */
  function findClaimingHint(units, candidates, size) {
    return buildEliminationHint(
      'claiming',
      '行列排除',
      findClaimingEliminations(units, candidates, size),
      candidates,
      size,
      claimingHead
    );
  }

  /* 6. 矩形排除（X-Wing） */
  function findXWingHint(units, candidates, size) {
    return buildEliminationHint(
      'x-wing',
      '矩形排除',
      findXWingEliminations(units, candidates, size),
      candidates,
      size,
      xWingHead
    );
  }

  /* ------------------------------ 反证法 ------------------------------ */

  /* 7. 反证法：逐个尝试候选数，只有能让盘面继续完成的候选数才成立 */
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

  /* ------------------------------ 难度分析 ------------------------------ */

  /* 在候选数表上落子，并从同行/同列/同宫的候选数中删掉该数字 */
  function fillCandidateCell(candidates, size, r, c, value) {
    var cfg = Core.getConfig(size);
    var i;
    candidates[r][c] = [];
    for (i = 0; i < size; i++) {
      removeCandidateValue(candidates, r, i, value);
      removeCandidateValue(candidates, i, c, value);
    }
    var boxR = Math.floor(r / cfg.boxRows) * cfg.boxRows;
    var boxC = Math.floor(c / cfg.boxCols) * cfg.boxCols;
    for (var rr = boxR; rr < boxR + cfg.boxRows; rr++) {
      for (var cc = boxC; cc < boxC + cfg.boxCols; cc++) {
        removeCandidateValue(candidates, rr, cc, value);
      }
    }
  }

  function applyEliminationToMap(candidates, detail) {
    if (!detail) return false;
    var applied = applyEliminations(candidates, detail.eliminations);
    if (applied.invalid || applied.removed.length === 0) return false;
    for (var r = 0; r < candidates.length; r++) {
      for (var c = 0; c < candidates[r].length; c++) {
        candidates[r][c] = applied.candidates[r][c];
      }
    }
    return true;
  }

  /*
   * 只用逻辑技巧（不回溯、不猜测）解盘，评估难度层级：
   *   Tier 1 = 唯一候选数 / 行·列·宫唯一
   *   Tier 2 = 数对排除
   *   Tier 3 = 区块排除 / 行列排除
   *   Tier 4 = 矩形排除
   * 返回 { solved, maxTier, techniques: {type: count}, remaining }。
   * 不修改传入的棋盘。
   */
  function analyzeDifficulty(grid, size) {
    Core.getConfig(size);
    var n = size;
    var techniques = {};
    var maxTier = 0;
    var r;
    var c;

    var emptyCount = 0;
    for (r = 0; r < n; r++) {
      for (c = 0; c < n; c++) {
        if (!grid[r][c]) emptyCount++;
      }
    }

    if (Core.findConflicts(grid, size).size > 0) {
      return {
        solved: false,
        maxTier: 0,
        techniques: techniques,
        remaining: emptyCount,
        reason: 'conflict',
      };
    }

    var candidates = computeCandidates(grid, size);
    var units = getUnits(size);
    var remaining = emptyCount;

    function count(type, tier) {
      techniques[type] = (techniques[type] || 0) + 1;
      if (tier > maxTier) maxTier = tier;
    }

    var guard = n * n * 20;
    while (remaining > 0 && guard > 0) {
      guard--;

      /* Tier 1：反复运行唯一候选数与行/列/宫唯一，直到没有新进展 */
      var progressed = true;
      while (progressed && remaining > 0) {
        progressed = false;

        var naked = findAnyNakedSingle(candidates);
        if (naked) {
          fillCandidateCell(candidates, n, naked.cell[0], naked.cell[1], naked.value);
          remaining--;
          count('naked-single', 1);
          progressed = true;
          continue;
        }

        var hiddenSingles = findHiddenSingles(units, candidates, n);
        if (hiddenSingles.length > 0) {
          var hidden = hiddenSingles[0];
          fillCandidateCell(candidates, n, hidden.cell[0], hidden.cell[1], hidden.value);
          remaining--;
          count('hidden-single', 1);
          progressed = true;
        }
      }
      if (remaining === 0) break;

      /* Tier 2：数对排除 */
      if (applyEliminationToMap(candidates, findNakedPairEliminations(units, candidates, n))) {
        count('naked-pair', 2);
        continue;
      }

      /* Tier 3：区块排除，其次行列排除 */
      if (applyEliminationToMap(candidates, findPointingEliminations(units, candidates, n))) {
        count('pointing', 3);
        continue;
      }
      if (applyEliminationToMap(candidates, findClaimingEliminations(units, candidates, n))) {
        count('claiming', 3);
        continue;
      }

      /* Tier 4：矩形排除 */
      if (applyEliminationToMap(candidates, findXWingEliminations(units, candidates, n))) {
        count('x-wing', 4);
        continue;
      }

      break;
    }

    return {
      solved: remaining === 0,
      maxTier: maxTier,
      techniques: techniques,
      remaining: remaining,
    };
  }

  /* ------------------------------ 提示入口 ------------------------------ */

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

    var units = getUnits(size);

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
    var hiddenSingles = findHiddenSingles(units, candidates, size);
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
    var pair = findNakedPairHint(units, candidates, size);
    if (pair) {
      if (solution && solution[pair.cell[0]][pair.cell[1]] !== pair.value) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      return success('naked-pair', '数对排除', pair.cell, pair.value, pair.explanation, pair.highlights);
    }

    /* 4. 区块排除 → 5. 行列排除 → 6. 矩形排除 */
    var eliminationHints = [
      findPointingHint(units, candidates, size),
      findClaimingHint(units, candidates, size),
      findXWingHint(units, candidates, size),
    ];
    for (var t = 0; t < eliminationHints.length; t++) {
      var eliminationHint = eliminationHints[t];
      if (!eliminationHint) continue;
      if (solution && solution[eliminationHint.cell[0]][eliminationHint.cell[1]] !== eliminationHint.value) {
        return failure('invalid', '暂时无法提示', BAD_BOARD_MESSAGE);
      }
      return success(
        eliminationHint.type,
        eliminationHint.title,
        eliminationHint.cell,
        eliminationHint.value,
        eliminationHint.explanation,
        eliminationHint.highlights
      );
    }

    /* 7. 反证法 */
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
    findPointingHint: findPointingHint,
    findClaimingHint: findClaimingHint,
    findXWingHint: findXWingHint,
    findContradictionHint: findContradictionHint,
    findNakedPairEliminations: findNakedPairEliminations,
    findPointingEliminations: findPointingEliminations,
    findClaimingEliminations: findClaimingEliminations,
    findXWingEliminations: findXWingEliminations,
    analyzeDifficulty: analyzeDifficulty,
  };
});
