// @ts-check
import * as THREE from 'three';

// What the hand rests on: a soft cushion that gives where the hand presses into it, and the
// shadows the hand and the cushion leave. All of it is shaped once at load from the hand's
// underside height map (assets/hand/under.bin, written by tools/build-hand.mjs), so nothing
// here costs anything per frame.

/** Load under.bin: how high the hand hangs over each millimetre of table (Infinity = no hand). */
export async function loadUnderside(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const buf = await res.arrayBuffer(), dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'NSU1') throw new Error(`${url}: not an underside file`);
  const W = dv.getUint32(4, true), H = dv.getUint32(8, true), q = new Uint16Array(buf, 24, W * H), z = new Float32Array(W * H);
  for (let k = 0; k < z.length; k++) z[k] = q[k] === 65535 ? Infinity : q[k] / 65534 * 0.08;
  return { W, H, x0: dv.getFloat32(12, true), y0: dv.getFloat32(16, true), cell: dv.getFloat32(20, true), z };
}

/** Separable Gaussian blur of a W×H field, sigma in cells. */
function blur(src, W, H, sigma) {
  const R = Math.ceil(sigma * 2.5), k = new Float32Array(R + 1); let sum = 0;
  for (let i = 0; i <= R; i++) { k[i] = Math.exp(-0.5 * (i / sigma) ** 2); sum += i ? 2 * k[i] : k[i]; }
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -R; i <= R; i++) a += src[y * W + Math.min(W - 1, Math.max(0, x + i))] * k[Math.abs(i)]; tmp[y * W + x] = a / sum; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0; for (let i = -R; i <= R; i++) a += tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x] * k[Math.abs(i)]; out[y * W + x] = a / sum; }
  return out;
}

/**
 * Build the cushion mesh and the table's shadow.
 * cfg (data/hand.json "rest"): centre [x, y], half [x, y], radius (corners), height, roll
 * (how far in from the edge the top keeps rising), all in metres.
 * @returns {{ cushion: THREE.Mesh, shadow: THREE.Mesh }}
 */
export function buildRest(under, cfg) {
  const { W, H, x0, y0, cell, z } = under;
  // Signed distance to the cushion's outline (a rounded rectangle), negative inside.
  const sd = (x, y) => {
    const qx = Math.abs(x - cfg.centre[0]) - cfg.half[0] + cfg.radius, qy = Math.abs(y - cfg.centre[1]) - cfg.half[1] + cfg.radius;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cfg.radius;
  };
  const pillow = (x, y) => { const t = Math.min(1, Math.max(0, -sd(x, y) / cfg.roll)); return cfg.height * Math.sqrt(1 - (1 - t) * (1 - t)); };

  // The hand's underside, draped: the lowest of (height + a bowl around each point), so the
  // cloth eases down toward where the hand presses instead of being stamped by it.
  const R = 14, K = 70 / (1 / cell) ** 2, draped = new Float32Array(W * H).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const h = z[y * W + x]; if (h === Infinity) continue;
    for (let j = Math.max(0, y - R); j <= Math.min(H - 1, y + R); j++) for (let i = Math.max(0, x - R); i <= Math.min(W - 1, x + R); i++) {
      const v = h + K * ((i - x) ** 2 + (j - y) ** 2), k = j * W + i;
      if (v < draped[k]) draped[k] = v;
    }
  }
  const cellAt = (f, x, y) => f[Math.min(H - 1, Math.max(0, Math.round((y - y0) / cell - 0.5))) * W + Math.min(W - 1, Math.max(0, Math.round((x - x0) / cell - 0.5)))];
  const top = (x, y) => Math.max(0, Math.min(pillow(x, y), cellAt(draped, x, y) - 0.0004));

  // Closeness of the hand to whatever is under it (cushion or table), blurred: the contact shade.
  const near = new Float32Array(W * H), foot = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x0 + (x + 0.5) * cell, wy = y0 + (y + 0.5) * cell, h = z[y * W + x];
    near[y * W + x] = h === Infinity ? 0 : Math.exp(-Math.max(0, h - top(wx, wy)) / 0.006);
    foot[y * W + x] = sd(wx, wy) < 0 ? 1 : 0;
  }
  const contact = blur(near, W, H, 2.5), cast = blur(near.map((v, k) => (z[k] === Infinity ? 0 : 1)), W, H, 7), halo = blur(foot, W, H, 9);

  // Cushion: a grid over its box; points outside the outline are pulled onto it at table height.
  const step = 0.002, nx = Math.ceil(2 * cfg.half[0] / step) + 3, ny = Math.ceil(2 * cfg.half[1] / step) + 3;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let x = cfg.centre[0] - cfg.half[0] + (i - 1) * step, y = cfg.centre[1] - cfg.half[1] + (j - 1) * step;
    const d = sd(x, y);
    if (d > 0) {
      const e = 1e-4, gx = sd(x + e, y) - sd(x - e, y), gy = sd(x, y + e) - sd(x, y - e), g = Math.hypot(gx, gy) || 1;
      x -= gx / g * d; y -= gy / g * d;
    }
    const k = (j * nx + i) * 3, shade = 1 - 0.5 * cellAt(contact, x, y) - 0.18 * cellAt(cast, x, y);
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = top(x, y);
    col[k] = col[k + 1] = col[k + 2] = shade;
    if (i && j) { const a = (j - 1) * nx + i - 1; idx.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const cushion = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.95, sheen: 1, sheenRoughness: 0.6 }));

  // Table shadow: a soft halo round the cushion plus the hand's own shade where it reaches past it.
  const px = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const a = Math.min(1, 0.42 * smooth(halo[k]) + 0.5 * contact[k] + 0.22 * cast[k]);
    px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = px[k * 4 + 3] = Math.round(255 * a);
  }
  const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * cell, H * cell), new THREE.MeshBasicMaterial({ color: 0x2a1410, alphaMap: tex, transparent: true, depthWrite: false }));
  shadow.position.set(x0 + W * cell / 2, y0 + H * cell / 2, 0);
  return { cushion, shadow };
}
const smooth = (t) => t * t * (3 - 2 * t);
