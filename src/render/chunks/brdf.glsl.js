/**
 * Analytic BRDF terms for the metallic-roughness workflow: GGX normal distribution,
 * height correlated Smith visibility, Schlick Fresnel, Lambert / Burley diffuse and
 * the mobile friendly split-sum environment approximation.
 * Include with '#include <brdf>'.
 */
export const brdf = `
#include <common>
#ifndef BRDF_GLSL_INCLUDED
#define BRDF_GLSL_INCLUDED

// Roughness is clamped so the specular lobe never degenerates into a point light
// sized highlight, which would alias badly at 1 sample per pixel.
#ifndef MIN_PERCEPTUAL_ROUGHNESS
#define MIN_PERCEPTUAL_ROUGHNESS 0.045
#endif
#ifndef MIN_ROUGHNESS
#define MIN_ROUGHNESS 0.002025
#endif

/** Trowbridge-Reitz (GGX) normal distribution. 'a' is the linear roughness (perceptual squared). */
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-9);
}

/** Height correlated Smith visibility term (already divided by 4*NoL*NoV). */
float V_SmithGGXCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float lambdaV = NoL * sqrt((NoV - a2 * NoV) * NoV + a2);
  float lambdaL = NoV * sqrt((NoL - a2 * NoL) * NoL + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-6);
}

/** Cheaper approximation of the term above, accurate enough for punctual lights. */
float V_SmithGGXCorrelatedFast(float NoV, float NoL, float a) {
  float v = mix(2.0 * NoL * NoV, NoL + NoV, a);
  return 0.5 / max(v, 1e-6);
}

/** Kelemen visibility, used for clear coat layers. */
float V_Kelemen(float LoH) {
  return 0.25 / max(LoH * LoH, 1e-6);
}

/** Neubelt visibility for cloth / sheen lobes. */
float V_Neubelt(float NoV, float NoL) {
  return 1.0 / max(4.0 * (NoL + NoV - NoL * NoV), 1e-6);
}

/** Ashikhmin-Premoze inverted gaussian distribution used for sheen. */
float D_Charlie(float NoH, float roughness) {
  float invAlpha = 1.0 / max(roughness, 1e-4);
  float cos2h = NoH * NoH;
  float sin2h = max(1.0 - cos2h, 1e-4);
  return (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * PI);
}

/** Schlick Fresnel with an explicit grazing reflectance. */
vec3 F_Schlick(vec3 f0, float f90, float VoH) {
  return f0 + (vec3(f90) - f0) * pow5(1.0 - VoH);
}
float F_Schlick(float f0, float f90, float VoH) {
  return f0 + (f90 - f0) * pow5(1.0 - VoH);
}
/** Schlick Fresnel assuming a grazing reflectance of 1. */
vec3 F_SchlickWhite(vec3 f0, float VoH) {
  return f0 + (vec3(1.0) - f0) * pow5(1.0 - VoH);
}

/** Normalized Lambertian diffuse. */
float Fd_Lambert() { return INV_PI; }

/** Disney / Burley diffuse, energy conserving and roughness aware. */
float Fd_Burley(float NoV, float NoL, float LoH, float perceptualRoughness) {
  float f90 = 0.5 + 2.0 * perceptualRoughness * LoH * LoH;
  float lightScatter = F_Schlick(1.0, f90, NoL);
  float viewScatter = F_Schlick(1.0, f90, NoV);
  return lightScatter * viewScatter * INV_PI;
}

/** Analytic split-sum environment BRDF (Karis, mobile approximation). */
vec3 EnvBRDFApprox(vec3 f0, float perceptualRoughness, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = perceptualRoughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

/** Same as above but returning the raw scale/bias pair (matches a BRDF LUT fetch). */
vec2 EnvBRDFApproxLUT(float perceptualRoughness, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = perceptualRoughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

/** Multi-scatter energy compensation factor for the specular lobe. */
vec3 energyCompensation(vec3 f0, vec2 dfg) {
  return 1.0 + f0 * (1.0 / max(dfg.y, 1e-4) - 1.0);
}

/** Normal incidence reflectance of a dielectric from its index of refraction. */
float iorToF0(float ior) {
  float k = (ior - 1.0) / (ior + 1.0);
  return k * k;
}

/** Remap the artist facing 0..1 reflectance parameter to a dielectric f0. */
float reflectanceToF0(float reflectance) {
  return 0.16 * reflectance * reflectance;
}

/** Grazing reflectance derived from f0, kills the rim glow of very dark materials. */
float computeF90(vec3 f0) {
  return saturate(dot(f0, vec3(50.0 * 0.33)));
}

/** Convert perceptual roughness to the linear roughness used by D and V. */
float perceptualRoughnessToRoughness(float perceptualRoughness) {
  float r = clamp(perceptualRoughness, float(MIN_PERCEPTUAL_ROUGHNESS), 1.0);
  return r * r;
}

#ifdef FRAGMENT_SHADER
/** Filter the normal map derivatives into roughness to reduce specular aliasing. */
float geometricNormalFiltering(float perceptualRoughness, vec3 worldNormal) {
  vec3 du = dFdx(worldNormal);
  vec3 dv = dFdy(worldNormal);
  float variance = 0.25 * (dot(du, du) + dot(dv, dv));
  float a = perceptualRoughness * perceptualRoughness;
  float kernelRoughness = min(2.0 * variance, 0.18);
  return saturate(sqrt(a + kernelRoughness));
}
#endif

#endif
`;
