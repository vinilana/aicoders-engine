/**
 * Surface shading: the MaterialInputs / PixelParams structs every lit shader builds,
 * plus the directional and punctual light evaluators. Attenuation follows the
 * physically based inverse square law with a smooth range cutoff window, and spot
 * cones use the standard smooth angular falloff.
 * Include with '#include <lighting>'.
 */
export const lighting = `
#include <common>
#include <brdf>
#include <lights_ubo>
#ifndef LIGHTING_GLSL_INCLUDED
#define LIGHTING_GLSL_INCLUDED

// Light type tags, mirrored by ClusteredLighting when it packs uLightData.
#define LIGHT_TYPE_POINT 0.0
#define LIGHT_TYPE_SPOT  1.0

/**
 * What a material shader fills in before shading. Values are already resolved
 * (textures sampled, normal mapped, colour space converted to linear).
 */
struct MaterialInputs {
  vec3  baseColor;          // linear albedo
  float opacity;
  float metallic;
  float perceptualRoughness;
  float occlusion;          // baked ambient occlusion, 1 = unoccluded
  float reflectance;        // dielectric reflectance parameter, 0.5 = 4% f0
  vec3  emissive;           // linear, already multiplied by its intensity
  vec3  normal;             // world space shading normal (normal mapped)
  vec3  geometricNormal;    // world space interpolated vertex normal
};

/** Everything derived once per pixel and reused by every light. */
struct PixelParams {
  vec3  diffuseColor;
  vec3  f0;
  float f90;
  float perceptualRoughness;
  float roughness;          // linear roughness = perceptual^2
  vec3  N;
  vec3  V;
  vec3  R;                  // reflection vector, for IBL
  float NoV;
  vec3  position;           // world space
  vec3  geometricNormal;
  float occlusion;
};

/** A point or spot light, unpacked from the clustered light data texture. */
struct PunctualLight {
  vec3  position;           // world space
  float range;              // cutoff distance, <= 0 means unbounded
  vec3  color;              // linear colour multiplied by intensity
  float intensity;
  vec3  direction;          // spot axis, pointing away from the light
  float innerConeCos;
  float outerConeCos;
  float type;               // LIGHT_TYPE_POINT or LIGHT_TYPE_SPOT
  float shadowIndex;        // < 0 when the light casts no shadow
};

/** Sensible defaults so a shader can fill only the fields it cares about. */
MaterialInputs defaultMaterialInputs() {
  MaterialInputs m;
  m.baseColor = vec3(1.0);
  m.opacity = 1.0;
  m.metallic = 0.0;
  m.perceptualRoughness = 1.0;
  m.occlusion = 1.0;
  m.reflectance = 0.5;
  m.emissive = vec3(0.0);
  m.normal = vec3(0.0, 1.0, 0.0);
  m.geometricNormal = vec3(0.0, 1.0, 0.0);
  return m;
}

/** Derive the per pixel shading parameters from the material inputs. */
PixelParams computePixelParams(const MaterialInputs m, vec3 worldPos, vec3 viewDir) {
  PixelParams px;
  float metallic = saturate(m.metallic);
  px.perceptualRoughness = clamp(m.perceptualRoughness, float(MIN_PERCEPTUAL_ROUGHNESS), 1.0);
  px.roughness = px.perceptualRoughness * px.perceptualRoughness;
  px.diffuseColor = m.baseColor * (1.0 - metallic);
  float dielectricF0 = reflectanceToF0(m.reflectance);
  px.f0 = mix(vec3(dielectricF0), m.baseColor, metallic);
  px.f90 = computeF90(px.f0);
  px.N = normalize(m.normal);
  px.V = normalize(viewDir);
  px.NoV = max(dot(px.N, px.V), 1e-4);
  px.R = reflect(-px.V, px.N);
  px.position = worldPos;
  px.geometricNormal = normalize(m.geometricNormal);
  px.occlusion = saturate(m.occlusion);
  return px;
}

/**
 * Core shading for one light direction.
 * L is the unit vector pointing from the surface towards the light,
 * radiance is colour * intensity, attenuation folds distance and cone falloff.
 */
vec3 surfaceShading(const PixelParams px, vec3 L, vec3 radiance, float attenuation, float shadow) {
  float visibility = attenuation * shadow;
  float NoL = saturate(dot(px.N, L));
  if (NoL <= 0.0 || visibility <= 0.0) return vec3(0.0);

  vec3 H = normalize(px.V + L);
  float NoH = saturate(dot(px.N, H));
  float LoH = saturate(dot(L, H));

  float D = D_GGX(NoH, px.roughness);
  float Vis = V_SmithGGXCorrelated(px.NoV, NoL, px.roughness);
  vec3 F = F_Schlick(px.f0, px.f90, LoH);

  vec3 Fr = (D * Vis) * F;
  vec3 Fd = px.diffuseColor * Fd_Burley(px.NoV, NoL, LoH, px.perceptualRoughness);

  return (Fd + Fr) * radiance * (NoL * visibility);
}

/** Smooth window that forces the inverse square falloff to reach zero at 'range'. */
float smoothRangeWindow(float distanceSquared, float invRangeSquared) {
  float factor = distanceSquared * invRangeSquared;
  float smoothFactor = saturate(1.0 - factor * factor);
  return smoothFactor * smoothFactor;
}

/** Physically based distance attenuation with a smooth cutoff at the light range. */
float getDistanceAttenuation(vec3 surfaceToLight, float range) {
  float distanceSquared = dot(surfaceToLight, surfaceToLight);
  float attenuation = 1.0 / max(distanceSquared, 1e-4);
  if (range > 0.0) {
    attenuation *= smoothRangeWindow(distanceSquared, 1.0 / max(range * range, 1e-8));
  }
  return attenuation;
}

/** Smooth spot cone falloff between the inner and outer cosine. */
float getSpotAttenuation(vec3 lightToSurface, vec3 spotDirection, float innerConeCos, float outerConeCos) {
  float cd = dot(normalize(spotDirection), lightToSurface);
  float t = saturate((cd - outerConeCos) / max(innerConeCos - outerConeCos, 1e-4));
  return t * t;
}

/** Evaluate one directional light slot of the Lights uniform block. */
vec3 evaluateDirectionalLight(const PixelParams px, int index, float shadow) {
  vec3 L = normalize(uDirLightDir[index].xyz);
  vec3 radiance = uDirLightColor[index].rgb;
  float lightShadow = uDirLightDir[index].w > 0.5 ? shadow : 1.0;
  return surfaceShading(px, L, radiance, 1.0, lightShadow);
}

/** Accumulate every active directional light. 'shadow' only applies to casters. */
vec3 evaluateDirectionalLights(const PixelParams px, float shadow) {
  vec3 result = vec3(0.0);
  int count = getDirectionalLightCount();
  for (int i = 0; i < DIR_LIGHT_SLOTS; ++i) {
    if (i >= count) break;
    result += evaluateDirectionalLight(px, i, shadow);
  }
  return result;
}

/** Evaluate a point or spot light. */
vec3 evaluatePunctualLight(const PixelParams px, const PunctualLight light, float shadow) {
  vec3 surfaceToLight = light.position - px.position;
  float distanceSquared = dot(surfaceToLight, surfaceToLight);
  if (light.range > 0.0 && distanceSquared > light.range * light.range) return vec3(0.0);

  float invDistance = inversesqrt(max(distanceSquared, 1e-8));
  vec3 L = surfaceToLight * invDistance;

  float attenuation = getDistanceAttenuation(surfaceToLight, light.range);
  if (light.type > 0.5) {
    attenuation *= getSpotAttenuation(-L, light.direction, light.innerConeCos, light.outerConeCos);
  }
  if (attenuation <= 0.0) return vec3(0.0);

  return surfaceShading(px, L, light.color, attenuation, shadow);
}

/** Flat ambient term for scenes without image based lighting. */
vec3 evaluateAmbient(const PixelParams px) {
  return getAmbientLight() * px.diffuseColor * px.occlusion;
}

/** Wrapped diffuse used by foliage / subsurface-ish materials. */
float diffuseWrap(float NoL, float wrap) {
  return saturate((NoL + wrap) / max((1.0 + wrap) * (1.0 + wrap), EPS));
}

#endif
`;
