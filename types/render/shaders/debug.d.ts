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
export function registerDebugShader(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
/**
 * Registration hook used by `src/render/shaders/index.js`.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
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
export const DEBUG_SHADER_NAME: "debug_lines";
/** Alias kept for `applyShaderModule()` in ./index.js, which reads `name`. */
export const name: "debug_lines";
/** Defines DebugRenderer toggles on this program. */
export const DEBUG_SHADER_DEFINES: Readonly<{
    CAMERA_UBO: "DEBUG_CAMERA_UBO";
    SRGB_OUTPUT: "DEBUG_SRGB_OUTPUT";
    ALPHA_TEST: "DEBUG_ALPHA_TEST";
}>;
/** Vertex stage. */
export const vertex: "#version 300 es\n\n#include <common>\n#include <camera_ubo>\n\nlayout(location = 0) in vec3 aPosition;\nlayout(location = 4) in vec4 aColor;\n\n#ifndef DEBUG_CAMERA_UBO\nuniform mat4 uDebugViewProj;\n#endif\n\nuniform float uDepthOffset;\n\nout vec4 vColor;\n\nvoid main() {\n  vColor = aColor;\n\n#ifdef DEBUG_CAMERA_UBO\n  vec4 clipPosition = uViewProj * vec4(aPosition, 1.0);\n#else\n  vec4 clipPosition = uDebugViewProj * vec4(aPosition, 1.0);\n#endif\n\n  // Bias in clip space so the offset stays constant in NDC after the divide.\n  clipPosition.z -= uDepthOffset * clipPosition.w;\n\n  gl_Position = clipPosition;\n}\n";
/** Fragment stage. */
export const fragment: "#version 300 es\nprecision highp float;\nprecision highp int;\n\n#include <common>\n\nin vec4 vColor;\n\nuniform float uOpacity;\n\nlayout(location = 0) out vec4 outColor;\n\nvoid main() {\n  vec4 color = vColor;\n  color.a = saturate(color.a * uOpacity);\n\n#ifdef DEBUG_ALPHA_TEST\n  if (color.a < 0.00392) discard;\n#endif\n\n#ifdef DEBUG_SRGB_OUTPUT\n  outColor = vec4(linearToSRGB(max(color.rgb, vec3(0.0))), color.a);\n#else\n  outColor = color;\n#endif\n}\n";
/** The program sources, in the `{name: {vertex, fragment}}` shape ./index.js accepts. */
export const DEBUG_SHADERS: Readonly<{
    debug_lines: {
        vertex: string;
        fragment: string;
    };
}>;
/** Permutations worth warming up ahead of the first frame. */
export const DEBUG_PERMUTATIONS: ({
    DEBUG_CAMERA_UBO: number;
    DEBUG_SRGB_OUTPUT: number;
} | {
    DEBUG_CAMERA_UBO: number;
    DEBUG_SRGB_OUTPUT?: undefined;
} | {
    DEBUG_SRGB_OUTPUT: number;
    DEBUG_CAMERA_UBO?: undefined;
})[];
