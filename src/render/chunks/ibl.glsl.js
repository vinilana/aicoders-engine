/**
 * Image based lighting, split-sum approximation (Karis 2013).
 *
 * Textures produced by IBL.js:
 *   unit 11  uIrradianceMap   samplerCube, 32^2, cosine convolved irradiance
 *   unit 12  uPrefilteredMap  samplerCube, 128^2 with 6 mips, GGX prefiltered radiance
 *   unit 13  uBRDFLUT         sampler2D, 256^2, the (scale, bias) DFG term
 *
 * uIBLParams = (intensity, maxMipLevel, horizonOcclusion, unused). It is a plain
 * per frame uniform, not part of a UBO. When it is left at zero the accessors fall
 * back to an intensity of 1 and derive the mip count from the texture size, so a
 * shader still renders correctly if the renderer forgets to set it.
 *
 * Include with '#include <ibl>'.
 */
export const ibl = `
#include <common>
#include <brdf>
#ifndef IBL_GLSL_INCLUDED
#define IBL_GLSL_INCLUDED

uniform highp samplerCube uIrradianceMap;
uniform highp samplerCube uPrefilteredMap;
uniform highp sampler2D uBRDFLUT;
uniform vec4 uIBLParams;

/** Global scale applied to every environment contribution. */
float getIBLIntensity() {
  return uIBLParams.x > 0.0 ? uIBLParams.x : 1.0;
}

/** Highest valid mip of the prefiltered radiance cube. */
float getIBLMaxMip() {
  if (uIBLParams.y > 0.0) return uIBLParams.y;
  return max(floor(log2(float(textureSize(uPrefilteredMap, 0).x))) - 1.0, 0.0);
}

/**
 * Map perceptual roughness to a mip level. The curve is the standard Karis fit,
 * which compensates for the fact that the prefiltered mips are not linear in
 * roughness.
 */
float roughnessToMip(float perceptualRoughness, float maxMip) {
  float r = saturate(perceptualRoughness);
  return maxMip * r * (2.0 - r);
}

/** Diffuse irradiance arriving at a surface with normal N. */
vec3 getIBLIrradiance(vec3 N) {
  return texture(uIrradianceMap, N).rgb * getIBLIntensity();
}

/** Prefiltered specular radiance along the reflection vector. */
vec3 getIBLRadiance(vec3 R, float perceptualRoughness) {
  float mip = roughnessToMip(perceptualRoughness, getIBLMaxMip());
  return textureLod(uPrefilteredMap, R, mip).rgb * getIBLIntensity();
}

/** The precomputed DFG term, or its analytic approximation as a fallback. */
vec2 getIBLDFG(float NoV, float perceptualRoughness) {
#ifdef USE_BRDF_LUT_APPROX
  return EnvBRDFApproxLUT(perceptualRoughness, NoV);
#else
  return texture(uBRDFLUT, vec2(NoV, perceptualRoughness)).rg;
#endif
}

/**
 * Specular occlusion derived from the diffuse AO term (Lagarde). Prevents fully
 * occluded cavities from still receiving a bright environment reflection.
 */
float computeSpecularOcclusion(float NoV, float ao, float roughness) {
  return saturate(pow(NoV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}

/**
 * Fade reflections that point below the geometric horizon, which removes the
 * light leaking typical of normal mapped surfaces.
 */
float horizonOcclusion(vec3 R, vec3 geometricNormal) {
  float horizon = min(1.0 + dot(R, geometricNormal), 1.0);
  return horizon * horizon;
}

/**
 * Full environment contribution.
 *
 * @param N          world space shading normal
 * @param R          world space reflection vector
 * @param NoV        saturated dot(N, V)
 * @param diffuseColor albedo * (1 - metallic)
 * @param f0         specular reflectance at normal incidence
 * @param perceptualRoughness artist facing roughness
 * @param occlusion  ambient occlusion, 1 = unoccluded
 */
vec3 evaluateIBL(vec3 N, vec3 R, float NoV, vec3 diffuseColor, vec3 f0,
                 float perceptualRoughness, float occlusion) {
  vec2 dfg = getIBLDFG(NoV, perceptualRoughness);

  vec3 irradiance = getIBLIrradiance(N);
  vec3 diffuse = diffuseColor * irradiance * occlusion;

  vec3 radiance = getIBLRadiance(R, perceptualRoughness);
  vec3 specularColor = f0 * dfg.x + vec3(dfg.y);
  float specOcclusion = computeSpecularOcclusion(NoV, occlusion, perceptualRoughness * perceptualRoughness);
  vec3 specular = radiance * specularColor * specOcclusion;

  // Multi scattering energy compensation keeps rough metals from going too dark.
  specular *= energyCompensation(f0, dfg);

  return diffuse + specular;
}

/** Variant that also fades reflections below the geometric horizon. */
vec3 evaluateIBLWithHorizon(vec3 N, vec3 R, vec3 geometricNormal, float NoV, vec3 diffuseColor,
                            vec3 f0, float perceptualRoughness, float occlusion) {
  vec2 dfg = getIBLDFG(NoV, perceptualRoughness);

  vec3 diffuse = diffuseColor * getIBLIrradiance(N) * occlusion;

  vec3 radiance = getIBLRadiance(R, perceptualRoughness);
  vec3 specularColor = f0 * dfg.x + vec3(dfg.y);
  float specOcclusion = computeSpecularOcclusion(NoV, occlusion, perceptualRoughness * perceptualRoughness);
  vec3 specular = radiance * specularColor * specOcclusion * horizonOcclusion(R, geometricNormal);
  specular *= energyCompensation(f0, dfg);

  return diffuse + specular;
}

/**
 * Bend the reflection vector towards the dominant direction of the GGX lobe.
 * Noticeably improves rough reflections compared to the plain mirror vector.
 */
vec3 getReflectedVector(vec3 N, vec3 V, float roughness) {
  vec3 R = reflect(-V, N);
  return normalize(mix(R, N, roughness * roughness));
}

#endif
`;
