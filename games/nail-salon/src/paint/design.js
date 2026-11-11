// @ts-check
import * as THREE from 'three';
import { FULLSCREEN_VERT, clearTarget, fullscreenPass } from '../engine/gpu.js';
import { FLAKES } from './stamps.js';

export { nailLayers } from './layers.js';

// applyDesign (PLAN §4.7): fill a nail's paint targets straight from a Design (§9.3), with no
// brush. One full-target pass per target replaces whatever was there: the polish flooded at
// film 1 inside the outline, its finish in Material, Detail and Id, nothing outside (no spill).
// French and ombre are a second polish over the tip; the accent nail gets its own polish. The top
// coat is not painted here: it is the nail's coat state (main.js setCoats), like a brushed one.

const HEAD = /* glsl */`
precision highp float;
uniform sampler2D tSdf;
uniform vec4 uRect;
uniform float uLen, uMode, uChip, uSeed, uAA, uHasBase;
uniform vec3 uFrench;     // tip share of the length, smile depth, edge softness
uniform vec2 uOmbre;      // blend start and end, as shares of the length
uniform vec3 uFlakeA, uFlakeB;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
${FLAKES}
vec2 paintP() { return uRect.xy + vUv * uRect.zw; }
// How much of the second polish (french tip, ombre) is here: 0 base … 1 over.
float overShare(vec2 p) {
  if (uMode > 1.5) return smoothstep(uLen * uOmbre.x, uLen * uOmbre.y, p.y);
  if (uMode > 0.5) {
    // The smile line: deepest toward the cuticle at the side walls, like a real french tip.
    float line = uLen * (1.0 - uFrench.x) - uFrench.y * (4.0 * p.x * p.x - 1.0 / 3.0);
    return smoothstep(line - uFrench.z, line + uFrench.z, p.y);
  }
  return 0.0;
}
// Film: 1 inside the outline (a hair of anti-aliasing past it), less where old polish chipped.
float film(vec2 p) {
  float sd = texture2D(tSdf, vUv).r;
  float f = (1.0 - smoothstep(0.0, uAA, sd)) * uHasBase;
  if (uChip > 0.0) {
    // Old polish wears off the free edge first, then along the walls, in ragged bites.
    float tipW = smoothstep(uLen - 0.45, uLen, p.y), edgeW = smoothstep(-0.14, 0.0, sd);
    float w = max(tipW, 0.6 * edgeW);
    vec2 q = p + uSeed * 7.31;
    float n = 0.65 * noise(q * 13.0) + 0.35 * noise(q * 41.0);
    f *= 1.0 - smoothstep(0.0, 0.03, n - (1.0 - uChip * w));
    f *= 1.0 - 0.12 * uChip * noise(q * 5.0);          // and goes a little thin all over
  }
  return f;
}`;

const pass = (body) => new THREE.ShaderMaterial({
  uniforms: {}, vertexShader: FULLSCREEN_VERT, fragmentShader: `${HEAD}\n${body}`,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending,
});

export class DesignPainter {
  /** @param {any} tuning data/tuning.json (uses "design") */
  constructor(tuning) {
    const D = tuning.design;
    this.u = {
      tSdf: { value: null }, uRect: { value: new THREE.Vector4() }, uLen: { value: 1 }, uMode: { value: 0 },
      uChip: { value: 0 }, uSeed: { value: 0 }, uAA: { value: D.edgeAA }, uHasBase: { value: 1 },
      uFrench: { value: new THREE.Vector3(...D.french) }, uOmbre: { value: new THREE.Vector2(...D.ombre) },
      uFlakeA: { value: new THREE.Vector3() }, uFlakeB: { value: new THREE.Vector3() },
      uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
      uMatA: { value: new THREE.Vector4() }, uMatB: { value: new THREE.Vector4() },
      uIdA: { value: 0 }, uIdB: { value: 0 },
    };
    // Same layout as the brush writes (PLAN §4.1): premultiplied pigment, film in alpha.
    this.pigment = pass(/* glsl */`
      uniform vec3 uColA, uColB;
      void main() { vec2 p = paintP(); float a = film(p); gl_FragColor = vec4(mix(uColA, uColB, overShare(p)) * a, a); }`);
    this.material = pass(/* glsl */`
      uniform vec4 uMatA, uMatB;
      void main() {
        vec2 p = paintP();
        vec4 m = mix(uMatA, uMatB, overShare(p));
        gl_FragColor = mix(vec4(0.0, 0.3, 0.0, 0.0), m, step(0.001, film(p)));   // bare = the cleared value
      }`);
    this.detail = pass(/* glsl */`
      void main() {
        vec2 p = paintP();
        vec3 f = overShare(p) > 0.5 ? nailFlakes(p, uFlakeB) : nailFlakes(p, uFlakeA);
        gl_FragColor = mix(vec4(0.5, 0.5, 0.0, 0.0), vec4(0.5 + f.xy, f.z, 0.0), step(0.001, film(p)));   // a = wetness: dry
      }`);
    this.id = pass(/* glsl */`
      uniform float uIdA, uIdB;
      void main() { vec2 p = paintP(); gl_FragColor = vec4(film(p) < 0.5 ? 0.0 : (overShare(p) > 0.5 ? uIdB : uIdA), 0.0, 0.0, 1.0); }`);
    for (const m of [this.pigment, this.material, this.detail, this.id]) m.uniforms = this.u;
  }

  /**
   * Replace one nail's paint with its layers.
   * @param {THREE.WebGLRenderer} renderer
   * @param {any} finger a Finger (its SDF, rect and outline length are used)
   * @param {ReturnType<typeof nailLayers>} L
   * @param {any} targets the PaintTargets holding this nail's paint now
   * @param {{ chipped?: number }} [o] chipped 0…1: old polish worn off at the edges
   */
  paint(renderer, finger, L, targets, o = {}) {
    const u = this.u, r = finger.frame.rect;
    u.tSdf.value = finger.sdf.texture;
    u.uRect.value.set(r.x0, r.y0, r.w, r.h);
    u.uLen.value = finger.info.length;
    u.uHasBase.value = L.base ? 1 : 0;
    u.uMode.value = L.mode === 'ombre' ? 2 : L.mode === 'french' ? 1 : 0;
    u.uChip.value = o.chipped || 0;
    u.uSeed.value = finger.id + 1;
    const set = (p, col, mat, flake, id) => {
      if (!p) return;
      const F = p.finishData;
      col.value.set(p.color);                         // sRGB hex → linear, as the brush does
      mat.value.set(F.translucency, F.roughness, F.metalness, F.iridescence);
      flake.value.fromArray(F.flake || [0, 0, 0]);
      id.value = F.id / 255;
    };
    set(L.base, u.uColA, u.uMatA, u.uFlakeA, u.uIdA);
    set(L.over || L.base, u.uColB, u.uMatB, u.uFlakeB, u.uIdB);
    fullscreenPass(renderer, this.pigment, targets.pigment);
    fullscreenPass(renderer, this.material, targets.material);
    fullscreenPass(renderer, this.detail, targets.detail);
    fullscreenPass(renderer, this.id, targets.id);
    clearTarget(renderer, targets.art, 0, 0, 0, 0);    // objects are redrawn from their records (M3)
  }
}
