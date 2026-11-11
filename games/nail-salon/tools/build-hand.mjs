// Build assets/hand/hand.bin from the Sketchfab download of "Female Hand" by yuzutarou (CC BY 4.0).
//
//   node tools/build-hand.mjs <dir with scene.gltf + scene.bin> [tris=220000]
//
// The download is 674k triangles in six chunks (split at the 16-bit vertex limit), with no
// textures and no rig. This welds the chunks back together by position, simplifies with
// meshoptimizer, turns and scales the hand into the game's space (see SPACE below), and writes
// a small binary the game loads directly (src/hand/model.js). Normals are rebuilt at load.
//
// File layout (little endian): "NSH2", uint32 verts, uint32 tris, float32 min[3], float32 size[3],
// uint16 position[verts*3] (0..65535 across the box), pad to 4 bytes, uint32 index[tris*3],
// uint8 tone[verts*3].
//
// The model came with no textures, so the skin's tone is baked here per vertex (`tone`):
//   [0] creases   128 = flat, higher = a fine crease (knuckle wrinkles, palm lines, nail folds)
//   [1] bumps     128 = flat, higher = a broad bump (knuckles, fingertips), lower = a hollow
//   [2] open sky  255 = sees all the light, 0 = buried (between the fingers, under the hand)
// The first two are measured on the full sculpt, before it is simplified.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-hand.mjs <dir with scene.gltf + scene.bin> [tris]'); process.exit(1); }
const targetTris = Number(process.argv[3] || 220000);
const OUT = new URL('../assets/hand/hand.bin', import.meta.url).pathname;

// SPACE: metres, a left hand lying palm down on the table. +x toward the thumb side, +y toward
// the fingertips, +z up out of the back of the hand. Origin under the middle of the palm at
// table height (the lowest point of the mesh is moved to z = 0). `MODEL_TO_GAME` is a row-major 3×3 acting on the glTF scene's coordinates
// (after the file's own node matrix), followed by a uniform scale; both were found by eye.
const MODEL_TO_GAME = JSON.parse(process.env.M || '[0,0,1, 1,0,0, 0,1,0]');
const SCALE = Number(process.env.SCALE || 0.025);

const gltf = JSON.parse(readFileSync(join(dir, 'scene.gltf'), 'utf8'));
const bin = readFileSync(join(dir, gltf.buffers[0].uri));
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3 };
function accessor(i) {
  const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView], n = SIZE[a.type];
  const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType];
  if (!T) throw new Error(`component type ${a.componentType}`);
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || n * T.BYTES_PER_ELEMENT;
  const out = new T(a.count * n), dv = new DataView(bin.buffer, bin.byteOffset + start);
  const get = T === Float32Array ? 'getFloat32' : T === Uint32Array ? 'getUint32' : 'getUint16';
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](k * stride + c * T.BYTES_PER_ELEMENT, true);
  return out;
}

// World matrix of every mesh node (column-major, as glTF stores it).
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const parts = [];
(function walk(ids, m) {
  for (const id of ids) {
    const n = gltf.nodes[id], w = n.matrix ? mul(m, n.matrix) : m;
    if (n.mesh != null) for (const p of gltf.meshes[n.mesh].primitives) parts.push({ m: w, pos: accessor(p.attributes.POSITION), idx: accessor(p.indices) });
    if (n.children) walk(n.children, w);
  }
})(gltf.scenes[gltf.scene || 0].nodes, I);

// Weld by position: the chunks share their seam vertices exactly.
const key = new Map(), P = [], index = [];
let inTris = 0;
for (const { m, pos, idx } of parts) {
  const remap = new Uint32Array(pos.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const k = `${x},${y},${z}`;
    let id = key.get(k);
    if (id === undefined) {
      id = P.length / 3; key.set(k, id);
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const M = MODEL_TO_GAME;
      P.push((M[0] * wx + M[1] * wy + M[2] * wz) * SCALE, (M[3] * wx + M[4] * wy + M[5] * wz) * SCALE, (M[6] * wx + M[7] * wy + M[8] * wz) * SCALE);
    }
    remap[v] = id;
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a !== b && b !== c && a !== c) index.push(a, b, c);
  }
  inTris += idx.length / 3;
}
let positions = new Float32Array(P), indices = new Uint32Array(index);
console.log(`in: ${inTris} tris, ${positions.length / 3} welded verts`);

// ---- skin tone, part 1: relief of the full sculpt --------------------------------------------
// Smooth the surface and see how far each vertex sits below (crease) or above (bump) the
// smoothed one, along its normal. Two amounts of smoothing give the fine and the broad relief.
function vertexNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += x; n[k + 1] += y; n[k + 2] += z; }
  }
  for (let v = 0; v < n.length; v += 3) { const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1; n[v] /= l; n[v + 1] /= l; n[v + 2] /= l; }
  return n;
}
function relief(pos, idx, stops) {
  const nv = pos.length / 3, start = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1] += 2;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const adj = new Uint32Array(idx.length * 2), fill = start.slice(0, nv);
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = idx[t + k]; adj[fill[a]++] = idx[t + (k + 1) % 3]; adj[fill[a]++] = idx[t + (k + 2) % 3]; }
  const nrm = vertexNormals(pos, idx), out = [];
  let cur = Float32Array.from(pos), next = new Float32Array(pos.length);
  for (let it = 1, last = Math.max(...stops); it <= last; it++) {
    for (let v = 0; v < nv; v++) {
      let x = 0, y = 0, z = 0; const s = start[v], e = start[v + 1];
      for (let j = s; j < e; j++) { const a = adj[j] * 3; x += cur[a]; y += cur[a + 1]; z += cur[a + 2]; }
      const w = e > s ? 0.5 / (e - s) : 0, k = e > s ? 0.5 : 1;
      next[v * 3] = cur[v * 3] * k + x * w; next[v * 3 + 1] = cur[v * 3 + 1] * k + y * w; next[v * 3 + 2] = cur[v * 3 + 2] * k + z * w;
    }
    [cur, next] = [next, cur];
    if (stops.includes(it)) {
      const d = new Float32Array(nv);
      for (let v = 0; v < nv; v++) d[v] = (cur[v * 3] - pos[v * 3]) * nrm[v * 3] + (cur[v * 3 + 1] - pos[v * 3 + 1]) * nrm[v * 3 + 1] + (cur[v * 3 + 2] - pos[v * 3 + 2]) * nrm[v * 3 + 2];
      out.push(d);
    }
  }
  return out;
}
const FINE = Number(process.env.FINE || 25), BROAD = Number(process.env.BROAD || 400);
const [fine, broad] = relief(positions, indices, [FINE, BROAD]);
{
  const pct = (a, p) => Float32Array.from(a).sort()[Math.floor(p * (a.length - 1))];
  console.log(`relief (mm): fine 1%/99% ${(pct(fine, 0.01) * 1000).toFixed(3)}/${(pct(fine, 0.99) * 1000).toFixed(3)}, broad ${(pct(broad, 0.01) * 1000).toFixed(3)}/${(pct(broad, 0.99) * 1000).toFixed(3)}`);
}

// The model has its own long free edges. The game draws its own nail plate at any length, so
// the model's free edge is pressed back to the end of the nail bed: every vertex that is past
// `bedLength` and above `shelfZ` in a nail frame (data/hand.json) slides back along the nail.
// The fingertip pad below it is left alone. Frames are in final coordinates, so the table
// shift below is applied to them here.
const hand = JSON.parse(readFileSync(new URL('../data/hand.json', import.meta.url), 'utf8'));
{
  let zMin = Infinity;
  for (let v = 2; v < positions.length; v += 3) if (positions[v] < zMin) zMin = positions[v];
  for (let v = 2; v < positions.length; v += 3) positions[v] -= zMin;
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (const f of hand.fingers) {
    if (f.shelfZ == null) continue;
    const len = (v) => Math.hypot(...v), t = f.tipDir.map((c) => c / len(f.tipDir));
    let n = f.normal.slice(); const d = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    n = n.map((c, i) => c - t[i] * d); n = n.map((c) => c / len(n));
    const s = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    let moved = 0;
    for (let v = 0; v < positions.length; v += 3) {
      const q = [positions[v] - f.origin[0], positions[v + 1] - f.origin[1], positions[v + 2] - f.origin[2]];
      const px = q[0] * s[0] + q[1] * s[1] + q[2] * s[2], py = q[0] * t[0] + q[1] * t[1] + q[2] * t[2], pz = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
      if (py <= f.bedLength || py > f.bedLength + f.width || Math.abs(px) > f.width || pz > 0.5 * f.width) continue;
      const k = sm(f.shelfZ - 0.0006, f.shelfZ - 0.0001, pz) * (1 - sm(0.7 * f.width, f.width, Math.abs(px)));
      if (k <= 0) continue;
      const back = (py - f.bedLength) * 0.97 * k;
      positions[v] -= t[0] * back; positions[v + 1] -= t[1] * back; positions[v + 2] -= t[2] * back;
      moved++;
    }
    console.log(`finger ${f.finger}: pressed back ${moved} free-edge vertices`);
  }
}

await MeshoptSimplifier.ready;
if (indices.length / 3 > targetTris) {
  const [out, err] = MeshoptSimplifier.simplify(indices, positions, 3, targetTris * 3, 0.01, []);
  indices = out;
  console.log(`simplified to ${indices.length / 3} tris, relative error ${err.toExponential(2)}`);
}
// Drop unused vertices.
const used = new Int32Array(positions.length / 3).fill(-1);
let nv = 0;
for (let i = 0; i < indices.length; i++) { if (used[indices[i]] < 0) used[indices[i]] = nv++; indices[i] = used[indices[i]]; }
const packed = new Float32Array(nv * 3), tone = new Uint8Array(nv * 3);
const FINE_MM = Number(process.env.FINE_MM || 0.25), BROAD_MM = Number(process.env.BROAD_MM || 2.5);
const byte = (x) => Math.max(0, Math.min(255, Math.round(128 + 127 * x)));
for (let v = 0; v < used.length; v++) if (used[v] >= 0) {
  packed.set(positions.subarray(v * 3, v * 3 + 3), used[v] * 3);
  tone[used[v] * 3] = byte(fine[v] * 1000 / FINE_MM);            // + = crease
  tone[used[v] * 3 + 1] = byte(-broad[v] * 1000 / BROAD_MM);     // + = bump
}
positions = packed;

// With a mirror in MODEL_TO_GAME the winding flips; put it back.
const M = MODEL_TO_GAME;
const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
if (det < 0) for (let t = 0; t < indices.length; t += 3) { const b = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = b; }

/** Draw every triangle into buf (W×H), keeping the largest depth per pixel. px, py, pd are per vertex. */
function rasterMax(buf, W, H, px, py, pd) {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], e = indices[t + 2];
    const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b], x2 = px[e], y2 = py[e];
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-9) continue;
    const ax = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5)), bx = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const ay = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5)), by = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    for (let Y = ay; Y <= by; Y++) for (let X = ax; X <= bx; X++) {
      const qx = X + 0.5, qy = Y + 0.5, l0 = ((y1 - y2) * (qx - x2) + (x2 - x1) * (qy - y2)) / den, l1 = ((y2 - y0) * (qx - x2) + (x0 - x2) * (qy - y2)) / den, l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      const z = l0 * pd[a] + l1 * pd[b] + l2 * pd[e], k = Y * W + X;
      if (z > buf[k]) buf[k] = z;
    }
  }
}

// ---- skin tone, part 2: how much of the sky each vertex sees ---------------------------------
// The hand is drawn into a depth map from many directions; a vertex is lit from a direction
// when nothing sits in front of it. Light from below is the table's bounce, worth less.
{
  const N = Number(process.env.AO_DIRS || 96), RES = 720, BIAS = 0.0012, nrm = vertexNormals(positions, indices);
  const c = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let v = k; v < positions.length; v += 3) { lo = Math.min(lo, positions[v]); hi = Math.max(hi, positions[v]); } return (lo + hi) / 2; });
  let R = 0; for (let v = 0; v < positions.length; v += 3) R = Math.max(R, Math.hypot(positions[v] - c[0], positions[v + 1] - c[1], positions[v + 2] - c[2]));
  const sum = new Float32Array(nv), wsum = new Float32Array(nv), buf = new Float32Array(RES * RES);
  const px = new Float32Array(nv), py = new Float32Array(nv), pd = new Float32Array(nv), S = (RES - 2) / (2 * R);
  for (let i = 0; i < N; i++) {
    const dz = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - dz * dz), ph = i * 2.399963, d = [r * Math.cos(ph), r * Math.sin(ph), dz];
    const h = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = [h[1] * d[2] - h[2] * d[1], h[2] * d[0] - h[0] * d[2], h[0] * d[1] - h[1] * d[0]]; const ul = Math.hypot(...u); u = u.map((x) => x / ul);
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    for (let v = 0; v < nv; v++) {
      const x = positions[v * 3] - c[0], y = positions[v * 3 + 1] - c[1], z = positions[v * 3 + 2] - c[2];
      px[v] = (x * u[0] + y * u[1] + z * u[2]) * S + RES / 2; py[v] = (x * w[0] + y * w[1] + z * w[2]) * S + RES / 2; pd[v] = x * d[0] + y * d[1] + z * d[2];
    }
    buf.fill(-Infinity); rasterMax(buf, RES, RES, px, py, pd);
    const sky = d[2] >= 0 ? 1 : 0.45;
    for (let v = 0; v < nv; v++) {
      const cos = nrm[v * 3] * d[0] + nrm[v * 3 + 1] * d[1] + nrm[v * 3 + 2] * d[2];
      if (cos <= 0.05) continue;
      wsum[v] += cos;
      if (buf[Math.min(RES - 1, Math.max(0, Math.floor(py[v]))) * RES + Math.min(RES - 1, Math.max(0, Math.floor(px[v])))] <= pd[v] + BIAS) sum[v] += cos * sky;
    }
  }
  let mean = 0;
  for (let v = 0; v < nv; v++) { const ao = wsum[v] > 0 ? sum[v] / wsum[v] : 1; tone[v * 3 + 2] = Math.round(255 * Math.min(1, ao)); mean += ao; }
  console.log(`open sky: mean ${(mean / nv).toFixed(3)} over ${N} directions`);
}

// ---- the underside: how high the hand hangs over each millimetre of table --------------------
// assets/hand/under.bin: "NSU1", uint32 W, H, float32 x0, y0, cell, then uint16[W*H]
// (65535 = no hand above, else height / 0.08 m * 65534). The game shapes the cushion and the
// shadow on the table from it (src/hand/rest.js).
{
  const CELL = 0.001, PAD = 0.04, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]; let zMax = 0;
  for (let v = 0; v < nv; v++) { for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], positions[v * 3 + k]); hi[k] = Math.max(hi[k], positions[v * 3 + k]); } zMax = Math.max(zMax, positions[v * 3 + 2]); }
  const x0 = lo[0] - PAD, y0 = lo[1] - PAD, W = Math.ceil((hi[0] - lo[0] + 2 * PAD) / CELL), H = Math.ceil((hi[1] - lo[1] + 2 * PAD) / CELL);
  const px = new Float32Array(nv), py = new Float32Array(nv), pd = new Float32Array(nv), buf = new Float32Array(W * H).fill(-Infinity);
  for (let v = 0; v < nv; v++) { px[v] = (positions[v * 3] - x0) / CELL; py[v] = (positions[v * 3 + 1] - y0) / CELL; pd[v] = -positions[v * 3 + 2]; }
  rasterMax(buf, W, H, px, py, pd);
  const out = Buffer.alloc(24 + W * H * 2);
  out.write('NSU1', 0, 'latin1'); out.writeUInt32LE(W, 4); out.writeUInt32LE(H, 8);
  out.writeFloatLE(x0, 12); out.writeFloatLE(y0, 16); out.writeFloatLE(CELL, 20);
  for (let k = 0; k < W * H; k++) out.writeUInt16LE(buf[k] === -Infinity ? 65535 : Math.min(65534, Math.round(-buf[k] / 0.08 * 65534)), 24 + k * 2);
  writeFileSync(OUT.replace('hand.bin', 'under.bin'), out);
  console.log(`underside: ${W}×${H} cells of ${CELL * 1000} mm from (${x0.toFixed(4)}, ${y0.toFixed(4)}), ${(out.length / 1024).toFixed(0)} KB`);
  if (process.env.SHOW) for (let Y = H - 5; Y >= 0; Y -= 10) { let l = ''; for (let X = 2; X < W; X += 5) { const z = -buf[Y * W + X]; l += z === Infinity ? ' .' : String(Math.min(99, Math.round(z * 1000))).padStart(2); } console.log(l); }
}

const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) { const p = positions[v * 3 + c]; if (p < min[c]) min[c] = p; if (p > max[c]) max[c] = p; }
const size = max.map((m, c) => m - min[c]);
const q = new Uint16Array(nv * 3);
for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) q[v * 3 + c] = Math.round((positions[v * 3 + c] - min[c]) / size[c] * 65535);

const posBytes = (nv * 6 + 3) & ~3;
const buf = Buffer.alloc(36 + posBytes + indices.length * 4 + tone.length);
buf.write('NSH2', 0, 'latin1');
buf.writeUInt32LE(nv, 4); buf.writeUInt32LE(indices.length / 3, 8);
for (let c = 0; c < 3; c++) { buf.writeFloatLE(min[c], 12 + c * 4); buf.writeFloatLE(size[c], 24 + c * 4); }
Buffer.from(q.buffer).copy(buf, 36);
Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength).copy(buf, 36 + posBytes);
Buffer.from(tone.buffer).copy(buf, 36 + posBytes + indices.length * 4);
writeFileSync(OUT, buf);
console.log(`out: ${nv} verts, ${indices.length / 3} tris, ${(buf.length / 1048576).toFixed(2)} MB → ${OUT}`);
console.log(`box min ${min.map((v) => v.toFixed(4))} size ${size.map((v) => v.toFixed(4))}`);
