// @ts-check
import * as THREE from 'three';

/**
 * Stand-in finger: a procedural last-two-segments finger used until the hand bake-off (M0.2)
 * picks a real model. It is built around a nail frame so the frame data in hand.json matches
 * it by construction, but it is an ordinary skin mesh in the frame's parent space: nothing
 * else in the game knows it is procedural.
 *
 * Side profile (paint coords, nail widths): the back of the finger is nearly flat along the
 * nail bed, then drops in a blunt front just past the bed end; the pad rounds up to meet it.
 */
export function buildStandinFinger(frame) {
  const bed = frame.bed;
  const A0 = 0.86, B0 = 0.68;                 // half-width, half-height of the finger body
  const yTip = bed + 0.13, yCap = yTip - 0.95, FRONT = 0.15, DROP = 0.35;
  const topBed = (y) => (y > 0 ? -0.06 * y * y : 0) + 0.05 * Math.exp(-(((y + 1.7) / 0.5) ** 2));
  const zMeet = topBed(bed) - DROP;
  const top = (y) => {
    if (y <= bed) return topBed(y);
    const u = Math.min(1, (y - bed) / FRONT);
    return topBed(bed) - DROP * (1 - Math.sqrt(1 - u * u));
  };
  const capU = (y) => Math.min(1, Math.max(0, (y - yCap) / (yTip - yCap)));
  const bottom = (y) => { const u = capU(y); return zMeet - (zMeet + 2 * B0) * Math.sqrt(1 - u * u); };
  const halfW = (y) => A0 * Math.pow(1 - Math.pow(capU(y), 3.2), 1 / 3.2) * (1 + 0.05 * Math.exp(-(((y + 1.7) / 0.6) ** 2)));

  const ys = [];
  for (let i = 0; i <= 44; i++) ys.push(-7 + (yCap + 7) * (i / 44));
  for (let i = 1; i <= 48; i++) ys.push(yCap + (yTip - yCap) * Math.sin((Math.PI / 2) * (i / 48)));
  const SEG = 96, rows = ys.length, pos = new Float32Array(rows * SEG * 3), idx = [];
  for (let r = 0; r < rows; r++) {
    const y = ys[r], zt = top(y), zb = bottom(y), zc = (zt + zb) / 2, h = Math.max(0, (zt - zb) / 2), a = halfW(y);
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2, o = (r * SEG + j) * 3;
      pos[o] = a * Math.cos(th); pos[o + 1] = y; pos[o + 2] = zc + h * Math.sin(th);
    }
  }
  for (let r = 0; r < rows - 1; r++) for (let j = 0; j < SEG; j++) {
    const a = r * SEG + j, b = r * SEG + (j + 1) % SEG, c = a + SEG, d = b + SEG;
    idx.push(a, c, b, b, c, d);              // outward-facing with (x, y, z) right-handed
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.applyMatrix4(frame.group.matrix);       // into the frame's parent space (metres)
  geo.computeVertexNormals();
  return geo;
}

/** Lowest point of the stand-in below the nail plane, in nail widths (for the table height). */
export const STANDIN_DEPTH = 2 * 0.68;
