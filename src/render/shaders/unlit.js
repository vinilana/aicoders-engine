/**
 * The 'unlit' program: constant shading, no light evaluation at all.
 *
 * Used for UI overlays, debug geometry, emissive decals, sprites and the
 * KHR_materials_unlit glTF extension. It shares the vertex feature set of the
 * standard shader (instancing, skinning, vertex colour, UV transform) so a mesh can
 * switch between the two without touching its geometry.
 */

/** Vertex stage. */
export const vertex = `#version 300 es

#include <common>
#include <camera_ubo>
#include <instancing>
#include <skinning>

layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;
#ifdef USE_VERTEX_COLOR
layout(location = 4) in vec4 aColor;
#endif
#ifdef USE_UV1
layout(location = 5) in vec2 aUV1;
#endif

uniform mat4 uModelMatrix;

#ifdef USE_UV_TRANSFORM
uniform mat3 uUVTransform;
#endif

out vec3 vWorldPos;
out vec2 vUV0;
out float vViewDepth;
#ifdef USE_UV1
out vec2 vUV1;
#endif
#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
out vec4 vColor;
#endif

void main() {
  vec3 objectPosition = aPosition;

#ifdef USE_SKINNING
  objectPosition = skinPosition(objectPosition, getSkinningMatrix());
#endif

  mat4 modelMatrix = getModelMatrix(uModelMatrix);
  vec4 worldPosition = modelMatrix * vec4(objectPosition, 1.0);
  vWorldPos = worldPosition.xyz;

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
  gl_Position = uProj * viewPosition;
}
`;

/** Fragment stage. */
export const fragment = `#version 300 es
precision highp float;
precision highp int;

#include <common>
#include <camera_ubo>

#ifdef USE_FOG
#include <fog>
#endif
#ifdef USE_TONEMAP
#include <tonemap>
#endif

in vec3 vWorldPos;
in vec2 vUV0;
in float vViewDepth;
#ifdef USE_UV1
in vec2 vUV1;
#endif
#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
in vec4 vColor;
#endif

#if defined(USE_UV1) && defined(BASECOLOR_UV1)
#define BASECOLOR_UV vUV1
#else
#define BASECOLOR_UV vUV0
#endif

uniform vec4 uBaseColorFactor;

#ifdef ALPHA_MODE_MASK
uniform float uAlphaCutoff;
#endif
#ifdef USE_BASECOLOR_MAP
uniform sampler2D uBaseColorMap;
#endif
#ifdef USE_TONEMAP
uniform float uExposure;
#endif

layout(location = 0) out vec4 outColor;

void main() {
  vec4 color = uBaseColorFactor;

#ifdef USE_BASECOLOR_MAP
  vec4 baseColorSample = texture(uBaseColorMap, BASECOLOR_UV);
  #ifdef MANUAL_SRGB_DECODE
  baseColorSample.rgb = sRGBToLinear(baseColorSample.rgb);
  #endif
  color *= baseColorSample;
#endif

#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)
  color *= vColor;
#endif

#ifdef ALPHA_MODE_MASK
  if (color.a < uAlphaCutoff) discard;
#endif

#ifdef DEPTH_ONLY
  outColor = vec4(0.0);
  return;
#endif

  vec3 rgb = color.rgb;

#ifdef USE_FOG
  rgb = applyFog(rgb, vViewDepth, vWorldPos.y);
#endif

  float alpha = 1.0;
#ifdef ALPHA_MODE_BLEND
  alpha = saturate(color.a);
#endif

#ifdef USE_TONEMAP
  float exposure = uExposure > 0.0 ? uExposure : 1.0;
  rgb = linearToSRGB(tonemapACESNarkowicz(rgb * exposure));
#endif

  outColor = vec4(rgb, alpha);
}
`;

/** Name this program is registered under in the ShaderLib. */
export const name = 'unlit';

/**
 * Register the unlit program on a shader library.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib) {
  shaderLib.register(name, { vertex, fragment });
  return shaderLib;
}
