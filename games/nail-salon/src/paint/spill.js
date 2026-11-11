// @ts-check
import * as THREE from 'three';
import { FULLSCREEN_VERT, fullscreenPass, makeTarget } from '../engine/gpu.js';

// Spill on every finger (PLAN M1.3). The skin shader shows the active finger's spill live from
// its paint targets. The other four come from this atlas: five tiles side by side, each holding
// only the polish that is on the SKIN (past the fold wall's hair), un-premultiplied colour + film.
// One texture instead of ten, so the skin stays well inside the iPad's texture-unit limit. It is
// redrawn only when an inactive finger's paint changes (switching nails, applyDesign, undo).

export const SPILL_TILES = 5;

export class SpillAtlas {
  /** @param {number} tile pixels per finger tile (square, in that finger's paint UV) */
  constructor(tile = 512) {
    this.tile = tile;
    this.target = makeTarget(tile, THREE.UnsignedByteType);
    this.target.setSize(tile * SPILL_TILES, tile);
    this.u = {
      tPig0: { value: null }, tPig1: { value: null }, tPig2: { value: null }, tPig3: { value: null }, tPig4: { value: null },
      tSdf0: { value: null }, tSdf1: { value: null }, tSdf2: { value: null }, tSdf3: { value: null }, tSdf4: { value: null },
      uEdge: { value: new THREE.Vector2(0.015, 0.03) },
    };
    const pick = (name) => [0, 1, 2, 3, 4].map((i) => `${i ? 'else ' : ''}if (k == ${i}) v = texture2D(${name}${i}, uv)${name === 'tSdf' ? '.r' : ''};`).join(' ');
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tPig0, tPig1, tPig2, tPig3, tPig4, tSdf0, tSdf1, tSdf2, tSdf3, tSdf4;
        uniform vec2 uEdge;
        varying vec2 vUv;
        void main() {
          float x = vUv.x * ${SPILL_TILES}.0;
          int k = int(floor(x));
          vec2 uv = vec2(fract(x), vUv.y);
          vec4 pig = vec4(0.0); float sd = 0.0;
          { vec4 v; ${pick('tPig').replace(/v = /g, 'pig = ')} }
          { float v; ${pick('tSdf').replace(/v = /g, 'sd = ')} }
          float film = clamp(pig.a, 0.0, 1.0) * smoothstep(uEdge.x, uEdge.y, sd);
          gl_FragColor = vec4(pig.rgb / max(pig.a, 1e-4), film);
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
  }

  get texture() { return this.target.texture; }

  /** Redraw every tile from each finger's current paint (whatever set it is bound to). */
  update(renderer, fingers) {
    for (const f of fingers) {
      this.u[`tPig${f.id}`].value = f.bound.pigment.texture;
      this.u[`tSdf${f.id}`].value = f.sdf.texture;
    }
    fullscreenPass(renderer, this.material, this.target);
  }

  get bytes() { return this.tile * this.tile * SPILL_TILES * 4; }
}
