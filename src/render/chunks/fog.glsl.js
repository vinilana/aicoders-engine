/**
 * Distance fog with an optional exponential height falloff.
 *
 * uFogParams = (mode, near|density, far, heightFalloff)
 *   mode 0 -> linear, fades between 'near' and 'far'
 *   mode 1 -> exponential,        1 - exp(-density * d)
 *   mode 2 -> exponential squared,1 - exp(-(density * d)^2)
 * uFogColor.a caps the maximum fog opacity so distant geometry never disappears
 * completely, and 'heightFalloff' (when > 0) attenuates the density with altitude
 * around y = 0.
 *
 * Include with '#include <fog>'.
 */
export const fog = `
#include <common>
#include <lights_ubo>
#ifndef FOG_GLSL_INCLUDED
#define FOG_GLSL_INCLUDED

#define FOG_MODE_LINEAR 0
#define FOG_MODE_EXP    1
#define FOG_MODE_EXP2   2

/** Linear fog factor: 0 at 'near', 1 at 'far'. */
float fogFactorLinear(float dist, float near, float far) {
  return saturate((dist - near) / max(far - near, EPS));
}

/** Exponential fog factor. */
float fogFactorExp(float dist, float density) {
  return 1.0 - exp(-density * dist);
}

/** Exponential squared fog factor, the classic OpenGL EXP2 curve. */
float fogFactorExp2(float dist, float density) {
  float d = density * dist;
  return 1.0 - exp(-d * d);
}

/**
 * Height based density scale. 'falloff' controls how quickly the fog thins out
 * above y = 0; the integral is approximated with the standard analytic form for
 * a ray of constant altitude, which is accurate enough for camera relative fog.
 */
float fogHeightScale(float worldY, float falloff) {
  if (falloff <= 0.0) return 1.0;
  return exp(-max(worldY, 0.0) * falloff);
}

/** Fog factor in [0,1] using the values stored in the Fog uniform block. */
float computeFogFactor(float viewDistance, float worldY) {
  int mode = int(uFogParams.x + 0.5);
  float factor;
  if (mode == FOG_MODE_EXP) {
    factor = fogFactorExp(viewDistance, uFogParams.y);
  } else if (mode == FOG_MODE_EXP2) {
    factor = fogFactorExp2(viewDistance, uFogParams.y);
  } else {
    factor = fogFactorLinear(viewDistance, uFogParams.y, uFogParams.z);
  }
  factor *= fogHeightScale(worldY, uFogParams.w);
  return saturate(factor * max(uFogColor.a, 0.0));
}

/** Blend a shaded colour towards the fog colour. */
vec3 applyFog(vec3 color, float viewDistance, float worldY) {
  return mix(color, uFogColor.rgb, computeFogFactor(viewDistance, worldY));
}

/** Convenience overload taking the world position directly. */
vec3 applyFog(vec3 color, float viewDistance, vec3 worldPos) {
  return applyFog(color, viewDistance, worldPos.y);
}

/**
 * Fog for additive / premultiplied surfaces: instead of blending towards the fog
 * colour the contribution is simply faded out, which keeps additive particles from
 * turning into bright fog coloured blobs.
 */
vec3 applyFogAdditive(vec3 color, float viewDistance, float worldY) {
  return color * (1.0 - computeFogFactor(viewDistance, worldY));
}

#endif
`;
