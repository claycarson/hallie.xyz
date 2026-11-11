// @ts-check
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/RGBELoader.js';
import { gpuCaps } from './engine/gpu.js';
import { NailFrame } from './hand/frame.js';
import { loadHand } from './hand/model.js';
import { loadUnderside, buildRest } from './hand/rest.js';
import { outline, sdPolygon, area, SHAPES } from './hand/outline.js';
import { OutlineSdf } from './hand/sdf.js';
import { SkinHeight, makePlateZ, buildPlate, buildPlateNormals } from './hand/plate.js';
import { makeFingerUniforms, makeNailMaterial, makeSkinMaterial } from './hand/materials.js';
import { PaintTargets } from './paint/targets.js';
import { StampRenderer } from './paint/stamps.js';
import { StrokeEngine } from './paint/stroke.js';
import { NailStats } from './paint/stats.js';
import { Leveler, WET_HZ } from './paint/leveling.js';
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
  const [tuning, handData, cameraData, themes, catalog] = await Promise.all(['tuning', 'hand', 'camera', 'themes', 'catalog'].map(json));
  const [handGeo, under] = await Promise.all([loadHand(`./${handData.file}`), loadUnderside(`./${handData.under}`)]);
  const tune = parseTune(Q.get('tune'));                // ?tune=… : frame editor offsets
  handData.fingers = handData.fingers.map((f) => tuned(f, tune[f.finger]));
  const fixed = Q.has('scene');                       // fixed test scene: nothing drifts
  const state = {
    scene: Q.get('scene') || Q.get('view') || 'nail',
    shape: Q.get('shape') || 'round', free: Number(Q.get('free') ?? NaN),
    theme: themes.find((t) => t.id === Q.get('theme')) || themes[0],
    polish: catalog.polishes[0], dirty: true, lastStats: 0, stamps: 0,
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

  // ---- the hand: skin, five nail frames, five plates ------------------------------------------
  // One finger is active (painted, with paint targets and fold shading on the skin). The other
  // four carry a bare plate until M1.1 gives every finger its own targets.
  const fold = handData.fold;
  const activeId = Q.has('finger') ? Number(Q.get('finger')) : handData.active;
  const cfg = handData.fingers.find((f) => f.finger === activeId) || handData.fingers[0];
  const frame = new NailFrame(cfg, handData.maxFree);
  scene.add(frame.group);
  const uniforms = makeFingerUniforms(frame, fold, tuning);
  const tips = { value: handData.fingers.map((f) => new THREE.Vector3(...f.origin).addScaledVector(new THREE.Vector3(...f.tipDir).normalize(), f.bedLength * 0.9).addScaledVector(new THREE.Vector3(...f.normal).normalize(), -0.004)) };
  const skinMesh = new THREE.Mesh(handGeo, makeSkinMaterial(uniforms, tips));
  scene.add(skinMesh);
  scene.updateMatrixWorld(true);
  frame.update();
  const skin = new SkinHeight(frame, [skinMesh]);
  const skinMask = skin.maskTexture();

  const table = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  table.position.z = -0.0005;
  const rest = buildRest(under, handData.rest);          // cushion + the shadows on the table
  rest.shadow.position.z = -0.0003;
  scene.add(table, rest.shadow, rest.cushion);

  const sdf = new OutlineSdf(frame.rect);
  const nailMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeNailMaterial(uniforms));
  frame.group.add(nailMesh);
  const nail = { info: outline('round', 1), plateZ: (x, y) => 0, shape: 'round', free: 0 };
  const sd = (x, y) => sdPolygon(nail.info.points, x, y);
  const surface = (x, y) => (sd(x, y) <= 0 ? nail.plateZ(x, y) : skin.at(x, y));

  // Bare plates on the other fingers.
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); blank.needsUpdate = true;
  const others = handData.fingers.filter((f) => f !== cfg).map((c) => {
    const fr = new NailFrame(c, handData.maxFree);
    scene.add(fr.group); fr.group.updateMatrixWorld(true); fr.update();
    const u = makeFingerUniforms(fr, fold, tuning);
    u.tPig.value = u.tMat.value = u.tDet.value = blank;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeNailMaterial(u));
    fr.group.add(mesh);
    return { cfg: c, frame: fr, uniforms: u, mesh, skin: new SkinHeight(fr, [skinMesh]), sdf: new OutlineSdf(fr.rect) };
  });
  function shapeOther(o, shape, free) {
    const info = outline(shape, o.frame.lengthFor(free));
    o.sdf.update(renderer, info.points);
    o.uniforms.tSdf.value = o.sdf.texture;
    o.uniforms.uCuticleDepth.value = info.cuticleDepth;
    o.mesh.geometry.dispose();
    const z = makePlateZ(o.frame, info.points, o.skin, fold, o.cfg);
    o.mesh.geometry = buildPlate(info, z, fold, o.frame.bed);
    o.uniforms.tNrm.value = buildPlateNormals(z, info.points, info.length, o.frame.rect, o.uniforms.tNrm.value);
  }

  // ---- paint -------------------------------------------------------------------------------
  const targets = new PaintTargets(1024, caps);
  targets.clear(renderer);
  const engine = new StrokeEngine(tuning.brush, sd);
  const stamps = new StampRenderer(tuning.brush, engine.capacity);
  const stats = new NailStats(tuning);
  stamps.setFinger(sdf.texture, skinMask, frame.rect);
  stats.setFinger(sdf.texture, targets, frame.rect);
  uniforms.tSdf.value = sdf.texture; uniforms.tPig.value = targets.pigment.texture;
  uniforms.tMat.value = targets.material.texture; uniforms.tDet.value = targets.detail.texture;

  const brushModel = new BrushModel(tuning.brushModel, frame.group);
  const leveler = new Leveler(targets.size, caps.halfFloat, tuning.wet);
  const sound = new BrushSound();
  const wet = { left: 0, acc: 0 };                  // seconds of wetness left; tick remainder
  const wetTick = (seconds) => {
    leveler.tick(renderer, targets, sdf.texture, seconds);
    uniforms.tPig.value = targets.pigment.texture;
    stats.setFinger(sdf.texture, targets, frame.rect);
    state.dirty = true;
  };
  /** Advance wet polish by dt seconds (level + dry), at the fixed tick rate. */
  const wetAdvance = (dt, maxTicks = 4) => {
    if (wet.left <= 0) return;
    wet.acc += dt;
    let n = Math.min(maxTicks, Math.floor(wet.acc * WET_HZ));
    wet.acc -= n / WET_HZ; if (wet.acc > 1 / WET_HZ) wet.acc = 0;
    for (; n > 0 && wet.left > 0; n--) { wetTick(); wet.left -= 1 / WET_HZ; }
  };

  const flush = () => {
    if (!engine.count) return;
    wet.left = tuning.wet.drySeconds + 0.5;
    stamps.flush(renderer, engine.stamps, engine.count, targets);
    state.stamps += engine.count; engine.reset(); state.dirty = true;
  };
  engine.onFull = flush;

  function setShape(shape, free) {
    nail.shape = shape; nail.free = free;
    nail.info = outline(shape, frame.lengthFor(free));
    sdf.update(renderer, nail.info.points);
    nail.plateZ = makePlateZ(frame, nail.info.points, skin, fold, cfg);
    nailMesh.geometry.dispose();
    nailMesh.geometry = buildPlate(nail.info, nail.plateZ, fold, frame.bed);
    uniforms.tNrm.value = buildPlateNormals(nail.plateZ, nail.info.points, nail.info.length, frame.rect, uniforms.tNrm.value);
    uniforms.uCuticleDepth.value = nail.info.cuticleDepth;
    engine.nailLength = nail.info.length;
    stats.refreshGeometry(renderer);
    for (const o of others) shapeOther(o, shape, free);
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

  function setRequest(id) {
    const p = id && catalog.polishes.find((q) => q.id === id);
    stats.setRequest(p ? new THREE.Color(p.color) : null, p ? [catalog.finishes[p.finish].id] : []);
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
    for (const u of [uniforms, ...others.map((o) => o.uniforms)]) { u.uSkinCol.value.set(theme.skin); u.uBedCol.value.set(theme.nailBed); }
    brushModel.setCap(theme.brushCap);
    /** @type {THREE.MeshStandardMaterial} */ (table.material).color.set(theme.table);
    /** @type {THREE.MeshPhysicalMaterial} */ (rest.cushion.material).color.set(theme.cushion);
    /** @type {THREE.MeshPhysicalMaterial} */ (rest.cushion.material).sheenColor.set(theme.cushion).lerp(new THREE.Color(0xffffff), 0.5);
  }

  // ---- camera ------------------------------------------------------------------------------
  const v = new THREE.Vector3();
  const rig = new CameraRig(camera, cameraData, cfg.finger, state.scene === 'hand' ? 'hand' : 'nail', startUp());
  function placeCamera() {
    rig.apply(frame.group.matrixWorld, nail.info.length);
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
    ro.applyMatrix4(frame.worldToPaint); rd.applyMatrix4(frame.worldToPaint).sub(ro);
    if (Math.abs(rd.z) < 1e-6) return false;
    let z = 0, x = 0, y = 0;
    for (let i = 0; i < 4; i++) {
      const t = (z - ro.z) / rd.z;
      x = ro.x + rd.x * t; y = ro.y + rd.y * t;
      z = surface(x, y);
    }
    out.x = x; out.y = y;
    const R = frame.rect;
    return x > R.x0 - 0.5 && x < R.x0 + R.w + 0.5 && y > R.y0 - 0.5 && y < R.y0 + R.h + 0.5;
  }
  function paintToClient(x, y) {
    const r = canvas.getBoundingClientRect();
    v.set(x, y, surface(x, y)).applyMatrix4(frame.group.matrixWorld).project(camera);
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }

  const tailAt = { x: 0, y: 0 }, RAD = Math.PI / 180;
  /** Point the brush model at the Pencil: its tail leans the way the real one does on screen. */
  function showBrush(cx, cy, x, y, altitude, azimuth, touching) {
    const M = tuning.brushModel, az = azimuth ?? M.defaultAzimuthDeg * RAD, alt = altitude ?? M.defaultAltitudeDeg * RAD;
    if (!clientToPaint(cx + Math.cos(az) * 40, cy + Math.sin(az) * 40, tailAt)) return;
    brushModel.place(x, y, surface(x, y), tailAt.x - x, tailAt.y - y, alt, touching, performance.now());
  }

  const input = new PointerInput(canvas, { toPaint: clientToPaint, engine, ...tuning.input, blocked: () => rig.turning, onCursor: showBrush });
  // Sound is off unless asked for (?sound=1): Clay found the synthesized brush bad and optional.
  if (Q.get('sound') === '1') canvas.addEventListener('pointerdown', () => sound.wake());

  // ---- start -------------------------------------------------------------------------------
  setShape(SHAPES.includes(state.shape) ? state.shape : 'round', Number.isFinite(state.free) ? state.free : cfg.naturalFree);
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
  bottle?.addEventListener('pointerdown', (e) => { e.preventDefault(); if (input.touchMayPress(e)) dipBrush(); });

  // ---- the turn button: fingertips down ↔ up (PLAN §6, R11) -----------------------------------
  const turnBtn = document.getElementById('turn');
  let turnSpin = 0;
  function turnHand() {
    if (engine.down || !rig.turn(performance.now())) return false;     // never while the brush is down
    turnSpin += 180;
    turnBtn?.style.setProperty('--spin', `${turnSpin}deg`);
    try { localStorage.setItem(HAND_KEY, rig.up ? 'up' : 'down'); } catch { /* storage may be off */ }
    return true;
  }
  // A resting palm must not turn the hand: the press is judged at pointerdown, where we know
  // what touched it.
  let turnOk = true;
  turnBtn?.addEventListener('pointerdown', (e) => { turnOk = input.touchMayPress(e); });
  turnBtn?.addEventListener('click', () => { if (turnOk) turnHand(); turnOk = true; });

  if (Q.get('debug') === 'frames') {
    addGizmos(scene, [frame, ...others.map((o) => o.frame)]);
    frameEditor(cfg, tune);
  }

  const overlay = Q.has('debug') ? new DebugOverlay(() => {
    const s = stats.last, f = (n) => n.toFixed(2);
    return [
      `gpu half-float ${caps.halfFloat}  paint ${(targets.bytes / 1048576).toFixed(0)} MB`,
      `pointer ${input.info.type}  alt ${input.info.altitude == null ? '-' : (input.info.altitude * 57.3).toFixed(0) + '°'}  coalesced ${input.info.coalesced}  predicted ${input.info.predicted}  hover ${input.info.hover}`,
      `polish ${state.polish.id}  load ${f(engine.load)}  speed ${f(engine.speed)}  stamps ${state.stamps}`,
      `coverage ${f(s.coverage)}  even ${f(s.evenness)}  spill ${s.spill.toFixed(3)}`,
      `colour ${f(s.colorMatch)}  finish ${f(s.finishMatch)}`,
      `shape ${nail.shape}  free ${f(nail.free)}  theme ${state.theme.id}  ${rig.up ? 'tips up' : 'tips down'}`,
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
  const perf = { frame: 0, js: 0, boot: 0 };                  // smoothed ms: frame to frame, and our own work
  const waiters = [];
  function loop(now) {
    const began = performance.now();
    perf.frame += (now - prev - perf.frame) * 0.1;
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    if (rig.update(now)) placeCamera();
    brushModel.update(now, engine.down, rig.view === 'nail' && !rig.turning);
    frame.update();
    flush();
    if (!fixed) wetAdvance(dt);
    sound.update(engine.down ? engine.speed : 0, engine.load);
    if (state.dirty && now - state.lastStats > tuning.stats.intervalMs) {
      state.dirty = false; state.lastStats = now;
      stats.refresh(renderer);
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
    info: () => ({ finger: cfg.finger, shape: nail.shape, free: nail.free, length: nail.info.length, bed: frame.bed, rect: frame.rect, caps, load: engine.load, stamps: state.stamps, frames }),
    sd, setShape, setPolish, setRequest, nextFrame,
    three: { scene, camera, renderer, key },
    setTheme: (id) => setTheme(themes.find((t) => t.id === id) || themes[0]),
    view: (view, up = rig.up) => { rig.view = view; rig.set(up); placeCamera(); return nextFrame(); },
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
    clear: () => { targets.clear(renderer); engine.dip(); wet.left = 0; state.dirty = true; return nextFrame(); },
    dip: () => engine.dip(),
    tapBottle: dipBrush,
    /** Let wet polish level and dry for `seconds` of game time, without waiting. */
    advance: (seconds) => { flush(); for (let n = Math.round(seconds * WET_HZ); n > 0 && wet.left > 0; n--) { wetTick(); wet.left -= 1 / WET_HZ; } return nextFrame(); },
    wetLeft: () => wet.left,
    setBrush: (radius) => { engine.radius = radius ?? tuning.brush.radius; },
    area: () => area(nail.info.points),
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
