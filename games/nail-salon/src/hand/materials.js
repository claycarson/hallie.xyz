// @ts-check
import * as THREE from 'three';

// Nail and skin materials (PLAN §4.5): MeshPhysicalMaterial extended with onBeforeCompile.
// Both read the finger's paint targets and outline SDF in paint-frame coordinates.

const srgb = (hex) => new THREE.Color(hex);     // THREE.Color converts sRGB hex to linear

/** Uniforms shared by the nail and the skin of one finger. Update values, never replace objects. */
export function makeFingerUniforms(frame, fold, tuning) {
  const r = frame.rect;
  return {
    tNrm: { value: null }, tSdf: { value: null }, tPig: { value: null }, tMat: { value: null }, tDet: { value: null },
    uRect: { value: new THREE.Vector4(r.x0, r.y0, r.w, r.h) },
    uBed: { value: frame.bed },
    uSmile: { value: fold.smile },
    uLunula: { value: new THREE.Vector2(...(frame.cfg.lunula ?? fold.lunula)) },
    uCuticleDepth: { value: 0.26 },
    uBedCol: { value: srgb('#f1c3b8') }, uSkinCol: { value: srgb('#e9b597') },
    uGroove: { value: new THREE.Vector2(fold.grooveWidth, fold.grooveDark) },
    uLip: { value: new THREE.Vector3(fold.lipStart, fold.lipEnd, fold.lipStrength) },
    uRim: { value: new THREE.Vector2(fold.rimWidth, fold.rimStrength) },
    uSkinFilm: { value: tuning.film.skinFactor },
    uWorldToPaint: { value: frame.worldToPaint },
  };
}

const COMMON = /* glsl */`
uniform sampler2D tSdf, tPig, tMat, tDet;
uniform vec4 uRect;
uniform float uBed, uSmile, uCuticleDepth, uSkinFilm;
uniform vec2 uLunula;
uniform vec3 uBedCol, uSkinCol;
uniform vec2 uGroove, uRim;
uniform vec3 uLip;
vec2 nlUv(vec2 p) { return (p - uRect.xy) / uRect.zw; }
float nlSmile(float x) { return uBed - uSmile * 4.0 * x * x; }
// How much of this point's edge is a skin fold (1) rather than free edge (0).
float nlFoldW(vec2 p) { float s = nlSmile(p.x); return 1.0 - smoothstep(s - 0.30, s - 0.12, p.y); }
float nlHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nlNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nlHash(i), nlHash(i + vec2(1, 0)), f.x), mix(nlHash(i + vec2(0, 1)), nlHash(i + vec2(1, 1)), f.x), f.y);
}
// Tilt a view-space normal by slopes g given in paint-frame x and y.
vec3 nlTilt(vec3 N, vec3 viewPos, vec2 p, vec2 g) {
  vec3 dpx = dFdx(viewPos), dpy = dFdy(viewPos);
  vec2 dux = dFdx(p), duy = dFdy(p);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  vec3 T = r1 * dux.x + r2 * duy.x, B = r1 * dux.y + r2 * duy.y;
  float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  return normalize(N - (T * g.x + B * g.y) * inv);
}`;

function inject(shader, uniforms, vertexDecl, vertexMain, fragBlocks) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${vertexDecl}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${vertexMain}`);
  let f = shader.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}\n${fragBlocks.decl}`);
  for (const [chunk, code] of Object.entries(fragBlocks.after)) {
    if (!f.includes(`#include <${chunk}>`)) throw new Error(`shader chunk missing: ${chunk}`);
    f = f.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);
  }
  shader.fragmentShader = f;
}

/** The nail plate: bare-nail zones under whatever the paint targets hold. */
export function makeNailMaterial(uniforms) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.35, metalness: 0, side: THREE.DoubleSide,
    clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 1, iridescenceIOR: 1.5, iridescenceThicknessRange: [250, 650],
  });
  m.onBeforeCompile = (shader) => inject(shader, uniforms,
    'attribute vec2 paintXY;\nvarying vec2 vPXY;\nvarying float vSkirt;', 'vPXY = paintXY; vSkirt = 1.0 - step(0.001, abs(normal.z));', {
      decl: 'varying vec2 vPXY;\nvarying float vSkirt;\nuniform sampler2D tNrm;\nuniform mat3 normalMatrix;',
      after: {
        color_fragment: /* glsl */`
          vec2 nlP = vPXY, nlUV = nlUv(vPXY);
          // The free edge's thickness wears the polish on the top face next to it.
          if (vSkirt > 0.5) nlUV = nlUv(vPXY - normalize(vPXY - vec2(0.0, uBed * 0.5)) * 0.05);
          float nlD = max(0.0, -texture2D(tSdf, nlUV).r);          // distance in from the outline
          vec4 nlPig = texture2D(tPig, nlUV), nlM = texture2D(tMat, nlUV), nlDt = texture2D(tDet, nlUV);
          float nlFilm = clamp(nlPig.a, 0.0, 1.0), nlWet = nlDt.a;
          float nlS = nlSmile(nlP.x), nlFold = nlFoldW(nlP);
          // Bare nail, from the base out: lunula, bed, onychodermal band, free edge.
          float nlFree = smoothstep(nlS - 0.015, nlS + 0.03, nlP.y);
          float nlBand = exp(-pow((nlP.y - (nlS - 0.04)) / 0.03, 2.0));
          float nlLun = 1.0 - smoothstep(0.7, 1.0, length(vec2(nlP.x / uLunula.x, (nlP.y - 0.03) / uLunula.y)));
          vec3 nlBare = uBedCol * mix(1.0, 0.93, smoothstep(0.2, uBed, nlP.y));
          nlBare = mix(nlBare, mix(uBedCol, vec3(1.0, 0.96, 0.93), 0.6), nlLun * 0.6);
          nlBare = mix(nlBare, vec3(0.98, 0.9, 0.86), nlBand * 0.35);
          nlBare = mix(nlBare, mix(vec3(0.86, 0.72, 0.66), vec3(0.92, 0.86, 0.79), smoothstep(nlS + 0.02, nlS + 0.22, nlP.y)), nlFree);
          nlBare *= 1.0 + 0.03 * (nlNoise(vec2(nlP.x * 60.0, nlP.y * 4.0)) - 0.5);
          // A near-solid coat hides the nail completely; only a thin coat shows what is under it.
          float nlHide = smoothstep(0.72, 0.92, nlFilm);
          vec3 nlCol = mix(nlBare * (1.0 - nlFilm) + nlPig.rgb, nlPig.rgb / max(nlFilm, 1e-3), nlHide);
          // Cuticle rim: thin translucent skin over the plate along the proximal edge only.
          float nlProx = (1.0 - smoothstep(uCuticleDepth * 0.9, uCuticleDepth * 1.6, nlP.y));
          float nlRimK = (1.0 - smoothstep(uRim.x * 0.5, uRim.x * 1.8, nlD)) * nlProx * uRim.y;
          nlCol = mix(nlCol, uSkinCol * 1.06, nlRimK * (1.0 - 0.6 * nlFilm));
          // The folds shade the plate where it tucks under them.
          nlCol *= mix(vec3(1.0), mix(vec3(0.70, 0.54, 0.52), vec3(1.0), smoothstep(0.0, 0.075, nlD)), nlFold);
          diffuseColor.rgb = nlCol;`,
        metalnessmap_fragment: /* glsl */`
          float nlRough = mix(0.38, nlM.g, nlFilm);
          nlRough = mix(nlRough, 0.06, nlWet * 0.5 * nlFilm);
          nlRough = mix(nlRough, 0.04, nlDt.b * nlFilm);               // sparkle flakes are little mirrors
          roughnessFactor = nlRough;
          metalnessFactor = nlM.b * nlFilm;`,
        normal_fragment_begin: /* glsl */`
          if (vSkirt < 0.5) {            // the top surface: per-pixel normal from the plate's own shape
            normal = normalize(normalMatrix * texture2D(tNrm, nlUV).xyz) * faceDirection;
            nonPerturbedNormal = normal;
          }`,
        normal_fragment_maps: /* glsl */`
          {
            float ridge = (1.0 - nlFilm) * 0.012 * cos(nlP.x * 120.0 + 6.0 * nlNoise(vec2(nlP.x * 14.0, nlP.y * 0.7))) * nlNoise(vec2(nlP.x * 25.0, 3.0));
            vec2 flake = (nlDt.rg - 0.5) * 1.6 * nlFilm;
            normal = nlTilt(normal, -vViewPosition, nlP, vec2(ridge, 0.0) + flake);
          }`,
        lights_physical_fragment: /* glsl */`
          material.clearcoat = max(0.22 * (1.0 - nlFilm), smoothstep(0.2, 0.8, nlFilm) * (1.0 - smoothstep(0.5, 0.7, nlM.g)));
          material.clearcoat *= 1.0 - nlRimK;
          material.clearcoatRoughness = mix(0.25, 0.10, nlFilm);
          material.iridescence = nlM.a * nlFilm;`,
      },
    });
  m.customProgramCacheKey = () => 'nail-plate-5';
  return m;
}

/**
 * The skin: tone baked into the mesh (creases, bumps, open sky; see tools/build-hand.mjs), pinker
 * fingertips, then fold shading and spilled polish round the active nail.
 * `tips` is a uniform holding the five fingertip positions in world space.
 */
export function makeSkinMaterial(uniforms, tips) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0,
    sheen: 0.45, sheenRoughness: 0.5, sheenColor: srgb('#ffb5a0'), clearcoat: 0.06, clearcoatRoughness: 0.5,
  });
  m.onBeforeCompile = (shader) => inject(shader, { ...uniforms, uTips: tips },
    'uniform mat4 uWorldToPaint;\nattribute vec3 tone;\nvarying vec3 vPaint, vTone, vWorld;\nvarying float vUp;',
    `vec4 skW = modelMatrix * vec4(transformed, 1.0);
     vPaint = (uWorldToPaint * skW).xyz; vWorld = skW.xyz; vTone = tone; vUp = normalize(mat3(modelMatrix) * normal).z;`, {
      decl: 'varying vec3 vPaint, vTone, vWorld;\nvarying float vUp;\nuniform vec3 uTips[5];',
      after: {
        color_fragment: /* glsl */`
          vec2 skUV = nlUv(vPaint.xy);
          float skIn = step(0.0, skUV.x) * step(skUV.x, 1.0) * step(0.0, skUV.y) * step(skUV.y, 1.0)
                     * smoothstep(-0.6, -0.4, vPaint.z) * step(vPaint.z, 1.0);   // this fingertip only
          float skSd = mix(9.0, texture2D(tSdf, skUV).r, skIn);
          float skFold = nlFoldW(vPaint.xy) * skIn;
          vec3 skCol = uSkinCol;
          {
            float crease = clamp((vTone.x - 0.5) * 2.0, 0.0, 1.0), bump = (vTone.y - 0.5) * 2.0, sky = vTone.z;
            float back = smoothstep(-0.2, 0.5, vUp);                                   // back of the hand vs palm
            float tip = 0.0;
            for (int i = 0; i < 5; i++) { vec3 d = vWorld - uTips[i]; tip += exp(-dot(d, d) / (0.011 * 0.011)); }
            tip = min(tip, 1.0);
            skCol *= mix(vec3(1.05, 0.96, 0.94), vec3(1.0), back);                     // the palm is paler and pinker
            skCol *= mix(vec3(1.0), vec3(1.05, 0.9, 0.88), max(tip * 0.9, clamp(bump, 0.0, 1.0) * 0.8 * back));   // blood shows at fingertips and knuckles
            skCol *= mix(vec3(1.0), vec3(0.78, 0.6, 0.56), min(crease * 0.8, 0.6));        // creases run darker and redder
            skCol *= mix(vec3(0.5, 0.3, 0.27), vec3(1.0), smoothstep(0.0, 0.85, sky));  // shade where the light can't reach, warm like skin
            skCol *= 1.0 + 0.04 * (nlNoise(vWorld.xy * 900.0) - 0.5) + 0.03 * (nlNoise(vWorld.yz * 2600.0) - 0.5);
          }
          // Groove: the skin darkens and warms right at the plate.
          float skGroove = (1.0 - smoothstep(0.0, uGroove.x, skSd)) * skFold;
          skCol *= mix(vec3(1.0), vec3(0.74, 0.56, 0.52), skGroove * uGroove.y);
          // Spilled polish sits flatter and thinner on skin than on the nail.
          vec4 skPig = texture2D(tPig, skUV);
          float skFilm = clamp(skPig.a, 0.0, 1.0) * skIn * smoothstep(0.015, 0.03, skSd);   // past the fold wall's hair
          skCol = mix(skCol, skPig.rgb / max(skPig.a, 1e-4), skFilm * uSkinFilm);
          diffuseColor.rgb = skCol;`,
        metalnessmap_fragment: /* glsl */`
          roughnessFactor = mix(roughnessFactor, 0.4, skFilm);`,
        normal_fragment_maps: /* glsl */`
          {
            // Raised lip of the fold: tilt the normal away from the nail across the lip band.
            float e = 0.006;
            vec2 grad = vec2(texture2D(tSdf, skUV + vec2(e / uRect.z, 0.0)).r - texture2D(tSdf, skUV - vec2(e / uRect.z, 0.0)).r,
                             texture2D(tSdf, skUV + vec2(0.0, e / uRect.w)).r - texture2D(tSdf, skUV - vec2(0.0, e / uRect.w)).r) / (2.0 * e);
            // Height of the lip as a function of distance from the nail; its slope tilts the normal.
            #define SK_LIP(d) (smoothstep(0.0, uLip.x, d) * (1.0 - smoothstep(uLip.x, uLip.y, d)))
            float dh = (SK_LIP(skSd + 0.004) - SK_LIP(skSd - 0.004)) / 0.008;
            normal = nlTilt(normal, -vViewPosition, vPaint.xy, grad * dh * uLip.z * 0.03 * skFold * step(0.0, skSd));
          }`,
      },
    });
  m.customProgramCacheKey = () => 'skin-2';
  return m;
}
