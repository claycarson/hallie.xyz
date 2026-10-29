// hallie.xyz page around tihle, a TI-83 Plus emulator (emu/, GPL-3.0,
// https://gitlab.com/taricorp/tihle), running Patrick Davidson's original
// Phoenix (program/PHOENIX.8XP, public domain) unmodified.
//
// tihle draws its 96×64 screen into the offscreen #canvas. This file recolors
// that to a TI-83 LCD and copies it to #screen at whole device pixels per
// calculator pixel, and turns keyboard and touch input into calculator keys.

(function () {
  const W = 96, H = 64;
  const PROGRAM = 'program/PHOENIX.8XP';

  // TI-83 Plus scancodes (tihle src/keyboard.rs, Phoenix keys.i)
  const TI = {
    down: 0x01, left: 0x02, right: 0x03, up: 0x04,
    enter: 0x09, second: 0x36, alpha: 0x30, clear: 0x0F,
    1: 0x22, 2: 0x1A, 3: 0x12, 4: 0x23, 5: 0x1B,
  };

  const emu = document.getElementById('canvas');
  const screen = document.getElementById('screen');
  const stage = document.getElementById('stage');
  const bezel = screen.parentElement;
  const ctx = screen.getContext('2d');

  // tihle renders with WebGL, which clears its buffer after each frame unless
  // asked not to. Keep it, so blit() can read the last frame at any time.
  const getContext = emu.getContext.bind(emu);
  emu.getContext = (type, attrs) =>
    getContext(type, type === '2d' ? attrs : Object.assign({}, attrs, { preserveDrawingBuffer: true }));

  // ─── Scaling ─────────────────────────────────
  // Pick the biggest whole number of *device* pixels per game pixel that fits,
  // so every game pixel is an exact square block on any screen density.
  // Landscape phones put the screen in a stretched middle column; everywhere
  // else the screen and controls are one centered block, so the screen gets
  // whatever height the controls leave over.
  const play = document.getElementById('play');
  const dpad = document.getElementById('dpad');
  const fireBtn = document.getElementById('fire');
  const sideBySide = matchMedia('(orientation: landscape) and (max-height: 520px)');
  let k = 1;
  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const pad = bezel.offsetWidth - bezel.clientWidth + 20; // border + padding
    const availW = stage.clientWidth - pad;
    let availH;
    if (sideBySide.matches) {
      availH = stage.clientHeight - pad;
    } else {
      const cs = getComputedStyle(play);
      // Rows under the screen: D-pad/FIRE, then the keys row.
      const controls = Math.max(document.querySelector('.pad-group').offsetHeight,
                                document.querySelector('.btn-group').offsetHeight)
                     + document.querySelector('.key-row').offsetHeight;
      availH = play.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
             - 2 * parseFloat(cs.rowGap) - controls - pad;
    }
    k = Math.max(1, Math.floor(Math.min(availW / W, availH / H) * dpr));
    sizeFire();
    screen.width = W * k;
    screen.height = H * k;
    screen.style.width = (W * k / dpr) + 'px';
    screen.style.height = (H * k / dpr) + 'px';
    ctx.imageSmoothingEnabled = false; // resizing resets context state
    paintBlank();
  }
  // FIRE is as wide as the D-pad's arrows reach, tip to tip (the arrow
  // tips sit at 11% and 89% of the cross).
  function sizeFire() {
    const size = Math.round(dpad.offsetWidth * 0.78) + 'px';
    fireBtn.style.width = fireBtn.style.height = size;
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 100));
  if (window.visualViewport) visualViewport.addEventListener('resize', fit);

  // ─── TI-83 LCD colors ────────────────────────
  // tihle draws lit pixels black on white. Sample one pixel per calculator
  // pixel and paint it as yellow-green glass or near-black ink. (Phoenix's
  // default "Backgr BLACK" setting really is a black play field; WHITE in
  // Settings gives the light one.)
  const LCD_BG = [141, 184, 28], LCD_INK = [16, 22, 8];
  const lcd = document.createElement('canvas');
  lcd.width = W; lcd.height = H;
  const lctx = lcd.getContext('2d', { willReadFrequently: true });

  function paintBlank() {
    ctx.fillStyle = `rgb(${LCD_BG})`;
    ctx.fillRect(0, 0, screen.width, screen.height);
  }

  // ─── Which screen is showing ─────────────────
  // The game can't tell us, but each menu screen has a fixed first text line
  // ("Phoenix 4.3", "Use up/down/2nd", "Phx Shop -" …). Fingerprint the top
  // 8 pixel rows, left 60 columns (the shop prints cash to the right), with
  // polarity normalized so the inverted "Backgr" setting matches too.
  // Anything unrecognized is gameplay.
  const bits = new Uint8Array(W * H);
  // Top band alone where the first line is unique; both bands for the two
  // screens that share "Phoenix 4.3". Captured in WebKit, or computed from
  // tihle's large font (lgfont.bin) for the shop, which is hard to reach.
  const SCREENS_TOP = {
    '1d849bb1': 'settings',   // "Use up/down/2nd"
    'bef687e8': 'info',       // "Arrows Move Ship" (instructions)
    '8ea4fea5': 'shop',       // "Phx Shop -"
    '894c7626': 'scores',     // high score table
    'a579dd33': 'prompt',     // " Enter your name" over the table
    '47430a9d': 'scoring',    // finished-game tally ("Shields", "Speed" …)
  };
  const SCREENS_FULL = {
    '7a699bbe:52858fa': 'title',
    '7a699bbe:5083e586': 'info', // contact info
  };
  let screenName = null, lastPrint = null;
  function band(y0, y1, x1) {
    let ink = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) ink += bits[y * W + x];
    const flip = ink * 2 > (y1 - y0) * x1 ? 1 : 0; // mostly lit: inverted display
    let h = 0x811c9dc5;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < x1; x++) {
        h ^= bits[y * W + x] ^ flip;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h.toString(16);
  }
  // Title and Contact Info share their first line, so a second band (the
  // "1 - Start Game" row on the title) tells them apart.
  const fingerprint = () => band(0, 8, 60) + ':' + band(31, 38, 96);

  function detectScreen() {
    const print = fingerprint();
    if (print === lastPrint) return;
    lastPrint = print;
    window.__phxPrint = print; // for capturing new fingerprints in devtools
    const name = SCREENS_FULL[print] || SCREENS_TOP[print.split(':')[0]] || 'play';
    if (name !== screenName) { screenName = name; relabel(name); }
  }

  // ─── Button labels per screen ────────────────
  // What each key does on each screen, from Phoenix's source (title12.asm,
  // shop12.asm, player12.asm). Keys missing from a screen fade back.
  const MENU = { 1: 'Start', 2: 'Settings', 3: 'Contact', 4: 'Help', clear: 'Quit' };
  const LABELS = {
    title:    MENU,
    info:     Object.assign({ 5: 'Menu' }, MENU),
    settings: { fire: 'CHANGE', 5: 'Back', clear: 'Back' },
    shop:     { enter: 'Buy', clear: 'Done' },
    scores:   { 1: 'OK', 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK', enter: 'OK', clear: 'OK', fire: 'OK' },
    scoring:  { enter: 'OK' },
    prompt:   { enter: 'OK' },
    play:     { fire: 'FIRE', 1: 'Gun 1', 2: 'Gun 2', 3: 'Gun 3', 4: 'Gun 4', 5: 'Gun 5',
                enter: 'Pause', clear: 'Quit' },
  };
  const KEY_NAMES = { '0x22': 1, '0x1A': 2, '0x12': 3, '0x23': 4, '0x1B': 5, '0x0F': 'clear', '0x09': 'enter' };
  const fireLabel = document.querySelector('#fire b');
  function relabel(name) {
    const labels = LABELS[name];
    for (const el of document.querySelectorAll('.tk')) {
      const text = labels[KEY_NAMES[el.dataset.key]];
      el.querySelector('small').textContent = text || '';
      el.classList.toggle('idle', !text);
    }
    fireLabel.textContent = labels.fire || 'FIRE';
    fireLabel.style.fontSize = fireLabel.textContent.length > 4 ? '1.3rem' : '';
    document.getElementById('fire').classList.toggle('idle', !labels.fire);
  }

  let running = false;
  function blit() {
    if (running) {
      // Nearest-neighbor downscale picks one source pixel per 4×4 block.
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(emu, 0, 0, W, H);
      const img = lctx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const on = d[i] + d[i + 1] + d[i + 2] < 384;
        bits[p] = on ? 1 : 0;
        const c = on ? LCD_INK : LCD_BG;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
      lctx.putImageData(img, 0, 0);
      ctx.drawImage(lcd, 0, 0, W * k, H * k);
      detectScreen();
    }
    requestAnimationFrame(blit);
  }

  // ─── Key plumbing ────────────────────────────
  // Several sources (keyboard, D-pad, buttons) can hold the same calculator
  // key; it goes up only when the last one lets go.
  // A key also stays down for at least MIN_HOLD ms: the game polls the
  // keyboard once a frame, so a quick tap released within the same frame
  // would never be seen.
  const MIN_HOLD = 60;
  let keydown = () => {}, keyup = () => {};
  const held = new Map();  // scancode → number of sources holding it
  const since = new Map(); // scancode → time it went down
  function press(code) {
    const n = held.get(code) || 0;
    held.set(code, n + 1);
    if (n === 0) { since.set(code, performance.now()); keydown(code); }
  }
  function release(code) {
    const n = held.get(code) || 0;
    if (n === 0) return;
    if (n > 1) { held.set(code, n - 1); return; }
    held.delete(code);
    const wait = MIN_HOLD - (performance.now() - since.get(code));
    if (wait <= 0) keyup(code);
    else setTimeout(() => { if (!held.has(code)) keyup(code); }, wait);
  }
  function releaseAll() {
    for (const code of held.keys()) keyup(code);
    held.clear();
  }

  // Keyboard → calculator. Handled here in the capture phase and stopped, so
  // SDL's own browser key handling never sees it and nothing double-fires.
  const KEYMAP = {
    ArrowUp: TI.up, ArrowDown: TI.down, ArrowLeft: TI.left, ArrowRight: TI.right,
    ' ': TI.second, z: TI.second, Z: TI.second, Control: TI.second, // fire = 2nd
    Enter: TI.enter, Shift: TI.alpha, a: TI.alpha, A: TI.alpha,     // pause / high scores
    // tihle can't pass MODE or DEL through (its key table lacks them), so
    // CLEAR does their jobs: leave the shop or settings, quit the game.
    Escape: TI.clear, Backspace: TI.clear,
    1: TI[1], 2: TI[2], 3: TI[3], 4: TI[4], 5: TI[5],
  };
  const keysDown = new Set();
  function onKey(e, down) {
    if (document.querySelector('.overlay.show')) return; // typing a name
    const code = KEYMAP[e.key];
    if (code === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (down) {
      if (keysDown.has(e.key)) return;
      keysDown.add(e.key);
      press(code);
    } else if (keysDown.delete(e.key)) {
      release(code);
    }
  }
  // While a card is open (typing a name), keys must reach the text box.
  // The emulator's SDL layer listens on the window and preventDefault()s
  // every key, which swallows typing, so stop keys here before it sees them.
  // This file loads before tihle, so these window listeners run first.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, e => {
      if (document.querySelector('.overlay.show')) e.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener('keydown', e => onKey(e, true), true);
  window.addEventListener('keyup', e => onKey(e, false), true);

  // Capture keeps a sliding thumb on its control; synthetic events can't be captured.
  function capture(el, e) {
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  }

  // ─── D-pad: one surface, direction from thumb position ──
  const arms = {
    left: dpad.querySelector('.left'), right: dpad.querySelector('.right'),
    up: dpad.querySelector('.up'), down: dpad.querySelector('.down'),
  };
  let dpadPointer = null;
  const dpadOn = new Set();

  function setDir(dirs) {
    for (const d of ['left', 'right', 'up', 'down']) {
      if (dirs.has(d) && !dpadOn.has(d)) { dpadOn.add(d); press(TI[d]); }
      if (!dirs.has(d) && dpadOn.has(d)) { dpadOn.delete(d); release(TI[d]); }
      arms[d].classList.toggle('on', dirs.has(d));
    }
  }
  function dirsAt(e) {
    const r = dpad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const dirs = new Set();
    const dead = r.width * 0.12;
    if (Math.hypot(dx, dy) < dead) return dirs;
    // 8-way: a direction is on when it's within 67.5° of the thumb angle
    const a = Math.atan2(dy, dx) * 180 / Math.PI; // 0 = right, 90 = down
    if (Math.abs(a) < 67.5) dirs.add('right');
    if (Math.abs(a) > 112.5) dirs.add('left');
    if (a > 22.5 && a < 157.5) dirs.add('down');
    if (a < -22.5 && a > -157.5) dirs.add('up');
    return dirs;
  }
  dpad.addEventListener('pointerdown', e => {
    e.preventDefault();
    dpadPointer = e.pointerId;
    capture(dpad, e);
    setDir(dirsAt(e));
  });
  dpad.addEventListener('pointermove', e => {
    if (e.pointerId === dpadPointer) setDir(dirsAt(e));
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    dpad.addEventListener(type, e => {
      if (e.pointerId !== dpadPointer) return;
      dpadPointer = null;
      setDir(new Set());
    });
  }

  // ─── Buttons ─────────────────────────────────
  function holdButton(el, code) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (el.classList.contains('on')) return;
      capture(el, e);
      el.classList.add('on');
      press(code);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, () => {
        if (!el.classList.contains('on')) return;
        el.classList.remove('on');
        release(code);
      });
    }
  }
  holdButton(fireBtn, TI.second);
  for (const el of document.querySelectorAll('.tk')) holdButton(el, parseInt(el.dataset.key, 16));

  // Block Safari's double-tap zoom, pinch zoom and long-press magnifier.
  document.addEventListener('touchstart', e => {
    if (!e.target.closest('a, .overlay')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Don't leave keys stuck down when the tab is hidden mid-press.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    keysDown.clear();
    setDir(new Set());
    for (const el of document.querySelectorAll('.on')) el.classList.remove('on');
    releaseAll();
  });

  // ─── Emulator memory ─────────────────────────
  // tihle keeps calculator RAM ($8000–$FFFF) as one flat array inside the
  // WebAssembly heap. Find it through Phoenix's built-in high score table
  // ("Patrick D ", 0, 30000). Phoenix is assembled at $9D93 (its $BB $6D
  // header), so the table's address is fixed: measure it in the 8XP file
  // (layoutFrom). The heap also holds a copy of the 8XP file itself; skip
  // the hit with the file header ("PHOENIX") just before the program start.
  // Variable offsets from the table come from Phoenix's vars.asm.
  let ramBase = -1, T = 0, tableFromStart = 0;
  const heap = () => Module.HEAPU8;
  const read8 = a => heap()[ramBase + a - 0x8000];
  const read16 = a => read8(a) | read8(a + 1) << 8;
  const write8 = (a, v) => { heap()[ramBase + a - 0x8000] = v; };
  const V = {
    level: () => T - 571, cash: () => T - 569, completed: () => T - 547,
    difficulty: () => T - 1,
    saveStart: () => T - 5,       // invert, speed, scroll, sides, difficulty
    saveEnd: () => T + 7 * 13,    // + the 7-entry table (10-char name, 0, score)
  };
  const BONUS_SCORE = 0x8852;     // TEXT_MEM+102: the finished-game total
  const SIG = [...'Patrick D '].map(c => c.charCodeAt(0)).concat([0, 0x30, 0x75]);
  const PHOENIX = [...'PHOENIX'].map(c => c.charCodeAt(0));

  function hasAt(h, at, bytes) {
    for (let j = 0; j < bytes.length; j++) if (h[at + j] !== bytes[j]) return false;
    return true;
  }
  function indexOfBytes(h, bytes, from = 0) {
    for (let o = h.indexOf(bytes[0], from); o !== -1; o = h.indexOf(bytes[0], o + 1)) {
      if (hasAt(h, o, bytes)) return o;
    }
    return -1;
  }
  function layoutFrom(file) {
    const start = indexOfBytes(file, [0xBB, 0x6D]);
    const table = indexOfBytes(file, SIG);
    if (start < 0 || table < 0) return false;
    tableFromStart = table - start;
    T = 0x9D93 + tableFromStart;
    return true;
  }
  function findRam() {
    if (!T) return false;
    const h = heap();
    for (let o = indexOfBytes(h, SIG); o !== -1; o = indexOfBytes(h, SIG, o + 1)) {
      const start = o - tableFromStart;
      let isFile = false;
      for (let i = start - 20; i < start; i++) if (hasAt(h, i, PHOENIX)) isFile = true;
      if (isFile) continue;
      ramBase = o - (T - 0x8000);
      return true;
    }
    return false;
  }

  // ─── This device's table and settings ────────
  // Phoenix's own High Scores table and Settings live in its program memory,
  // which a reload wipes. Keep a copy in the browser and put it back on boot.
  const SAVE_KEY = 'phx.save.v1', NAME_KEY = 'phx.name', MINE_KEY = 'phx.mine.v1';
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
  };
  let savedJson = null;
  function snapshot() {
    const out = [];
    for (let a = V.saveStart(); a < V.saveEnd(); a++) out.push(read8(a));
    return out;
  }
  function restoreSave() {
    const saved = store.get(SAVE_KEY, null);
    if (!Array.isArray(saved) || saved.length !== V.saveEnd() - V.saveStart()) return;
    saved.forEach((v, i) => write8(V.saveStart() + i, v & 0xFF));
    savedJson = JSON.stringify(saved);
  }
  function persist() {
    const json = JSON.stringify(snapshot());
    if (json !== savedJson) { savedJson = json; store.set(SAVE_KEY, JSON.parse(json)); }
  }
  function phoenixTable() {
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const at = T + i * 13;
      let name = '';
      for (let j = 0; j < 10; j++) name += String.fromCharCode(read8(at + j));
      rows.push({ name: name.trim() || '—', score: read16(at + 11) });
    }
    return rows;
  }

  // ─── Runs ────────────────────────────────────
  // A run starts when play begins at level 1+, and ends on the high score
  // screens (Phoenix shows them after a death and after finishing). Finished
  // games pass through the tally screen first; their score is bonus_score.
  let run = null, runState = 'idle';
  function trackRun() {
    const level = read8(V.level());
    if (runState === 'idle') {
      if (screenName === 'play' && level >= 1) {
        run = { level, cash: read16(V.cash()), difficulty: read8(V.difficulty()), finished: false };
        runState = 'running';
      }
      return;
    }
    if (runState === 'running') {
      if (screenName === 'play') {
        if (level < run.level) { runState = 'idle'; return; } // a new game began
        run.level = level;
        run.cash = read16(V.cash());
      }
      if (screenName === 'scoring') run.finished = true;
      if (screenName === 'scores' || screenName === 'prompt') {
        if (run.finished) run.score = read16(BONUS_SCORE);
        runState = 'ended';
        endRun(run);
      }
      return;
    }
    // ended: wait for the title or a fresh game
    if (screenName === 'title' || level === 0 || (screenName === 'play' && level < run.level)) runState = 'idle';
  }

  // ─── End-of-run card ─────────────────────────
  const SCORES_API = location.hostname.endsWith('hallie.xyz')
    ? 'https://scores.hallie.xyz/api/scores'
    : `http://${location.hostname}:8811/api/scores`; // local testing
  const DIFFICULTY = ['Easy', 'Medium', 'Hard'];
  const runOv = document.getElementById('run-ov');
  const runName = document.getElementById('run-name');
  const runMsg = document.getElementById('run-msg');
  let ending = null;

  const cleanName = raw => String(raw || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10);

  function endRun(r) {
    ending = r;
    document.getElementById('run-title').textContent = r.finished ? 'You beat Phoenix! 🎉' : 'Game over!';
    document.getElementById('run-stats').textContent =
      `Level ${r.level} · $${r.cash}` + (r.finished ? ` · Score ${r.score}` : '') + ` · ${DIFFICULTY[r.difficulty] || ''}`;
    runName.value = store.get(NAME_KEY, '');
    runMsg.textContent = '';
    keysDown.clear(); setDir(new Set()); releaseAll();
    runOv.classList.add('show');
  }

  function keepLocally(r, name) {
    const mine = store.get(MINE_KEY, []);
    mine.push({ name, level: r.level, cash: r.cash, difficulty: r.difficulty,
                score: r.finished ? r.score : null, date: new Date().toISOString().slice(0, 10) });
    store.set(MINE_KEY, mine.slice(-50));
  }

  // If Phoenix itself is asking for a name (a finished game that made its
  // table), write it straight into the blank entry and press ENTER: tihle
  // can't type most of the letter keys Phoenix's name entry uses.
  function answerPrompt(name) {
    if (screenName !== 'prompt') return;
    for (let i = 0; i < 7; i++) {
      const at = T + i * 13;
      let blank = true;
      for (let j = 0; j < 10; j++) if (read8(at + j) !== 0x20) blank = false;
      if (!blank) continue;
      const padded = name.padEnd(10, ' ');
      for (let j = 0; j < 10; j++) write8(at + j, padded.charCodeAt(j));
      break;
    }
    press(TI.enter); release(TI.enter);
  }

  function closeRun(name) {
    answerPrompt(name || 'PLAYER');
    runName.blur();
    runOv.classList.remove('show');
    ending = null;
    pinTop();
  }

  // iOS scrolls the page up to keep the name box above the keyboard and
  // leaves it there when the keyboard closes; this page blocks touch
  // scrolling, so it would stay stuck. Snap back whenever nobody's typing.
  const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';
  function pinTop() {
    if (typing()) return;
    window.scrollTo(0, 0);
    // again after the keyboard's closing animation settles the viewport
    setTimeout(() => { if (!typing()) window.scrollTo(0, 0); }, 350);
  }
  runName.addEventListener('blur', pinTop);
  window.addEventListener('scroll', () => { if (!typing() && window.scrollY) window.scrollTo(0, 0); });
  if (window.visualViewport) visualViewport.addEventListener('resize', pinTop);

  document.getElementById('run-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!ending) return;
    const name = cleanName(runName.value);
    if (!name) { runMsg.textContent = 'Type your name first!'; return; }
    store.set(NAME_KEY, name);
    const r = ending;
    keepLocally(r, name);
    runMsg.textContent = 'Saving…';
    try {
      const res = await fetch(SCORES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, level: r.level, cash: r.cash, difficulty: r.difficulty,
                               score: r.finished ? r.score : null }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 400 && body.error === 'name') {
        runMsg.textContent = 'Try a different name.';
        return;
      }
      if (!res.ok) throw new Error(res.status);
      const best = Math.min(...Object.values(body.ranks || {}).filter(Boolean));
      runMsg.textContent = Number.isFinite(best) ? `You're #${best} on the big board! 🏆` : 'Saved! 🌟';
    } catch (_) {
      runMsg.textContent = 'Saved on this device. The big board is taking a nap.';
    }
    setTimeout(() => closeRun(name), 1600);
  });
  document.getElementById('run-skip').addEventListener('click', () => {
    if (!ending) return;
    keepLocally(ending, cleanName(runName.value) || store.get(NAME_KEY, '') || 'PLAYER');
    closeRun(cleanName(runName.value) || store.get(NAME_KEY, ''));
  });

  // ─── 🏆 Board ────────────────────────────────
  const boardOv = document.getElementById('board-ov');
  const boardList = document.getElementById('board-list');
  let boardData = null, boardTab = 'champions';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function row(rank, name, val, sub) {
    const r = el('div', 'row');
    r.append(el('span', 'rank', rank), el('span', 'name', name));
    const v = el('span', 'val', val);
    if (sub) v.append(el('span', 'sub', sub));
    r.append(v);
    return r;
  }
  const furthestVal = e => [`Level ${e.level}`, `$${e.cash} · ${DIFFICULTY[e.difficulty] || ''}`];

  function renderBoard() {
    boardList.replaceChildren();
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === boardTab);
    if (boardTab === 'mine') {
      boardList.append(el('h3', '', 'This calculator’s table'));
      if (ramBase >= 0) phoenixTable().forEach((e, i) => boardList.append(row(i + 1, e.name, String(e.score))));
      boardList.append(el('h3', '', 'Your best runs'));
      const mine = store.get(MINE_KEY, [])
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.level - a.level || b.cash - a.cash)
        .slice(0, 10);
      if (!mine.length) boardList.append(el('div', 'empty', 'No runs yet. Go fly! 🚀'));
      mine.forEach((e, i) => boardList.append(e.score !== null
        ? row(i + 1, e.name, String(e.score), `Level ${e.level} · finished`)
        : row(i + 1, e.name, ...furthestVal(e))));
      return;
    }
    if (!boardData) { boardList.append(el('div', 'empty', boardData === null ? 'Loading…' : '')); return; }
    if (boardData.error) { boardList.append(el('div', 'empty', 'The big board is taking a nap. Try later!')); return; }
    const list = boardData[boardTab] || [];
    if (!list.length) boardList.append(el('div', 'empty', boardTab === 'champions'
      ? 'Nobody has beaten Phoenix yet. Will you be first?' : 'No scores yet. Be the first!'));
    list.forEach((e, i) => boardList.append(boardTab === 'champions'
      ? row(i + 1, e.name, String(e.score), `Level ${e.level} · ${DIFFICULTY[e.difficulty] || ''}`)
      : row(i + 1, e.name, ...furthestVal(e))));
  }
  async function openBoard() {
    boardData = null;
    renderBoard();
    boardOv.classList.add('show');
    try {
      const res = await fetch(SCORES_API);
      if (!res.ok) throw new Error(res.status);
      boardData = await res.json();
    } catch (_) {
      boardData = { error: true };
    }
    renderBoard();
  }
  document.getElementById('trophy').addEventListener('click', openBoard);
  document.getElementById('board-close').addEventListener('click', () => boardOv.classList.remove('show'));
  boardOv.addEventListener('click', e => { if (e.target === boardOv) boardOv.classList.remove('show'); });
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => { boardTab = t.dataset.tab; renderBoard(); });
  }

  // Find RAM once the program is loaded, restore the save, then watch.
  function startScores() {
    const timer = setInterval(() => {
      if (!running || !findRam()) return;
      clearInterval(timer);
      restoreSave();
      setInterval(persist, 1000);
      setInterval(trackRun, 250);
    }, 500);
  }

  // ─── Boot ────────────────────────────────────
  // Fetch the program first, then start the emulator with it written into its
  // in-memory filesystem and passed as the program to run.
  fit();
  requestAnimationFrame(blit);

  fetch(PROGRAM)
    .then(r => { if (!r.ok) throw new Error(`${PROGRAM}: ${r.status}`); return r.arrayBuffer(); })
    .then(buf => {
      layoutFrom(new Uint8Array(buf));
      window.Module = {
        arguments: ['/phoenix.8xp'],
        canvas: emu,
        locateFile: path => 'emu/' + path,
        preRun: [() => { FS.writeFile('/phoenix.8xp', new Uint8Array(buf)); }],
        // main() hands off to an animation-frame loop and never returns, so
        // postRun never fires; hook up input once the runtime is ready instead.
        onRuntimeInitialized: () => {
          keydown = code => Module._tihle_keydown(code);
          keyup = code => Module._tihle_keyup(code);
          running = true;
          startScores();
        },
        // CLEAR mid-game exits the program and the emulator stops.
        // Start over rather than leave a dead screen (a saved game lives
        // in emulator memory, so it doesn't survive this).
        print: t => {
          console.log('[tihle]', t);
          if (/Emulation terminated/.test(t)) setTimeout(() => location.reload(), 800);
        },
        printErr: t => console.warn('[tihle]', t),
      };
      const s = document.createElement('script');
      s.src = 'emu/tihle.js';
      document.body.appendChild(s);
    })
    .catch(err => console.error('Phoenix failed to load:', err));
})();
