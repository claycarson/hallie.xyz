// @ts-check
import * as THREE from 'three';

/**
 * Load the hand mesh written by tools/build-hand.mjs ("NSH1": quantized positions + indices).
 * The file is already in the game's space (metres; +y to the fingertips, +z out of the back of
 * the hand). Normals are rebuilt here, which is cheaper than shipping them.
 */
export async function loadHand(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const buf = await res.arrayBuffer(), dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'NSH1') throw new Error(`${url}: not a hand file`);
  const nv = dv.getUint32(4, true), nt = dv.getUint32(8, true);
  const min = [0, 1, 2].map((c) => dv.getFloat32(12 + c * 4, true)), size = [0, 1, 2].map((c) => dv.getFloat32(24 + c * 4, true));
  const q = new Uint16Array(buf, 36, nv * 3), pos = new Float32Array(nv * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = min[i % 3] + q[i] / 65535 * size[i % 3];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 36 + ((nv * 6 + 3) & ~3), nt * 3), 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}
