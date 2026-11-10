// @ts-check
import * as THREE from 'three';
import { drawInto } from '../engine/gpu.js';
import { STAMP_FLOATS } from './stroke.js';

// Brush stamps (PLAN §4.2): every stamp buffered this frame is drawn as one instanced quad,
// one draw call per paint target.

const VERT = /* glsl */`
attribute vec4 aPosDir;     // x, y, dirX, dirY (paint coords)
attribute vec4 aParams;     // radius, alpha, tipInside, stroke distance
uniform vec4 uRect;
uniform float uLong;
varying vec2 vLocal, vP;
varying vec4 vParams;
void main() {
  vec2 dir = aPosDir.zw, perp = vec2(-dir.y, dir.x);
  vec2 p = aPosDir.xy + (dir * position.x * uLong + perp * position.y) * aParams.x;
  vLocal = position.xy; vP = p; vParams = aParams;
  gl_Position = vec4((p - uRect.xy) / uRect.zw * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG_HEAD = /* glsl */`
precision highp float;
uniform sampler2D tSdf, tSkinMask;
uniform vec4 uRect;
uniform float uWall, uStreak;
varying vec2 vLocal, vP;
varying vec4 vParams;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
// Stamp coverage 0…1 before the centre alpha: soft ellipse × bristle streaks × fold wall.
float footprint(out float sd) {
  vec2 uv = (vP - uRect.xy) / uRect.zw;
  sd = texture2D(tSdf, uv).r;
  float soft = 1.0 - smoothstep(0.5, 1.0, length(vLocal));
  // Bristle lines run along the stroke: noise across the brush, drifting slowly along it.
  float across = vLocal.y * vParams.x;
  float streak = mix(1.0 - uStreak, 1.0, noise(vec2(across * 85.0, vParams.w * 1.3)));
  float wall = mix(1.0, 1.0 - smoothstep(0.0, uWall, sd), vParams.z);     // tipInside: stop at the fold
  float skin = mix(1.0, texture2D(tSkinMask, uv).r, step(0.0, sd));       // no paint in thin air
  return soft * streak * wall * skin;
}`;

function stampMaterial(shared, body, blend) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, ...(blend.uniforms || {}) },
    vertexShader: VERT,
    fragmentShader: `${FRAG_HEAD}\n${body}`,
    depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: blend.src, blendDst: blend.dst, blendSrcAlpha: blend.srcA, blendDstAlpha: blend.dstA,
  });
}

export class StampRenderer {
  /**
   * @param {object} brush data/tuning.json "brush"
   * @param {number} capacity must match the StrokeEngine's
   */
  constructor(brush, capacity) {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * STAMP_FLOATS), STAMP_FLOATS);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aPosDir', new THREE.InterleavedBufferAttribute(this.buffer, 4, 0));
    quad.setAttribute('aParams', new THREE.InterleavedBufferAttribute(this.buffer, 4, 4));
    this.geometry = quad;

    const shared = this.shared = {
      tSdf: { value: null }, tSkinMask: { value: null },
      uRect: { value: new THREE.Vector4() },
      uLong: { value: brush.longAxis }, uWall: { value: brush.wall }, uStreak: { value: brush.streak },
    };
    this.uColor = { value: new THREE.Color() };
    this.uMat = { value: new THREE.Vector3(0, 0.25, 0) };
    this.uId = { value: 1 / 255 };

    // Pigment: premultiplied "over", so film can never pass 1 (R6).
    this.pigment = stampMaterial(shared, /* glsl */`
      uniform vec3 uColor;
      void main() { float sd; float a = footprint(sd) * vParams.y; gl_FragColor = vec4(uColor * a, a); }`,
      { uniforms: { uColor: this.uColor }, src: THREE.OneFactor, dst: THREE.OneMinusSrcAlphaFactor, srcA: THREE.OneFactor, dstA: THREE.OneMinusSrcAlphaFactor });

    // Material: lerp all four channels toward the polish's values by stamp alpha. The alpha
    // channel (iridescence) lerps through the constant blend alpha, set per polish.
    this.material = stampMaterial(shared, /* glsl */`
      uniform vec3 uMat;
      void main() { float sd; float a = min(1.0, footprint(sd) * vParams.y * 2.5); gl_FragColor = vec4(uMat, a); }`,
      { uniforms: { uMat: this.uMat }, src: THREE.SrcAlphaFactor, dst: THREE.OneMinusSrcAlphaFactor, srcA: THREE.ConstantAlphaFactor, dstA: THREE.OneMinusSrcAlphaFactor });

    // Detail: flake offsets and sparkle lerp by stamp alpha; wetness adds up and clamps at 1.
    this.detail = stampMaterial(shared, /* glsl */`
      void main() { float sd; float a = min(1.0, footprint(sd) * vParams.y * 2.5); gl_FragColor = vec4(0.5, 0.5, 0.0, a); }`,
      { src: THREE.SrcAlphaFactor, dst: THREE.OneMinusSrcAlphaFactor, srcA: THREE.OneFactor, dstA: THREE.OneFactor });

    // Id: which finish is on top. Hard-edged, no blending.
    this.id = stampMaterial(shared, /* glsl */`
      uniform float uId;
      void main() { float sd; if (footprint(sd) < 0.5) discard; gl_FragColor = vec4(uId, 0.0, 0.0, 1.0); }`,
      { uniforms: { uId: this.uId }, src: THREE.OneFactor, dst: THREE.ZeroFactor, srcA: THREE.OneFactor, dstA: THREE.ZeroFactor });

    this.mesh = new THREE.Mesh(quad, this.pigment);
    this.mesh.frustumCulled = false;
  }

  /** Choose the polish the next stamps lay down. `color` is linear RGB. */
  setPolish(color, finish) {
    this.uColor.value.copy(color);
    this.uMat.value.set(finish.translucency, finish.roughness, finish.metalness);
    this.material.blendAlpha = finish.iridescence;
    this.uId.value = finish.id / 255;
  }

  /** Bind one finger's SDF, skin mask and paint rectangle. */
  setFinger(sdfTexture, skinMask, rect) {
    this.shared.tSdf.value = sdfTexture; this.shared.tSkinMask.value = skinMask;
    this.shared.uRect.value.set(rect.x0, rect.y0, rect.w, rect.h);
  }

  /** Draw `count` buffered stamps into the finger's targets. */
  flush(renderer, stamps, count, targets) {
    if (!count) return;
    this.buffer.array.set(stamps.subarray(0, count * STAMP_FLOATS));
    this.buffer.clearUpdateRanges(); this.buffer.addUpdateRange(0, count * STAMP_FLOATS);
    this.buffer.needsUpdate = true;
    this.geometry.instanceCount = count;
    for (const [mat, target] of [[this.pigment, targets.pigment], [this.material, targets.material], [this.detail, targets.detail], [this.id, targets.id]]) {
      this.mesh.material = mat;
      drawInto(renderer, this.mesh, target);
    }
  }
}
