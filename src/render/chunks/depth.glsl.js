/**
 * Depth buffer utilities: linearisation, view Z conversions and position
 * reconstruction from a depth sample. Every function takes its projection data
 * explicitly so the chunk stays usable from post processing shaders that do not
 * bind the Camera uniform block.
 * Include with '#include <depth>'.
 */
export const depth = `
#include <common>
#ifndef DEPTH_GLSL_INCLUDED
#define DEPTH_GLSL_INCLUDED

/**
 * Window space depth (0..1, as sampled from a depth texture) to a positive
 * distance along the view axis, for a perspective projection.
 */
float linearizeDepth(float depth, float near, float far) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * near * far) / max(far + near - z * (far - near), 1e-9);
}

/** Same as above, normalized into [0,1] between the near and far planes. */
float linearizeDepth01(float depth, float near, float far) {
  return (linearizeDepth(depth, near, far) - near) / max(far - near, 1e-9);
}

/** Window space depth to view space Z (negative, right handed). */
float perspectiveDepthToViewZ(float depth, float near, float far) {
  return (near * far) / max((far - near) * depth - far, -1e-9);
}

/** View space Z (negative) back to window space depth in [0,1]. */
float viewZToPerspectiveDepth(float viewZ, float near, float far) {
  return ((near + viewZ) * far) / max((far - near) * viewZ, 1e-9);
}

/** Orthographic counterparts, where depth is already linear. */
float orthographicDepthToViewZ(float depth, float near, float far) {
  return depth * (near - far) - near;
}
float viewZToOrthographicDepth(float viewZ, float near, float far) {
  return (viewZ + near) / max(near - far, 1e-9);
}

/** Positive view distance from a view space position. */
float viewDepthFromViewPos(vec3 viewPos) { return -viewPos.z; }

/**
 * Reconstruct the view space position of a pixel.
 * uv is in [0,1], depth is the raw depth texture sample in [0,1].
 */
vec3 viewPositionFromDepth(vec2 uv, float depth, mat4 invProj) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = invProj * ndc;
  float w = abs(viewPos.w) < 1e-9 ? 1e-9 : viewPos.w;
  return viewPos.xyz / w;
}

/** Reconstruct the world space position of a pixel from its depth. */
vec3 worldPositionFromDepth(vec2 uv, float depth, mat4 invViewProj) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 worldPos = invViewProj * ndc;
  float w = abs(worldPos.w) < 1e-9 ? 1e-9 : worldPos.w;
  return worldPos.xyz / w;
}

/**
 * Fast reconstruction from a precomputed view ray: pass the interpolated ray that
 * points from the camera through the pixel at the far plane, in view space.
 */
vec3 viewPositionFromRay(vec3 viewRay, float linearDepth, float far) {
  return viewRay * (linearDepth / max(far, 1e-9));
}

#ifdef FRAGMENT_SHADER
/** Reconstruct the view space normal from the depth buffer (SSAO fallback). */
vec3 viewNormalFromDepth(vec3 viewPos) {
  return normalize(cross(dFdx(viewPos), dFdy(viewPos)));
}
#endif

/** Logarithmic depth encode/decode, useful for very large view distances. */
float encodeLogDepth(float clipW, float far) {
  return log2(max(1e-6, 1.0 + clipW)) / log2(1.0 + far);
}

#endif
`;
