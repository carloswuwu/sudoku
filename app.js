/*
 * 数独 · Sudoku — 界面逻辑
 * 依赖 sudoku-core.js（window.SudokuCore）
 */
(function () {
  'use strict';

  var Core = window.SudokuCore;
  var Hints = window.SudokuHints;
  var STORAGE_KEY = 'sudoku-save-v1';
  var CONFIG_KEY = 'sudoku-last-config-v1';
  var DIFFICULTY_LABEL = { easy: '简单', medium: '中等', hard: '困难' };
  var DIFFICULTY_DESC = {
    easy: '提示较多，只需唯一候选数即可推出。',
    medium: '需要使用数对排除等常用技巧。',
    hard: '可能出现区块排除、矩形排除等进阶推理。',
  };
  /* 各难度期望的推理层级：1=唯一候选，2=数对，3=区块/行列排除，4=矩形排除（5=逻辑链也无法完成） */
  var DIFFICULTY_TIER = { easy: 1, medium: 2, hard: 3 };

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
    hintHighlights: new Set(),
    hintTargetKey: null,
    elapsed: 0,
    paused: false,
    completed: false,
    history: [],
  };

  var dom = {};
  var cellRefs = [];
  var padButtons = {};
  var ticker = null;
  var timerBase = 0;
  var timerAnchor = null;
  var toastTimer = null;
  var hintCardTimer = null;
  var hintHighlightTimer = null;
  var modalChoice = { size: 9, difficulty: 'medium' };
  var winHiddenForModal = false;
  var deferredInstallPrompt = null;
  var modalReturnFocus = null;
  var winReturnFocus = null;
  var pauseReturnFocus = null;
  var restartReturnFocus = null;

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

  function activeElementOrNull() {
    var el = document.activeElement;
    return el && el !== document.body ? el : null;
  }

  function restoreFocus(el) {
    if (!el || !el.isConnected || el.disabled || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  }

  function focusAfterRender(el) {
    if (!el || typeof el.focus !== 'function') return;
    setTimeout(function () {
      try {
        el.focus({ preventScroll: true });
      } catch (err) {
        el.focus();
      }
    }, 0);
  }

  /* 把 Tab / Shift+Tab 限制在当前弹窗内（对话框打开时背景不可聚焦） */
  function trapTab(container, event) {
    if (!container || event.key !== 'Tab') return;
    var focusable = container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = document.activeElement;
    if (!container.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
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

  /* ------------------------------------------------------------------ */
  /* 计时器：按真实时间累计，而不是数 setInterval 次数，避免掉帧/节流时少计时 */
  /* ------------------------------------------------------------------ */

  function currentElapsedSeconds() {
    if (timerAnchor === null) return timerBase;
    return timerBase + Math.floor((Date.now() - timerAnchor) / 1000);
  }

  function startTimer() {
    if (timerAnchor !== null) return;
    timerBase = state.elapsed;
    timerAnchor = Date.now();
  }

  function pauseTimer() {
    if (timerAnchor === null) return;
    state.elapsed = currentElapsedSeconds();
    timerBase = state.elapsed;
    timerAnchor = null;
  }

  function resetTimer() {
    state.elapsed = 0;
    timerBase = 0;
    timerAnchor = null;
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

  /*
   * 按难度生成题目：出题仍由 sudoku-core 负责（提示数目标保证唯一解），
   * 这里再用提示引擎的难度分析挑选真正需要对应推理层级的盘面。
   * 尝试次数有上限，并保留最接近目标难度的候选，避免生成卡顿。
   */
  function analyzeTier(puzzle, size) {
    if (!Hints || typeof Hints.analyzeDifficulty !== 'function') return -1;
    var info = Hints.analyzeDifficulty(puzzle, size);
    if (!info) return -1;
    return info.solved ? info.maxTier : 5;
  }

  function acceptTier(score, difficulty) {
    if (score < 0) return true;
    if (difficulty === 'hard') return score >= 3;
    if (difficulty === 'medium') return score === 2 || score === 3;
    return score === 1 || score === 5;
  }

  function generateGame(size, difficulty) {
    if (!Hints || typeof Hints.analyzeDifficulty !== 'function') {
      return Core.generatePuzzle(size, difficulty);
    }
    var target = DIFFICULTY_TIER[difficulty] || 1;
    var attempts = 1;
    if (difficulty === 'medium') attempts = size === 9 ? 12 : size === 6 ? 4 : 1;
    else if (difficulty === 'hard') attempts = size === 9 ? 10 : size === 6 ? 4 : 1;
    if (attempts <= 1) return Core.generatePuzzle(size, difficulty);

    var best = null;
    var bestDistance = 99;
    var bestScore = -1;
    for (var i = 0; i < attempts; i++) {
      var game = Core.generatePuzzle(size, difficulty);
      var score = analyzeTier(game.puzzle, size);
      if (acceptTier(score, difficulty)) return game;
      var distance = Math.abs(score - target);
      if (distance < bestDistance || (distance === bestDistance && score < bestScore)) {
        best = game;
        bestDistance = distance;
        bestScore = score;
      }
    }
    return best || Core.generatePuzzle(size, difficulty);
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheDom();
    buildMiniGrids();
    bindEvents();
    setupPwa();
    startTicker();

    var saved = loadSave();
    if (saved && restoreGame(saved)) {
      toast('已恢复上次进度');
      return;
    }

    var game = null;
    var lastConfig = loadLastConfig();
    try {
      game = generateGame(lastConfig.size, lastConfig.difficulty);
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
    dom.controls = document.querySelector('.controls');
    dom.toast = $('toast');
    dom.restartModal = $('restartModal');
    dom.restartConfirmBtn = $('restartConfirmBtn');
    dom.restartCancelBtn = $('restartCancelBtn');
    dom.installBtn = $('installBtn');
    dom.hintCard = $('hintCard');
    dom.hintTitle = $('hintTitle');
    dom.hintText = $('hintText');
    dom.hintClose = $('hintClose');
  }

  /* PWA：仅在 HTTPS / localhost 下挂载 manifest 并注册 Service Worker（file:// 下跳过） */
  function isPwaContext() {
    return (
      location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    );
  }

  function setupPwa() {
    if (!isPwaContext()) return;

    if (!document.querySelector('link[rel="manifest"]')) {
      var manifestLink = document.createElement('link');
      manifestLink.rel = 'manifest';
      manifestLink.href = 'manifest.webmanifest';
      document.head.appendChild(manifestLink);
    }

    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service Worker 注册失败：', err);
      });
    });
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
      if (!state.values.length || state.paused || state.completed) return;
      if (timerAnchor === null) startTimer();
      var elapsed = currentElapsedSeconds();
      if (elapsed === state.elapsed) return;
      state.elapsed = elapsed;
      dom.timer.textContent = formatTime(state.elapsed);
      if (state.elapsed % 10 === 0) save();
    }, 500);
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    dom.board.addEventListener('click', onBoardClick);
    dom.board.addEventListener('focusin', onBoardFocus);
    dom.pad.addEventListener('click', onPadClick);

    dom.notesBtn.addEventListener('click', toggleNotesMode);
    dom.undoBtn.addEventListener('click', undo);
    dom.eraseBtn.addEventListener('click', eraseSelected);
    dom.hintBtn.addEventListener('click', useHint);
    if (dom.hintClose) dom.hintClose.addEventListener('click', hideHintCard);

    dom.pauseBtn.addEventListener('click', togglePause);
    if (dom.resumeBtn) dom.resumeBtn.addEventListener('click', function () {
      setPaused(false);
    });
    dom.pauseOverlay.addEventListener('click', function () {
      setPaused(false);
    });

    dom.newGameBtn.addEventListener('click', openNewGameModal);
    dom.restartBtn.addEventListener('click', openRestartConfirm);
    dom.restartConfirmBtn.addEventListener('click', confirmRestart);

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

    Array.prototype.forEach.call(document.querySelectorAll('.js-cancel-restart'), function (btn) {
      btn.addEventListener('click', closeRestartConfirm);
    });

    dom.restartModal.addEventListener('click', function (event) {
      if (event.target === dom.restartModal) closeRestartConfirm();
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
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    if (dom.installBtn) dom.installBtn.addEventListener('click', promptInstall);
  }

  function onBeforeInstallPrompt(event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (dom.installBtn) dom.installBtn.hidden = false;
  }

  function onAppInstalled() {
    deferredInstallPrompt = null;
    if (dom.installBtn) dom.installBtn.hidden = true;
    toast('已安装到桌面');
  }

  function promptInstall() {
    if (!deferredInstallPrompt) return;
    var promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    promptEvent.prompt();
    if (promptEvent.userChoice && typeof promptEvent.userChoice.then === 'function') {
      promptEvent.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted' && dom.installBtn) {
          dom.installBtn.hidden = true;
        }
      });
    }
  }

  function onBoardClick(event) {
    var cell = event.target.closest('.cell');
    if (!cell || !dom.board.contains(cell)) return;
    var r = parseInt(cell.getAttribute('data-r'), 10);
    var c = parseInt(cell.getAttribute('data-c'), 10);
    selectCell(r, c);
  }

  /* Tab 进入棋盘或脚本聚焦某个格子时，同步选中状态 */
  function onBoardFocus(event) {
    var cell = event.target && event.target.closest ? event.target.closest('.cell') : null;
    if (!cell || !dom.board.contains(cell)) return;
    var r = parseInt(cell.getAttribute('data-r'), 10);
    var c = parseInt(cell.getAttribute('data-c'), 10);
    if (Number.isNaN(r) || Number.isNaN(c)) return;
    selectCell(r, c);
  }

  function onPadClick(event) {
    var btn = event.target.closest('.pad-btn');
    if (!btn) return;
    inputDigit(parseInt(btn.getAttribute('data-d'), 10));
  }

  function onKeydown(event) {
    /* 重玩确认弹窗优先于其他弹窗处理 */
    if (!dom.restartModal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRestartConfirm();
        return;
      }
      trapTab(dom.restartModal, event);
      return;
    }
    /* 弹窗打开时只处理 Esc / Tab（焦点限制在弹窗内） */
    if (!dom.newGameModal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNewGameModal();
        return;
      }
      trapTab(dom.newGameModal, event);
      return;
    }
    if (!dom.winOverlay.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        hideWin();
        return;
      }
      trapTab(dom.winOverlay, event);
      return;
    }
    if (state.paused) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPaused(false);
        return;
      }
      if (event.key === 'Tab') {
        trapTab(dom.pauseOverlay, event);
        return;
      }
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

    var boardMax = n === 4 ? 460 : n === 6 ? 520 : 560;
    dom.app.style.setProperty('--board-max', boardMax + 'px');

    dom.board.setAttribute('aria-rowcount', String(n));
    dom.board.setAttribute('aria-colcount', String(n));

    cellRefs = [];
    var fragment = document.createDocumentFragment();

    for (var r = 0; r < n; r++) {
      var rowEl = document.createElement('div');
      rowEl.className = 'board-row';
      rowEl.setAttribute('role', 'row');
      var rowRefs = [];
      for (var c = 0; c < n; c++) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.tabIndex = -1;
        cell.setAttribute('data-r', String(r));
        cell.setAttribute('data-c', String(c));
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-rowindex', String(r + 1));
        cell.setAttribute('aria-colindex', String(c + 1));
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
        rowEl.appendChild(cell);
        rowRefs.push({ el: cell, num: num, notes: notes, noteSpans: noteSpans });
      }
      fragment.appendChild(rowEl);
      cellRefs.push(rowRefs);
    }

    dom.board.appendChild(fragment);
  }

  function buildPad() {
    var n = state.size;
    dom.pad.innerHTML = '';
    dom.pad.setAttribute('data-size', String(n));
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
    /* 焦点落点：有选中格用选中格，否则用左上角，保证棋盘始终只有一个 Tab 停留点 */
    var rovingR = sel ? sel.r : 0;
    var rovingC = sel ? sel.c : 0;
    /* 只根据行/列/宫规则找冲突，不参考题目答案 */
    var conflicts = Core.findConflicts(state.values, n);

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
          if (conflicts.has(keyOf(r, c))) classes.push('conflict');
          else if (!isSelected && value === selVal) classes.push('same');
        }

        if (state.hintHighlights.has(keyOf(r, c))) classes.push('hint-glow');
        if (state.hintTargetKey === keyOf(r, c)) classes.push('hint-target');

        ref.el.className = classes.join(' ');

        var noteSet = state.notes[r][c];
        var noteList = [];
        if (!value && noteSet.size) {
          noteSet.forEach(function (d) {
            noteList.push(d);
          });
          noteList.sort(function (a, b) {
            return a - b;
          });
        }

        var label = '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列，';
        label += value ? '数字 ' + value : '空';
        if (!value && noteList.length) label += '，笔记 ' + noteList.join('、');
        if (given) label += '（题目）';
        if (conflicts.has(keyOf(r, c))) label += '（与同行、同列或同宫的数字重复）';
        ref.el.setAttribute('aria-label', label);
        ref.el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        ref.el.tabIndex = r === rovingR && c === rovingC ? 0 : -1;

        if (value !== 0) {
          ref.num.textContent = String(value);
          ref.notes.classList.remove('show');
          for (var d = 1; d <= n; d++) ref.noteSpans.get(d).textContent = '';
        } else {
          ref.num.textContent = '';
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
      btn.setAttribute(
        'aria-label',
        remain > 0 ? '填入数字 ' + d + '，还剩 ' + remain + ' 个' : '填入数字 ' + d + '，已完成'
      );
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
  /* 逻辑提示                                                            */
  /* ------------------------------------------------------------------ */

  function showHintCard(title, text) {
    if (!dom.hintCard) return;
    dom.hintTitle.textContent = title;
    dom.hintText.textContent = text;
    dom.hintCard.hidden = false;
    clearTimeout(hintCardTimer);
    hintCardTimer = setTimeout(hideHintCard, 14000);
  }

  function hideHintCard() {
    clearTimeout(hintCardTimer);
    if (dom.hintCard) dom.hintCard.hidden = true;
  }

  function clearHintHighlights() {
    clearTimeout(hintHighlightTimer);
    state.hintHighlights = new Set();
    state.hintTargetKey = null;
  }

  function resetHint() {
    hideHintCard();
    clearHintHighlights();
  }

  function scheduleHintHighlightClear() {
    clearTimeout(hintHighlightTimer);
    hintHighlightTimer = setTimeout(function () {
      state.hintHighlights = new Set();
      state.hintTargetKey = null;
      if (cellRefs.length) renderBoard();
    }, 5000);
  }

  /* ------------------------------------------------------------------ */
  /* 游戏操作                                                            */
  /* ------------------------------------------------------------------ */

  function selectCell(r, c) {
    if (state.paused || state.completed) return;
    if (state.selected && state.selected.r === r && state.selected.c === c) {
      focusCell(r, c);
      return;
    }
    state.selected = { r: r, c: c };
    renderBoard();
    focusCell(r, c);
  }

  /* 把键盘焦点移到指定格子，让屏幕阅读器和键盘操作跟着选中格走 */
  function focusCell(r, c) {
    if (!cellRefs[r] || !cellRefs[r][c]) return;
    var el = cellRefs[r][c].el;
    if (document.activeElement === el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  }

  function ensureSelection() {
    if (state.selected) return state.selected;
    var n = state.size;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!state.puzzle[r][c] && !state.values[r][c]) {
          state.selected = { r: r, c: c };
          renderBoard();
          focusCell(r, c);
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

    /* 是否与同行、同列或同宫的已有数字重复（只看规则，不看答案） */
    var hasConflict = hasConflictingPeer(r, c, value);
    if (hasConflict) {
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

    if (!hasConflict) checkCompletion();
  }

  function toggleNote(r, c, digit) {
    if (state.values[r][c]) return;
    pushHistory();
    var set = state.notes[r][c];
    if (set.has(digit)) set.delete(digit);
    else set.add(digit);
    state.selected = { r: r, c: c };
    renderBoard();
    renderMeta();
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
    renderMeta();
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
      focusCell(0, 0);
      return;
    }
    state.selected = {
      r: clamp(state.selected.r + dr, 0, n - 1),
      c: clamp(state.selected.c + dc, 0, n - 1),
    };
    renderBoard();
    focusCell(state.selected.r, state.selected.c);
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

  function hasConflictingPeer(r, c, value) {
    var conflict = false;
    forEachPeer(r, c, function (rr, cc) {
      if (state.values[rr][cc] === value) conflict = true;
    });
    return conflict;
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
    resetHint();
    renderAll();
    save();
  }

  function useHint() {
    if (state.paused || state.completed) return;
    if (!state.values.length) return;
    if (!Hints) {
      toast('提示功能暂不可用');
      return;
    }

    var result = Hints.findHint(state.values, state.size, state.solution, state.selected);
    if (!result) return;

    if (!result.ok) {
      clearHintHighlights();
      if (cellRefs.length) renderBoard();
      showHintCard(result.title || '暂时无法提示', result.explanation || '');
      return;
    }

    var target = result.cell;
    var value = result.value;
    var key = keyOf(target.r, target.c);

    pushHistory();
    state.values[target.r][target.c] = value;
    state.notes[target.r][target.c].clear();
    state.hinted.add(key);
    state.hints += 1;
    state.selected = { r: target.r, c: target.c };
    state.hintHighlights = new Set(result.highlights || []);
    state.hintTargetKey = key;

    clearPeerNotes(target.r, target.c, value);
    renderAll();
    save();
    pulseCell(target.r, target.c);
    showHintCard(result.title || '提示', result.explanation || ('这里应填 ' + value + '。'));
    scheduleHintHighlightClear();
    checkCompletion();
  }

  function checkCompletion() {
    var n = state.size;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!state.values[r][c]) return false;
      }
    }
    /* 填满且没有任何行/列/宫冲突，即为完成 */
    if (Core.findConflicts(state.values, n).size > 0) return false;
    state.completed = true;
    pauseTimer();
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
    if (paused) {
      pauseTimer();
      resetHint();
      pauseReturnFocus = activeElementOrNull();
      if (dom.board) dom.board.inert = true;
      if (dom.controls) dom.controls.inert = true;
      updatePauseUI();
      renderMeta();
      save();
      if (cellRefs.length) renderBoard();
      focusAfterRender(dom.resumeBtn);
    } else {
      if (dom.board) dom.board.inert = false;
      if (dom.controls) dom.controls.inert = false;
      startTimer();
      updatePauseUI();
      renderMeta();
      save();
      var returnTo = pauseReturnFocus;
      pauseReturnFocus = null;
      restoreFocus(returnTo);
    }
  }

  function openRestartConfirm() {
    if (!state.values.length || state.completed) return;
    restartReturnFocus = activeElementOrNull();
    if (dom.app) dom.app.inert = true;
    dom.restartModal.hidden = false;
    focusAfterRender(dom.restartCancelBtn);
  }

  function closeRestartConfirm() {
    if (dom.restartModal.hidden) return;
    dom.restartModal.hidden = true;
    if (dom.app) dom.app.inert = false;
    var returnTo = restartReturnFocus;
    restartReturnFocus = null;
    restoreFocus(returnTo || dom.restartBtn);
  }

  function confirmRestart() {
    closeRestartConfirm();
    performRestart();
  }

  function performRestart() {
    if (!state.values.length) return;
    state.values = state.puzzle.map(function (row) {
      return row.slice();
    });
    state.notes = createNotes(state.size);
    state.selected = null;
    state.mistakes = 0;
    state.hints = 0;
    state.hinted = new Set();
    resetTimer();
    state.history = [];
    state.notesMode = false;
    state.paused = false;
    state.completed = false;
    resetHint();
    updatePauseUI();
    renderAll();
    save();
    startTimer();
    toast('已重新开始本局');
  }

  /* ------------------------------------------------------------------ */
  /* 新游戏                                                              */
  /* ------------------------------------------------------------------ */

  function openNewGameModal() {
    modalReturnFocus = activeElementOrNull();
    if (dom.app) dom.app.inert = true;
    modalChoice.size = state.size;
    modalChoice.difficulty = state.difficulty;
    syncModalUI();
    dom.newGameModal.hidden = false;
    focusAfterRender(dom.startGameBtn);
  }

  function closeNewGameModal() {
    dom.newGameModal.hidden = true;
    var returnTo = modalReturnFocus;
    modalReturnFocus = null;
    /* 从胜利弹窗进入「换个难度」后取消，应回到胜利弹窗 */
    if (winHiddenForModal && state.completed) {
      dom.winOverlay.hidden = false;
      focusAfterRender(dom.playAgainBtn);
    } else {
      if (dom.app) dom.app.inert = false;
      /* 暂停中打开又取消「新游戏」时，棋盘仍应保持不可聚焦 */
      if (state.paused) {
        if (dom.board) dom.board.inert = true;
        if (dom.controls) dom.controls.inert = true;
      }
      restoreFocus(returnTo || dom.newGameBtn);
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
          game = generateGame(size, difficulty);
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
    resetTimer();
    state.paused = false;
    state.completed = false;
    state.history = [];

    hideWin();
    resetHint();
    dom.pauseOverlay.hidden = true;
    buildBoard();
    buildPad();
    updatePauseUI();
    renderAll();
    save();
    startTimer();
    rememberConfig(game.size, game.difficulty);
  }

  function showLoading(show) {
    dom.loadingOverlay.hidden = !show;
  }

  /* ------------------------------------------------------------------ */
  /* 胜利                                                                */
  /* ------------------------------------------------------------------ */

  function showWin() {
    hideHintCard();
    winReturnFocus = activeElementOrNull();
    dom.winTime.textContent = formatTime(state.elapsed);
    dom.winMistakes.textContent = String(state.mistakes);
    dom.winHints.textContent = String(state.hints);
    dom.winDifficulty.textContent = state.size + '×' + state.size + ' · ' + DIFFICULTY_LABEL[state.difficulty];
    dom.winOverlay.hidden = false;
    if (dom.app) dom.app.inert = true;
    focusAfterRender(dom.playAgainBtn);
  }

  function hideWin() {
    dom.winOverlay.hidden = true;
    if (dom.app) dom.app.inert = false;
    var returnTo = winReturnFocus;
    winReturnFocus = null;
    restoreFocus(returnTo);
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
      var elapsedNow = currentElapsedSeconds();
      state.elapsed = elapsedNow;
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
        elapsed: elapsedNow,
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
    timerBase = state.elapsed;
    timerAnchor = null;
    state.paused = false;
    state.completed = false;
    state.history = [];

    dom.pauseOverlay.hidden = true;
    buildBoard();
    buildPad();
    updatePauseUI();
    renderAll();
    startTimer();
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
