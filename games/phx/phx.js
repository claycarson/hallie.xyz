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
    enter: 0x09, second: 0x36, alpha: 0x30, mode: 0x37, del: 0x38,
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
      const controls = Math.max(document.querySelector('.pad-group').offsetHeight,
                                document.querySelector('.btn-group').offsetHeight);
      availH = play.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
             - parseFloat(cs.rowGap) - controls - pad;
    }
    k = Math.max(1, Math.floor(Math.min(availW / W, availH / H) * dpr));
    screen.width = W * k;
    screen.height = H * k;
    screen.style.width = (W * k / dpr) + 'px';
    screen.style.height = (H * k / dpr) + 'px';
    ctx.imageSmoothingEnabled = false; // resizing resets context state
    paintBlank();
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
  const MENU = { 1: 'Start', 2: 'Settings', 3: 'Contact', 4: 'Help', mode: 'Quit' };
  const LABELS = {
    title:    MENU,
    info:     Object.assign({ 5: 'Menu' }, MENU),
    settings: { fire: 'CHANGE', 5: 'Back', mode: 'Back' },
    shop:     { enter: 'Buy', mode: 'Done' },
    scores:   { 1: 'OK', 2: 'OK', 3: 'OK', 4: 'OK', 5: 'OK', enter: 'OK', mode: 'OK', fire: 'OK' },
    play:     { fire: 'FIRE', 1: 'Gun 1', 2: 'Gun 2', 3: 'Gun 3', 4: 'Gun 4', 5: 'Gun 5',
                enter: 'Pause', mode: 'Save+Quit' },
  };
  const KEY_NAMES = { '0x22': 1, '0x1A': 2, '0x12': 3, '0x23': 4, '0x1B': 5, '0x37': 'mode', '0x09': 'enter' };
  const fireLabel = document.querySelector('#fire b');
  function relabel(name) {
    const labels = LABELS[name];
    for (const el of document.querySelectorAll('.tk')) {
      const text = labels[KEY_NAMES[el.dataset.key]];
      el.querySelector('small').textContent = text || '';
      el.classList.toggle('idle', !text);
    }
    fireLabel.textContent = labels.fire || 'FIRE';
    fireLabel.style.fontSize = fireLabel.textContent.length > 4 ? '0.9rem' : '';
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
    Escape: TI.mode, Backspace: TI.del,  // MODE: leave shop / save & quit; DEL: quit
    1: TI[1], 2: TI[2], 3: TI[3], 4: TI[4], 5: TI[5],
  };
  const keysDown = new Set();
  function onKey(e, down) {
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
  window.addEventListener('keydown', e => onKey(e, true), true);
  window.addEventListener('keyup', e => onKey(e, false), true);

  // Capture keeps a sliding thumb on its control; synthetic events can't be captured.
  function capture(el, e) {
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  }

  // ─── D-pad: one surface, direction from thumb position ──
  const dpad = document.getElementById('dpad');
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
  holdButton(document.getElementById('fire'), TI.second);
  for (const el of document.querySelectorAll('.tk')) holdButton(el, parseInt(el.dataset.key, 16));

  // Block Safari's double-tap zoom, pinch zoom and long-press magnifier.
  document.addEventListener('touchstart', e => {
    if (!e.target.closest('a')) e.preventDefault();
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

  // ─── Boot ────────────────────────────────────
  // Fetch the program first, then start the emulator with it written into its
  // in-memory filesystem and passed as the program to run.
  fit();
  requestAnimationFrame(blit);

  fetch(PROGRAM)
    .then(r => { if (!r.ok) throw new Error(`${PROGRAM}: ${r.status}`); return r.arrayBuffer(); })
    .then(buf => {
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
        },
        // MODE or DEL mid-game exits the program and the emulator stops.
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
