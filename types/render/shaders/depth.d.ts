/**
 * Register the depth program on a shader library, plus the `depthShadow` variant
 * that defaults to the explicit light matrix.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
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
export const vertex: "#version 300 es\n\n#include <common>\n#include <camera_ubo>\n#include <instancing>\n#include <skinning>\n\nlayout(location = 0) in vec3 aPosition;\n#if defined(WRITE_NORMALS)\nlayout(location = 1) in vec3 aNormal;\n#endif\n#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)\nlayout(location = 2) in vec2 aUV0;\n#endif\n\nuniform mat4 uModelMatrix;\n#if defined(WRITE_NORMALS)\nuniform mat3 uNormalMatrix;\n#endif\n#ifdef SHADOW_PASS\nuniform mat4 uLightViewProj;\n#endif\n#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP) && defined(USE_UV_TRANSFORM)\nuniform mat3 uUVTransform;\n#endif\n\n#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)\nout vec2 vUV0;\n#endif\n#if defined(WRITE_LINEAR_DEPTH)\nout float vViewDepth;\n#endif\n#if defined(WRITE_NORMALS)\nout vec3 vNormal;\n#endif\n\nvoid main() {\n  vec3 objectPosition = aPosition;\n#if defined(WRITE_NORMALS)\n  vec3 objectNormal = aNormal;\n#endif\n\n#ifdef USE_SKINNING\n  mat4 skinMatrix = getSkinningMatrix();\n  objectPosition = skinPosition(objectPosition, skinMatrix);\n  #if defined(WRITE_NORMALS)\n  objectNormal = mat3(skinMatrix) * objectNormal;\n  #endif\n#endif\n\n  mat4 modelMatrix = getModelMatrix(uModelMatrix);\n  vec4 worldPosition = modelMatrix * vec4(objectPosition, 1.0);\n\n#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)\n  #ifdef USE_UV_TRANSFORM\n  vUV0 = (uUVTransform * vec3(aUV0, 1.0)).xy;\n  #else\n  vUV0 = aUV0;\n  #endif\n#endif\n\n#if defined(WRITE_NORMALS)\n  mat3 normalMatrix = uNormalMatrix;\n  #ifdef USE_INSTANCING\n  normalMatrix = normalMatrix * getInstanceNormalMatrixFast(getInstanceMatrix());\n  #endif\n  vNormal = normalMatrix * objectNormal;\n#endif\n\n#if defined(WRITE_LINEAR_DEPTH)\n  vViewDepth = -(uView * worldPosition).z;\n#endif\n\n#ifdef SHADOW_PASS\n  gl_Position = uLightViewProj * worldPosition;\n#else\n  gl_Position = uViewProj * worldPosition;\n#endif\n}\n";
/** Fragment stage. */
export const fragment: "#version 300 es\nprecision highp float;\nprecision highp int;\n\n#include <common>\n\n#if defined(ALPHA_MODE_MASK) && defined(USE_BASECOLOR_MAP)\nin vec2 vUV0;\nuniform sampler2D uBaseColorMap;\n#endif\n#if defined(WRITE_LINEAR_DEPTH)\nin float vViewDepth;\n#endif\n#if defined(WRITE_NORMALS)\nin vec3 vNormal;\n#endif\n\n#ifdef ALPHA_MODE_MASK\nuniform vec4 uBaseColorFactor;\nuniform float uAlphaCutoff;\n#endif\n\n// A depth only target declares no draw buffer, in which case this write is simply\n// discarded by the driver. Declaring the output unconditionally keeps one single\n// permutation working for both the depth only and the depth + data targets.\nlayout(location = 0) out vec4 outColor;\n\nvoid main() {\n#ifdef ALPHA_MODE_MASK\n  float alpha = uBaseColorFactor.a;\n  #ifdef USE_BASECOLOR_MAP\n  alpha *= texture(uBaseColorMap, vUV0).a;\n  #endif\n  if (alpha < uAlphaCutoff) discard;\n#endif\n\n  vec4 result = vec4(0.0, 0.0, 0.0, 1.0);\n\n#if defined(WRITE_LINEAR_DEPTH)\n  result.r = vViewDepth;\n#endif\n#if defined(WRITE_NORMALS)\n  result.gb = packNormalOct(normalize(vNormal));\n#endif\n\n  outColor = result;\n}\n";
/** Name this program is registered under in the ShaderLib. */
export const name: "depth";
/**
 * Name of the convenience permutation that projects with `uLightViewProj`.
 * Registered alongside `depth` so a shadow mapper can pick either strategy.
 */
export const shadowPassName: "depthShadow";
