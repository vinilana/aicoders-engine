/**
 * Registers the shadow program in a ShaderLib.
 *
 * Idempotent with respect to *this* source: re-registering would invalidate
 * every compiled permutation, so a library that already holds this exact program
 * is left untouched. A different program registered under the same name (for
 * instance a placeholder installed while this module was still loading) IS
 * replaced, because ShadowMapper relies on the uniform names declared here.
 *
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
/**
 * Alias of {@link register}, handy when several shader modules are imported
 * side by side and the short name would collide.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib}
 */
export function registerShadowShader(shaderLib: import('../ShaderLib.js').ShaderLib): import('../ShaderLib.js').ShaderLib;
/**
 * Depth-only shadow caster program.
 *
 * This is the program used to fill every shadow map the engine produces:
 * the directional cascaded shadow maps (one orthographic pass per cascade,
 * rendered into the layers of a DEPTH_COMPONENT32F 2D array), the spot light
 * maps (one perspective pass per light) and the point light maps (six
 * perspective passes, one per cube face).
 *
 * The fragment stage declares no output on purpose: the shadow render targets
 * carry no color attachment, so the rasterizer only has to write depth. That
 * also keeps early-Z enabled in the (common) permutation without alpha testing.
 *
 * Permutation defines (all optional):
 *   USE_INSTANCING     per instance model matrix at locations 8..11
 *   USE_SKINNING       GPU skinning through the bone texture (unit 6)
 *   ALPHA_MODE_MASK    alpha cutout: fragments below the cutoff are discarded
 *   USE_BASECOLOR_MAP  the cutout alpha comes from the base color map (unit 0)
 *   SHADOW_CLAMP_NEAR  orthographic passes only: flatten occluders that sit in
 *                      front of the near plane onto it instead of clipping them
 *                      away ("pancaking"), so they keep casting a shadow
 */
/** Name this program is registered under in the ShaderLib. */
export const SHADOW_SHADER_NAME: "shadow";
export namespace SHADOW_TEXTURE_UNITS {
    const baseColorMap: number;
    const boneTexture: number;
}
/**
 * Uniform names the shadow program exposes. ShadowMapper writes exactly these.
 * @type {Object<string,string>}
 */
export const SHADOW_UNIFORMS: {
    [x: string]: string;
};
/** Vertex stage: object space position -> shadow clip space. */
export const shadowVertexShader: "#version 300 es\n#include <common>\n#include <instancing>\n#include <skinning>\n\nlayout(location = 0) in vec3 aPosition;\n\n#ifdef ALPHA_MODE_MASK\nlayout(location = 2) in vec2 aUV0;\nout vec2 vUV0;\nuniform vec4 uUVTransform;   // xy = scale, zw = offset\n#endif\n\nuniform mat4 uModelMatrix;\nuniform mat4 uShadowViewProj;\n\nvoid main() {\n  vec3 position = aPosition;\n\n#ifdef USE_SKINNING\n  position = skinPosition(position, getSkinningMatrix());\n#endif\n\n  mat4 modelMatrix = getModelMatrix(uModelMatrix);\n  vec4 worldPosition = modelMatrix * vec4(position, 1.0);\n\n#ifdef ALPHA_MODE_MASK\n  vUV0 = aUV0 * uUVTransform.xy + uUVTransform.zw;\n#endif\n\n  vec4 clipPosition = uShadowViewProj * worldPosition;\n\n#ifdef SHADOW_CLAMP_NEAR\n  // Orthographic light camera, so w is exactly 1 and this is a plain clamp:\n  // an occluder between the light and the near plane is flattened onto the\n  // near plane instead of being clipped, which keeps its shadow. Never enable\n  // this for a perspective pass, where w can be negative behind the light.\n  clipPosition.z = max(clipPosition.z, -clipPosition.w);\n#endif\n\n  gl_Position = clipPosition;\n}\n";
/** Fragment stage: nothing but the (optional) alpha cutout test. */
export const shadowFragmentShader: "#version 300 es\nprecision highp float;\nprecision highp int;\n\n#ifdef ALPHA_MODE_MASK\nin vec2 vUV0;\n\nuniform vec4 uBaseColorFactor;   // rgb unused here, a = material opacity\nuniform float uAlphaCutoff;\n\n#ifdef USE_BASECOLOR_MAP\nuniform sampler2D uBaseColorMap; // texture unit 0\n#endif\n#endif\n\nvoid main() {\n#ifdef ALPHA_MODE_MASK\n  float alpha = uBaseColorFactor.a;\n#ifdef USE_BASECOLOR_MAP\n  alpha *= texture(uBaseColorMap, vUV0).a;\n#endif\n  if (alpha < uAlphaCutoff) discard;\n#endif\n}\n";
/**
 * The (vertex, fragment) source pair, ready for `ShaderLib.register`.
 * @type {{vertex: string, fragment: string}}
 */
export const shadowShader: {
    vertex: string;
    fragment: string;
};
/**
 * Permutations worth warming up before the first frame. ShadowMapper compiles
 * exactly what a scene needs on demand; this list is what `Renderer.compile()`
 * can use to pay the cost up front instead.
 * @type {Array<Object>}
 */
export const SHADOW_PERMUTATIONS: Array<any>;
