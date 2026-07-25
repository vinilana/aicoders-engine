/**
 * Common GLSL helpers shared by every shader: math constants, saturate overloads,
 * colour space conversions, cheap hashes and octahedral normal packing.
 * Include with '#include <common>'.
 */
export const common = `
#ifndef COMMON_GLSL_INCLUDED
#define COMMON_GLSL_INCLUDED

#define PI            3.14159265359
#define PI2           6.28318530718
#define HALF_PI       1.57079632679
#define INV_PI        0.31830988618
#define INV_PI2       0.15915494309
#define EPS           1e-6
#define FLT_EPS       1.19209290e-7
#define LOG2          1.442695
#define FLT_MAX       3.402823466e+38

/** Clamp to the [0,1] range. */
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2  saturate(vec2 x)  { return clamp(x, 0.0, 1.0); }
vec3  saturate(vec3 x)  { return clamp(x, 0.0, 1.0); }
vec4  saturate(vec4 x)  { return clamp(x, 0.0, 1.0); }

/** x squared / x to the fifth, cheaper than pow(). */
float pow2(float x) { return x * x; }
vec3  pow2(vec3 x)  { return x * x; }
float pow4(float x) { float x2 = x * x; return x2 * x2; }
float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }
vec3  pow5(vec3 x)  { vec3 x2 = x * x; return x2 * x2 * x; }

/** Largest / smallest component. */
float max3(vec3 v) { return max(v.x, max(v.y, v.z)); }
float min3(vec3 v) { return min(v.x, min(v.y, v.z)); }
float maxComponent(vec4 v) { return max(max(v.x, v.y), max(v.z, v.w)); }

/** Perceptual luminance of a linear RGB colour (Rec. 709). */
float luminance(vec3 linearColor) {
  return dot(linearColor, vec3(0.2126, 0.7152, 0.0722));
}

/** Normalize guarding against zero-length input. */
vec3 safeNormalize(vec3 v) {
  float len = dot(v, v);
  return len > 0.0 ? v * inversesqrt(len) : vec3(0.0, 0.0, 1.0);
}

/** Remap a value from [a,b] into [0,1]. */
float remap01(float v, float a, float b) { return saturate((v - a) / max(b - a, EPS)); }

/** Linear step, i.e. smoothstep without the hermite curve. */
float linearstep(float e0, float e1, float x) { return saturate((x - e0) / max(e1 - e0, EPS)); }

/** sRGB electro-optical transfer functions. Lighting always happens in linear space. */
float sRGBToLinear(float c) {
  c = max(c, 0.0);
  return c <= 0.04045 ? c * 0.0773993808 : pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
vec3 sRGBToLinear(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 low = c * 0.0773993808;
  vec3 high = pow(c * 0.9478672986 + 0.0521327014, vec3(2.4));
  return mix(high, low, step(c, vec3(0.04045)));
}
vec4 sRGBToLinear(vec4 c) { return vec4(sRGBToLinear(c.rgb), c.a); }

float linearToSRGB(float c) {
  c = max(c, 0.0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 0.41666) - 0.055;
}
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(0.41666)) - 0.055;
  return mix(high, low, step(c, vec3(0.0031308)));
}
vec4 linearToSRGB(vec4 c) { return vec4(linearToSRGB(c.rgb), c.a); }

/** Fast approximate gamma 2.2 conversions (use when precision is not critical). */
vec3 gammaToLinearFast(vec3 c) { return c * c; }
vec3 linearToGammaFast(vec3 c) { return sqrt(max(c, vec3(0.0))); }

/** Cheap deterministic hashes (no Math.random equivalent on the GPU). */
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
/** Classic screen-space pseudo random, kept for compatibility. */
float rand(vec2 co) { return hash12(co); }

/** Rotate a 2D vector by an angle in radians. */
vec2 rotate2D(vec2 v, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

/** Octahedral normal encoding: unit vector <-> two components. */
vec2 octWrap(vec2 v) {
  return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z) + EPS);
  n.xy = n.z >= 0.0 ? n.xy : octWrap(n.xy);
  return n.xy;
}
vec3 octDecode(vec2 f) {
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
/** Packed into the [0,1] range, ready for an RG8/RG16 render target. */
vec2 packNormalOct(vec3 n) { return octEncode(n) * 0.5 + 0.5; }
vec3 unpackNormalOct(vec2 f) { return octDecode(f * 2.0 - 1.0); }

/** Pack a [0,1] float into RGBA8 and back (portable depth storage). */
vec4 packFloatToRGBA(float v) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}
float unpackRGBAToFloat(vec4 v) {
  return dot(v, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

/** Build an orthonormal basis around a unit vector (Duff et al. 2017). */
void branchlessONB(vec3 n, out vec3 t, out vec3 b) {
  float sgn = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (sgn + n.z);
  float d = n.x * n.y * a;
  t = vec3(1.0 + sgn * n.x * n.x * a, sgn * d, -sgn * n.x);
  b = vec3(d, sgn + n.y * n.y * a, -n.y);
}

#endif
`;
