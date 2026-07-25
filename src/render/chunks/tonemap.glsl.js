/**
 * Tone mapping operators and the final display transform. Everything upstream of
 * this chunk works in linear HDR; only the very last pass may call these.
 * Include with '#include <tonemap>'.
 */
export const tonemap = `
#include <common>
#ifndef TONEMAP_GLSL_INCLUDED
#define TONEMAP_GLSL_INCLUDED

// Tone mapping modes, mirrored by Renderer.toneMapping / PostProcessing.setToneMapping.
#define TONEMAP_NONE       0
#define TONEMAP_LINEAR     1
#define TONEMAP_REINHARD   2
#define TONEMAP_ACES       3
#define TONEMAP_ACES_FIT   4
#define TONEMAP_UNCHARTED2 5
#define TONEMAP_AGX        6

/** Scale scene referred radiance by the camera exposure. */
vec3 applyExposure(vec3 color, float exposure) { return color * exposure; }

/** Simple Reinhard, keeps highlights but desaturates them quickly. */
vec3 tonemapReinhard(vec3 color) {
  return color / (color + vec3(1.0));
}

/** Extended Reinhard with a configurable white point. */
vec3 tonemapReinhardExtended(vec3 color, float whitePoint) {
  float w2 = max(whitePoint * whitePoint, EPS);
  vec3 numerator = color * (1.0 + color / w2);
  return numerator / (1.0 + color);
}

/** Luminance only Reinhard, preserves hue and saturation far better. */
vec3 tonemapReinhardLuminance(vec3 color, float whitePoint) {
  float l = luminance(color);
  float w2 = max(whitePoint * whitePoint, EPS);
  float lNew = (l * (1.0 + l / w2)) / (1.0 + l);
  return color * (lNew / max(l, EPS));
}

/** ACES filmic approximation by Krzysztof Narkowicz - one multiply-add, very fast. */
vec3 tonemapACESNarkowicz(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

// sRGB primaries <-> ACES 2065-1 / ACEScg working space, from Stephen Hill's fit.
const mat3 ACES_INPUT_MAT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUTPUT_MAT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/** ACES filmic, Stephen Hill's "fitted" version: more accurate, slightly costlier. */
vec3 tonemapACESFitted(vec3 color) {
  color = ACES_INPUT_MAT * color;
  color = RRTAndODTFit(color);
  color = ACES_OUTPUT_MAT * color;
  return saturate(color);
}

/** Uncharted 2 filmic curve (John Hable). */
vec3 uncharted2Partial(vec3 x) {
  const float A = 0.15;
  const float B = 0.50;
  const float C = 0.10;
  const float D = 0.20;
  const float E = 0.02;
  const float F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 tonemapUncharted2(vec3 color) {
  const float W = 11.2;
  vec3 curr = uncharted2Partial(color * 2.0);
  vec3 whiteScale = vec3(1.0) / uncharted2Partial(vec3(W));
  return saturate(curr * whiteScale);
}

/** AgX-like contrast curve, gentle highlight rolloff with strong hue retention. */
vec3 tonemapAgX(vec3 color) {
  color = max(color, vec3(0.0));
  vec3 v = pow(color / (color + vec3(1.0)), vec3(1.0 / 2.2));
  vec3 x = saturate(v);
  return saturate(x * x * (3.0 - 2.0 * x));
}

/** Dispatch helper: keeps the permutation count down by branching on a uniform. */
vec3 tonemap(vec3 color, int mode) {
  if (mode == TONEMAP_NONE) return color;
  if (mode == TONEMAP_LINEAR) return saturate(color);
  if (mode == TONEMAP_REINHARD) return tonemapReinhardExtended(color, 4.0);
  if (mode == TONEMAP_ACES) return tonemapACESNarkowicz(color);
  if (mode == TONEMAP_ACES_FIT) return tonemapACESFitted(color);
  if (mode == TONEMAP_UNCHARTED2) return tonemapUncharted2(color);
  if (mode == TONEMAP_AGX) return tonemapAgX(color);
  return color;
}

/** Full display transform: exposure -> tone curve -> sRGB encode. */
vec3 displayTransform(vec3 hdrColor, float exposure, int mode) {
  return linearToSRGB(tonemap(applyExposure(hdrColor, exposure), mode));
}

/** Explicit gamma helpers for shaders that need a non standard gamma. */
vec3 applyGamma(vec3 color, float gamma) { return pow(max(color, vec3(0.0)), vec3(1.0 / max(gamma, EPS))); }
vec3 removeGamma(vec3 color, float gamma) { return pow(max(color, vec3(0.0)), vec3(max(gamma, EPS))); }

/** Inverse of the Narkowicz curve, used when blending LDR content into an HDR buffer. */
vec3 tonemapACESInverse(vec3 x) {
  x = saturate(x);
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  vec3 t = d * x - b;
  vec3 disc = sqrt(max(t * t - 4.0 * e * x * (c * x - a), vec3(0.0)));
  return (t + disc) / (2.0 * (a - c * x));
}

#endif
`;
