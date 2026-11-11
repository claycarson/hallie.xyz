// @ts-check
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/RGBELoader.js';
import { gpuCaps } from './engine/gpu.js';
import { NailFrame } from './hand/frame.js';
import { Finger } from './hand/finger.js';
import { loadHand } from './hand/model.js';
import { loadUnderside, buildRest } from './hand/rest.js';
import { area, SHAPES } from './hand/outline.js';
import { makeFingerUniforms, makeSkinMaterial } from './hand/materials.js';
import { PaintTargets } from './paint/targets.js';
import { StampRenderer } from './paint/stamps.js';
import { StrokeEngine } from './paint/stroke.js';
import { Leveler, WET_HZ } from './paint/leveling.js';
import { DesignPainter, nailLayers } from './paint/design.js';
import { SpillAtlas } from './paint/spill.js';
import { BrushSound } from './audio/brush.js';
import { PointerInput } from './input/pointer.js';
import { DebugOverlay } from './debug/overlay.js';
import { CameraRig } from './scene/rig.js';
import { BrushModel } from './brush/model.js';
import { parseTune, tuned, addGizmos, frameEditor } from './debug/frames.js';

const Q = new URLSearchParams(location.search);
const json = (name) => fetch(`./data/${name}.json`).then((r) => { if (!r.ok) throw new Error(`data/${name}.json ${r.status}`); return r.json(); });

const HAND_KEY = 'nailSalon.handDirection';

async function boot() {
  const bootStart = performance.now();
  const [tuning, handData, cameraData, themes, catalog, designs] = await Promise.all(['tuning', 'hand', 'camera', 'themes', 'catalog', 'designs'].map(json));
  const [handGeo, under] = await Promise.all([loadHand(`./${handData.file}`), loadUnderside(`./${handData.under}`)]);
  const tune = parseTune(Q.get('tune'));                // ?tune=… : frame editor offsets
  handData.fingers = handData.fingers.map((f) => tuned(f, tune[f.finger]));
  const fixed = Q.has('scene');                       // fixed test scene: nothing drifts
  const perf = { frame: 0, js: 0, boot: 0, switchMs: 0 };  // smoothed ms: frame to frame, our own work; last nail switch
  const state = {
    scene: Q.get('scene') || Q.get('view') || 'nail',
    shape: Q.get('shape') || 'round', free: Number(Q.get('free') ?? NaN),
    theme: themes.find((t) => t.id === Q.get('theme')) || themes[0],
    polish: catalog.polishes[0], dirty: true, lastStats: 0, stamps: 0, tool: /** @type {'polish' | 'swab' | 'remover'} */ ('polish'),
  };

  // ---- renderer, scene, light --------------------------------------------------------------
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gl'));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const caps = gpuCaps(renderer);
  if (!caps.halfFloat) throw new Error('This GPU cannot render to half-float targets; the RGBA8 fallback is not built yet.');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cameraData.fov, 1, 0.005, 5);
  const key = new THREE.DirectionalLight(0xffffff, 0.6), rimL = new THREE.DirectionalLight(0xffffff, 0), rimR = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(key, rimL, rimR);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envCache = new Map();
  const loadEnv = (name) => {
    if (!envCache.has(name)) envCache.set(name, new RGBELoader().loadAsync(`./assets/hdr/${name}.hdr`).then((t) => { const e = pmrem.fromEquirectangular(t).texture; t.dispose(); return e; }));
    return envCache.get(name);
  };

  // ---- the hand: skin and five fingers ------------------------------------------------------
  // Every finger owns small paint targets (tuning.paint.restSize). The one being painted, the
  // active finger, is bound to one shared full-size set instead: its paint is copied up when
  // it becomes active and copied back down when it stops (PLAN §4.1). The skin's fold shading
  // and spill follow the active finger.
  const fold = handData.fold;
  const startId = Q.has('finger') ? Number(Q.get('finger')) : handData.active;
  const startCfg = handData.fingers.find((f) => f.finger === startId) || handData.fingers[0];
  const skinU = makeFingerUniforms(new NailFrame(startCfg, handData.maxFree), fold, tuning);
  const tips = { value: handData.fingers.map((f) => new THREE.Vector3(...f.origin).addScaledVector(new THREE.Vector3(...f.tipDir).normalize(), f.bedLength * 0.9).addScaledVector(new THREE.Vector3(...f.normal).normalize(), -0.004)) };
  // The other fingers' spill reaches the skin through one atlas texture (src/paint/spill.js).
  const spillU = {
    tSpill: { value: null }, uActiveF: { value: -1 },
    uW2P: { value: handData.fingers.map(() => new THREE.Matrix4()) }, uRects: { value: handData.fingers.map(() => new THREE.Vector4()) },
  };
  const skinMesh = new THREE.Mesh(handGeo, makeSkinMaterial(skinU, tips, spillU));
  scene.add(skinMesh);
  scene.updateMatrixWorld(true);
  const fingers = handData.fingers.map((c) => new Finger(c, { scene, skinMesh, renderer, handData, tuning, caps }));
  for (const f of fingers) {
    spillU.uW2P.value[f.id].copy(f.frame.worldToPaint);
    const r = f.frame.rect; spillU.uRects.value[f.id].set(r.x0, r.y0, r.w, r.h);
  }
  const spill = new SpillAtlas(tuning.paint.restSize);
  spillU.tSpill.value = spill.texture;
  /** Redraw the other fingers' spill (after their paint or shape changes). */
  const refreshSpill = () => spill.update(renderer, fingers);

  const table = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  table.position.z = -0.0005;
  const rest = buildRest(under, handData.rest);          // cushion + the shadows on the table
  rest.shadow.position.z = -0.0003;
  scene.add(table, rest.shadow, rest.cushion);

  // ---- paint -------------------------------------------------------------------------------
  const big = new PaintTargets(tuning.paint.activeSize, caps);
  big.clear(renderer);
  /** @type {Finger} */
  let active = fingers.find((f) => f.cfg === startCfg) || fingers[0];
  const engine = new StrokeEngine(tuning.brush, (x, y) => active.sd(x, y));
  const stamps = new StampRenderer(tuning.brush, engine.capacity);
  /** The active finger's stats reader (each finger has its own). */
  let stats = active.nstats;
  const brushModel = new BrushModel(tuning.brushModel, active.frame.group);
  const leveler = new Leveler(big.size, caps.halfFloat, tuning.wet);
  const sound = new BrushSound();
  const wet = { acc: 0 };                          // tick remainder; each finger keeps its own wetness
  /** Point everything that follows the active finger at it and at the shared targets. */
  function bindActive() {
    active.bind(big);
    for (const k of Object.keys(skinU)) skinU[k].value = active.uniforms[k].value;
    spillU.uActiveF.value = active.id;
    stamps.setFinger(active.sdf.texture, active.skinMask, active.frame.rect);
    stats = active.nstats;
    engine.nailLength = active.info.length;
  }
  const wetTick = (seconds) => {
    leveler.tick(renderer, big, active.sdf.texture, seconds);
    bindActive();
    active.dirty = true; state.dirty = true;
  };
  /** Advance wet polish by dt seconds at the fixed tick rate: the active finger levels and dries,
   *  the others only dry. */
  const wetAdvance = (dt, maxTicks = 4) => {
    if (!fingers.some((f) => f.wet.left > 0)) { wet.acc = 0; return; }
    wet.acc += dt;
    let n = Math.min(maxTicks, Math.floor(wet.acc * WET_HZ));
    wet.acc -= n / WET_HZ; if (wet.acc > 1 / WET_HZ) wet.acc = 0;
    for (; n > 0; n--) wetStep();
  };
  function wetStep() {
    for (const f of fingers) {
      if (f.wet.left <= 0) continue;
      if (f === active) wetTick(); else leveler.dryOnly(renderer, f.targets, tuning.wet.drySeconds, f.wet);
      f.wet.left -= 1 / WET_HZ;
    }
  }

  const flush = () => {
    if (!engine.count) return;
    if (state.tool === 'polish') { active.wet.left = tuning.wet.drySeconds + 0.5; active.mapColor = state.polish.color; }
    stamps.flush(renderer, engine.stamps, engine.count, big);
    state.stamps += engine.count; engine.reset(); state.dirty = true; active.dirty = true;
  };
  engine.onFull = flush;

  /**
   * Make a finger the one being painted. Copies the old one's paint back down (only if it
   * changed, so a visit doesn't soften it) and the new one's up. Returns the ms it took.
   */
  function activate(f) {
    if (f === active) return 0;
    const t0 = performance.now();
    flush();
    if (engine.down) engine.end();
    const old = active;
    if (old.dirty) old.targets.copyFrom(renderer, big);
    old.bind(old.targets);
    if (old.dirty) old.nstats.refresh(renderer, true).then(() => drawMap());   // its numbers, from its own copy
    old.dirty = false;
    active = f;
    big.copyFrom(renderer, f.targets);
    bindActive();
    refreshSpill();
    f.frame.group.add(brushModel.root, brushModel.shadow);
    state.dirty = true;
    perf.switchMs = performance.now() - t0;
    return perf.switchMs;
  }

  /** GPU memory held by paint: every finger's own set, the shared one and the leveling scratch. */
  const paintBytes = () => big.bytes + undo.bytes + spill.bytes + fingers.reduce((n, f) => n + f.targets.bytes, 0) + big.size * big.size * (caps.halfFloat ? 8 : 4);

  // ---- tools: the polish brush, the swab and the remover pad (PLAN §7, §8) -------------------
  /** @param {'polish' | 'swab' | 'remover'} name */
  function setTool(name) {
    if (engine.down) return false;
    flush();
    state.tool = name;
    const T = tuning.tools;
    engine.setTool(name === 'polish' ? null : T[name]);
    stamps.setEraser(name === 'polish' ? null : name, T.swab.edge, T.remover.idClear);
    // The 3D brush shows only for polish (loop: brushModel.update). Swab and pad models: later.
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.getAttribute('data-tool') === name);
    return true;
  }

  // ---- Oops: one level of undo (PLAN §4.3) ---------------------------------------------------
  // Just before every stroke (any tool), the active nail's whole paint set is copied aside. Oops
  // copies it back; if she has moved on, the camera goes back to that nail first.
  const undo = new PaintTargets(tuning.paint.activeSize, caps);
  /** @type {{ finger: Finger, wet: number, mapColor: string | undefined } | null} */
  let undoFrom = null;
  const oopsBtn = document.getElementById('oops');
  const showOops = () => oopsBtn?.toggleAttribute('disabled', !undoFrom);
  function snapshot() {
    flush();
    undo.copyFrom(renderer, big);
    undoFrom = { finger: active, wet: active.wet.left, mapColor: active.mapColor };
    showOops();
  }
  async function undoLast() {
    if (!undoFrom || engine.down) return false;
    flush();
    const { finger: f, wet: w, mapColor } = undoFrom;
    // On another nail: go back to it first, so she sees what Oops did and the restore is full size.
    if (f !== active && !goTo('nail', f.id)) return false;
    undoFrom = null; showOops();
    big.copyFrom(renderer, undo); bindActive(); active.dirty = true;
    f.wet.left = w; f.mapColor = mapColor;
    state.dirty = true;
    await f.nstats.refresh(renderer, true);
    drawMap();
    return true;
  }

  function setShape(shape, free) {
    flush();
    for (const f of fingers) f.setShape(renderer, shape, free);
    bindActive();
    refreshSpill();
    state.dirty = true;
  }

  function setPolish(id) {
    const p = catalog.polishes.find((q) => q.id === id);
    if (!p) throw new Error(`unknown polish: ${id}`);
    state.polish = p;
    stamps.setPolish(new THREE.Color(p.color), catalog.finishes[p.finish]);   // sRGB hex → linear
    brushModel.setPolish(p.color);
    engine.dip();
  }

  // ---- applyDesign (PLAN §4.7): paint every nail straight from a Design, no brush ----------
  const designer = new DesignPainter(tuning);
  /**
   * Replace all five nails with a Design (§9.3): its shape, polish (accent nail too), french or
   * ombre tip and top coat, dry. Each nail keeps a record (§4.6) of the parts that are objects.
   * @param {any} design @param {{ chipped?: number }} [o] chipped 0…1 for old polish
   */
  async function applyDesign(design, o = {}) {
    flush();
    if (engine.down) engine.end();
    if (design.shape && design.shape !== active.shape) setShape(design.shape, active.free);
    for (const f of fingers) {
      const L = nailLayers(design, f.id, catalog);
      designer.paint(renderer, f, L, f.bound, o);
      f.wet.left = 0; f.wet.debt = 0;
      f.dirty = f === active;                        // the active one is in the shared set
      f.mapColor = L.base?.color;
      f.record = { finger: f.id, shape: f.shape, freeLength: f.free, polish: L.base?.id ?? null, topCoat: L.topCoat, dry: true, oldPolish: !!o.chipped, art: L.objects };
    }
    state.dirty = true;
    undoFrom = null; showOops();
    refreshSpill();
    await Promise.all(fingers.map((f) => f.nstats.refresh(renderer, true)));
    drawMap();
  }

  function setRequest(id) {
    const p = id && catalog.polishes.find((q) => q.id === id);
    for (const f of fingers) f.nstats.setRequest(p ? new THREE.Color(p.color) : null, p ? [catalog.finishes[p.finish].id] : []);
    state.dirty = true;
  }

  async function setTheme(theme) {
    state.theme = theme;
    for (const [k, v] of Object.entries(theme.css)) document.documentElement.style.setProperty(k, v);
    const L = theme.lighting;
    scene.environment = await loadEnv(L.hdri);
    scene.environmentIntensity = L.envIntensity;
    scene.environmentRotation.set(L.envTilt ?? 0.7, L.envRot, 0);
    renderer.toneMappingExposure = L.exposure;
    key.color.set(L.key[0]); key.intensity = L.key[1];
    rimL.color.set(L.rim[0]); rimR.color.set(L.rim[1]); rimL.intensity = rimR.intensity = L.rim[2];
    for (const u of [skinU, ...fingers.map((f) => f.uniforms)]) { u.uSkinCol.value.set(theme.skin); u.uBedCol.value.set(theme.nailBed); }
    brushModel.setCap(theme.brushCap);
    /** @type {THREE.MeshStandardMaterial} */ (table.material).color.set(theme.table);
    /** @type {THREE.MeshPhysicalMaterial} */ (rest.cushion.material).color.set(theme.cushion);
    /** @type {THREE.MeshPhysicalMaterial} */ (rest.cushion.material).sheenColor.set(theme.cushion).lerp(new THREE.Color(0xffffff), 0.5);
  }

  // ---- camera ------------------------------------------------------------------------------
  const v = new THREE.Vector3();
  const rig = new CameraRig(camera, cameraData, active.id, state.scene === 'hand' ? 'hand' : 'nail', startUp());
  function placeCamera() {
    rig.apply(active.frame.group.matrixWorld, active.info.length);
    key.position.set(-0.3, 0.6, 0.4).add(camera.position); rimL.position.set(-0.6, 0.2, -0.15); rimR.position.set(0.6, 0.2, -0.15);
  }
  /** Which way the hand starts: ?flip=1 for tests, otherwise the saved choice (R11: tips down). */
  function startUp() {
    if (Q.has('flip')) return Q.get('flip') === '1';
    if (fixed) return false;
    try { return localStorage.getItem(HAND_KEY) === 'up'; } catch { return false; }
  }
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  // ---- pointer ↔ paint frame ---------------------------------------------------------------
  // The camera looks nearly straight down the nail normal, so a ray is intersected with the
  // paint plane and corrected against the surface height a few times. No mesh raycasts.
  const ro = new THREE.Vector3(), rd = new THREE.Vector3();
  function clientToPaint(cx, cy, out) {
    const r = canvas.getBoundingClientRect();
    ro.setFromMatrixPosition(camera.matrixWorld);
    rd.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height * 2 - 1), 0.5).unproject(camera);
    const frame = active.frame;
    ro.applyMatrix4(frame.worldToPaint); rd.applyMatrix4(frame.worldToPaint).sub(ro);
    if (Math.abs(rd.z) < 1e-6) return false;
    let z = 0, x = 0, y = 0;
    for (let i = 0; i < 4; i++) {
      const t = (z - ro.z) / rd.z;
      x = ro.x + rd.x * t; y = ro.y + rd.y * t;
      z = active.surface(x, y);
    }
    out.x = x; out.y = y;
    const R = frame.rect;
    return x > R.x0 - 0.5 && x < R.x0 + R.w + 0.5 && y > R.y0 - 0.5 && y < R.y0 + R.h + 0.5;
  }
  function paintToClient(x, y) {
    const r = canvas.getBoundingClientRect();
    v.set(x, y, active.surface(x, y)).applyMatrix4(active.frame.group.matrixWorld).project(camera);
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }

  const tailAt = { x: 0, y: 0 }, RAD = Math.PI / 180;
  /** Point the brush model at the Pencil: its tail leans the way the real one does on screen. */
  function showBrush(cx, cy, x, y, altitude, azimuth, touching) {
    const M = tuning.brushModel, az = azimuth ?? M.defaultAzimuthDeg * RAD, alt = altitude ?? M.defaultAltitudeDeg * RAD;
    if (!clientToPaint(cx + Math.cos(az) * 40, cy + Math.sin(az) * 40, tailAt)) return;
    brushModel.place(x, y, active.surface(x, y), tailAt.x - x, tailAt.y - y, alt, touching, performance.now());
  }

  const pt = { x: 0, y: 0 };
  /** Empty background in nail view: no finger under this screen point. */
  const offHand = (cx, cy) => !clientToPaint(cx, cy, pt) || !active.onHand(pt.x, pt.y);
  const input = new PointerInput(canvas, {
    toPaint: clientToPaint, engine, ...tuning.input, onCursor: (...a) => { if (state.tool === 'polish') showBrush(...a); }, offHand,
    onBeforeStroke: snapshot,
    blocked: () => rig.moving || rig.view !== 'nail',
  });
  // Sound is off unless asked for (?sound=1): Clay found the synthesized brush bad and optional.
  if (Q.get('sound') === '1') canvas.addEventListener('pointerdown', () => sound.wake());

  // ---- start -------------------------------------------------------------------------------
  setShape(SHAPES.includes(state.shape) ? state.shape : 'round', Number.isFinite(state.free) ? state.free : startCfg.naturalFree);
  bindActive();
  setPolish(Q.get('polish') || 'cream-red');
  setRequest(Q.get('polish') || 'cream-red');
  await setTheme(state.theme);
  resize(); placeCamera();

  // ---- the bottle: tap to dip the brush (PLAN §4.2) ------------------------------------------
  // The brush runs low as it paints and goes streaky; the bottle shows how much is left on it.
  const bottle = /** @type {HTMLElement | null} */ (document.getElementById('bottle'));
  const bottleLevel = /** @type {SVGElement | null} */ (bottle?.querySelector('.level'));
  const bottleShown = { load: -1, color: '' };
  function drawBottle() {
    if (!bottle || !bottleLevel) return;
    const load = Math.round(engine.load * 50) / 50;
    if (load !== bottleShown.load) {
      bottleShown.load = load;
      bottleLevel.style.transform = `scaleY(${(0.12 + 0.88 * load).toFixed(3)})`;
      bottle.classList.toggle('low', load < tuning.brush.lowLoad);
    }
    if (state.polish.color !== bottleShown.color) { bottleShown.color = state.polish.color; bottleLevel.setAttribute('fill', state.polish.color); }
  }
  function dipBrush() {
    engine.dip();
    if (!bottle) return;
    bottle.classList.remove('dip'); void bottle.offsetWidth; bottle.classList.add('dip');
  }
  bottle?.addEventListener('pointerdown', (e) => { e.preventDefault(); if (input.touchMayPress(e)) { setTool('polish'); dipBrush(); } });
  for (const b of document.querySelectorAll('[data-tool]')) {
    if (b === bottle) continue;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (input.touchMayPress(e)) setTool(/** @type {any} */ (b.getAttribute('data-tool'))); });
  }
  oopsBtn?.addEventListener('pointerdown', (e) => { e.preventDefault(); if (input.touchMayPress(e)) undoLast(); });

  // ---- the turn button: fingertips down ↔ up (PLAN §6, R11) -----------------------------------
  const turnBtn = document.getElementById('turn');
  let turnSpin = 0;
  function turnHand() {
    if (engine.down || !rig.turn(performance.now())) return false;     // never while the brush is down
    turnSpin += 180;
    turnBtn?.style.setProperty('--spin', `${turnSpin}deg`);
    try { localStorage.setItem(HAND_KEY, rig.up ? 'up' : 'down'); } catch { /* storage may be off */ }
    drawMap();
    return true;
  }
  // A resting palm must not turn the hand: the press is judged at pointerdown, where we know
  // what touched it.
  let turnOk = true;
  turnBtn?.addEventListener('pointerdown', (e) => { turnOk = input.touchMayPress(e); });
  turnBtn?.addEventListener('click', () => { if (turnOk) turnHand(); turnOk = true; });

  // ---- moving between nails (PLAN §5, §6, §13.3) ---------------------------------------------
  // Arrows beside the nail, the mini-map, a swipe on empty background, or (in hand view) a tap
  // on a nail. Changing nails re-dips the brush during the glide (§4.2).
  const wc = new THREE.Vector3();
  /** Fingers left to right as they sit on screen (fingertips down puts the thumb on the left). */
  const screenOrder = () => fingers.map((f) => [f, f.centre(wc).x]).sort((a, b) => (rig.up ? a[1] - b[1] : b[1] - a[1])).map((p) => p[0]);
  function goTo(view, id = active.id) {
    if (rig.moving || engine.down) return false;
    const f = fingers.find((q) => q.id === id) || active;
    if (view === rig.view && f === active) return false;
    if (f !== active) { activate(f); engine.dip(); }
    rig.goTo(view, f.id, performance.now());
    document.body.dataset.view = view;
    drawMap();
    return true;
  }
  /** The next nail to the right (+1) or left (−1) on screen. */
  function step(dir) {
    const order = screenOrder(), i = order.indexOf(active), next = order[i + dir];
    return next ? goTo('nail', next.id) : false;
  }
  for (const [id, dir] of [['prev', -1], ['next', 1]]) {
    const b = document.getElementById(id);
    let ok = true;
    b?.addEventListener('pointerdown', (e) => { ok = input.touchMayPress(e); });
    b?.addEventListener('click', () => { if (ok) step(dir); ok = true; });
  }

  // A press on the canvas that paints nothing: a swipe on background (nail view) or a tap on a
  // nail (hand view). Judged on release; palms are ignored.
  const nav = { id: -1, x: 0, y: 0, t: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    if (nav.id !== -1 || !input.touchMayPress(e) || rig.moving) return;
    if (rig.view === 'nail' && !offHand(e.clientX, e.clientY)) return;     // on the hand: a stroke
    Object.assign(nav, { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });
  });
  const navEnd = (e) => {
    if (e.pointerId !== nav.id) return;
    nav.id = -1;
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - nav.x, dy = e.clientY - nav.y, N = tuning.nav;
    if (rig.view === 'nail') {
      if (Math.abs(dx) > N.swipePx && Math.abs(dx) > 1.5 * Math.abs(dy) && e.timeStamp - nav.t < N.swipeMs) step(dx < 0 ? 1 : -1);
    } else if (Math.hypot(dx, dy) < N.tapPx) {
      let best = null, bestD = N.pickPx;
      for (const f of fingers) {
        f.centre(wc).project(camera);
        const r = canvas.getBoundingClientRect(), d = Math.hypot(r.left + (wc.x + 1) / 2 * r.width - e.clientX, r.top + (1 - wc.y) / 2 * r.height - e.clientY);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (best) goTo('nail', best.id);
    }
  };
  canvas.addEventListener('pointerup', navEnd);
  canvas.addEventListener('pointercancel', navEnd);

  // The mini-map: the five nails where they sit on the hand, filled as they're painted; the one
  // being painted is highlighted. Tap a nail to go there, the palm for the whole hand.
  const map = document.getElementById('map');
  function drawMap() {
    if (!map) return;
    const sgn = rig.up ? 1 : -1;               // map x follows screen x; fingertips down = tips at the bottom
    const pts = fingers.map((f) => { f.centre(wc); return [sgn * wc.x, -sgn * wc.y]; });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const W = 150, H = 120, tipsLow = !rig.up, k = 110 / Math.max(x1 - x0, 1e-6);
    const at = (p) => [20 + (p[0] - x0) * k, (tipsLow ? 76 : 44) + (p[1] - (y0 + y1) / 2) * k];
    const palmY = tipsLow ? 18 : 102;
    const edge = tipsLow ? palmY + 10 : palmY - 10;
    // Each nail is a little nail (cuticle curve, rounded tip) at the end of its finger, pointing
    // away from the palm. The one being painted is bigger and lit in the theme's accent.
    const NAIL = 'M-7 -7Q0 -10 7 -7L7 3Q7 10 0 10Q-7 10 -7 3Z';
    const parts = fingers.map((f, i) => {
      const [x, y] = at(pts[i]), bx = 75 + (x - 75) * 0.6;
      const deg = Math.atan2(y - edge, x - bx) * 180 / Math.PI - 90, cov = Math.min(1, f.stats.coverage / tuning.film.covered);
      const nail = `<g class="nail${f === active ? ' on' : ''}" data-finger="${f.id}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})${f === active ? ' scale(1.3)' : ''}">
        <path class="bare" d="${NAIL}"/><path d="${NAIL}" fill="${f.mapColor || state.polish.color}" fill-opacity="${cov.toFixed(2)}"/><path class="edge" d="${NAIL}"/></g>`;
      return { stalk: `<path d="M${bx.toFixed(1)} ${edge} L${x.toFixed(1)} ${y.toFixed(1)}"/>`, nail };
    });
    map.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="palm" data-hand="1"><rect x="35" y="${palmY - 16}" width="80" height="32" rx="14"/><g class="stalks">${parts.map((p) => p.stalk).join('')}</g></g>${parts.map((p) => p.nail).join('')}</svg>`;
  }
  map?.addEventListener('pointerdown', (e) => {
    if (!input.touchMayPress(e)) return;
    const t = /** @type {Element} */ (e.target), g = t.closest('[data-finger]');
    if (g) goTo('nail', Number(g.getAttribute('data-finger')));
    else if (t.closest('[data-hand]')) goTo('hand');
  });
  document.body.dataset.view = rig.view;
  // ?design=<id from data/designs.json> paints every nail with it; &chipped=0…1 wears it.
  if (Q.has('design')) {
    const d = designs.designs[Q.get('design')];
    if (!d) throw new Error(`unknown design: ${Q.get('design')}`);
    setRequest(d.polish);
    if (d.polish && !Q.has('polish')) setPolish(d.polish);     // the bottle holds the design's polish
    await applyDesign(d, { chipped: Number(Q.get('chipped') || 0) });
  }
  drawMap();

  if (Q.get('debug') === 'frames') {
    addGizmos(scene, fingers.map((f) => f.frame));
    frameEditor(startCfg, tune);
  }

  const overlay = Q.has('debug') ? new DebugOverlay(() => {
    const s = stats.last, f = (n) => n.toFixed(2);
    return [
      `gpu half-float ${caps.halfFloat}  paint ${(paintBytes() / 1048576).toFixed(0)} MB  switch ${perf.switchMs.toFixed(1)} ms`,
      `pointer ${input.info.type}  alt ${input.info.altitude == null ? '-' : (input.info.altitude * 57.3).toFixed(0) + '°'}  coalesced ${input.info.coalesced}  predicted ${input.info.predicted}  hover ${input.info.hover}`,
      `polish ${state.polish.id}  load ${f(engine.load)}  speed ${f(engine.speed)}  stamps ${state.stamps}`,
      `coverage ${f(s.coverage)}  even ${f(s.evenness)}  spill ${s.spill.toFixed(3)}`,
      `colour ${f(s.colorMatch)}  finish ${f(s.finishMatch)}`,
      `finger ${active.id}  ${rig.view} view  shape ${active.shape}  free ${f(active.free)}  theme ${state.theme.id}  ${rig.up ? 'tips up' : 'tips down'}`,
      `frame ${perf.frame.toFixed(1)} ms  js ${perf.js.toFixed(1)} ms  gpu time n/a`,
      `draws ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  geometries ${renderer.info.memory.geometries}  textures ${renderer.info.memory.textures}`,
      `size ${innerWidth}x${innerHeight} @${renderer.getPixelRatio()}  boot ${perf.boot.toFixed(0)} ms`,
    ];
  }, debugControls()) : null;

  /** Debug-only shortcuts: each one reloads the page with one query value changed. */
  function debugControls() {
    const go = (k, val) => { const u = new URLSearchParams(location.search); u.set(k, val); return `?${u}`; };
    return [
      ...themes.map((t) => ({ label: t.name, href: go('theme', t.id) })),
      ...['nail', 'hand'].map((n) => ({ label: n, href: go('view', n) })),
      ...handData.fingers.map((f) => ({ label: `f${f.finger}`, href: go('finger', String(f.finger)) })),
    ];
  }

  let frames = 0, prev = performance.now();
  const waiters = [];
  function loop(now) {
    const began = performance.now();
    perf.frame += (now - prev - perf.frame) * 0.1;
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    if (rig.update(now)) placeCamera();
    brushModel.update(now, engine.down, rig.view === 'nail' && !rig.turning && state.tool === 'polish');
    active.frame.update();
    flush();
    if (!fixed) wetAdvance(dt);
    sound.update(engine.down ? engine.speed : 0, engine.load);
    if (state.dirty && now - state.lastStats > tuning.stats.intervalMs) {
      state.dirty = false; state.lastStats = now;
      stats.refresh(renderer).then(() => drawMap());
    }
    renderer.render(scene, camera);
    drawBottle();
    perf.js += (performance.now() - began - perf.js) * 0.1;
    overlay?.tick(); frames++;
    while (waiters.length) waiters.pop()();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  const nextFrame = () => new Promise((res) => waiters.push(res));

  // ---- test API (PLAN §14.2): the robot painter and every Playwright test use only this ----
  let clock = 1000;
  const api = {
    info: () => ({ finger: active.id, view: rig.view, shape: active.shape, free: active.free, length: active.info.length, bed: active.frame.bed, rect: active.frame.rect, caps, load: engine.load, stamps: state.stamps, frames }),
    sd: (x, y) => active.sd(x, y), setShape, setPolish, setRequest, nextFrame,
    /** Paint every nail from a Design (an object, or an id in data/designs.json). */
    applyDesign: (d, o) => applyDesign(typeof d === 'string' ? designs.designs[d] : d, o),
    /** Each nail's record from the last applyDesign (PLAN §4.6), or null. */
    records: () => fingers.map((f) => f.record ?? null),
    three: { scene, camera, renderer, key },
    setTheme: (id) => setTheme(themes.find((t) => t.id === id) || themes[0]),
    view: (view, up = rig.up) => { rig.view = view; rig.set(up); document.body.dataset.view = view; placeCamera(); return nextFrame(); },
    /** Glide to the hand or to a nail, as a tap would, and wait until the camera arrives. */
    async goTo(view, finger) { const ok = goTo(view, finger); while (rig.moving) await nextFrame(); await nextFrame(); return ok; },
    /** Arrow to the next nail on screen (+1 right, −1 left) and wait. */
    async step(dir) { const ok = step(dir); while (rig.moving) await nextFrame(); await nextFrame(); return ok; },
    order: () => screenOrder().map((f) => f.id),
    /** Every finger's stats: the active one fresh, the others from when they were last active. */
    async statsAll() { flush(); await stats.refresh(renderer, true); for (const f of fingers) await f.nstats._flight?.catch(() => {}); return fingers.map((f) => ({ ...f.stats })); },
    paintBytes: () => paintBytes(),
    /** Is this screen point empty background (where a swipe starts)? */
    offHand: (cx, cy) => offHand(cx, cy),
    /** What a screen point maps to: paint coords, and whether there is hand there. */
    hit: (cx, cy) => { const ok = clientToPaint(cx, cy, pt); return { ok, x: pt.x, y: pt.y, onHand: active.onHand(pt.x, pt.y) }; },
    switchMs: () => perf.switchMs,
    /** Where a finger's nail is on screen right now (hand view picking). */
    nailOnScreen: (id) => { const f = fingers.find((q) => q.id === id); f.centre(wc).project(camera); const r = canvas.getBoundingClientRect(); return [r.left + (wc.x + 1) / 2 * r.width, r.top + (1 - wc.y) / 2 * r.height]; },
    /** Press the turn button and wait for the turn to finish. Resolves false if it was refused. */
    async turn() { const ok = turnHand(); while (rig.turning) await nextFrame(); await nextFrame(); return ok; },
    direction: () => ({ up: rig.up, turning: rig.turning, t: rig.t }),
    brush: () => brushModel.state(),
    /** One pointer event at a paint-frame point. kind: down | move | up | hover | predict. */
    pen(kind, x, y, o = {}) {
      const [clientX, clientY] = paintToClient(x, y), s = { clientX, clientY, pointerType: o.pointerType ?? 'pen', timeStamp: clock += 16, altitudeAngle: o.altitude ?? 50 * Math.PI / 180, azimuthAngle: o.azimuth ?? 0.8 };
      if (kind === 'hover') input.cursor(s, false); else if (kind === 'predict') input.cursor(s, true); else input.handle(kind, s);
      return nextFrame();
    },
    stampCount: () => state.stamps + engine.count,
    /** Where a paint-frame point is on screen, in CSS pixels. */
    project: (x, y) => paintToClient(x, y),
    clear: () => { big.clear(renderer); for (const f of fingers) { f.targets.clear(renderer); f.wet.left = 0; f.dirty = false; f.nstats.last = { coverage: 0, evenness: 1, colorMatch: 0, finishMatch: 0, spill: 0 }; } refreshSpill(); undoFrom = null; showOops(); engine.dip(); state.dirty = true; return nextFrame(); },
    setTool, undo: undoLast, canUndo: () => !!undoFrom, tool: () => state.tool,
    dip: () => engine.dip(),
    tapBottle: dipBrush,
    /** Let wet polish level and dry for `seconds` of game time, without waiting. */
    advance: (seconds) => { flush(); for (let n = Math.round(seconds * WET_HZ); n > 0 && fingers.some((f) => f.wet.left > 0); n--) wetStep(); return nextFrame(); },
    wetLeft: () => active.wet.left,
    setBrush: (radius) => { engine.radius = radius ?? tuning.brush.radius; },
    area: () => area(active.info.points),
    stats: async () => { flush(); return stats.refresh(renderer, true); },
    filmAt: (x, y) => stats.filmAt(x, y),
    /**
     * Feed synthetic pointer samples through the real input path.
     * points: [[x, y], …] in paint coords. opts: speed (nail widths/s), pointerType,
     * altitude (radians), at (ms on the synthetic clock, to jump time), dip (re-dip first).
     */
    async stroke(points, opts = {}) {
      const { speed = 1.2, pointerType = 'pen', altitude = 50 * Math.PI / 180, step = 0.01, dip = true } = opts;
      if (opts.at != null) clock = opts.at; else clock += 200;
      if (dip) engine.dip();
      const before = state.stamps + engine.count;
      const send = (kind, x, y) => {
        const [cx, cy] = paintToClient(x, y);
        input.handle(kind, { clientX: cx, clientY: cy, pointerType, timeStamp: clock, altitudeAngle: pointerType === 'pen' ? altitude : undefined });
      };
      send('down', points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i], len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(len / step));
        for (let k = 1; k <= n; k++) { clock += (len / n) / speed * 1000; send('move', x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n); }
      }
      input.handle('up', { pointerType, timeStamp: clock });
      flush();
      await nextFrame();
      return { stamps: state.stamps - before, clock };
    },
  };
  await nextFrame();
  await stats.refresh(renderer);
  perf.boot = performance.now() - bootStart;
  return api;
}

const ready = boot();
ready.catch((e) => {
  console.error(e);
  const el = document.getElementById('boot-error');
  if (el) { el.style.display = 'block'; el.textContent = String(e && e.message || e); }
});
// Exposed always for now (M0); gate behind ?debug once the game has a front door.
/** @type {any} */ (window).__salon = { ready };
ready.then((api) => Object.assign(/** @type {any} */ (window).__salon, api));
