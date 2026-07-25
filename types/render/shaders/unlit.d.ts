/**
 * Register the unlit program on a shader library.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
/**
 * The 'unlit' program: constant shading, no light evaluation at all.
 *
 * Used for UI overlays, debug geometry, emissive decals, sprites and the
 * KHR_materials_unlit glTF extension. It shares the vertex feature set of the
 * standard shader (instancing, skinning, vertex colour, UV transform) so a mesh can
 * switch between the two without touching its geometry.
 */
/** Vertex stage. */
export const vertex: "#version 300 es\n\n#include <common>\n#include <camera_ubo>\n#include <instancing>\n#include <skinning>\n\nlayout(location = 0) in vec3 aPosition;\nlayout(location = 2) in vec2 aUV0;\n#ifdef USE_VERTEX_COLOR\nlayout(location = 4) in vec4 aColor;\n#endif\n#ifdef USE_UV1\nlayout(location = 5) in vec2 aUV1;\n#endif\n\nuniform mat4 uModelMatrix;\n\n#ifdef USE_UV_TRANSFORM\nuniform mat3 uUVTransform;\n#endif\n\nout vec3 vWorldPos;\nout vec2 vUV0;\nout float vViewDepth;\n#ifdef USE_UV1\nout vec2 vUV1;\n#endif\n#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)\nout vec4 vColor;\n#endif\n\nvoid main() {\n  vec3 objectPosition = aPosition;\n\n#ifdef USE_SKINNING\n  objectPosition = skinPosition(objectPosition, getSkinningMatrix());\n#endif\n\n  mat4 modelMatrix = getModelMatrix(uModelMatrix);\n  vec4 worldPosition = modelMatrix * vec4(objectPosition, 1.0);\n  vWorldPos = worldPosition.xyz;\n\n#ifdef USE_UV_TRANSFORM\n  vUV0 = (uUVTransform * vec3(aUV0, 1.0)).xy;\n  #ifdef USE_UV1\n  vUV1 = (uUVTransform * vec3(aUV1, 1.0)).xy;\n  #endif\n#else\n  vUV0 = aUV0;\n  #ifdef USE_UV1\n  vUV1 = aUV1;\n  #endif\n#endif\n\n#if defined(USE_VERTEX_COLOR) && defined(USE_INSTANCE_COLOR)\n  vColor = aColor * getInstanceColor();\n#elif defined(USE_VERTEX_COLOR)\n  vColor = aColor;\n#elif defined(USE_INSTANCE_COLOR)\n  vColor = getInstanceColor();\n#endif\n\n  vec4 viewPosition = uView * worldPosition;\n  vViewDepth = -viewPosition.z;\n  gl_Position = uProj * viewPosition;\n}\n";
/** Fragment stage. */
export const fragment: "#version 300 es\nprecision highp float;\nprecision highp int;\n\n#include <common>\n#include <camera_ubo>\n\n#ifdef USE_FOG\n#include <fog>\n#endif\n#ifdef USE_TONEMAP\n#include <tonemap>\n#endif\n\nin vec3 vWorldPos;\nin vec2 vUV0;\nin float vViewDepth;\n#ifdef USE_UV1\nin vec2 vUV1;\n#endif\n#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)\nin vec4 vColor;\n#endif\n\n#if defined(USE_UV1) && defined(BASECOLOR_UV1)\n#define BASECOLOR_UV vUV1\n#else\n#define BASECOLOR_UV vUV0\n#endif\n\nuniform vec4 uBaseColorFactor;\n\n#ifdef ALPHA_MODE_MASK\nuniform float uAlphaCutoff;\n#endif\n#ifdef USE_BASECOLOR_MAP\nuniform sampler2D uBaseColorMap;\n#endif\n#ifdef USE_TONEMAP\nuniform float uExposure;\n#endif\n\nlayout(location = 0) out vec4 outColor;\n\nvoid main() {\n  vec4 color = uBaseColorFactor;\n\n#ifdef USE_BASECOLOR_MAP\n  vec4 baseColorSample = texture(uBaseColorMap, BASECOLOR_UV);\n  #ifdef MANUAL_SRGB_DECODE\n  baseColorSample.rgb = sRGBToLinear(baseColorSample.rgb);\n  #endif\n  color *= baseColorSample;\n#endif\n\n#if defined(USE_VERTEX_COLOR) || defined(USE_INSTANCE_COLOR)\n  color *= vColor;\n#endif\n\n#ifdef ALPHA_MODE_MASK\n  if (color.a < uAlphaCutoff) discard;\n#endif\n\n#ifdef DEPTH_ONLY\n  outColor = vec4(0.0);\n  return;\n#endif\n\n  vec3 rgb = color.rgb;\n\n#ifdef USE_FOG\n  rgb = applyFog(rgb, vViewDepth, vWorldPos.y);\n#endif\n\n  float alpha = 1.0;\n#ifdef ALPHA_MODE_BLEND\n  alpha = saturate(color.a);\n#endif\n\n#ifdef USE_TONEMAP\n  float exposure = uExposure > 0.0 ? uExposure : 1.0;\n  rgb = linearToSRGB(tonemapACESNarkowicz(rgb * exposure));\n#endif\n\n  outColor = vec4(rgb, alpha);\n}\n";
/** Name this program is registered under in the ShaderLib. */
export const name: "unlit";
