/**
 * The 'depth' program: depth prepass and shadow map rendering.
 *
 * The same source serves both passes because they need exactly the same thing -
 * transform the vertex, optionally clip it against an alpha mask, and write
 * nothing but depth. Keeping them together means foliage cut out with
 * ALPHA_MODE_MASK casts the correct shadow with no second implementation.
 *
 * Which matrix projects the vertex is chosen by a define:
 *   default      -> uViewProj from the Camera uniform block (depth prepass, and
 *                   also the shadow pass when ShadowMapper rebinds the Camera UBO
 *                   once per cascade)
 *   SHADOW_PASS  -> the explicit `uLightViewProj` uniform (shadow pass when
 *                   ShadowMapper keeps the camera block pointed at the real camera)
 *
 * The uniform only exists in the SHADOW_PASS permutation, so the prepass can never
 * pick up a stale light matrix from a previous pass.
 *
 * Optional colour output (all off by default, the pass writes depth only):
 *   WRITE_LINEAR_DEPTH -> red channel receives the positive view distance
 *   WRITE_NORMALS      -> green/blue receive the octahedral encoded world normal
 */

/** Vertex stage. */
export const vertex = `#version 300 es

#include <common>
#include <camera_ubo>
#include <instancing>
#include <skinning>

layout(location = 0) in vec3 aPosition;
#if defined(WRITE_NORMALS)
layout(location = 1) in vec3 aNormal;
#endif
#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)
layout(location = 2) in vec2 aUV0;
#endif

uniform mat4 uModelMatrix;
#if defined(WRITE_NORMALS)
uniform mat3 uNormalMatrix;
#endif
#ifdef SHADOW_PASS
uniform mat4 uLightViewProj;
#endif
#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP) && defined(USE_UV_TRANSFORM)
uniform mat3 uUVTransform;
#endif

#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)
out vec2 vUV0;
#endif
#if defined(WRITE_LINEAR_DEPTH)
out float vViewDepth;
#endif
#if defined(WRITE_NORMALS)
out vec3 vNormal;
#endif

void main() {
  vec3 objectPosition = aPosition;
#if defined(WRITE_NORMALS)
  vec3 objectNormal = aNormal;
#endif

#ifdef USE_SKINNING
  mat4 skinMatrix = getSkinningMatrix();
  objectPosition = skinPosition(objectPosition, skinMatrix);
  #if defined(WRITE_NORMALS)
  objectNormal = mat3(skinMatrix) * objectNormal;
  #endif
#endif

  mat4 modelMatrix = getModelMatrix(uModelMatrix);
  vec4 worldPosition = modelMatrix * vec4(objectPosition, 1.0);

#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)
  #ifdef USE_UV_TRANSFORM
  vUV0 = (uUVTransform * vec3(aUV0, 1.0)).xy;
  #else
  vUV0 = aUV0;
  #endif
#endif

#if defined(WRITE_NORMALS)
  mat3 normalMatrix = uNormalMatrix;
  #ifdef USE_INSTANCING
  normalMatrix = normalMatrix * getInstanceNormalMatrixFast(getInstanceMatrix());
  #endif
  vNormal = normalMatrix * objectNormal;
#endif

#if defined(WRITE_LINEAR_DEPTH)
  vViewDepth = -(uView * worldPosition).z;
#endif

#ifdef SHADOW_PASS
  gl_Position = uLightViewProj * worldPosition;
#else
  gl_Position = uViewProj * worldPosition;
#endif
}
`;

/** Fragment stage. */
export const fragment = `#version 300 es
precision highp float;
precision highp int;

#include <common>

#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)
in vec2 vUV0;
uniform sampler2D uBaseColorMap;
#endif
#if defined(WRITE_LINEAR_DEPTH)
in float vViewDepth;
#endif
#if defined(WRITE_NORMALS)
in vec3 vNormal;
#endif

#ifdef ALPHA_MODE_MASK
uniform vec4 uBaseColorFactor;
uniform float uAlphaCutoff;
#endif

// A depth only target declares no draw buffer, in which case this write is simply
// discarded by the driver. Declaring the output unconditionally keeps one single
// permutation working for both the depth only and the depth + data targets.
layout(location = 0) out vec4 outColor;

void main() {
#ifdef ALPHA_MODE_MASK
  float alpha = uBaseColorFactor.a;
  #ifdef USE_BASECOLOR_MAP
  alpha *= texture(uBaseColorMap, vUV0).a;
  #endif
  if (alpha < uAlphaCutoff) discard;
#endif

  vec4 result = vec4(0.0, 0.0, 0.0, 1.0);

#if defined(WRITE_LINEAR_DEPTH)
  result.r = vViewDepth;
#endif
#if defined(WRITE_NORMALS)
  result.gb = packNormalOct(normalize(vNormal));
#endif

  outColor = result;
}
`;

/** Name this program is registered under in the ShaderLib. */
export const name = 'depth';

/**
 * Name of the convenience permutation that projects with `uLightViewProj`.
 * Registered alongside `depth` so a shadow mapper can pick either strategy.
 */
export const shadowPassName = 'depthShadow';

/**
 * Register the depth program on a shader library, plus the `depthShadow` variant
 * that defaults to the explicit light matrix.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib) {
  shaderLib.register(name, { vertex, fragment });
  shaderLib.register(shadowPassName, { vertex, fragment, defines: { SHADOW_PASS: 1 } });
  return shaderLib;
}
