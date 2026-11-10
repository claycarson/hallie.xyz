// @ts-check
// Turns pointer samples (already mapped to paint-frame coordinates) into brush stamps
// (PLAN §4.2). Pure: no DOM, no three.js, no allocation per sample.
//
// Stamp record, 8 floats: x, y, dirX, dirY, radius, alpha, flags, strokeDistance
//   flags bit 0 = tipInside (the fold wall applies), value 0 or 1.

export const STAMP_FLOATS = 8;

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export class StrokeEngine {
  /**
   * @param {object} tuning data/tuning.json "brush" block
   * @param {(x: number, y: number) => number} sd signed distance to the nail outline (nail widths)
   * @param {number} [capacity] stamps buffered between flushes
   */
  constructor(tuning, sd, capacity = 2048) {
    this.t = tuning;
    this.sd = sd;
    this.capacity = capacity;
    this.stamps = new Float32Array(capacity * STAMP_FLOATS);
    this.count = 0;
    this.load = 1;
    this.nailLength = 1;       // set by the owner; drives load drain
    this.radius = tuning.radius;
    this.down = false;
    this.speed = 0;            // nail widths per second, smoothed
    this._x = 0; this._y = 0; this._t = 0;
    this._carry = 0;           // distance walked since the last stamp
    this._dist = 0;            // distance along this stroke
    this._snap = false;
    this._seed = 0;
    this._dx = 0; this._dy = 1;
    /** Called when the buffer fills mid-stroke, so the owner can draw and reset it. */
    this.onFull = null;
  }

  dip() { this.load = 1; }

  /** Width factor from Pencil tilt. altitude in radians (π/2 = upright); null for finger/mouse. */
  tiltFactor(altitude) {
    if (altitude == null) return 1;
    const deg = altitude * 180 / Math.PI;
    return mix(this.t.tiltFlat, this.t.tiltUpright, smoothstep(25, 70, deg));
  }

  begin(x, y, timeMs, widthFactor = 1) {
    this.down = true;
    this._x = x; this._y = y; this._t = timeMs;
    this._carry = 0; this._dist = 0; this.speed = 0;
    this._seed = (this._seed + 7.31) % 97;
    const d = this.sd(x, y);
    this._snap = d > 0 && d <= this.t.snap;       // forgiving start just outside the nail
    this._emit(x, y, widthFactor, this.t.speedSlow);
  }

  move(x, y, timeMs, widthFactor = 1) {
    if (!this.down) return;
    const dx = x - this._x, dy = y - this._y, len = Math.hypot(dx, dy);
    const dt = Math.max(1e-3, (timeMs - this._t) / 1000);
    if (len < 1e-6) { this._t = timeMs; return; }
    const inst = len / dt;
    this.speed = this.speed === 0 ? inst : mix(this.speed, inst, 0.35);
    this._dx = dx / len; this._dy = dy / len;
    const step = this.t.spacing * this.radius * widthFactor;
    let walked = step - this._carry;
    while (walked <= len) {
      this._dist += step;
      this.load = Math.max(0, this.load - step / (this.t.drainLengths * this.nailLength));
      this._emit(this._x + this._dx * walked, this._y + this._dy * walked, widthFactor, this.speed);
      walked += step;
    }
    this._carry = len - (walked - step);
    this._x = x; this._y = y; this._t = timeMs;
  }

  end() { this.down = false; this.speed = 0; }

  _emit(x, y, widthFactor, speed) {
    let d = this.sd(x, y), inside = d <= 0;
    if (this._snap) {
      if (inside || d > this.t.snap * 1.5) this._snap = false;
      else {                                         // slide the stamp just inside the outline
        const e = 0.004;
        const gx = (this.sd(x + e, y) - this.sd(x - e, y)) / (2 * e);
        const gy = (this.sd(x, y + e) - this.sd(x, y - e)) / (2 * e);
        const g = Math.hypot(gx, gy) || 1;
        x -= gx / g * (d + 0.01); y -= gy / g * (d + 0.01);
        inside = true;
      }
    }
    const t = this.t;
    const speedFactor = mix(1, t.speedMin, smoothstep(t.speedSlow, t.speedFast, speed));
    const loadFactor = mix(t.loadFloor, 1, smoothstep(0, t.loadKnee, this.load));
    if (this.count >= this.capacity) { if (this.onFull) this.onFull(); if (this.count >= this.capacity) return; }
    const o = this.count++ * STAMP_FLOATS, s = this.stamps;
    s[o] = x; s[o + 1] = y; s[o + 2] = this._dx; s[o + 3] = this._dy;
    s[o + 4] = this.radius * widthFactor;
    s[o + 5] = t.centreAlpha * loadFactor * speedFactor;
    s[o + 6] = inside ? 1 : 0;
    s[o + 7] = this._dist + this._seed;
  }

  reset() { this.count = 0; }
}
