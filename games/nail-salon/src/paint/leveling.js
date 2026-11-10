// @ts-check
import * as THREE from 'three';
import { FULLSCREEN_VERT, fullscreenPass, makeTarget } from '../engine/gpu.js';

// Wet polish (PLAN §4.3). On a fixed 15 Hz tick, while a finger is wet:
//   level  one small blur of Pigment, weighted by wetness, into the shared scratch target,
//          which then swaps places with the finger's Pigment. Samples on the other side of
//          the outline get weight 0, so polish never creeps onto the skin (or off it).
//   dry    wetness (Detail alpha) steps down toward 0.
export const WET_HZ = 15;

export class Leveler {
  constructor(size, halfFloat, wet) {
    this.wet = wet;
    this.scratch = makeTarget(size, halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType);
    this.level = new THREE.ShaderMaterial({
      uniforms: { tPig: { value: null }, tDet: { value: null }, tSdf: { value: null }, uTexel: { value: 1 / size }, uStrength: { value: wet.level } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tPig, tDet, tSdf;
        uniform float uTexel, uStrength;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tPig, vUv);
          float wet = texture2D(tDet, vUv).a, side = step(texture2D(tSdf, vUv).r, 0.0);
          vec4 sum = c; float n = 1.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7853982;
            vec2 uv = vUv + vec2(cos(a), sin(a)) * uTexel * 2.0;
            float w = 1.0 - abs(side - step(texture2D(tSdf, uv).r, 0.0));     // same side of the outline only
            w *= step(0.02, texture2D(tDet, uv).a);                            // and only from wet polish
            sum += texture2D(tPig, uv) * w; n += w;
          }
          gl_FragColor = mix(c, sum / n, clamp(wet * uStrength, 0.0, 1.0));
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    // dst.a − k, rgb untouched.
    this.dry = new THREE.ShaderMaterial({
      uniforms: { uK: { value: 1 / 255 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: 'uniform float uK; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uK); }',
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.ReverseSubtractEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    this._debt = 0;
  }

  /**
   * One 15 Hz tick for a finger. `seconds` is how long full wetness takes to dry (20, or 2 in
   * the dryer). Swaps targets.pigment with the scratch; the caller re-binds the texture.
   */
  tick(renderer, targets, sdfTexture, seconds = this.wet.drySeconds) {
    const u = this.level.uniforms;
    u.tPig.value = targets.pigment.texture; u.tDet.value = targets.detail.texture; u.tSdf.value = sdfTexture;
    fullscreenPass(renderer, this.level, this.scratch);
    const done = this.scratch; this.scratch = targets.pigment; targets.pigment = done;
    this._debt += 255 / (seconds * WET_HZ);
    const steps = Math.floor(this._debt);
    if (steps > 0) {
      this._debt -= steps;
      this.dry.uniforms.uK.value = steps / 255;
      fullscreenPass(renderer, this.dry, targets.detail);
    }
  }

  dispose() { this.scratch.dispose(); this.level.dispose(); this.dry.dispose(); }
}
