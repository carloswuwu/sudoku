/*
 * 数独 · Sudoku — 界面逻辑
 * 依赖 sudoku-core.js（window.SudokuCore）
 */
(function () {
  'use strict';

  var Core = window.SudokuCore;
  var STORAGE_KEY = 'sudoku-save-v1';
  var CONFIG_KEY = 'sudoku-last-config-v1';
  var DIFFICULTY_LABEL = { easy: '简单', medium: '中等', hard: '困难' };
  var DIFFICULTY_DESC = {
    easy: '提示较多，适合热身与新手。',
    medium: '恰到好处的思考量，经典体验。',
    hard: '提示更少，需要更扎实的推理。',
  };
  var CONFETTI_COLORS = ['#22d3ee', '#818cf8', '#f472b6', '#fbbf24', '#34d399', '#fde68a'];

  var state = {
    size: 9,
    difficulty: 'medium',
    puzzle: [],
    solution: [],
    values: [],
    notes: [],
    selected: null,
    notesMode: false,
    mistakes: 0,
    hints: 0,
    hinted: new Set(),
    elapsed: 0,
    paused: false,
    completed: false,
    history: [],
  };

  var dom = {};
  var cellRefs = [];
  var padButtons = {};
  var ticker = null;
  var toastTimer = null;
  var modalChoice = { size: 9, difficulty: 'medium' };
  var winHiddenForModal = false;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function keyOf(r, c) {
    return r + ':' + c;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(totalSeconds) {
    var sec = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function pad(num) {
      return num < 10 ? '0' + num : String(num);
    }
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  function createNotes(size) {
    var notes = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(new Set());
      notes.push(row);
    }
    return notes;
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheDom();
    buildMiniGrids();
    bindEvents();
    startTicker();

    var saved = loadSave();
    if (saved && restoreGame(saved)) {
      toast('已恢复上次进度');
      return;
    }

    var game = null;
    var lastConfig = loadLastConfig();
    try {
      game = Core.generatePuzzle(lastConfig.size, lastConfig.difficulty);
    } catch (err) {
      console.error('生成初始题目失败', err);
    }
    if (game) {
      applyGame(game);
    } else {
      showLoading(true);
      setTimeout(function () {
        showLoading(false);
        toast('生成失败，请刷新页面重试');
      }, 600);
    }
  }

  function cacheDom() {
    dom.app = document.querySelector('.app');
    dom.board = $('board');
    dom.timer = $('timer');
    dom.mistakes = $('mistakes');
    dom.hints = $('hints');
    dom.modeBadge = $('modeBadge');
    dom.pauseBtn = $('pauseBtn');
    dom.pauseOverlay = $('pauseOverlay');
    dom.resumeBtn = $('resumeBtn');
    dom.loadingOverlay = $('loadingOverlay');
    dom.notesBtn = $('notesBtn');
    dom.undoBtn = $('undoBtn');
    dom.eraseBtn = $('eraseBtn');
    dom.hintBtn = $('hintBtn');
    dom.pad = $('pad');
    dom.newGameBtn = $('newGameBtn');
    dom.restartBtn = $('restartBtn');
    dom.newGameModal = $('newGameModal');
    dom.sizeOptions = $('sizeOptions');
    dom.difficultyOptions = $('difficultyOptions');
    dom.difficultyDesc = $('difficultyDesc');
    dom.startGameBtn = $('startGameBtn');
    dom.winOverlay = $('winOverlay');
    dom.winTime = $('winTime');
    dom.winMistakes = $('winMistakes');
    dom.winHints = $('winHints');
    dom.winDifficulty = $('winDifficulty');
    dom.playAgainBtn = $('playAgainBtn');
    dom.changeSettingsBtn = $('changeSettingsBtn');
    dom.toast = $('toast');
    dom.confetti = $('confetti');
  }

  function buildMiniGrids() {
    var miniGrids = document.querySelectorAll('.mini-grid');
    Array.prototype.forEach.call(miniGrids, function (grid) {
      var size = parseInt(grid.getAttribute('data-size'), 10);
      var cfg = Core.getConfig(size);
      grid.innerHTML = '';
      grid.style.gridTemplateColumns = 'repeat(' + size + ', 1fr)';
      grid.style.gridTemplateRows = 'repeat(' + size + ', 1fr)';
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          var cell = document.createElement('span');
          cell.className = 'mini-cell';
          if (c < size - 1 && (c + 1) % cfg.boxCols === 0) cell.classList.add('mx-r');
          if (r < size - 1 && (r + 1) % cfg.boxRows === 0) cell.classList.add('mx-b');
          grid.appendChild(cell);
        }
      }
    });
  }

  function startTicker() {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(function () {
      if (state.paused || state.completed) return;
      if (!state.values.length) return;
      state.elapsed += 1;
      dom.timer.textContent = formatTime(state.elapsed);
      if (state.elapsed % 10 === 0) save();
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    dom.board.addEventListener('click', onBoardClick);
    dom.pad.addEventListener('click', onPadClick);

    dom.notesBtn.addEventListener('click', toggleNotesMode);
    dom.undoBtn.addEventListener('click', undo);
    dom.eraseBtn.addEventListener('click', eraseSelected);
    dom.hintBtn.addEventListener('click', useHint);

    dom.pauseBtn.addEventListener('click', togglePause);
    dom.pauseOverlay.addEventListener('click', function () {
      setPaused(false);
    });

    dom.newGameBtn.addEventListener('click', openNewGameModal);
    dom.restartBtn.addEventListener('click', restartGame);

    dom.sizeOptions.addEventListener('click', function (event) {
      var card = event.target.closest('.size-card');
      if (!card) return;
      modalChoice.size = parseInt(card.getAttribute('data-size'), 10);
      syncModalUI();
    });

    dom.difficultyOptions.addEventListener('click', function (event) {
      var btn = event.target.closest('.diff-btn');
      if (!btn) return;
      modalChoice.difficulty = btn.getAttribute('data-difficulty');
      syncModalUI();
    });

    dom.startGameBtn.addEventListener('click', function () {
      startNewGame(modalChoice.size, modalChoice.difficulty);
    });

    Array.prototype.forEach.call(document.querySelectorAll('.js-cancel-new'), function (btn) {
      btn.addEventListener('click', closeNewGameModal);
    });

    dom.newGameModal.addEventListener('click', function (event) {
      if (event.target === dom.newGameModal) closeNewGameModal();
    });

    dom.playAgainBtn.addEventListener('click', function () {
      hideWin();
      startNewGame(state.size, state.difficulty);
    });

    dom.changeSettingsBtn.addEventListener('click', function () {
      winHiddenForModal = !dom.winOverlay.hidden;
      hideWin();
      openNewGameModal();
    });

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && !state.paused && !state.completed && state.values.length) {
        setPaused(true);
      }
    });
    window.addEventListener('beforeunload', save);
  }

  function onBoardClick(event) {
    var cell = event.target.closest('.cell');
    if (!cell || !dom.board.contains(cell)) return;
    var r = parseInt(cell.getAttribute('data-r'), 10);
    var c = parseInt(cell.getAttribute('data-c'), 10);
    selectCell(r, c);
  }

  function onPadClick(event) {
    var btn = event.target.closest('.pad-btn');
    if (!btn) return;
    inputDigit(parseInt(btn.getAttribute('data-d'), 10));
  }

  function onKeydown(event) {
    /* 弹窗打开时只处理 Esc */
    if (!dom.newGameModal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNewGameModal();
      }
      return;
    }
    if (!dom.winOverlay.hidden) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
      return;
    }

    var k = event.key;
    if (k >= '1' && k <= '9') {
      if (parseInt(k, 10) <= state.size) {
        event.preventDefault();
        inputDigit(parseInt(k, 10));
      }
      return;
    }

    switch (k) {
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        eraseSelected();
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1, 0);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1, 0);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        moveSelection(0, -1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveSelection(0, 1);
        return;
      case 'Escape':
        if (state.paused) {
          event.preventDefault();
          setPaused(false);
        }
        return;
      default:
        break;
    }

    var lower = k.toLowerCase();
    if (lower === 'n') {
      event.preventDefault();
      toggleNotesMode();
    } else if (lower === 'h') {
      event.preventDefault();
      useHint();
    } else if (lower === 'p') {
      event.preventDefault();
      togglePause();
    } else if (lower === 'z') {
      event.preventDefault();
      undo();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 棋盘构建与渲染                                                       */
  /* ------------------------------------------------------------------ */

  function buildBoard() {
    var n = state.size;
    var cfg = Core.getConfig(n);
    var noteCols = n === 4 ? 2 : 3;
    var noteRows = n === 4 ? 2 : Math.ceil(n / 3);

    dom.board.innerHTML = '';
    dom.board.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
    dom.board.style.gridTemplateRows = 'repeat(' + n + ', 1fr)';
    dom.board.style.setProperty('--note-cols', String(noteCols));
    dom.board.style.setProperty('--note-rows', String(noteRows));
    dom.board.setAttribute('data-size', String(n));
    dom.board.setAttribute('aria-label', n + '×' + n + ' 数独棋盘');

    var boardMax = n === 4 ? 480 : n === 6 ? 540 : 600;
    dom.app.style.setProperty('--board-max', boardMax + 'px');

    cellRefs = [];
    var fragment = document.createDocumentFragment();

    for (var r = 0; r < n; r++) {
      var rowRefs = [];
      for (var c = 0; c < n; c++) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.setAttribute('data-r', String(r));
        cell.setAttribute('data-c', String(c));
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列');
        if (c < n - 1) {
          cell.classList.add((c + 1) % cfg.boxCols === 0 ? 'edge-r' : 'line-r');
        }
        if (r < n - 1) {
          cell.classList.add((r + 1) % cfg.boxRows === 0 ? 'edge-b' : 'line-b');
        }

        var num = document.createElement('span');
        num.className = 'num';

        var notes = document.createElement('span');
        notes.className = 'notes';
        var noteSpans = new Map();
        for (var d = 1; d <= n; d++) {
          var note = document.createElement('span');
          note.className = 'note';
          note.setAttribute('data-d', String(d));
          notes.appendChild(note);
          noteSpans.set(d, note);
        }

        cell.appendChild(num);
        cell.appendChild(notes);
        fragment.appendChild(cell);
        rowRefs.push({ el: cell, num: num, notes: notes, noteSpans: noteSpans });
      }
      cellRefs.push(rowRefs);
    }

    dom.board.appendChild(fragment);
  }

  function buildPad() {
    var n = state.size;
    var cols = n === 4 ? 2 : 3;
    dom.pad.innerHTML = '';
    dom.pad.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    padButtons = {};
    for (var d = 1; d <= n; d++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pad-btn';
      btn.setAttribute('data-d', String(d));
      btn.setAttribute('aria-label', '填入数字 ' + d);

      var digit = document.createElement('span');
      digit.className = 'digit';
      digit.textContent = String(d);

      var count = document.createElement('span');
      count.className = 'count';

      btn.appendChild(digit);
      btn.appendChild(count);
      dom.pad.appendChild(btn);
      padButtons[d] = btn;
    }
  }

  function renderAll() {
    renderBoard();
    renderPad();
    renderMeta();
  }

  function renderBoard() {
    var n = state.size;
    if (!cellRefs.length) return;
    var cfg = Core.getConfig(n);
    var sel = state.selected;
    var selVal = 0;
    var selBox = -1;
    if (sel) {
      selVal = state.values[sel.r][sel.c];
      selBox = Core.boxIndex(sel.r, sel.c, n);
    }

    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var ref = cellRefs[r][c];
        var value = state.values[r][c];
        var given = state.puzzle[r][c] !== 0;
        var classes = ['cell'];

        if (c < n - 1) classes.push((c + 1) % cfg.boxCols === 0 ? 'edge-r' : 'line-r');
        if (r < n - 1) classes.push((r + 1) % cfg.boxRows === 0 ? 'edge-b' : 'line-b');

        if (given) classes.push('given');
        if (value && !given) classes.push('user');
        if (state.hinted.has(keyOf(r, c))) classes.push('hinted');

        var isSelected = !!sel && sel.r === r && sel.c === c;
        if (isSelected) {
          classes.push('selected');
        } else if (sel && (sel.r === r || sel.c === c || Core.boxIndex(r, c, n) === selBox)) {
          classes.push('peer');
        }

        if (value) {
          if (value !== state.solution[r][c]) classes.push('wrong');
          else if (!isSelected && value === selVal) classes.push('same');
        }

        ref.el.className = classes.join(' ');

        var label = '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列，';
        label += value ? '数字 ' + value : '空';
        if (given) label += '（题目）';
        if (value && value !== state.solution[r][c]) label += '（错误）';
        ref.el.setAttribute('aria-label', label);

        if (value !== 0) {
          ref.num.textContent = String(value);
          ref.notes.classList.remove('show');
          for (var d = 1; d <= n; d++) ref.noteSpans.get(d).textContent = '';
        } else {
          ref.num.textContent = '';
          var noteSet = state.notes[r][c];
          var hasNotes = noteSet.size > 0;
          ref.notes.classList.toggle('show', hasNotes);
          for (var d2 = 1; d2 <= n; d2++) {
            var span = ref.noteSpans.get(d2);
            span.textContent = noteSet.has(d2) ? String(d2) : '';
            span.classList.toggle('hit', noteSet.has(d2) && selVal === d2);
          }
        }
      }
    }
  }

  function renderPad() {
    var n = state.size;
    for (var d = 1; d <= n; d++) {
      var btn = padButtons[d];
      if (!btn) continue;
      var count = 0;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (state.values[r][c] === d) count += 1;
        }
      }
      var remain = n - count;
      btn.querySelector('.count').textContent = remain > 0 ? remain : '✓';
      btn.classList.toggle('complete', remain <= 0);
    }
  }

  function renderMeta() {
    dom.timer.textContent = formatTime(state.elapsed);
    dom.timer.classList.toggle('is-paused', state.paused);
    dom.mistakes.textContent = String(state.mistakes);
    dom.hints.textContent = String(state.hints);
    dom.notesBtn.classList.toggle('active', state.notesMode);
    dom.notesBtn.setAttribute('aria-pressed', state.notesMode ? 'true' : 'false');
    dom.undoBtn.disabled = state.history.length === 0;
    dom.modeBadge.textContent = state.size + '×' + state.size + ' · ' + DIFFICULTY_LABEL[state.difficulty];
  }

  function updatePauseUI() {
    dom.pauseOverlay.hidden = !state.paused;
    dom.board.classList.toggle('blurred', state.paused);
    dom.pauseBtn.classList.toggle('is-active', state.paused);
    dom.pauseBtn.setAttribute('aria-label', state.paused ? '继续游戏' : '暂停游戏');
    dom.timer.classList.toggle('is-paused', state.paused);
  }

  function pulseCell(r, c) {
    if (!cellRefs[r] || !cellRefs[r][c]) return;
    var el = cellRefs[r][c].el;
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
    setTimeout(function () {
      el.classList.remove('pulse');
    }, 260);
  }

  /* ------------------------------------------------------------------ */
  /* 游戏操作                                                            */
  /* ------------------------------------------------------------------ */

  function selectCell(r, c) {
    if (state.paused || state.completed) return;
    state.selected = { r: r, c: c };
    renderBoard();
  }

  function ensureSelection() {
    if (state.selected) return state.selected;
    var n = state.size;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!state.puzzle[r][c] && state.values[r][c] !== state.solution[r][c]) {
          state.selected = { r: r, c: c };
          renderBoard();
          return state.selected;
        }
      }
    }
    return null;
  }

  function inputDigit(digit) {
    if (state.paused || state.completed) return;
    if (!state.values.length) return;
    if (digit < 1 || digit > state.size) return;
    var sel = ensureSelection();
    if (!sel) return;
    var r = sel.r;
    var c = sel.c;
    if (state.puzzle[r][c]) return;
    if (state.notesMode && !state.values[r][c]) {
      toggleNote(r, c, digit);
    } else {
      placeNumber(r, c, digit);
    }
  }

  function placeNumber(r, c, value) {
    if (state.values[r][c] === value) {
      clearCell(r, c);
      return;
    }
    pushHistory();
    state.values[r][c] = value;
    state.notes[r][c].clear();
    state.hinted.delete(keyOf(r, c));

    var isWrong = value !== state.solution[r][c];
    if (isWrong) {
      state.mistakes += 1;
    } else {
      clearPeerNotes(r, c, value);
    }

    state.selected = { r: r, c: c };
    renderBoard();
    renderPad();
    renderMeta();
    save();
    pulseCell(r, c);

    if (!isWrong) checkCompletion();
  }

  function toggleNote(r, c, digit) {
    if (state.values[r][c]) return;
    pushHistory();
    var set = state.notes[r][c];
    if (set.has(digit)) set.delete(digit);
    else set.add(digit);
    state.selected = { r: r, c: c };
    renderBoard();
    save();
  }

  function clearCell(r, c) {
    if (state.puzzle[r][c]) return;
    if (!state.values[r][c] && state.notes[r][c].size === 0) return;
    pushHistory();
    state.values[r][c] = 0;
    state.notes[r][c].clear();
    state.hinted.delete(keyOf(r, c));
    state.selected = { r: r, c: c };
    renderBoard();
    renderPad();
    save();
  }

  function eraseSelected() {
    if (state.paused || state.completed) return;
    var sel = ensureSelection();
    if (!sel) return;
    clearCell(sel.r, sel.c);
  }

  function toggleNotesMode() {
    if (state.paused || state.completed) return;
    state.notesMode = !state.notesMode;
    renderMeta();
    save();
  }

  function moveSelection(dr, dc) {
    if (state.paused || state.completed) return;
    var n = state.size;
    if (!state.selected) {
      state.selected = { r: 0, c: 0 };
      renderBoard();
      return;
    }
    state.selected = {
      r: clamp(state.selected.r + dr, 0, n - 1),
      c: clamp(state.selected.c + dc, 0, n - 1),
    };
    renderBoard();
  }

  function forEachPeer(r, c, fn) {
    var n = state.size;
    var cfg = Core.getConfig(n);
    for (var i = 0; i < n; i++) {
      if (i !== r) fn(i, c);
      if (i !== c) fn(r, i);
    }
    var boxR = Math.floor(r / cfg.boxRows) * cfg.boxRows;
    var boxC = Math.floor(c / cfg.boxCols) * cfg.boxCols;
    for (var rr = boxR; rr < boxR + cfg.boxRows; rr++) {
      for (var cc = boxC; cc < boxC + cfg.boxCols; cc++) {
        if (rr === r || cc === c) continue;
        fn(rr, cc);
      }
    }
  }

  function clearPeerNotes(r, c, value) {
    forEachPeer(r, c, function (rr, cc) {
      state.notes[rr][cc].delete(value);
    });
  }

  function undo() {
    if (state.paused || state.completed) return;
    var snapshot = state.history.pop();
    if (!snapshot) return;
    state.values = snapshot.values;
    state.notes = restoreNotes(snapshot.notes);
    state.mistakes = snapshot.mistakes;
    state.hints = snapshot.hints;
    state.hinted = new Set(snapshot.hinted);
    state.selected = snapshot.selected;
    state.notesMode = snapshot.notesMode;
    renderAll();
    save();
  }

  function useHint() {
    if (state.paused || state.completed) return;
    if (!state.values.length) return;
    var n = state.size;
    var target = null;
    var sel = state.selected;
    if (sel && !state.puzzle[sel.r][sel.c] && state.values[sel.r][sel.c] !== state.solution[sel.r][sel.c]) {
      target = { r: sel.r, c: sel.c };
    }
    if (!target) {
      outer: for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (!state.puzzle[r][c] && state.values[r][c] !== state.solution[r][c]) {
            target = { r: r, c: c };
            break outer;
          }
        }
      }
    }
    if (!target) {
      toast('这一局已经填完啦');
      return;
    }
    pushHistory();
    var value = state.solution[target.r][target.c];
    state.values[target.r][target.c] = value;
    state.notes[target.r][target.c].clear();
    state.hinted.add(keyOf(target.r, target.c));
    state.hints += 1;
    state.selected = target;
    clearPeerNotes(target.r, target.c, value);
    renderAll();
    save();
    pulseCell(target.r, target.c);
    checkCompletion();
  }

  function checkCompletion() {
    var n = state.size;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (state.values[r][c] !== state.solution[r][c]) return false;
      }
    }
    state.completed = true;
    state.paused = false;
    updatePauseUI();
    renderAll();
    save();
    showWin();
    return true;
  }

  function pushHistory() {
    state.history.push({
      values: state.values.map(function (row) {
        return row.slice();
      }),
      notes: state.notes.map(function (row) {
        return row.map(function (set) {
          return Array.from(set);
        });
      }),
      mistakes: state.mistakes,
      hints: state.hints,
      hinted: Array.from(state.hinted),
      selected: state.selected ? { r: state.selected.r, c: state.selected.c } : null,
      notesMode: state.notesMode,
    });
    if (state.history.length > 200) state.history.shift();
  }

  function restoreNotes(rawNotes) {
    var notes = createNotes(state.size);
    for (var r = 0; r < state.size; r++) {
      for (var c = 0; c < state.size; c++) {
        var list = rawNotes[r] && rawNotes[r][c];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) notes[r][c].add(list[i]);
      }
    }
    return notes;
  }

  function togglePause() {
    if (state.completed) return;
    setPaused(!state.paused);
  }

  function setPaused(paused) {
    if (state.completed) return;
    if (state.paused === paused) return;
    state.paused = paused;
    updatePauseUI();
    renderMeta();
    save();
  }

  function restartGame() {
    if (!state.values.length) return;
    if (!window.confirm('重玩本局？当前填入的数字会被清除。')) return;
    state.values = state.puzzle.map(function (row) {
      return row.slice();
    });
    state.notes = createNotes(state.size);
    state.selected = null;
    state.mistakes = 0;
    state.hints = 0;
    state.hinted = new Set();
    state.elapsed = 0;
    state.history = [];
    state.notesMode = false;
    state.paused = false;
    state.completed = false;
    updatePauseUI();
    renderAll();
    save();
    toast('已重新开始本局');
  }

  /* ------------------------------------------------------------------ */
  /* 新游戏                                                              */
  /* ------------------------------------------------------------------ */

  function openNewGameModal() {
    modalChoice.size = state.size;
    modalChoice.difficulty = state.difficulty;
    syncModalUI();
    dom.newGameModal.hidden = false;
    setTimeout(function () {
      try {
        dom.startGameBtn.focus({ preventScroll: true });
      } catch (err) {
        dom.startGameBtn.focus();
      }
    }, 40);
  }

  function closeNewGameModal() {
    dom.newGameModal.hidden = true;
    /* 从胜利弹窗进入「换个难度」后取消，应回到胜利弹窗 */
    if (winHiddenForModal && state.completed) {
      dom.winOverlay.hidden = false;
    }
    winHiddenForModal = false;
  }

  function syncModalUI() {
    var cards = dom.sizeOptions.querySelectorAll('.size-card');
    Array.prototype.forEach.call(cards, function (card) {
      card.classList.toggle('selected', parseInt(card.getAttribute('data-size'), 10) === modalChoice.size);
    });
    var buttons = dom.difficultyOptions.querySelectorAll('.diff-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-difficulty') === modalChoice.difficulty);
    });
    dom.difficultyDesc.textContent = DIFFICULTY_DESC[modalChoice.difficulty] || '';
  }

  function startNewGame(size, difficulty) {
    winHiddenForModal = false;
    closeNewGameModal();
    hideWin();
    showLoading(true);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var game = null;
        try {
          game = Core.generatePuzzle(size, difficulty);
        } catch (err) {
          console.error('生成题目失败', err);
        }
        showLoading(false);
        if (game) applyGame(game);
        else toast('生成题目失败，请重试');
      });
    });
  }

  function applyGame(game) {
    state.size = game.size;
    state.difficulty = game.difficulty;
    state.puzzle = game.puzzle.map(function (row) {
      return row.slice();
    });
    state.solution = game.solution.map(function (row) {
      return row.slice();
    });
    state.values = game.puzzle.map(function (row) {
      return row.slice();
    });
    state.notes = createNotes(game.size);
    state.selected = null;
    state.notesMode = false;
    state.mistakes = 0;
    state.hints = 0;
    state.hinted = new Set();
    state.elapsed = 0;
    state.paused = false;
    state.completed = false;
    state.history = [];

    hideWin();
    dom.pauseOverlay.hidden = true;
    buildBoard();
    buildPad();
    updatePauseUI();
    renderAll();
    save();
    rememberConfig(game.size, game.difficulty);
  }

  function showLoading(show) {
    dom.loadingOverlay.hidden = !show;
  }

  /* ------------------------------------------------------------------ */
  /* 胜利 / 彩带                                                         */
  /* ------------------------------------------------------------------ */

  function showWin() {
    dom.winTime.textContent = formatTime(state.elapsed);
    dom.winMistakes.textContent = String(state.mistakes);
    dom.winHints.textContent = String(state.hints);
    dom.winDifficulty.textContent = state.size + '×' + state.size + ' · ' + DIFFICULTY_LABEL[state.difficulty];
    dom.winOverlay.hidden = false;
    launchConfetti();
  }

  function hideWin() {
    dom.winOverlay.hidden = true;
  }

  function launchConfetti() {
    var layer = dom.confetti;
    layer.innerHTML = '';
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var i = 0; i < 84; i++) {
      var piece = document.createElement('i');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.width = 5 + Math.random() * 7 + 'px';
      piece.style.height = 9 + Math.random() * 9 + 'px';
      piece.style.setProperty('--delay', (Math.random() * 0.7).toFixed(2) + 's');
      piece.style.setProperty('--dur', (2.6 + Math.random() * 1.8).toFixed(2) + 's');
      piece.style.setProperty('--drift', Math.round(Math.random() * 180 - 90) + 'px');
      piece.style.setProperty('--rot', Math.round(Math.random() * 900 - 450) + 'deg');
      layer.appendChild(piece);
    }
    setTimeout(function () {
      layer.innerHTML = '';
    }, 5200);
  }

  /* ------------------------------------------------------------------ */
  /* 存储                                                                */
  /* ------------------------------------------------------------------ */

  function save() {
    if (state.completed) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        /* 忽略 */
      }
      return;
    }
    if (!state.values.length) return;
    try {
      var payload = {
        version: 1,
        size: state.size,
        difficulty: state.difficulty,
        puzzle: state.puzzle,
        solution: state.solution,
        values: state.values,
        notes: state.notes.map(function (row) {
          return row.map(function (set) {
            return Array.from(set);
          });
        }),
        selected: state.selected,
        notesMode: state.notesMode,
        mistakes: state.mistakes,
        hints: state.hints,
        hinted: Array.from(state.hinted),
        elapsed: state.elapsed,
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      /* 存储不可用时忽略，不影响游戏 */
    }
  }

  function isMatrix(matrix, n, allowZero) {
    if (!Array.isArray(matrix) || matrix.length !== n) return false;
    for (var r = 0; r < n; r++) {
      var row = matrix[r];
      if (!Array.isArray(row) || row.length !== n) return false;
      for (var c = 0; c < n; c++) {
        var value = row[c];
        var min = allowZero ? 0 : 1;
        if (!Number.isInteger(value) || value < min || value > n) return false;
      }
    }
    return true;
  }

  function loadLastConfig() {
    var fallback = { size: 9, difficulty: 'medium' };
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return fallback;
      var data = JSON.parse(raw);
      if (!data || [4, 6, 9].indexOf(data.size) < 0) return fallback;
      if (!DIFFICULTY_LABEL[data.difficulty]) return fallback;
      return { size: data.size, difficulty: data.difficulty };
    } catch (err) {
      return fallback;
    }
  }

  function rememberConfig(size, difficulty) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ size: size, difficulty: difficulty }));
    } catch (err) {
      /* 忽略存储失败 */
    }
  }

  function loadSave() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || [4, 6, 9].indexOf(data.size) < 0) return null;
      var n = data.size;
      if (!isMatrix(data.puzzle, n, true)) return null;
      if (!isMatrix(data.values, n, true)) return null;
      if (!isMatrix(data.solution, n, false)) return null;
      if (!Core.isValidSolution(data.solution, n)) return null;
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (data.puzzle[r][c] !== 0 && data.puzzle[r][c] !== data.solution[r][c]) return null;
        }
      }
      if (!Array.isArray(data.notes) || data.notes.length !== n) return null;
      for (var r2 = 0; r2 < n; r2++) {
        if (!Array.isArray(data.notes[r2]) || data.notes[r2].length !== n) return null;
      }
      var selected = null;
      if (data.selected && Number.isInteger(data.selected.r) && Number.isInteger(data.selected.c) &&
          data.selected.r >= 0 && data.selected.r < n && data.selected.c >= 0 && data.selected.c < n) {
        selected = { r: data.selected.r, c: data.selected.c };
      }
      var hinted = [];
      if (Array.isArray(data.hinted)) {
        hinted = data.hinted.filter(function (k) {
          return typeof k === 'string' && /^\d+:\d+$/.test(k);
        });
      }
      return {
        size: n,
        difficulty: DIFFICULTY_LABEL[data.difficulty] ? data.difficulty : 'medium',
        puzzle: data.puzzle,
        solution: data.solution,
        values: data.values,
        notes: data.notes,
        selected: selected,
        notesMode: !!data.notesMode,
        mistakes: Number.isInteger(data.mistakes) && data.mistakes >= 0 ? data.mistakes : 0,
        hints: Number.isInteger(data.hints) && data.hints >= 0 ? data.hints : 0,
        hinted: hinted,
        elapsed: Number.isFinite(data.elapsed) && data.elapsed >= 0 ? Math.floor(data.elapsed) : 0,
      };
    } catch (err) {
      return null;
    }
  }

  function restoreGame(data) {
    var n = data.size;
    state.size = n;
    state.difficulty = data.difficulty;
    state.puzzle = data.puzzle.map(function (row) {
      return row.slice();
    });
    state.solution = data.solution.map(function (row) {
      return row.slice();
    });
    state.values = data.values.map(function (row) {
      return row.slice();
    });
    state.notes = createNotes(n);
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var list = data.notes[r][c];
        for (var i = 0; i < list.length; i++) {
          var d = list[i];
          if (Number.isInteger(d) && d >= 1 && d <= n) state.notes[r][c].add(d);
        }
      }
    }
    state.selected = data.selected;
    state.notesMode = data.notesMode;
    state.mistakes = data.mistakes;
    state.hints = data.hints;
    state.hinted = new Set(data.hinted);
    state.elapsed = data.elapsed;
    state.paused = false;
    state.completed = false;
    state.history = [];

    dom.pauseOverlay.hidden = true;
    buildBoard();
    buildPad();
    updatePauseUI();
    renderAll();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 提示条                                                              */
  /* ------------------------------------------------------------------ */

  function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    dom.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('show');
      toastTimer = setTimeout(function () {
        dom.toast.hidden = true;
      }, 240);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
