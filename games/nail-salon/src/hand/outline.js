// @ts-check
// Nail outline: always 96 points in paint-frame units (nail widths), same order for every
// shape so two outlines can be blended point by point (PLAN §3.3). Pure: no DOM, no three.js.
//
// Paint frame: x across the nail (-0.5 … 0.5 at the walls), y from the cuticle centre (0)
// toward the tip. Points run counter-clockwise seen from above the nail:
//   0–31  cuticle arc, left end → base centre → right end
//   32–47 right wall, cuticle end → tip start
//   48–79 tip profile, right → left
//   80–95 left wall, tip start → cuticle end

export const N_POINTS = 96;
export const SHAPES = ['round', 'square', 'squoval', 'oval', 'almond', 'coffin', 'stiletto'];

/** Tip profiles. h = tip height in half-widths; n, m = superellipse exponents (x, y). */
const TIP = {
  round:    { h: 0.55, n: 2, m: 2 },
  square:   { h: 0.16, n: 7, m: 7 },
  squoval:  { h: 0.32, n: 3.6, m: 3.2 },
  oval:     { h: 0.95, n: 2, m: 2 },
  almond:   { h: 1.5, n: 1.55, m: 2 },
  stiletto: { h: 2.2, n: 1.12, m: 1.6 },
  coffin:   { h: 1.3, flat: 0.5 },
};

const CUTICLE_DEPTH = 0.26;   // how far the U of the cuticle rises at its ends
const CUTICLE_HALF = 0.5;     // half-width where the cuticle arc meets the walls: a nail grows
                              // out at the cuticle's width, so the walls run parallel (Clay)
const smooth = (t) => t * t * (3 - 2 * t);
const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

/**
 * @param {string} shape one of SHAPES
 * @param {number} length total nail length in nail widths (bed + free edge)
 * @returns {{ points: Float32Array, length: number, tipStart: number, cuticleDepth: number }}
 */
export function outline(shape, length) {
  const tip = TIP[shape];
  if (!tip) throw new Error(`unknown nail shape: ${shape}`);
  const pts = new Float32Array(N_POINTS * 2);
  const yc = CUTICLE_DEPTH;
  const hTip = Math.max(0.04, Math.min(tip.h * 0.5, length - yc - 0.12));
  const ys = length - hTip;
  let k = 0;
  const put = (x, y) => { pts[k++] = x; pts[k++] = y; };

  for (let i = 0; i < 32; i++) {                       // cuticle arc (a soft U)
    const a = Math.PI * i / 32, c = Math.cos(a), s = Math.sin(a);
    put(-CUTICLE_HALF * spow(c, 2 / 2.6), yc * (1 - Math.pow(s, 2 / 2.2)));
  }
  for (let j = 0; j < 16; j++) {                       // right wall
    const v = j / 16;
    put(CUTICLE_HALF + (0.5 - CUTICLE_HALF) * smooth(v), yc + (ys - yc) * v);
  }
  for (let i = 0; i < 32; i++) {                       // tip
    let X, Y;
    if (tip.flat !== undefined) {                      // coffin: taper, flat end, taper
      const f = tip.flat;
      if (i < 12) { const v = i / 12; X = 1 - (1 - f) * v; Y = v; }
      else if (i < 20) { const v = (i - 12) / 8; X = f - 2 * f * v; Y = 1; }
      else { const v = (i - 20) / 12; X = -f - (1 - f) * v; Y = 1 - v; }
    } else {
      const a = Math.PI * i / 32;
      X = spow(Math.cos(a), 2 / tip.n); Y = Math.pow(Math.sin(a), 2 / tip.m);
    }
    put(0.5 * X, ys + hTip * Y);
  }
  for (let j = 0; j < 16; j++) {                       // left wall
    const v = j / 16;
    put(-(0.5 + (CUTICLE_HALF - 0.5) * smooth(v)), ys + (yc - ys) * v);
  }
  return { points: pts, length, tipStart: ys, cuticleDepth: yc };
}

/** Blend two outlines point by point (filing morphs toward the target shape). */
export function blend(a, b, t, out = new Float32Array(N_POINTS * 2)) {
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Signed distance from (x, y) to the closed polygon; negative inside. Same loop as the GPU pass. */
export function sdPolygon(pts, x, y) {
  const n = pts.length >> 1;
  let d = Infinity, s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    const ex = xj - xi, ey = yj - yi, wx = x - xi, wy = y - yi;
    let h = (wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-12);
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    const bx = wx - ex * h, by = wy - ey * h, dd = bx * bx + by * by;
    if (dd < d) d = dd;
    const c1 = y >= yi, c2 = y < yj, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** Polygon area (positive for the counter-clockwise order used here). */
export function area(pts) {
  let a = 0;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) a += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  return a / 2;
}
