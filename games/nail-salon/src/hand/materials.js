// @ts-check
import * as THREE from 'three';

// Nail and skin materials (PLAN §4.5): MeshPhysicalMaterial extended with onBeforeCompile.
// Both read the finger's paint targets and outline SDF in paint-frame coordinates.

const srgb = (hex) => new THREE.Color(hex);     // THREE.Color converts sRGB hex to linear

/** Uniforms shared by the nail and the skin of one finger. Update values, never replace objects. */
export function makeFingerUniforms(frame, fold, tuning) {
  const r = frame.rect;
  return {
    tSdf: { value: null }, tPig: { value: null }, tMat: { value: null }, tDet: { value: null },
    uRect: { value: new THREE.Vector4(r.x0, r.y0, r.w, r.h) },
    uBed: { value: frame.bed },
    uSmile: { value: fold.smile },
    uCuticleDepth: { value: 0.26 },
    uBedCol: { value: srgb('#f1c3b8') }, uSkinCol: { value: srgb('#e9b597') },
    uGroove: { value: new THREE.Vector2(fold.grooveWidth, fold.grooveDark) },
    uLip: { value: new THREE.Vector3(fold.lipStart, fold.lipEnd, fold.lipStrength) },
    uRim: { value: new THREE.Vector2(fold.rimWidth, fold.rimStrength) },
    uSkinFilm: { value: tuning.film.skinFactor },
    uWorldToPaint: { value: frame.worldToPaint },
    uProcSkin: { value: 1 },
  };
}

const COMMON = /* glsl */`
uniform sampler2D tSdf, tPig, tMat, tDet;
uniform vec4 uRect;
uniform float uBed, uSmile, uCuticleDepth, uSkinFilm;
uniform vec3 uBedCol, uSkinCol;
uniform vec2 uGroove, uRim;
uniform vec3 uLip;
vec2 nlUv(vec2 p) { return (p - uRect.xy) / uRect.zw; }
float nlSmile(float x) { return uBed - uSmile * 4.0 * x * x; }
// How much of this point's edge is a skin fold (1) rather than free edge (0).
float nlFoldW(vec2 p) { float s = nlSmile(p.x); return 1.0 - smoothstep(s - 0.10, s, p.y); }
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
    'attribute vec2 paintXY;\nvarying vec2 vPXY;', 'vPXY = paintXY;', {
      decl: 'varying vec2 vPXY;',
      after: {
        color_fragment: /* glsl */`
          vec2 nlP = vPXY, nlUV = nlUv(vPXY);
          float nlD = max(0.0, -texture2D(tSdf, nlUV).r);          // distance in from the outline
          vec4 nlPig = texture2D(tPig, nlUV), nlM = texture2D(tMat, nlUV), nlDt = texture2D(tDet, nlUV);
          float nlFilm = clamp(nlPig.a, 0.0, 1.0), nlWet = nlDt.a;
          float nlS = nlSmile(nlP.x), nlFold = nlFoldW(nlP);
          // Bare nail, from the base out: lunula, bed, onychodermal band, free edge.
          float nlFree = smoothstep(nlS - 0.015, nlS + 0.03, nlP.y);
          float nlBand = exp(-pow((nlP.y - (nlS - 0.04)) / 0.03, 2.0));
          float nlLun = 1.0 - smoothstep(0.7, 1.0, length(vec2(nlP.x / 0.30, (nlP.y - 0.02) / 0.27)));
          vec3 nlBare = uBedCol * mix(1.0, 0.93, smoothstep(0.2, uBed, nlP.y));
          nlBare = mix(nlBare, mix(uBedCol, vec3(1.0, 0.96, 0.93), 0.6), nlLun * 0.6);
          nlBare = mix(nlBare, vec3(0.98, 0.9, 0.86), nlBand * 0.35);
          nlBare = mix(nlBare, vec3(0.93, 0.89, 0.82), nlFree);
          nlBare *= 1.0 + 0.03 * (nlNoise(vec2(nlP.x * 60.0, nlP.y * 4.0)) - 0.5);
          vec3 nlCol = nlBare * (1.0 - nlFilm) + nlPig.rgb;
          // Cuticle rim: thin translucent skin over the plate along the proximal edge only.
          float nlProx = (1.0 - smoothstep(uCuticleDepth * 0.9, uCuticleDepth * 1.6, nlP.y));
          float nlRimK = (1.0 - smoothstep(uRim.x * 0.5, uRim.x * 1.8, nlD)) * nlProx * uRim.y;
          nlCol = mix(nlCol, uSkinCol * 1.06, nlRimK * (1.0 - 0.6 * nlFilm));
          // The folds shade the plate where it tucks under them.
          nlCol *= mix(1.0, mix(0.62, 1.0, smoothstep(0.0, 0.075, nlD)), nlFold);
          diffuseColor.rgb = nlCol;`,
        metalnessmap_fragment: /* glsl */`
          float nlRough = mix(0.38, nlM.g, nlFilm);
          nlRough = mix(nlRough, 0.06, nlWet * 0.5 * nlFilm);
          roughnessFactor = nlRough;
          metalnessFactor = nlM.b * nlFilm;`,
        normal_fragment_maps: /* glsl */`
          {
            float ridge = (1.0 - nlFilm) * 0.035 * cos(nlP.x * 150.0 + 3.0 * nlNoise(vec2(nlP.x * 9.0, 0.0)));
            vec2 flake = (nlDt.rg - 0.5) * 2.0 * nlFilm;
            normal = nlTilt(normal, -vViewPosition, nlP, vec2(ridge, 0.0) + flake);
          }`,
        lights_physical_fragment: /* glsl */`
          material.clearcoat = max(0.22 * (1.0 - nlFilm), smoothstep(0.2, 0.8, nlFilm) * (1.0 - smoothstep(0.5, 0.7, nlM.g)));
          material.clearcoat *= 1.0 - nlRimK;
          material.clearcoatRoughness = mix(0.25, 0.03, nlFilm);
          material.iridescence = nlM.a * nlFilm;`,
      },
    });
  m.customProgramCacheKey = () => 'nail-plate-1';
  return m;
}

/** The skin: fold shading around the nail, spilled polish, and (stand-in only) procedural tone. */
export function makeSkinMaterial(uniforms) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0,
    sheen: 0.45, sheenRoughness: 0.5, sheenColor: srgb('#ffb5a0'), clearcoat: 0.06, clearcoatRoughness: 0.5,
  });
  m.onBeforeCompile = (shader) => inject(shader, { ...uniforms },
    'uniform mat4 uWorldToPaint;\nvarying vec3 vPaint;',
    'vPaint = (uWorldToPaint * modelMatrix * vec4(transformed, 1.0)).xyz;', {
      decl: 'varying vec3 vPaint;\nuniform float uProcSkin;',
      after: {
        color_fragment: /* glsl */`
          vec2 skUV = nlUv(vPaint.xy);
          float skIn = step(0.0, skUV.x) * step(skUV.x, 1.0) * step(0.0, skUV.y) * step(skUV.y, 1.0)
                     * smoothstep(-0.6, -0.4, vPaint.z);
          float skSd = mix(9.0, texture2D(tSdf, skUV).r, skIn);
          float skFold = nlFoldW(vPaint.xy) * skIn;
          vec3 skCol = uSkinCol;
          if (uProcSkin > 0.5) {
            float top = smoothstep(-0.9, -0.2, vPaint.z);
            skCol *= mix(vec3(1.06, 0.93, 0.9), vec3(1.0), top);                       // pinker pad
            skCol *= mix(vec3(1.0), vec3(1.05, 0.95, 0.93), smoothstep(-0.3, 0.9, vPaint.y) * 0.6);
            skCol *= 1.0 + 0.05 * (nlNoise(vPaint.xy * 14.0) - 0.5) + 0.03 * (nlNoise(vPaint.xy * 70.0) - 0.5);
            float crease = 0.0;
            for (int i = 0; i < 3; i++) {
              float yc = -1.55 - 0.16 * float(i) + 0.03 * sin(vPaint.x * 5.0 + float(i) * 2.0);
              crease += exp(-pow((vPaint.y - yc) / 0.02, 2.0));
            }
            skCol *= 1.0 - 0.14 * crease * top;
          }
          // Groove: the skin darkens and warms right at the plate.
          float skGroove = (1.0 - smoothstep(0.0, uGroove.x, skSd)) * skFold;
          skCol *= mix(vec3(1.0), vec3(0.74, 0.56, 0.52), skGroove * uGroove.y);
          // Spilled polish sits flatter and thinner on skin than on the nail.
          vec4 skPig = texture2D(tPig, skUV);
          float skFilm = clamp(skPig.a, 0.0, 1.0) * skIn * step(0.0, skSd);
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
  m.customProgramCacheKey = () => 'skin-1';
  return m;
}
