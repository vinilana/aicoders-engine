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
export const SHADOW_SHADER_NAME = 'shadow';

/** Fixed texture units used by the shadow program (see the contract table). */
export const SHADOW_TEXTURE_UNITS = {
  baseColorMap: 0,
  boneTexture: 6
};

/**
 * Uniform names the shadow program exposes. ShadowMapper writes exactly these.
 * @type {Object<string,string>}
 */
export const SHADOW_UNIFORMS = {
  viewProjection: 'uShadowViewProj',
  model: 'uModelMatrix',
  uvTransform: 'uUVTransform',
  baseColorFactor: 'uBaseColorFactor',
  alphaCutoff: 'uAlphaCutoff',
  baseColorMap: 'uBaseColorMap',
  boneTexture: 'uBoneTexture',
  bindMatrix: 'uBindMatrix',
  bindMatrixInverse: 'uBindMatrixInverse'
};

/** Vertex stage: object space position -> shadow clip space. */
export const shadowVertexShader = `#version 300 es
#include <common>
#include <instancing>
#include <skinning>

layout(location = 0) in vec3 aPosition;

#ifdef ALPHA_MODE_MASK
layout(location = 2) in vec2 aUV0;
out vec2 vUV0;
uniform vec4 uUVTransform;   // xy = scale, zw = offset
#endif

uniform mat4 uModelMatrix;
uniform mat4 uShadowViewProj;

void main() {
  vec3 position = aPosition;

#ifdef USE_SKINNING
  position = skinPosition(position, getSkinningMatrix());
#endif

  mat4 modelMatrix = getModelMatrix(uModelMatrix);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);

#ifdef ALPHA_MODE_MASK
  vUV0 = aUV0 * uUVTransform.xy + uUVTransform.zw;
#endif

  vec4 clipPosition = uShadowViewProj * worldPosition;

#ifdef SHADOW_CLAMP_NEAR
  // Orthographic light camera, so w is exactly 1 and this is a plain clamp:
  // an occluder between the light and the near plane is flattened onto the
  // near plane instead of being clipped, which keeps its shadow. Never enable
  // this for a perspective pass, where w can be negative behind the light.
  clipPosition.z = max(clipPosition.z, -clipPosition.w);
#endif

  gl_Position = clipPosition;
}
`;

/** Fragment stage: nothing but the (optional) alpha cutout test. */
export const shadowFragmentShader = `#version 300 es
precision highp float;
precision highp int;

#ifdef ALPHA_MODE_MASK
in vec2 vUV0;

uniform vec4 uBaseColorFactor;   // rgb unused here, a = material opacity
uniform float uAlphaCutoff;

#ifdef USE_BASECOLOR_MAP
uniform sampler2D uBaseColorMap; // texture unit 0
#endif
#endif

void main() {
#ifdef ALPHA_MODE_MASK
  float alpha = uBaseColorFactor.a;
#ifdef USE_BASECOLOR_MAP
  alpha *= texture(uBaseColorMap, vUV0).a;
#endif
  if (alpha < uAlphaCutoff) discard;
#endif
}
`;

/**
 * The (vertex, fragment) source pair, ready for `ShaderLib.register`.
 * @type {{vertex: string, fragment: string}}
 */
export const shadowShader = {
  vertex: shadowVertexShader,
  fragment: shadowFragmentShader
};

/**
 * Permutations worth warming up before the first frame. ShadowMapper compiles
 * exactly what a scene needs on demand; this list is what `Renderer.compile()`
 * can use to pay the cost up front instead.
 * @type {Array<Object>}
 */
export const SHADOW_PERMUTATIONS = [
  { SHADOW_CLAMP_NEAR: 1 },
  { SHADOW_CLAMP_NEAR: 1, USE_INSTANCING: 1 },
  { SHADOW_CLAMP_NEAR: 1, USE_SKINNING: 1 },
  { SHADOW_CLAMP_NEAR: 1, ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 },
  { SHADOW_CLAMP_NEAR: 1, USE_INSTANCING: 1, ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 },
  {},
  { USE_INSTANCING: 1 },
  { ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 }
];

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
export function register(shaderLib) {
  if (!shaderLib || typeof shaderLib.register !== 'function') {
    throw new Error('shadow.register: um ShaderLib valido e obrigatorio.');
  }
  if (typeof shaderLib.getSource === 'function') {
    const existing = shaderLib.getSource(SHADOW_SHADER_NAME);
    if (existing !== null && existing !== undefined && existing.vertex === shadowVertexShader) {
      return shaderLib;
    }
  } else if (typeof shaderLib.has === 'function' && shaderLib.has(SHADOW_SHADER_NAME) === true) {
    return shaderLib;
  }
  shaderLib.register(SHADOW_SHADER_NAME, shadowShader);
  return shaderLib;
}

/**
 * Alias of {@link register}, handy when several shader modules are imported
 * side by side and the short name would collide.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib}
 */
export function registerShadowShader(shaderLib) {
  return register(shaderLib);
}
