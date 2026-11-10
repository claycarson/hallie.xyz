// Build assets/hand/hand.bin from the Sketchfab download of "Female Hand" by yuzutarou (CC BY 4.0).
//
//   node tools/build-hand.mjs <dir with scene.gltf + scene.bin> [tris=220000]
//
// The download is 674k triangles in six chunks (split at the 16-bit vertex limit), with no
// textures and no rig. This welds the chunks back together by position, simplifies with
// meshoptimizer, turns and scales the hand into the game's space (see SPACE below), and writes
// a small binary the game loads directly (src/hand/model.js). Normals are rebuilt at load.
//
// File layout (little endian): "NSH1", uint32 verts, uint32 tris, float32 min[3], float32 size[3],
// uint16 position[verts*3] (0..65535 across the box), pad to 4 bytes, uint32 index[tris*3].
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
const packed = new Float32Array(nv * 3);
for (let v = 0; v < used.length; v++) if (used[v] >= 0) packed.set(positions.subarray(v * 3, v * 3 + 3), used[v] * 3);
positions = packed;

// With a mirror in MODEL_TO_GAME the winding flips; put it back.
const M = MODEL_TO_GAME;
const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
if (det < 0) for (let t = 0; t < indices.length; t += 3) { const b = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = b; }

const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) { const p = positions[v * 3 + c]; if (p < min[c]) min[c] = p; if (p > max[c]) max[c] = p; }
const size = max.map((m, c) => m - min[c]);
const q = new Uint16Array(nv * 3);
for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) q[v * 3 + c] = Math.round((positions[v * 3 + c] - min[c]) / size[c] * 65535);

const posBytes = (nv * 6 + 3) & ~3;
const buf = Buffer.alloc(36 + posBytes + indices.length * 4);
buf.write('NSH1', 0, 'latin1');
buf.writeUInt32LE(nv, 4); buf.writeUInt32LE(indices.length / 3, 8);
for (let c = 0; c < 3; c++) { buf.writeFloatLE(min[c], 12 + c * 4); buf.writeFloatLE(size[c], 24 + c * 4); }
Buffer.from(q.buffer).copy(buf, 36);
Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength).copy(buf, 36 + posBytes);
writeFileSync(OUT, buf);
console.log(`out: ${nv} verts, ${indices.length / 3} tris, ${(buf.length / 1048576).toFixed(2)} MB → ${OUT}`);
console.log(`box min ${min.map((v) => v.toFixed(4))} size ${size.map((v) => v.toFixed(4))}`);
