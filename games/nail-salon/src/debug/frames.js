// @ts-check
import * as THREE from 'three';

// The nail-frame editor (PLAN §3.3), at ?debug=frames. Each slider is an offset from the frame in
// data/hand.json; the offsets live in the URL (?tune=…) and the page reloads with them, because a
// frame change rebuilds the skin height map, the plate and the paint frame. "Copy JSON" gives the
// finger's new entry for hand.json. Rerun tools/build-hand.mjs afterwards (it trims the sculpt's
// own free edges using these frames).

const SLIDERS = [
  ['dx', 'origin x', 'mm', 1.5], ['dy', 'origin y', 'mm', 1.5], ['dz', 'origin z', 'mm', 1.5],
  ['yaw', 'turn', '°', 12], ['pitch', 'tip up/down', '°', 12], ['roll', 'roll', '°', 12],
  ['dw', 'width', 'mm', 1.5], ['dl', 'bed length', 'mm', 2],
];
const RAD = Math.PI / 180;
const round = (v, n = 5) => Number(v.toFixed(n));

/** Read ?tune=… Each finger number maps to its slider offsets. */
export function parseTune(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/** Apply slider offsets to one finger's entry, returning a new entry. */
export function tuned(cfg, t) {
  if (!t) return cfg;
  const n = new THREE.Vector3(...cfg.normal), tip = new THREE.Vector3(...cfg.tipDir).normalize();
  n.addScaledVector(tip, -n.dot(tip)).normalize();
  const side = new THREE.Vector3().crossVectors(tip, n);
  tip.applyAxisAngle(n, (t.yaw || 0) * RAD); side.applyAxisAngle(n, (t.yaw || 0) * RAD);
  tip.applyAxisAngle(side, (t.pitch || 0) * RAD); n.applyAxisAngle(side, (t.pitch || 0) * RAD);
  n.applyAxisAngle(tip, (t.roll || 0) * RAD);
  return {
    ...cfg,
    origin: [round(cfg.origin[0] + (t.dx || 0) / 1000), round(cfg.origin[1] + (t.dy || 0) / 1000), round(cfg.origin[2] + (t.dz || 0) / 1000)],
    tipDir: tip.toArray().map((v) => round(v, 4)), normal: n.toArray().map((v) => round(v, 4)),
    width: round(cfg.width + (t.dw || 0) / 1000), bedLength: round(cfg.bedLength + (t.dl || 0) / 1000),
  };
}

/** Three arrows on every nail: side (red), tip (green), out of the nail (blue). */
export function addGizmos(scene, frames) {
  for (const f of frames) {
    const L = f.width * 1.4, o = new THREE.Vector3(...f.cfg.origin), m = f.group.matrix.elements;
    [[m[0], m[1], m[2], 0xff3344], [m[4], m[5], m[6], 0x22cc66], [m[8], m[9], m[10], 0x3388ff]].forEach(([x, y, z, c]) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(x, y, z).normalize(), o, L, c, L * 0.25, L * 0.12);
      a.traverse((p) => { /** @type {any} */ (p).material && (/** @type {any} */ (p).material.depthTest = false); p.renderOrder = 5; });
      scene.add(a);
    });
  }
}

/** The slider panel for the active finger. */
export function frameEditor(cfg, tune) {
  const id = String(cfg.finger), t = tune[id] || {}, el = document.createElement('div');
  el.id = 'frames';
  el.innerHTML = `<b>Finger ${id}</b>` + SLIDERS.map(([k, label, unit, max]) => `
    <label>${label} <output>${t[k] || 0} ${unit}</output>
      <input type="range" data-k="${k}" min="${-max}" max="${max}" step="${max / 30}" value="${t[k] || 0}"></label>`).join('')
    + '<button type="button" data-copy>Copy JSON</button> <button type="button" data-reset>Reset</button>';
  document.body.appendChild(el);
  const reload = () => {
    const u = new URLSearchParams(location.search);
    if (Object.keys(tune).length) u.set('tune', JSON.stringify(tune)); else u.delete('tune');
    location.search = u.toString();
  };
  el.addEventListener('input', (e) => {
    const r = /** @type {HTMLInputElement} */ (e.target), S = SLIDERS.find((s) => s[0] === r.dataset.k);
    /** @type {HTMLElement} */ (r.previousElementSibling).textContent = `${Number(r.value).toFixed(2)} ${S?.[2]}`;
  });
  el.addEventListener('change', (e) => {
    const r = /** @type {HTMLInputElement} */ (e.target);
    if (!r.dataset.k) return;
    tune[id] = { ...(tune[id] || {}), [r.dataset.k]: Number(r.value) };
    reload();
  });
  el.querySelector('[data-copy]')?.addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(cfg)).catch(() => {}));
  el.querySelector('[data-reset]')?.addEventListener('click', () => { delete tune[id]; reload(); });
  return el;
}
