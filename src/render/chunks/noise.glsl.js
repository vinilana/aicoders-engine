/**
 * Deterministic procedural noise: integer hashes, value noise, fbm and the
 * blue-noise-like screen space dither used to rotate shadow PCF kernels.
 * Include with '#include <noise>'.
 */
export const noise = `
#include <common>
#ifndef NOISE_GLSL_INCLUDED
#define NOISE_GLSL_INCLUDED

/** Scalar hash of a 3D lattice point, in [0,1). */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

/** Vector hash of a 3D lattice point, each component in [0,1). */
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

/** Vector hash of a 2D lattice point. */
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

/** Quintic interpolant, C2 continuous, avoids the visible grid of the cubic one. */
vec3 quinticFade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
vec2 quinticFade(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

/** Trilinear value noise in [0,1]. */
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = quinticFade(f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

/** Bilinear value noise in [0,1]. */
float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = quinticFade(f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Gradient (Perlin style) noise in roughly [-1,1]. */
float gradientNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = quinticFade(f);
  float v = 0.0;
  for (int cz = 0; cz < 2; ++cz) {
    for (int cy = 0; cy < 2; ++cy) {
      for (int cx = 0; cx < 2; ++cx) {
        vec3 o = vec3(float(cx), float(cy), float(cz));
        vec3 g = normalize(hash3(i + o) * 2.0 - 1.0);
        float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
        v += w * dot(g, f - o);
      }
    }
  }
  return v * 2.0;
}

/** Fractal brownian motion over value noise. Octaves are clamped to 8. */
float fbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= octaves) break;
    sum += amplitude * valueNoise3(p);
    norm += amplitude;
    amplitude *= 0.5;
    p *= 2.02;
  }
  return sum / max(norm, EPS);
}

/** Two dimensional variant of the above. */
float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= octaves) break;
    sum += amplitude * valueNoise2(p);
    norm += amplitude;
    amplitude *= 0.5;
    p *= 2.02;
  }
  return sum / max(norm, EPS);
}

/** Ridged fbm, useful for terrain and cloud shapes. */
float ridgedFbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; ++i) {
    if (i >= octaves) break;
    float n = 1.0 - abs(valueNoise3(p) * 2.0 - 1.0);
    sum += amplitude * n * n;
    norm += amplitude;
    amplitude *= 0.5;
    p *= 2.02;
  }
  return sum / max(norm, EPS);
}

/** Curl-free rotation of the domain, breaks up axis aligned artefacts in fbm. */
vec3 domainWarp(vec3 p, float strength) {
  return p + strength * vec3(valueNoise3(p + 17.3), valueNoise3(p + 47.9), valueNoise3(p + 83.1));
}

/**
 * Interleaved gradient noise (Jimenez 2014). Very cheap, spectrally close to blue
 * noise, and the canonical choice for rotating sampling kernels per pixel.
 */
float interleavedGradientNoise(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}

/** Temporally animated variant using the golden ratio sequence over the frame index. */
float interleavedGradientNoise(vec2 fragCoord, float frame) {
  vec2 p = fragCoord + 5.588238 * fract(frame * 0.6180339887);
  return interleavedGradientNoise(p);
}

/** Alias with an explicit name, matches the naming used by the post processing passes. */
float blueNoise(vec2 fragCoord, float frame) {
  return interleavedGradientNoise(fragCoord, frame);
}

/** Triangular probability density dither, for cheap banding removal on 8 bit targets. */
float triangularDither(vec2 fragCoord, float frame) {
  float r0 = hash12(fragCoord + frame * 0.7071);
  float r1 = hash12(fragCoord.yx + frame * 0.5773 + 19.19);
  return (r0 + r1) - 1.0;
}

#endif
`;
