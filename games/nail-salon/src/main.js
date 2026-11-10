// @ts-check
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/RGBELoader.js';
import { gpuCaps } from './engine/gpu.js';
import { NailFrame } from './hand/frame.js';
import { loadHand } from './hand/model.js';
import { outline, sdPolygon, area, SHAPES } from './hand/outline.js';
import { OutlineSdf } from './hand/sdf.js';
import { SkinHeight, makePlateZ, buildPlate } from './hand/plate.js';
import { makeFingerUniforms, makeNailMaterial, makeSkinMaterial } from './hand/materials.js';
import { PaintTargets } from './paint/targets.js';
import { StampRenderer } from './paint/stamps.js';
import { StrokeEngine } from './paint/stroke.js';
import { NailStats } from './paint/stats.js';
import { Leveler, WET_HZ } from './paint/leveling.js';
import { BrushSound } from './audio/brush.js';
import { PointerInput } from './input/pointer.js';
import { DebugOverlay } from './debug/overlay.js';

const Q = new URLSearchParams(location.search);
const json = (name) => fetch(`./data/${name}.json`).then((r) => { if (!r.ok) throw new Error(`data/${name}.json ${r.status}`); return r.json(); });

async function boot() {
  const [tuning, handData, cameraData, themes, catalog] = await Promise.all(['tuning', 'hand', 'camera', 'themes', 'catalog'].map(json));
  const handGeo = await loadHand(`./${handData.file}`);
  const fixed = Q.has('scene');                       // fixed test scene: nothing drifts
  const state = {
    scene: Q.get('scene') || 'nail', flip: Q.get('flip') === '1',
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
  uniforms.uProcSkin.value = 0;
  const skinMesh = new THREE.Mesh(handGeo, makeSkinMaterial(uniforms));
  scene.add(skinMesh);
  scene.updateMatrixWorld(true);
  frame.update();
  const skin = new SkinHeight(frame, [skinMesh]);
  const skinMask = skin.maskTexture();

  const table = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  table.position.z = -0.002;
  scene.add(table);

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
    o.mesh.geometry = buildPlate(info, makePlateZ(o.frame, info.points, o.skin, fold, o.cfg), fold, o.frame.bed);
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
    /** @type {THREE.MeshStandardMaterial} */ (table.material).color.set(theme.table);
  }

  // ---- camera ------------------------------------------------------------------------------
  const v = new THREE.Vector3(), up = new THREE.Vector3(), tgt = new THREE.Vector3();
  function placeCamera() {
    const m = frame.group.matrixWorld, sign = state.flip ? 1 : -1;       // default: fingertips down (R11)
    if (state.scene === 'hand') {
      // The whole hand, seen from over the fingertips (or over the wrist when flipped).
      const h = cameraData.hand, p = h.pitch * Math.PI / 180, yaw = h.yaw * Math.PI / 180;
      tgt.set(h.target[0], h.target[1], h.target[2]);
      v.set(Math.cos(p) * Math.sin(yaw), -sign * Math.cos(p) * Math.cos(yaw), Math.sin(p)).multiplyScalar(h.distance).add(tgt);
      camera.position.copy(v); camera.up.set(0, 0, 1); camera.lookAt(tgt);
      key.position.set(-0.3, 0.6, 0.4).add(camera.position); rimL.position.set(-0.6, 0.2, -0.15); rimR.position.set(0.6, 0.2, -0.15);
      camera.updateMatrixWorld(true);
      return;
    } else {
      tgt.set(0, nail.info.length * 0.5, 0);
      v.set(0, tgt.y, cameraData.nail.distance);
      up.set(0, sign, 0);
    }
    camera.position.copy(v).applyMatrix4(m);
    camera.up.copy(up).transformDirection(m);
    camera.lookAt(tgt.applyMatrix4(m));
    key.position.set(-0.3, 0.6, 0.4).add(camera.position); rimL.position.set(-0.6, 0.2, -0.15); rimR.position.set(0.6, 0.2, -0.15);
    camera.updateMatrixWorld(true);
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

  const input = new PointerInput(canvas, { toPaint: clientToPaint, engine, palmSeconds: tuning.input.palmSeconds });
  // Sound is off unless asked for (?sound=1): Clay found the synthesized brush bad and optional.
  if (Q.get('sound') === '1') canvas.addEventListener('pointerdown', () => sound.wake());

  // ---- start -------------------------------------------------------------------------------
  setShape(SHAPES.includes(state.shape) ? state.shape : 'round', Number.isFinite(state.free) ? state.free : cfg.naturalFree);
  setPolish(Q.get('polish') || 'cream-red');
  setRequest(Q.get('polish') || 'cream-red');
  await setTheme(state.theme);
  resize(); placeCamera();

  const overlay = Q.has('debug') ? new DebugOverlay(() => {
    const s = stats.last, f = (n) => n.toFixed(2);
    return [
      `gpu half-float ${caps.halfFloat}  paint ${(targets.bytes / 1048576).toFixed(0)} MB`,
      `pointer ${input.info.type}  alt ${input.info.altitude == null ? '-' : (input.info.altitude * 57.3).toFixed(0) + '°'}  coalesced ${input.info.coalesced}  hover ${input.info.hover}`,
      `polish ${state.polish.id}  load ${f(engine.load)}  speed ${f(engine.speed)}  stamps ${state.stamps}`,
      `coverage ${f(s.coverage)}  even ${f(s.evenness)}  spill ${s.spill.toFixed(3)}`,
      `colour ${f(s.colorMatch)}  finish ${f(s.finishMatch)}`,
      `shape ${nail.shape}  free ${f(nail.free)}  theme ${state.theme.id}  ${state.flip ? 'tips up' : 'tips down'}`,
    ];
  }) : null;

  let frames = 0, prev = performance.now();
  const waiters = [];
  function loop(now) {
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    frame.update();
    flush();
    if (!fixed) wetAdvance(dt);
    sound.update(engine.down ? engine.speed : 0, engine.load);
    if (state.dirty && now - state.lastStats > tuning.stats.intervalMs) {
      state.dirty = false; state.lastStats = now;
      stats.refresh(renderer);
    }
    if (!fixed) scene.environmentRotation.y = state.theme.lighting.envRot + Math.sin(now / 3800) * 0.35;
    renderer.render(scene, camera);
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
    view: (scene, flip = state.flip) => { state.scene = scene; state.flip = flip; placeCamera(); return nextFrame(); },
    clear: () => { targets.clear(renderer); engine.dip(); wet.left = 0; state.dirty = true; return nextFrame(); },
    dip: () => engine.dip(),
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
