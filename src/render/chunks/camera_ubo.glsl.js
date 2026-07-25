/**
 * The 'Camera' std140 uniform block (binding point 0) plus small accessors.
 * The layout mirrors UniformBuffers.camera byte for byte - do not reorder.
 * Include with '#include <camera_ubo>'.
 */
export const camera_ubo = `
#ifndef CAMERA_UBO_GLSL_INCLUDED
#define CAMERA_UBO_GLSL_INCLUDED

layout(std140) uniform Camera {
  mat4 uView;
  mat4 uProj;
  mat4 uViewProj;
  mat4 uInvView;
  mat4 uInvProj;
  vec4 uCameraPos;      // xyz = world position, w = 1.0
  vec4 uCameraParams;   // x = near, y = far, z = 1/(far-near), w = vertical fov (radians)
  vec4 uResolution;     // x = width, y = height, z = 1/width, w = 1/height
  vec4 uTimeParams;     // x = elapsed seconds, y = delta seconds, z = frame index, w = unused
};

/** World space camera position. */
vec3 getCameraPosition() { return uCameraPos.xyz; }
/** Near / far plane distances (positive). */
float getCameraNear() { return uCameraParams.x; }
float getCameraFar()  { return uCameraParams.y; }
/** Vertical field of view in radians. */
float getCameraFovY() { return uCameraParams.w; }

/** Framebuffer size and its reciprocal. */
vec2 getResolution()    { return uResolution.xy; }
vec2 getTexelSize()     { return uResolution.zw; }

/** Normalized screen coordinates from gl_FragCoord.xy. */
vec2 fragCoordToUV(vec2 fragCoord) { return fragCoord * uResolution.zw; }

/** Time helpers. */
float getTime()      { return uTimeParams.x; }
float getDeltaTime() { return uTimeParams.y; }
float getFrame()     { return uTimeParams.z; }

/** World space view vector (from a surface point towards the camera). */
vec3 getViewDirection(vec3 worldPos) { return normalize(uCameraPos.xyz - worldPos); }

/** Camera forward axis in world space (right handed, looks down -Z). */
vec3 getCameraForward() { return -normalize(vec3(uInvView[2][0], uInvView[2][1], uInvView[2][2])); }

#endif
`;
