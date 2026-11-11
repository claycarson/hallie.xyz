// @ts-check
// The flood rule (PLAN §7): how much of a nail a clear-coat brush has touched. Clear coats carry
// no colour, so this is counted on the CPU from the stamps themselves: a grid of points inside the
// outline, each marked when a stamp's pad covers it. Pure: no DOM, no three.js.

import { sdPolygon } from '../hand/outline.js';

export class TouchGrid {
  /** @param {number} perWidth grid points per nail width */
  constructor(perWidth = 40) {
    this.perWidth = perWidth;
    this.xs = new Float32Array(0); this.ys = new Float32Array(0);
    this.touched = new Uint8Array(0);
    this.count = 0;
  }

  /** Points inside an outline (paint coords, nail widths). Clears what was touched. */
  setOutline(points, length) {
    const step = 1 / this.perWidth, xs = [], ys = [];
    for (let y = step / 2; y < length; y += step) for (let x = -0.5 + step / 2; x < 0.5; x += step) {
      if (sdPolygon(points, x, y) < 0) { xs.push(x); ys.push(y); }
    }
    this.xs = Float32Array.from(xs); this.ys = Float32Array.from(ys);
    this.touched = new Uint8Array(xs.length);
    this.count = 0;
    return this;
  }

  reset() { this.touched.fill(0); this.count = 0; }

  /**
   * Mark every point within `reach` × radius of a stamp.
   * @param {Float32Array} stamps records of `floats` numbers: x, y, …, radius at index 4
   */
  mark(stamps, n, floats, reach = 0.8) {
    const { xs, ys, touched } = this;
    for (let k = 0; k < n; k++) {
      const o = k * floats, sx = stamps[o], sy = stamps[o + 1], r = stamps[o + 4] * reach, r2 = r * r;
      for (let i = 0; i < xs.length; i++) {
        if (touched[i]) continue;
        const dx = xs[i] - sx, dy = ys[i] - sy;
        if (dx * dx + dy * dy <= r2) { touched[i] = 1; this.count++; }
      }
    }
  }

  /** Share of the nail touched, 0…1. */
  get share() { return this.xs.length ? this.count / this.xs.length : 0; }
}
