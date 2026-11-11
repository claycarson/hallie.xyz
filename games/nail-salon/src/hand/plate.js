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
    this.zs = this.blurred(4);
  }

  /** Gaussian-blurred copy of the heights (sigma in cells), from cells with skin only. */
  blurred(sigma) {
    const { nx, ny, z, valid } = this, R = Math.ceil(sigma * 2.5), k = [];
    for (let i = -R; i <= R; i++) k.push(Math.exp(-i * i / (2 * sigma * sigma)));
    const pass = (src, wsrc, dx, dy) => {
      const out = new Float32Array(nx * ny), wout = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let sum = 0, w = 0;
        for (let t = -R; t <= R; t++) {
          const ii = i + t * dx, jj = j + t * dy;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const q = jj * nx + ii, g = k[t + R] * wsrc[q];
          sum += src[q] * g; w += g;
        }
        out[j * nx + i] = sum; wout[j * nx + i] = w;
      }
      return [out, wout];
    };
    // Take the highest skin within two cells first, so the smooth surface lies on top of the
    // model's nail rather than cutting through it where the nail curves hard.
    const w0 = Float32Array.from(valid), z0 = new Float32Array(nx * ny), D = 3;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let m = -Infinity;
      for (let b = Math.max(0, j - D); b <= Math.min(ny - 1, j + D); b++) for (let a = Math.max(0, i - D); a <= Math.min(nx - 1, i + D); a++) if (valid[b * nx + a] && z[b * nx + a] > m) m = z[b * nx + a];
      z0[j * nx + i] = m > -Infinity ? m : z[j * nx + i];
    }
    let [a, wa] = pass(z0, w0, 1, 0);
    for (let q = 0; q < a.length; q++) { a[q] = wa[q] > 1e-6 ? a[q] / wa[q] : z[q]; }
    const wv = wa.map((v) => (v > 1e-6 ? 1 : 0));
    let [b, wb] = pass(a, wv, 0, 1);
    for (let q = 0; q < b.length; q++) b[q] = wb[q] > 1e-6 ? b[q] / wb[q] : z[q];
    return b;
  }

  /** Height at paint coords (x, y), in nail widths. Catmull-Rom, so slopes are continuous
   *  (bilinear made a mirror finish show the grid). */
  at(x, y) { return this.sample(this.z, x, y); }

  /** The same surface with the model's small bumps and facets smoothed away: what the nail
   *  plate follows, so a glossy finish reflects cleanly. */
  smooth(x, y) { return this.sample(this.zs, x, y); }

  sample(z, x, y) {
    const r = this.rect, nx = this.nx, ny = this.ny;
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
  const BACK = 0.16, RUN = 0.25, SIDE = 0.36;
  const zFree = (x, y) => {
    const b = smile(x) - BACK;
    // Tangent from the middle of the nail. Across the nail the free edge keeps the bed's curve
    // out to SIDE and runs straight from there: the finger's side walls are too steep to follow.
    const xs = Math.max(-SIDE, Math.min(SIDE, x)), z0 = skin.smooth(xs, b), slope = (z0 - skin.smooth(xs, b - RUN)) / RUN, d = y - b;
    const sgn = x < 0 ? -1 : 1, lat = (skin.smooth(sgn * SIDE, b) - skin.smooth(sgn * (SIDE - 0.08), b)) / 0.08;
    const ext = z0 + lat * Math.abs(x - xs) + slope * d - (d > 0 ? cfg.arch * d * d : 0);
    if (d >= 0) return ext + fold.lift;
    const w = smoothstep(-0.3, 0, d);                      // ease from the bed onto the tangent
    return skin.smooth(x, y) * (1 - w) + ext * w + fold.lift;
  };
  const z = (x, y) => {
    const d = Math.max(0, -sdPolygon(outlinePts, x, y));
    const e = smoothstep(0, fold.sinkBand, d);
    const crown = fold.crown * cfg.dome * (1 - Math.min(1, 4 * x * x)) * e;
    const top = zFree(x, y) + crown;
    // At the outline the edge tucks `sink` under the real skin wherever the skin is up beside
    // the plate (the folds), and stays up where the finger falls away. The switch between the
    // two is steep, so the line where the fold lets go follows a smooth contour of the skin:
    // a gentle switch crossed the skin at a shallow angle and left a jagged notch.
    const sk = skin.at(x, y), near = smoothstep(top - fold.lift - 0.09, top - fold.lift - 0.04, sk);
    const under = Math.max(top - fold.lift - 3 * fold.sink, Math.min(top - fold.lift - fold.sink, sk - fold.sink));
    const along = 1 - smoothstep(smile(x) - 0.12, smile(x) + 0.02, y);       // never past the bed
    return top + (under - top) * (1 - e) * near * along;
  };
  /** The plate's own curve, before its edges dip under the folds. */
  z.shell = (x, y) => zFree(x, y) + fold.crown * cfg.dome * (1 - Math.min(1, 4 * x * x));
  return z;
}

// Dense enough that a mirror finish shows no facets from interpolated normals.
const RINGS = [0, 0.02, 0.045, 0.08, 0.12, 0.16, 0.2];
for (let t = 0.25; t < 1.001; t += 0.05) RINGS.push(Math.min(1, t));

/**
 * NailPlate geometry in paint coords: rings from the outline in to a spine, so the mesh edge
 * is the outline exactly. Normals are analytic (from the height function), never averaged.
 * Attribute `paintXY` is the paint-frame position the materials sample with; `skirt` marks the
 * free edge's thickness.
 */
export function buildPlate(outlineInfo, plateZ, fold, bed) {
  const pts = outlineInfo.points, L = outlineInfo.length, R = RINGS.length;
  const ya = Math.min(0.42, L / 2), yb = Math.max(L - 0.42, L / 2);
  const nv = N_POINTS * R, pos = [], nor = [], pxy = [], idx = [], skirt = [];
  const E = 0.004;
  for (let r = 0; r < R; r++) for (let i = 0; i < N_POINTS; i++) {
    const px = pts[2 * i], py = pts[2 * i + 1], t = RINGS[r];
    const x = px * (1 - t), y = py + (Math.min(yb, Math.max(ya, py)) - py) * t;
    const z = plateZ(x, y);
    const gx = (plateZ(x + E, y) - plateZ(x - E, y)) / (2 * E), gy = (plateZ(x, y + E) - plateZ(x, y - E)) / (2 * E);
    const inv = 1 / Math.hypot(gx, gy, 1);
    pos.push(x, y, z); nor.push(-gx * inv, -gy * inv, inv); pxy.push(x, y); skirt.push(0);
  }
  for (let r = 0; r < R - 1; r++) for (let i = 0; i < N_POINTS; i++) {
    const a = r * N_POINTS + i, b = r * N_POINTS + (i + 1) % N_POINTS, c = a + N_POINTS, d = b + N_POINTS;
    idx.push(a, b, d, a, d, c);
  }
  // Free edge thickness: a skirt hanging from the outline wherever it is past the bed.
  const smileY = (x) => bed - fold.smile * 4 * x * x;
  // Normals are smooth along the edge (averaged from both neighbouring segments) and lean a
  // little up toward the top face: one flat normal per quad made every other quad catch the
  // light, a row of white specks along the tip.
  const edgeN = (i) => {
    const a = (i + N_POINTS - 1) % N_POINTS, b = (i + 1) % N_POINTS;
    const ex = pts[2 * b] - pts[2 * a], ey = pts[2 * b + 1] - pts[2 * a + 1], il = 1 / Math.hypot(ex, ey, 0.35 * Math.hypot(ex, ey));
    return [ey * il, -ex * il, 0.35 * Math.hypot(ex, ey) * il];
  };
  let base = nv;
  for (let i = 0; i < N_POINTS; i++) {
    const j = (i + 1) % N_POINTS;
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if (yi < smileY(xi) || yj < smileY(xj)) continue;
    const zi = plateZ(xi, yi), zj = plateZ(xj, yj), ni = edgeN(i), nj = edgeN(j);
    pos.push(xi, yi, zi, xj, yj, zj, xj, yj, zj - fold.edgeThickness, xi, yi, zi - fold.edgeThickness);
    nor.push(...ni, ...nj, ...nj, ...ni);
    skirt.push(1, 1, 1, 1);
    pxy.push(xi, yi, xj, yj, xj, yj, xi, yi);
    idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    base += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('paintXY', new THREE.Float32BufferAttribute(pxy, 2));
  geo.setAttribute('skirt', new THREE.Float32BufferAttribute(skirt, 1));   // 1 on the free edge's thickness
  geo.setIndex(idx);
  return geo;
}

// Powers of x and y in the smooth shell fitted over the nail.
const SHELL_X = 5, SHELL_Y = 4;

/**
 * A smooth shell z(x, y), a low-order polynomial fitted over the nail's outline. A real plate is
 * one clean curve: following the sculpt instead bent every highlight round its small bumps.
 * @returns {{ dx: (x: number, y: number) => number, dy: (x: number, y: number) => number }}
 */
export function fitShell(shell, pts, length) {
  const inside = [], n = SHELL_X * SHELL_Y, step = 0.02;
  for (let y = 0; y <= length; y += step) for (let x = -0.6; x <= 0.6; x += step) if (sdPolygon(pts, x, y) < -0.03) inside.push(x, y, shell(x, y));
  const A = Array.from({ length: n }, () => new Float64Array(n + 1)), row = new Float64Array(n);
  const terms = (x, u) => { let k = 0, px = 1; for (let a = 0; a < SHELL_X; a++, px *= x) { let py = 1; for (let b = 0; b < SHELL_Y; b++, py *= u) row[k++] = px * py; } };
  for (let i = 0; i < inside.length; i += 3) {
    terms(inside[i], inside[i + 1] / length);
    for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += row[r] * row[c]; A[r][n] += row[r] * inside[i + 2]; }
  }
  for (let r = 0; r < n; r++) A[r][r] += 1e-9;                  // keeps the solve steady
  for (let c = 0; c < n; c++) {                                 // Gaussian elimination with pivoting
    let best = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[best][c])) best = r;
    [A[c], A[best]] = [A[best], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const w = A.map((r, i) => r[n] / r[i]);
  const grad = (x, y, alongY) => {
    const u = y / length; let sum = 0, k = 0;
    for (let a = 0; a < SHELL_X; a++) for (let b = 0; b < SHELL_Y; b++, k++) {
      const da = alongY ? a : Math.max(0, a - 1), db = alongY ? Math.max(0, b - 1) : b, m = alongY ? b / length : a;
      if (m) sum += w[k] * m * x ** da * u ** db;
    }
    return sum;
  };
  return { dx: (x, y) => grad(x, y, false), dy: (x, y) => grad(x, y, true) };
}

/**
 * The plate's normals as a texture over the paint frame (paint-space xyz, half-float), read per
 * pixel by the nail material. They come from the fitted shell, not the sunk mesh, so the plate's
 * edge doesn't catch the light as a pale line where it dips under the skin.
 */
export function buildPlateNormals(plateZ, pts, length, rect, old, nx = 192, ny = 320) {
  const data = new Uint16Array(nx * ny * 4), h = THREE.DataUtils.toHalfFloat, S = fitShell(plateZ.shell, pts, length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.max(-0.62, Math.min(0.62, rect.x0 + rect.w * (i + 0.5) / nx)), y = Math.max(0, Math.min(length, rect.y0 + rect.h * (j + 0.5) / ny));
    const gx = S.dx(x, y), gy = S.dy(x, y);
    const inv = 1 / Math.hypot(gx, gy, 1), k = (j * nx + i) * 4;
    data[k] = h(-gx * inv); data[k + 1] = h(-gy * inv); data[k + 2] = h(inv); data[k + 3] = h(1);
  }
  old?.dispose();
  const t = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
