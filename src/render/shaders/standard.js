/**
 * The 'standard' program: physically based metallic-roughness shading.
 *
 * This is the main lit shader of the engine. Everything it needs already lives in
 * the reusable chunks, so the program itself is only the plumbing: attribute
 * decoding, texture sampling and the order in which the light contributions are
 * accumulated.
 *
 * Lighting is evaluated entirely in LINEAR space and written to colour attachment 0
 * in HDR. The tone map + sRGB encode is the job of PostProcessing; it only happens
 * here when USE_TONEMAP is defined, which the renderer does when it draws straight
 * to the default framebuffer with no post chain.
 *
 * Per object uniforms (set by the renderer):
 *   uModelMatrix, uNormalMatrix, and uPrevModelMatrix / uPrevViewProj under
 *   USE_MOTION_VECTORS.
 *
 * Per material uniforms (set by StandardMaterial):
 *   uBaseColorFactor, uEmissiveFactor, uMetallic, uRoughness, uReflectance,
 *   uNormalScale, uOcclusionStrength, uAlphaCutoff, uUVTransform and the five
 *   texture maps on their fixed units.
 */

/** Vertex stage. */
export const vertex = `#version 300 es

#include <common>
#include <camera_ubo>
#include <instancing>
#include <skinning>

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV0;
#ifdef USE_TANGENT
layout(location = 3) in vec4 aTangent;
#endif
#ifdef USE_VERTEX_COLOR
layout(location = 4) in vec4 aColor;
#endif
#ifdef USE_UV1
layout(location = 5) in vec2 aUV1;
#endif

uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;

#ifdef USE_UV_TRANSFORM
uniform mat3 uUVTransform;
#endif

#ifdef USE_MOTION_VECTORS
uniform mat4 uPrevModelMatrix;
uniform mat4 uPrevViewProj;
#endif

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV0;
out float vViewDepth;
#ifdef USE_UV1
out vec2 vUV1;
#endif
#ifdef USE_TANGENT
out vec4 vTangent;
#endif
#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
out vec4 vColor;
#endif
#ifdef USE_MOTION_VECTORS
out vec4 vCurrentClip;
out vec4 vPreviousClip;
#endif

void main() {
  vec3 objectPosition = aPosition;
  vec3 objectNormal = aNormal;
#ifdef USE_TANGENT
  vec3 objectTangent = aTangent.xyz;
#endif

#ifdef USE_SKINNING
  mat4 skinMatrix = getSkinningMatrix();
  objectPosition = skinPosition(objectPosition, skinMatrix);
  mat3 skinRotation = mat3(skinMatrix);
  objectNormal = skinRotation * objectNormal;
  #ifdef USE_TANGENT
  objectTangent = skinRotation * objectTangent;
  #endif
#endif

  mat4 modelMatrix = getModelMatrix(uModelMatrix);
  vec4 worldPosition = modelMatrix * vec4(objectPosition, 1.0);
  vWorldPos = worldPosition.xyz;

  // The node normal matrix only covers uModelMatrix, so the per instance part has
  // to be folded in here: inverseTranspose(A*B) == inverseTranspose(A) * inverseTranspose(B).
  mat3 normalMatrix = uNormalMatrix;
#ifdef USE_INSTANCING
  #ifdef USE_INSTANCE_EXACT_NORMALS
  normalMatrix = normalMatrix * getInstanceNormalMatrix(getInstanceMatrix());
  #else
  normalMatrix = normalMatrix * getInstanceNormalMatrixFast(getInstanceMatrix());
  #endif
#endif
  vNormal = normalMatrix * objectNormal;

#ifdef USE_TANGENT
  // Tangents transform with the model matrix itself, never with its inverse transpose.
  vTangent = vec4(mat3(modelMatrix) * objectTangent, aTangent.w);
#endif

#ifdef USE_UV_TRANSFORM
  vUV0 = (uUVTransform * vec3(aUV0, 1.0)).xy;
  #ifdef USE_UV1
  vUV1 = (uUVTransform * vec3(aUV1, 1.0)).xy;
  #endif
#else
  vUV0 = aUV0;
  #ifdef USE_UV1
  vUV1 = aUV1;
  #endif
#endif

#if defined(USE_VERTEX_COLOR) && defined(USE_INSTANCE_COLOR)
  vColor = aColor * getInstanceColor();
#elif defined(USE_VERTEX_COLOR)
  vColor = aColor;
#elif defined(USE_INSTANCE_COLOR)
  vColor = getInstanceColor();
#endif

  vec4 viewPosition = uView * worldPosition;
  vViewDepth = -viewPosition.z;

  vec4 clipPosition = uProj * viewPosition;
  gl_Position = clipPosition;

#ifdef USE_MOTION_VECTORS
  mat4 previousModel = uPrevModelMatrix;
  #ifdef USE_INSTANCING
  // Instance transforms carry no history, so the current one is reused; only the
  // node level motion produces velocity for instanced draws.
  previousModel = previousModel * getInstanceMatrix();
  #endif
  vCurrentClip = clipPosition;
  vPreviousClip = uPrevViewProj * (previousModel * vec4(objectPosition, 1.0));
#endif
}
`;

/** Fragment stage. */
export const fragment = `#version 300 es
precision highp float;
precision highp int;

#include <common>
#include <camera_ubo>
#include <lights_ubo>
#include <brdf>
#include <lighting>
#include <normal_mapping>

#ifdef USE_CLUSTERED
#include <cluster>
#endif
#ifdef USE_SHADOWS
#include <shadow>
#endif
#ifdef USE_IBL
#include <ibl>
#endif
#ifdef USE_FOG
#include <fog>
#endif
#ifdef USE_TONEMAP
#include <tonemap>
#endif

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV0;
in float vViewDepth;
#ifdef USE_UV1
in vec2 vUV1;
#endif
#ifdef USE_TANGENT
in vec4 vTangent;
#endif
#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
in vec4 vColor;
#endif
#ifdef USE_MOTION_VECTORS
in vec4 vCurrentClip;
in vec4 vPreviousClip;
#endif

// Which UV set feeds each map. glTF allows any texture to reference TEXCOORD_1,
// so every slot gets its own opt in define; without it everything uses UV0.
#ifdef USE_UV1
#define SECONDARY_UV vUV1
#else
#define SECONDARY_UV vUV0
#endif

#ifdef BASECOLOR_UV1
#define BASECOLOR_UV SECONDARY_UV
#else
#define BASECOLOR_UV vUV0
#endif
#ifdef NORMAL_UV1
#define NORMAL_UV SECONDARY_UV
#else
#define NORMAL_UV vUV0
#endif
#ifdef MR_UV1
#define MR_UV SECONDARY_UV
#else
#define MR_UV vUV0
#endif
#ifdef OCCLUSION_UV1
#define OCCLUSION_UV SECONDARY_UV
#else
#define OCCLUSION_UV vUV0
#endif
#ifdef EMISSIVE_UV1
#define EMISSIVE_UV SECONDARY_UV
#else
#define EMISSIVE_UV vUV0
#endif

uniform vec4 uBaseColorFactor;   // rgb = linear albedo, a = opacity
uniform vec3 uEmissiveFactor;    // linear, already scaled by emissiveIntensity
uniform float uMetallic;
uniform float uRoughness;
uniform float uReflectance;      // 0.5 -> 4% dielectric f0, derived from ior on the CPU

#ifdef ALPHA_MODE_MASK
uniform float uAlphaCutoff;
#endif
#ifdef USE_BASECOLOR_MAP
uniform sampler2D uBaseColorMap;
#endif
#ifdef USE_NORMAL_MAP
uniform sampler2D uNormalMap;
uniform float uNormalScale;
#endif
#ifdef USE_MR_MAP
uniform sampler2D uMetallicRoughnessMap;
#endif
#ifdef USE_OCCLUSION_MAP
uniform sampler2D uOcclusionMap;
uniform float uOcclusionStrength;
#endif
#ifdef USE_EMISSIVE_MAP
uniform sampler2D uEmissiveMap;
#endif
#ifdef USE_TONEMAP
uniform float uExposure;
#endif

layout(location = 0) out vec4 outColor;
#ifdef USE_MOTION_VECTORS
layout(location = 1) out vec2 outVelocity;
#endif

/**
 * Resolve the world space shading normal: interpolated normal, flipped for the
 * back faces of double sided materials, then perturbed by the normal map through
 * either the vertex tangent frame or a screen space cotangent frame.
 */
vec3 resolveShadingNormal(vec3 geometricNormal) {
#ifdef USE_NORMAL_MAP
  vec3 mapNormal = decodeNormalMap(texture(uNormalMap, NORMAL_UV).xyz, uNormalScale);
  #ifdef USE_TANGENT
  vec4 tangent = vTangent;
    #ifdef DOUBLE_SIDED
  // The bitangent handedness mirrors along with the normal on a back face.
  tangent.w = gl_FrontFacing ? tangent.w : -tangent.w;
    #endif
  return perturbNormalTangent(geometricNormal, tangent, mapNormal);
  #else
  return perturbNormal(geometricNormal, vWorldPos, NORMAL_UV, mapNormal);
  #endif
#else
  return geometricNormal;
#endif
}

/** Index of the first directional light that writes into the shadow map, or -1. */
int findShadowCastingLight() {
  int count = getDirectionalLightCount();
  for (int i = 0; i < DIR_LIGHT_SLOTS; ++i) {
    if (i >= count) break;
    if (uDirLightDir[i].w > 0.5) return i;
  }
  return -1;
}

void main() {
  // ---------------------------------------------------------------- base colour
  vec4 baseColor = uBaseColorFactor;
#ifdef USE_BASECOLOR_MAP
  vec4 baseColorSample = texture(uBaseColorMap, BASECOLOR_UV);
  #ifdef MANUAL_SRGB_DECODE
  baseColorSample.rgb = sRGBToLinear(baseColorSample.rgb);
  #endif
  baseColor *= baseColorSample;
#endif
#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
  baseColor *= vColor;
#endif

#ifdef ALPHA_MODE_MASK
  if (baseColor.a < uAlphaCutoff) discard;
#endif

#ifdef DEPTH_ONLY
  // Depth prepass permutation: the alpha test above is the only work that matters.
  outColor = vec4(0.0);
  #ifdef USE_MOTION_VECTORS
  outVelocity = vec2(0.0);
  #endif
  return;
#endif

  // -------------------------------------------------------------------- normals
  vec3 geometricNormal = faceForwardNormal(normalize(vNormal), gl_FrontFacing);
  vec3 shadingNormal = resolveShadingNormal(geometricNormal);

  // ------------------------------------------------------- metallic / roughness
  float metallic = uMetallic;
  float perceptualRoughness = uRoughness;
#ifdef USE_MR_MAP
  // glTF packing: green = roughness, blue = metallic.
  vec4 mrSample = texture(uMetallicRoughnessMap, MR_UV);
  perceptualRoughness *= mrSample.g;
  metallic *= mrSample.b;
#endif
#ifdef USE_SPECULAR_AA
  perceptualRoughness = geometricNormalFiltering(perceptualRoughness, shadingNormal);
#endif

  // ------------------------------------------------------------------ occlusion
  float occlusion = 1.0;
#ifdef USE_OCCLUSION_MAP
  float occlusionSample = texture(uOcclusionMap, OCCLUSION_UV).r;
  occlusion = 1.0 + uOcclusionStrength * (occlusionSample - 1.0);
#endif

  // ------------------------------------------------------------------- emissive
  vec3 emissive = uEmissiveFactor;
#ifdef USE_EMISSIVE_MAP
  vec3 emissiveSample = texture(uEmissiveMap, EMISSIVE_UV).rgb;
  #ifdef MANUAL_SRGB_DECODE
  emissiveSample = sRGBToLinear(emissiveSample);
  #endif
  emissive *= emissiveSample;
#endif

  // ---------------------------------------------------------------- shading set
  MaterialInputs material = defaultMaterialInputs();
  material.baseColor = baseColor.rgb;
  material.opacity = baseColor.a;
  material.metallic = metallic;
  material.perceptualRoughness = perceptualRoughness;
  material.occlusion = occlusion;
  material.reflectance = uReflectance;
  material.emissive = emissive;
  material.normal = shadingNormal;
  material.geometricNormal = geometricNormal;

  PixelParams px = computePixelParams(material, vWorldPos, getViewDirection(vWorldPos));

  // -------------------------------------------------------------------- shadows
  float shadow = 1.0;
#ifdef USE_SHADOWS
  int shadowLight = findShadowCastingLight();
  if (shadowLight >= 0) {
    vec3 shadowLightDir = normalize(uDirLightDir[shadowLight].xyz);
    shadow = getShadow(vWorldPos, px.geometricNormal, shadowLightDir, vViewDepth, gl_FragCoord.xy);
  }
#endif

  // ------------------------------------------------------------------- lighting
  vec3 color = evaluateDirectionalLights(px, shadow);

#ifdef USE_CLUSTERED
  color += evaluatePunctualLights(px, gl_FragCoord.xy, vViewDepth);
#endif

  color += evaluateAmbient(px);

#ifdef USE_IBL
  color += evaluateIBLWithHorizon(
    px.N, px.R, px.geometricNormal, px.NoV,
    px.diffuseColor, px.f0, px.perceptualRoughness, px.occlusion
  );
#endif

  color += material.emissive;

  // ------------------------------------------------------------------------ fog
#ifdef USE_FOG
  color = applyFog(color, vViewDepth, vWorldPos.y);
#endif

  // ----------------------------------------------------------------- alpha, out
  float alpha = 1.0;
#ifdef ALPHA_MODE_BLEND
  alpha = saturate(material.opacity);
#endif

#ifdef USE_TONEMAP
  // Direct to screen path: no post processing chain will do this for us.
  float exposure = uExposure > 0.0 ? uExposure : 1.0;
  color = linearToSRGB(tonemapACESNarkowicz(color * exposure));
#endif

  outColor = vec4(color, alpha);

#ifdef USE_MOTION_VECTORS
  vec2 currentNDC = vCurrentClip.xy / max(abs(vCurrentClip.w), 1e-6);
  vec2 previousNDC = vPreviousClip.xy / max(abs(vPreviousClip.w), 1e-6);
  outVelocity = (currentNDC - previousNDC) * 0.5;
#endif
}
`;

/** Name this program is registered under in the ShaderLib. */
export const name = 'standard';

/**
 * Register the standard program on a shader library.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib) {
  shaderLib.register(name, { vertex, fragment });
  return shaderLib;
}
