// @ts-check
import * as THREE from 'three';
import { FULLSCREEN_VERT, fullscreenPass, makeTarget } from '../engine/gpu.js';

// Stats readback (PLAN §4.6): what the game knows about a nail. A 256² RGBA8 target, each
// pixel a 4×4 box of samples of the 1024² paint targets, read back without stalling.
//
//   R  inside the outline and film ≥ covered threshold
//   G  film (inside or outside)
//   B  covered and within OKLab distance of the request colour
//   A  covered and the finish on top is in the request's allowed set
//
// A second mode of the same shader writes geometry (R = inside fraction, G = clearly outside
// fraction) so the CPU side needs no polygon maths of its own. Re-read when the shape changes.

export const STATS_SIZE = 256;
const MAX_FINISH = 9;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSdf, tPig, tId;
uniform float uTexel, uCovered, uMargin, uMode, uReqOn, uDist;
uniform vec3 uReq;
uniform float uAllowed[${MAX_FINISH}];
varying vec2 vUv;
vec3 oklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
void main() {
  vec4 acc = vec4(0.0);
  vec3 req = oklab(uReq);
  for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) {
    vec2 uv = vUv + (vec2(float(i), float(j)) - 1.5) * uTexel;
    float sd = texture2D(tSdf, uv).r;
    if (uMode > 0.5) { acc.r += step(sd, 0.0); acc.g += step(uMargin, sd); continue; }
    vec4 p = texture2D(tPig, uv);
    float film = clamp(p.a, 0.0, 1.0), cov = step(sd, 0.0) * step(uCovered, film);
    acc.r += cov; acc.g += film;
    acc.b += cov * uReqOn * step(distance(oklab(p.rgb / max(p.a, 1e-4)), req), uDist);
    int id = int(floor(texture2D(tId, uv).r * 255.0 + 0.5));
    float ok = 0.0;
    for (int k = 0; k < ${MAX_FINISH}; k++) if (k == id) ok = uAllowed[k];
    acc.a += cov * ok;
  }
  gl_FragColor = acc / 16.0;
}`;

export class NailStats {
  constructor(tuning) {
    this.tuning = tuning;
    this.target = makeTarget(STATS_SIZE, THREE.UnsignedByteType, THREE.NearestFilter);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tSdf: { value: null }, tPig: { value: null }, tId: { value: null },
        uTexel: { value: 1 / 1024 }, uCovered: { value: tuning.film.covered }, uMargin: { value: tuning.stats.spillMargin },
        uMode: { value: 0 }, uReqOn: { value: 0 }, uDist: { value: tuning.stats.colorDist },
        uReq: { value: new THREE.Color() }, uAllowed: { value: new Float32Array(MAX_FINISH) },
      },
      vertexShader: FULLSCREEN_VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const n = STATS_SIZE * STATS_SIZE;
    this.pixels = new Uint8Array(n * 4);
    this.inside = new Float32Array(n);      // fraction of each pixel inside the outline
    this.outside = new Uint8Array(n);       // 1 where the whole pixel is clear of the outline
    this.insideSum = 1;
    this._flight = null;
    this.rect = null;
    /** @type {{coverage:number, evenness:number, colorMatch:number, finishMatch:number, spill:number}} */
    this.last = { coverage: 0, evenness: 1, colorMatch: 0, finishMatch: 0, spill: 0 };
  }

  setFinger(sdfTexture, targets, rect) {
    const u = this.material.uniforms;
    u.tSdf.value = sdfTexture; u.tPig.value = targets.pigment.texture; u.tId.value = targets.id.texture;
    u.uTexel.value = 1 / targets.size;
    this.rect = rect;
  }

  /** What the customer asked for: a linear colour (or null) and the allowed finish ids. */
  setRequest(color, finishIds) {
    const u = this.material.uniforms;
    u.uReqOn.value = color ? 1 : 0;
    if (color) u.uReq.value.copy(color);
    u.uAllowed.value.fill(0);
    for (const id of finishIds || []) u.uAllowed.value[id] = 1;
  }

  /**
   * Read the outline's geometry for the bound finger and use it. Call after its SDF changes.
   * This waits on the GPU, so it is done when shapes change, never on a nail switch: keep the
   * returned geometry with the finger and hand it back with `useGeometry`.
   */
  refreshGeometry(renderer) {
    this.material.uniforms.uMode.value = 1;
    fullscreenPass(renderer, this.material, this.target);
    this.material.uniforms.uMode.value = 0;
    const px = new Uint8Array(this.pixels.length), n = STATS_SIZE * STATS_SIZE;
    const g = { inside: new Float32Array(n), outside: new Uint8Array(n), insideSum: 1 };
    renderer.readRenderTargetPixels(this.target, 0, 0, STATS_SIZE, STATS_SIZE, px);
    let sum = 0;
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      g.inside[i] = px[k] / 255; sum += g.inside[i];
      g.outside[i] = px[k + 1] === 255 ? 1 : 0;
    }
    g.insideSum = Math.max(1, sum);
    this.useGeometry(g);
    return g;
  }

  /** Use a finger's outline geometry from an earlier `refreshGeometry`. */
  useGeometry(g) { this.inside = g.inside; this.outside = g.outside; this.insideSum = g.insideSum; }

  /**
   * Render and read the stats. The frame loop calls this loosely (a read already in flight is
   * enough for it); pass fresh = true to be sure the numbers include everything painted so far.
   */
  async refresh(renderer, fresh = false) {
    if (this._flight) {
      await this._flight.catch(() => {});
      if (!fresh) return this.last;
    }
    this._flight = (async () => {
      fullscreenPass(renderer, this.material, this.target);
      await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, STATS_SIZE, STATS_SIZE, this.pixels);
      this.last = this.compute();
    })();
    try { await this._flight; } finally { this._flight = null; }
    return this.last;
  }

  compute() {
    const px = this.pixels, n = this.inside.length, spillFilm = this.tuning.stats.spillFilm * 255;
    let cov = 0, colour = 0, finish = 0, spill = 0, m = 0, s1 = 0, s2 = 0;
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      const r = px[k];
      if (r) {
        cov += r; colour += px[k + 2]; finish += px[k + 3];
        if (r === 255) { const g = px[k + 1] / 255; m++; s1 += g; s2 += g * g; }
      }
      if (this.outside[i] && px[k + 1] > spillFilm) spill++;
    }
    const sd = m > 1 ? Math.sqrt(Math.max(0, s2 / m - (s1 / m) ** 2)) : 0;
    return {
      coverage: Math.min(1, cov / 255 / this.insideSum),
      evenness: 1 - Math.min(1, sd / 0.25),
      colorMatch: cov ? colour / cov : 0,
      finishMatch: cov ? finish / cov : 0,
      spill: spill / this.insideSum,
    };
  }

  /** Film at a paint-frame point, from the last readback (a 4×4 texel average). */
  filmAt(x, y) {
    const r = this.rect;
    const i = Math.min(STATS_SIZE - 1, Math.max(0, Math.floor((x - r.x0) / r.w * STATS_SIZE)));
    const j = Math.min(STATS_SIZE - 1, Math.max(0, Math.floor((y - r.y0) / r.h * STATS_SIZE)));
    return this.pixels[(j * STATS_SIZE + i) * 4 + 1] / 255;
  }

  dispose() { this.target.dispose(); this.material.dispose(); }
}
