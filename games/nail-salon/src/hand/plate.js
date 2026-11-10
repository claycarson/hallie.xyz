// @ts-check
import * as THREE from 'three';
import { N_POINTS, sdPolygon } from './outline.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Skin height under the paint frame: the skin mesh drawn into a small height grid, looking
 * straight down the nail normal (a software z-buffer keeping the highest surface). Works on any
 * hand model; the plate conforms to it so its edges can sink under the folds by a known
 * amount (PLAN R5).
 */
export class SkinHeight {
  constructor(frame, skinMeshes, nx = 129, ny = 193) {
    this.rect = frame.rect; this.nx = nx; this.ny = ny;
    this.z = new Float32Array(nx * ny).fill(-Infinity);
    this.valid = new Uint8Array(nx * ny);
    frame.update();
    const r = this.rect, TOP = 1.5, BOTTOM = -2.5, z = this.z;
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    for (const mesh of skinMeshes) {
      m.multiplyMatrices(frame.worldToPaint, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex();
      const g = new Float32Array(pos.count * 3);                 // grid x, grid y, height
      for (let v = 0; v < pos.count; v++) {
        p.fromBufferAttribute(pos, v).applyMatrix4(m);
        g[v * 3] = (p.x - r.x0) / r.w * (nx - 1); g[v * 3 + 1] = (p.y - r.y0) / r.h * (ny - 1); g[v * 3 + 2] = p.z;
      }
      const nt = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < nt; t++) {
        const a = (index ? index.getX(t * 3) : t * 3) * 3, b = (index ? index.getX(t * 3 + 1) : t * 3 + 1) * 3, c = (index ? index.getX(t * 3 + 2) : t * 3 + 2) * 3;
        const ax = g[a], ay = g[a + 1], bx = g[b], by = g[b + 1], cx = g[c], cy = g[c + 1];
        const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx)));
        if (i0 > i1) continue;
        const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy)));
        if (j0 > j1) continue;
        const az = g[a + 2], bz = g[b + 2], cz = g[c + 2];
        if (Math.min(az, bz, cz) > TOP || Math.max(az, bz, cz) < BOTTOM) continue;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-12) continue;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const u = ((by - cy) * (i - cx) + (cx - bx) * (j - cy)) / den, w = ((cy - ay) * (i - cx) + (ax - cx) * (j - cy)) / den, q = 1 - u - w;
          if (u < -1e-6 || w < -1e-6 || q < -1e-6) continue;
          const h = u * az + w * bz + q * cz, k = j * nx + i;
          if (h <= TOP && h > z[k]) { z[k] = h; this.valid[k] = 1; }
        }
      }
    }
    for (let k = 0; k < z.length; k++) if (!this.valid[k]) z[k] = 0;
    // Fill misses (air past the fingertip) from the row before, so sampling stays finite.
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!this.valid[k]) this.z[k] = Math.min(this.z[k - nx], -0.6);
    }
    for (let i = 0; i < nx; i++) if (!this.valid[i]) this.z[i] = -0.6;
  }

  /** Height at paint coords (x, y), in nail widths. Catmull-Rom, so slopes are continuous
   *  (bilinear made a mirror finish show the grid). */
  at(x, y) {
    const r = this.rect, nx = this.nx, ny = this.ny, z = this.z;
    const fx = Math.min(nx - 1, Math.max(0, (x - r.x0) / r.w * (nx - 1)));
    const fy = Math.min(ny - 1, Math.max(0, (y - r.y0) / r.h * (ny - 1)));
    const i = Math.min(nx - 2, fx | 0), j = Math.min(ny - 2, fy | 0), u = fx - i, v = fy - j;
    const u2 = u * u, u3 = u2 * u, v2 = v * v, v3 = v2 * v;
    const wu0 = -0.5 * u3 + u2 - 0.5 * u, wu1 = 1.5 * u3 - 2.5 * u2 + 1, wu2 = -1.5 * u3 + 2 * u2 + 0.5 * u, wu3 = 0.5 * u3 - 0.5 * u2;
    const wv0 = -0.5 * v3 + v2 - 0.5 * v, wv1 = 1.5 * v3 - 2.5 * v2 + 1, wv2 = -1.5 * v3 + 2 * v2 + 0.5 * v, wv3 = 0.5 * v3 - 0.5 * v2;
    const i0 = i > 0 ? i - 1 : 0, i3 = i < nx - 2 ? i + 2 : nx - 1;
    let sum = 0;
    for (let m = 0; m < 4; m++) {
      const jj = Math.min(ny - 1, Math.max(0, j - 1 + m)) * nx;
      const row = z[jj + i0] * wu0 + z[jj + i] * wu1 + z[jj + i + 1] * wu2 + z[jj + i3] * wu3;
      sum += row * (m === 0 ? wv0 : m === 1 ? wv1 : m === 2 ? wv2 : wv3);
    }
    return sum;
  }

  /** 8-bit mask texture: 1 where there is skin a brush could touch, 0 in the air or far below. */
  maskTexture() {
    const data = new Uint8Array(this.nx * this.ny);
    for (let k = 0; k < data.length; k++) data[k] = this.valid[k] ? 255 * clamp01((this.z[k] + 0.55) / 0.15) : 0;
    const t = new THREE.DataTexture(data, this.nx, this.ny, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }
}

/**
 * Height of the nail plate over the paint frame.
 * Over the bed it rides `lift` above the skin; along the cuticle and the side walls it dips
 * `sink` below the skin within `sinkBand` of the outline, so the depth test draws the fold
 * over the plate's edge. Past the bed end it leaves the finger along its own tangent.
 */
export function makePlateZ(frame, outlinePts, skin, fold, cfg) {
  const bed = frame.bed;
  const smile = (x) => bed - fold.smile * 4 * x * x;
  // The plate leaves the finger a little before the bed ends and runs on along its own tangent,
  // taken from well back on the bed: the skin right at the bed end is the fingertip dropping away.
  const BACK = 0.12, RUN = 0.25, SIDE = 0.34;
  const zFree = (x, y) => {
    const b = smile(x) - BACK;
    if (y <= b) return skin.at(x, y) + fold.lift;
    // Tangent from the middle of the nail; the side walls are too steep to extend from.
    const xs = Math.max(-SIDE, Math.min(SIDE, x)), z0 = skin.at(xs, b), slope = (z0 - skin.at(xs, b - RUN)) / RUN, d = y - b;
    const side = Math.max(-0.3, skin.at(x, b) - z0);
    return z0 + side + fold.lift + slope * d - cfg.arch * d * d;
  };
  return (x, y) => {
    const d = Math.max(0, -sdPolygon(outlinePts, x, y));
    const e = smoothstep(0, fold.sinkBand, d);
    const foldW = 1 - smoothstep(smile(x) - 0.30, smile(x) - 0.12, y);   // lifted clear before it leaves the finger
    const crown = fold.crown * cfg.dome * (1 - Math.min(1, 4 * x * x)) * e;
    return zFree(x, y) + crown - (fold.lift + fold.sink) * (1 - e) * foldW;
  };
}

// Dense enough that a mirror finish shows no facets from interpolated normals.
const RINGS = [0, 0.02, 0.045, 0.08, 0.12, 0.16, 0.2];
for (let t = 0.25; t < 1.001; t += 0.05) RINGS.push(Math.min(1, t));

/**
 * NailPlate geometry in paint coords: rings from the outline in to a spine, so the mesh edge
 * is the outline exactly. Normals are analytic (from the height function), never averaged.
 * Attribute `paintXY` is the paint-frame position the materials sample with.
 */
export function buildPlate(outlineInfo, plateZ, fold, bed) {
  const pts = outlineInfo.points, L = outlineInfo.length, R = RINGS.length;
  const ya = Math.min(0.42, L / 2), yb = Math.max(L - 0.42, L / 2);
  const nv = N_POINTS * R, pos = [], nor = [], pxy = [], idx = [];
  const E = 0.004;
  for (let r = 0; r < R; r++) for (let i = 0; i < N_POINTS; i++) {
    const px = pts[2 * i], py = pts[2 * i + 1], t = RINGS[r];
    const x = px * (1 - t), y = py + (Math.min(yb, Math.max(ya, py)) - py) * t;
    const z = plateZ(x, y);
    const gx = (plateZ(x + E, y) - plateZ(x - E, y)) / (2 * E), gy = (plateZ(x, y + E) - plateZ(x, y - E)) / (2 * E);
    const inv = 1 / Math.hypot(gx, gy, 1);
    pos.push(x, y, z); nor.push(-gx * inv, -gy * inv, inv); pxy.push(x, y);
  }
  for (let r = 0; r < R - 1; r++) for (let i = 0; i < N_POINTS; i++) {
    const a = r * N_POINTS + i, b = r * N_POINTS + (i + 1) % N_POINTS, c = a + N_POINTS, d = b + N_POINTS;
    idx.push(a, b, d, a, d, c);
  }
  // Free edge thickness: a skirt hanging from the outline wherever it is past the bed.
  const smileY = (x) => bed - fold.smile * 4 * x * x;
  let base = nv;
  for (let i = 0; i < N_POINTS; i++) {
    const j = (i + 1) % N_POINTS;
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if (yi < smileY(xi) || yj < smileY(xj)) continue;
    const ex = xj - xi, ey = yj - yi, il = 1 / Math.hypot(ex, ey), nx = ey * il, ny = -ex * il;   // outward
    const zi = plateZ(xi, yi), zj = plateZ(xj, yj);
    pos.push(xi, yi, zi, xj, yj, zj, xj, yj, zj - fold.edgeThickness, xi, yi, zi - fold.edgeThickness);
    for (let k = 0; k < 4; k++) nor.push(nx, ny, 0);
    pxy.push(xi, yi, xj, yj, xj, yj, xi, yi);
    idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    base += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('paintXY', new THREE.Float32BufferAttribute(pxy, 2));
  geo.setIndex(idx);
  return geo;
}
