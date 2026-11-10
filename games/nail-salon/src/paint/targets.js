// @ts-check
import * as THREE from 'three';
import { clearTarget, makeTarget } from '../engine/gpu.js';

/**
 * One finger's paint targets (PLAN §4.1), all in paint-frame UV and all linear data.
 *   pigment  rgb = polish colour × film (premultiplied), a = film 0…1
 *   material r = translucency, g = roughness, b = metalness, a = iridescence
 *   detail   rg = flake normal offset, b = sparkle mask, a = wetness
 *   art      stickers, dots, stripes (premultiplied)
 *   id       r = finish id ÷ 255 of the polish on top
 */
export class PaintTargets {
  constructor(size, caps) {
    this.size = size;
    this.halfFloat = caps.halfFloat;
    this.pigment = makeTarget(size, caps.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType);
    this.material = makeTarget(size, THREE.UnsignedByteType);
    this.detail = makeTarget(size, THREE.UnsignedByteType);
    this.art = makeTarget(size, THREE.UnsignedByteType);
    this.id = makeTarget(256, THREE.UnsignedByteType, THREE.NearestFilter);
  }

  clear(renderer) {
    clearTarget(renderer, this.pigment, 0, 0, 0, 0);
    clearTarget(renderer, this.material, 0, 0.3, 0, 0);
    clearTarget(renderer, this.detail, 0.5, 0.5, 0, 0);
    clearTarget(renderer, this.art, 0, 0, 0, 0);
    clearTarget(renderer, this.id, 0, 0, 0, 0);
  }

  /** Bytes of GPU memory held (for the debug overlay). */
  get bytes() {
    const s = this.size * this.size;
    return s * (this.halfFloat ? 8 : 4) + s * 4 * 3 + 256 * 256 * 4;
  }

  dispose() { for (const t of [this.pigment, this.material, this.detail, this.art, this.id]) t.dispose(); }
}
