/**
 * Cascaded shadow map sampling. The cascades live in a single
 * DEPTH_COMPONENT32F 2D array texture sampled through a sampler2DArrayShadow, so
 * every tap gets free hardware 2x2 PCF on top of our 16 tap Poisson disk.
 * The disk is rotated per pixel by interleaved gradient noise, animated over the
 * frame index, which turns the residual banding into temporal noise.
 * Include with '#include <shadow>'.
 */
export const shadow = `
#include <common>
#include <noise>
#include <camera_ubo>
#include <lights_ubo>
#ifndef SHADOW_GLSL_INCLUDED
#define SHADOW_GLSL_INCLUDED

#ifndef SHADOW_CASCADES
#define SHADOW_CASCADES 4
#endif

// Texture unit 8, see the fixed unit table in the architecture contract.
uniform highp sampler2DArrayShadow uShadowMap;

/** Vogel-like Poisson disk, 16 taps, mean distance optimised for PCF. */
const vec2 POISSON_DISK_16[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2( 0.94558609, -0.76890725),
  vec2(-0.09418410, -0.92938870), vec2( 0.34495938,  0.29387760),
  vec2(-0.91588581,  0.45771432), vec2(-0.81544232, -0.87912464),
  vec2(-0.38277543,  0.27676845), vec2( 0.97484398,  0.75648379),
  vec2( 0.44323325, -0.97511554), vec2( 0.53742981, -0.47373420),
  vec2(-0.26496911, -0.41893023), vec2( 0.79197514,  0.19090188),
  vec2(-0.24188840,  0.99706507), vec2(-0.81409955,  0.91437590),
  vec2( 0.19984126,  0.78641367), vec2( 0.14383161, -0.14100790)
);

/** Pick the tightest cascade that still contains this view depth. */
int selectShadowCascade(float viewDepth) {
  int cascade = SHADOW_CASCADES - 1;
  for (int i = 0; i < SHADOW_CASCADES; ++i) {
    if (viewDepth < uCascadeSplits[i]) {
      cascade = i;
      break;
    }
  }
  return cascade;
}

/** Project a world position into a cascade, returning [0,1] texture space coordinates. */
vec3 worldToShadowCoord(int cascade, vec3 worldPos) {
  vec4 clip = uCascadeMatrix[cascade] * vec4(worldPos, 1.0);
  float w = abs(clip.w) < 1e-9 ? 1e-9 : clip.w;
  return (clip.xyz / w) * 0.5 + 0.5;
}

/**
 * 16 tap rotated Poisson PCF against one cascade layer.
 * 'radius' is expressed in shadow map texels.
 */
float sampleShadowPCF(int cascade, vec3 shadowCoord, float radius, float rotation) {
  float texelSize = uShadowParams.x;
  float s = sin(rotation);
  float c = cos(rotation);
  vec2 scale = vec2(texelSize * radius);
  float sum = 0.0;
  for (int i = 0; i < 16; ++i) {
    vec2 o = POISSON_DISK_16[i];
    vec2 rotated = vec2(o.x * c - o.y * s, o.x * s + o.y * c) * scale;
    sum += texture(uShadowMap, vec4(shadowCoord.xy + rotated, float(cascade), shadowCoord.z));
  }
  return sum * 0.0625;
}

/** Single hardware-PCF tap, used by the cheap shadow path. */
float sampleShadowHard(int cascade, vec3 shadowCoord) {
  return texture(uShadowMap, vec4(shadowCoord.xy, float(cascade), shadowCoord.z));
}

/**
 * Sample one cascade with normal offset and slope scaled depth bias applied.
 * Returns 1.0 when fully lit, 0.0 when fully shadowed.
 */
float sampleShadowCascade(int cascade, vec3 worldPos, vec3 N, vec3 L, float rotation) {
  float NoL = saturate(dot(N, L));
  // Cascades get progressively coarser, so scale both biases with the cascade index.
  float cascadeScale = 1.0 + float(cascade) * 0.75;
  float normalBias = uShadowParams.z * cascadeScale * (2.0 - NoL);
  vec3 offsetPos = worldPos + N * normalBias;

  vec3 coord = worldToShadowCoord(cascade, offsetPos);
  if (coord.z <= 0.0 || coord.z >= 1.0) return 1.0;
  if (any(lessThan(coord.xy, vec2(0.0))) || any(greaterThan(coord.xy, vec2(1.0)))) return 1.0;

  float slope = clamp(tan(acos(clamp(NoL, 0.0, 0.9999))), 0.0, 4.0);
  float bias = uShadowParams.y * cascadeScale * (1.0 + slope);
  coord.z -= bias;

  float radius = max(uShadowParams2.y, 0.0) * max(uShadowParams.w, 0.0) * cascadeScale;
  if (radius <= 0.0) return sampleShadowHard(cascade, coord);
  return sampleShadowPCF(cascade, coord, radius, rotation);
}

/**
 * Full CSM lookup with a smooth transition band between neighbouring cascades and
 * a fade to fully lit past the shadow distance.
 *
 * @param worldPos  shaded world position
 * @param N         world space normal (geometric normal is preferred here)
 * @param L         unit vector towards the light
 * @param viewDepth positive distance along the camera view axis
 * @param fragCoord gl_FragCoord.xy, used to decorrelate the PCF kernel rotation
 */
float getShadow(vec3 worldPos, vec3 N, vec3 L, float viewDepth, vec2 fragCoord) {
  float fadeDistance = uShadowParams2.w;
  if (fadeDistance > 0.0 && viewDepth >= fadeDistance) return 1.0;

  float rotation = interleavedGradientNoise(fragCoord, uTimeParams.z) * PI2;
  int cascade = selectShadowCascade(viewDepth);
  float result = sampleShadowCascade(cascade, worldPos, N, L, rotation);

  // Cross fade with the next cascade over the last 'blend' world units of this one.
  float blend = uShadowParams2.z;
  if (blend > 0.0 && cascade < SHADOW_CASCADES - 1) {
    float split = uCascadeSplits[cascade];
    float t = saturate((viewDepth - (split - blend)) / blend);
    if (t > 0.0) {
      float next = sampleShadowCascade(cascade + 1, worldPos, N, L, rotation);
      result = mix(result, next, t);
    }
  }

  // Fade the shadow out over the last 10% of the shadow distance.
  if (fadeDistance > 0.0) {
    float fadeStart = fadeDistance * 0.9;
    result = mix(result, 1.0, saturate((viewDepth - fadeStart) / max(fadeDistance - fadeStart, EPS)));
  }

  return saturate(result);
}

/** Debug helper: a distinct tint per cascade, handy to validate the split distances. */
vec3 getCascadeDebugColor(float viewDepth) {
  int cascade = selectShadowCascade(viewDepth);
  if (cascade == 0) return vec3(1.0, 0.35, 0.35);
  if (cascade == 1) return vec3(0.35, 1.0, 0.35);
  if (cascade == 2) return vec3(0.35, 0.55, 1.0);
  return vec3(1.0, 1.0, 0.35);
}

#endif
`;
