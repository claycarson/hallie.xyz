// @ts-check
import * as THREE from 'three';

/** What this GPU can render to. Checked once at boot (PLAN §2.4). */
export function gpuCaps(renderer) {
  const gl = renderer.getContext();
  const halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  return { halfFloat, webgl2: renderer.capabilities.isWebGL2 !== false, maxTexture: renderer.capabilities.maxTextureSize };
}

const _cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _tri = new THREE.BufferGeometry();
_tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
_tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const _mesh = new THREE.Mesh(_tri);
_mesh.frustumCulled = false;
const _color = new THREE.Color();

export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Run `fn` with `target` bound, then put the renderer back exactly as it was. */
export function withTarget(renderer, target, fn) {
  const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  fn();
  renderer.setRenderTarget(prev);
  renderer.autoClear = auto;
}

/** Draw a full-target pass with `material` (blending comes from the material). */
export function fullscreenPass(renderer, material, target) {
  withTarget(renderer, target, () => { _mesh.material = material; renderer.render(_mesh, _cam); });
}

/** Draw any object (for example instanced stamps) into a target with a pass-through camera. */
export function drawInto(renderer, object, target) {
  withTarget(renderer, target, () => renderer.render(object, _cam));
}

export function clearTarget(renderer, target, r, g, b, a) {
  withTarget(renderer, target, () => {
    const alpha = renderer.getClearAlpha(); renderer.getClearColor(_color);
    renderer.setClearColor(new THREE.Color(r, g, b), a);
    renderer.clear(true, false, false);
    renderer.setClearColor(_color, alpha);
  });
}

export function makeTarget(size, type, filter = THREE.LinearFilter, format = THREE.RGBAFormat) {
  return new THREE.WebGLRenderTarget(size, size, {
    type, format, depthBuffer: false, stencilBuffer: false,
    minFilter: filter, magFilter: filter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.NoColorSpace,
  });
}

const _copy = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null } },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
  depthTest: false, depthWrite: false, blending: THREE.NoBlending,
});

/** Copy one target into another of any size, with the source's filtering (linear scales smoothly). */
export function copyTarget(renderer, src, dst) {
  _copy.uniforms.tSrc.value = src.texture;
  fullscreenPass(renderer, _copy, dst);
}
