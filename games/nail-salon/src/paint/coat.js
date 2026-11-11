// @ts-check
import * as THREE from 'three';
import { FULLSCREEN_VERT, fullscreenPass } from '../engine/gpu.js';

/**
 * The flood rule's moment (PLAN §7): once a clear coat has touched half the nail, it spreads to
 * fill it. On screen that is a wet shine over the whole nail (Detail alpha = 1 inside the
 * outline, by Max blending so flakes stay put); the leveler's drying then fades it.
 */
export class CoatFlood {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tSdf: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tSdf;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - smoothstep(0.0, 0.01, texture2D(tSdf, vUv).r)); }`,
      depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
    });
  }

  /** Wet the whole nail of `finger`, in the paint set that holds it now. */
  wet(renderer, finger, targets) {
    this.material.uniforms.tSdf.value = finger.sdf.texture;
    fullscreenPass(renderer, this.material, targets.detail);
  }
}
