// @ts-check
import * as THREE from 'three';
import { N_POINTS } from './outline.js';
import { FULLSCREEN_VERT, fullscreenPass, makeTarget } from '../engine/gpu.js';

/**
 * Outline SDF (PLAN §3.3): one 512² single-channel half-float texture per finger holding the
 * signed distance to the nail outline in nail widths, negative inside. The fold wall, the nail
 * and skin materials, the stats pass and the fold shading all read this one texture.
 */
export class OutlineSdf {
  constructor(rect, size = 512) {
    this.target = makeTarget(size, THREE.HalfFloatType, THREE.LinearFilter, THREE.RedFormat);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPts: { value: new Float32Array(N_POINTS * 2) }, uRect: { value: new THREE.Vector4(rect.x0, rect.y0, rect.w, rect.h) } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec2 uPts[${N_POINTS}];
        uniform vec4 uRect;
        varying vec2 vUv;
        void main() {
          vec2 p = uRect.xy + vUv * uRect.zw;
          float d = 1e9, s = 1.0;
          for (int i = 0, j = ${N_POINTS - 1}; i < ${N_POINTS}; j = i, i++) {
            vec2 e = uPts[j] - uPts[i], w = p - uPts[i];
            vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
            d = min(d, dot(b, b));
            bvec3 c = bvec3(p.y >= uPts[i].y, p.y < uPts[j].y, e.x * w.y > e.y * w.x);
            if (all(c) || all(not(c))) s = -s;
          }
          gl_FragColor = vec4(s * sqrt(d), 0.0, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
  }

  get texture() { return this.target.texture; }

  /** Re-run when the shape or length changes (throttle to 10 Hz while filing). */
  update(renderer, points) {
    this.material.uniforms.uPts.value.set(points);
    fullscreenPass(renderer, this.material, this.target);
  }

  dispose() { this.target.dispose(); this.material.dispose(); }
}
