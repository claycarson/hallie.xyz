// @ts-check
import * as THREE from 'three';
import { N_POINTS, sdPolygon } from './outline.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Skin height under the paint frame, sampled once by raycasting the skin mesh straight down
 * the nail normal. Works on any hand model; the plate conforms to it so its edges can sink
 * under the folds by a known amount (PLAN R5).
 */
export class SkinHeight {
  constructor(frame, skinMeshes, nx = 65, ny = 97) {
    this.rect = frame.rect; this.nx = nx; this.ny = ny;
    this.z = new Float32Array(nx * ny);
    this.valid = new Uint8Array(nx * ny);
    frame.update();
    const ray = new THREE.Raycaster(), o = new THREE.Vector3(), d = new THREE.Vector3(), hits = [];
    const m = frame.group.matrixWorld, START = 1.5;
    d.set(0, 0, -1).transformDirection(m);
    const scale = new THREE.Vector3().setFromMatrixColumn(m, 2).length();   // world metres per nail width
    ray.far = scale * 4;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      o.set(this.rect.x0 + this.rect.w * i / (nx - 1), this.rect.y0 + this.rect.h * j / (ny - 1), START).applyMatrix4(m);
      ray.set(o, d); hits.length = 0;
      ray.intersectObjects(skinMeshes, false, hits);
      const k = j * nx + i;
      if (hits.length) { this.z[k] = START - hits[0].distance / scale; this.valid[k] = 1; }
    }
    // Fill misses (air past the fingertip) from the row before, so sampling stays finite.
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!this.valid[k]) this.z[k] = Math.min(this.z[k - nx], -0.6);
    }
    for (let i = 0; i < nx; i++) if (!this.valid[i]) this.z[i] = -0.6;
  }

  /** Bilinear height at paint coords (x, y), in nail widths. */
  at(x, y) {
    const r = this.rect, nx = this.nx, ny = this.ny;
    const fx = Math.min(nx - 1.001, Math.max(0, (x - r.x0) / r.w * (nx - 1)));
    const fy = Math.min(ny - 1.001, Math.max(0, (y - r.y0) / r.h * (ny - 1)));
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * nx + i, z = this.z;
    return (z[k] * (1 - u) + z[k + 1] * u) * (1 - v) + (z[k + nx] * (1 - u) + z[k + nx + 1] * u) * v;
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
  const zFree = (x, y) => {
    const b = smile(x);
    if (y <= b) return skin.at(x, y) + fold.lift;
    const z0 = skin.at(x, b), slope = (z0 - skin.at(x, b - 0.12)) / 0.12, d = y - b;
    return z0 + fold.lift + slope * d - cfg.arch * d * d;
  };
  return (x, y) => {
    const d = Math.max(0, -sdPolygon(outlinePts, x, y));
    const e = smoothstep(0, fold.sinkBand, d);
    const foldW = 1 - smoothstep(smile(x) - 0.10, smile(x), y);
    const crown = fold.crown * cfg.dome * (1 - Math.min(1, 4 * x * x)) * e;
    return zFree(x, y) + crown - (fold.lift + fold.sink) * (1 - e) * foldW;
  };
}

const RINGS = [0, 0.02, 0.045, 0.08, 0.14, 0.24, 0.4, 0.6, 0.8, 1];

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
