/**
 * The `debug_lines` program: flat, per-vertex coloured GL_LINES.
 *
 * It is the only program DebugRenderer needs: every gizmo it can draw (boxes,
 * spheres, frusta, arrows, skeletons, BVH nodes, normals, points) is decomposed
 * into line segments on the CPU and pushed into a single interleaved stream of
 * `position (vec3) + colour (vec4)` vertices, which this program renders with one
 * `drawArrays(LINES, ...)` call.
 *
 * Vertex colours live in LINEAR space, exactly like every other colour in the
 * engine. The `DEBUG_SRGB_OUTPUT` permutation encodes them to sRGB on the way out,
 * which is what an overlay drawn straight into the default (LDR) framebuffer needs;
 * leave it off when the lines are drawn into the HDR buffer before tone mapping.
 *
 * Permutations (all optional, chosen by DebugRenderer):
 *   DEBUG_CAMERA_UBO   take the view-projection from the `Camera` uniform block
 *                      (binding 0). This is the default path.
 *   DEBUG_SRGB_OUTPUT  encode linear -> sRGB before writing the fragment.
 *   DEBUG_ALPHA_TEST   discard fully transparent fragments instead of blending them.
 *
 * Uniforms:
 *   uDebugViewProj (mat4)   only declared when DEBUG_CAMERA_UBO is NOT defined.
 *   uDepthOffset   (float)  NDC depth bias, pulls the lines towards the viewer so
 *                           a wireframe does not z-fight with the surface it hugs.
 *   uOpacity       (float)  global multiplier applied to the vertex alpha.
 */

/** Name this program is registered under in the ShaderLib. */
export const DEBUG_SHADER_NAME = 'debug_lines';

/** Alias kept for `applyShaderModule()` in ./index.js, which reads `name`. */
export const name = DEBUG_SHADER_NAME;

/** Defines DebugRenderer toggles on this program. */
export const DEBUG_SHADER_DEFINES = Object.freeze({
  CAMERA_UBO: 'DEBUG_CAMERA_UBO',
  SRGB_OUTPUT: 'DEBUG_SRGB_OUTPUT',
  ALPHA_TEST: 'DEBUG_ALPHA_TEST'
});

/** Vertex stage. */
export const vertex = `#version 300 es

#include <common>
#include <camera_ubo>

layout(location = 0) in vec3 aPosition;
layout(location = 4) in vec4 aColor;

#ifndef DEBUG_CAMERA_UBO
uniform mat4 uDebugViewProj;
#endif

uniform float uDepthOffset;

out vec4 vColor;

void main() {
  vColor = aColor;

#ifdef DEBUG_CAMERA_UBO
  vec4 clipPosition = uViewProj * vec4(aPosition, 1.0);
#else
  vec4 clipPosition = uDebugViewProj * vec4(aPosition, 1.0);
#endif

  // Bias in clip space so the offset stays constant in NDC after the divide.
  clipPosition.z -= uDepthOffset * clipPosition.w;

  gl_Position = clipPosition;
}
`;

/** Fragment stage. */
export const fragment = `#version 300 es
precision highp float;
precision highp int;

#include <common>

in vec4 vColor;

uniform float uOpacity;

layout(location = 0) out vec4 outColor;

void main() {
  vec4 color = vColor;
  color.a = saturate(color.a * uOpacity);

#ifdef DEBUG_ALPHA_TEST
  if (color.a < 0.00392) discard;
#endif

#ifdef DEBUG_SRGB_OUTPUT
  outColor = vec4(linearToSRGB(max(color.rgb, vec3(0.0))), color.a);
#else
  outColor = color;
#endif
}
`;

/** The program sources, in the `{name: {vertex, fragment}}` shape ./index.js accepts. */
export const DEBUG_SHADERS = Object.freeze({
  [DEBUG_SHADER_NAME]: { vertex, fragment }
});

/** Permutations worth warming up ahead of the first frame. */
export const DEBUG_PERMUTATIONS = [
  { DEBUG_CAMERA_UBO: 1, DEBUG_SRGB_OUTPUT: 1 },
  { DEBUG_CAMERA_UBO: 1 },
  { DEBUG_SRGB_OUTPUT: 1 },
  null
];

/**
 * Register the debug line program on a shader library.
 *
 * Idempotent: registering the very same source twice is skipped, because
 * `ShaderLib.register` invalidates every compiled permutation of a name it
 * replaces, and DebugRenderer holds on to the Program it resolved.
 *
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function registerDebugShader(shaderLib) {
  if (!shaderLib || typeof shaderLib.register !== 'function') {
    throw new Error('registerDebugShader: um ShaderLib valido e obrigatorio.');
  }
  if (typeof shaderLib.getSource === 'function') {
    const existing = shaderLib.getSource(DEBUG_SHADER_NAME);
    if (existing !== null && existing !== undefined && existing.vertex === vertex) {
      return shaderLib;
    }
  }
  shaderLib.register(DEBUG_SHADER_NAME, { vertex, fragment });
  return shaderLib;
}

/**
 * Registration hook used by `src/render/shaders/index.js`.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib) {
  return registerDebugShader(shaderLib);
}
