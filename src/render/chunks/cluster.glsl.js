/**
 * Clustered (froxel) punctual lighting.
 *
 * Data layout produced by ClusteredLighting:
 *  - uClusterGrid   usampler3D  R32UI, CLUSTER_X x CLUSTER_Y x CLUSTER_Z,
 *                   value = (offset << 12) | count
 *  - uLightIndices  usampler2D  R32UI, flat list of light indices, row major
 *  - uLightData     sampler2D   RGBA32F, 4 consecutive texels per light:
 *                     texel 0: position.xyz, range
 *                     texel 1: color.rgb (already scaled by intensity), intensity
 *                     texel 2: direction.xyz, innerConeCos
 *                     texel 3: type, shadowIndex, unused, outerConeCos
 *
 * The Z slice uses the standard exponential distribution
 *   slice = floor(log(viewDepth) * CLUSTER_Z / log(far/near) - CLUSTER_Z * log(near) / log(far/near))
 * which must match the CPU side assignment exactly.
 *
 * Include with '#include <cluster>'.
 */
export const cluster = `
#include <common>
#include <camera_ubo>
#include <lighting>
#ifndef CLUSTER_GLSL_INCLUDED
#define CLUSTER_GLSL_INCLUDED

#ifndef CLUSTER_X
#define CLUSTER_X 16
#endif
#ifndef CLUSTER_Y
#define CLUSTER_Y 9
#endif
#ifndef CLUSTER_Z
#define CLUSTER_Z 24
#endif
#ifndef MAX_LIGHTS_PER_CLUSTER
#define MAX_LIGHTS_PER_CLUSTER 128
#endif

// Texture unit 10.
uniform highp sampler2D uLightData;

#ifdef USE_CLUSTERED
// Texture units 9 and 7.
uniform highp usampler3D uClusterGrid;
uniform highp usampler2D uLightIndices;
#endif

/** Fetch texel 'index' from a linear RGBA32F list stored in a 2D texture. */
vec4 fetchLightTexel(int index, int width) {
  int y = index / width;
  int x = index - y * width;
  return texelFetch(uLightData, ivec2(x, y), 0);
}

/** Unpack the four texels describing one punctual light. */
PunctualLight fetchPunctualLight(int lightIndex) {
  int width = textureSize(uLightData, 0).x;
  int base = lightIndex * 4;
  vec4 t0 = fetchLightTexel(base, width);
  vec4 t1 = fetchLightTexel(base + 1, width);
  vec4 t2 = fetchLightTexel(base + 2, width);
  vec4 t3 = fetchLightTexel(base + 3, width);

  PunctualLight light;
  light.position = t0.xyz;
  light.range = t0.w;
  light.color = t1.rgb;
  light.intensity = t1.w;
  light.direction = t2.xyz;
  light.innerConeCos = t2.w;
  light.type = t3.x;
  light.shadowIndex = t3.y;
  light.outerConeCos = t3.w;
  return light;
}

/** Froxel coordinate for a pixel, from its screen position and positive view depth. */
ivec3 getClusterCoord(vec2 fragCoord, float viewDepth) {
  vec2 tileCount = vec2(float(CLUSTER_X), float(CLUSTER_Y));
  vec2 tile = floor(fragCoord * uResolution.zw * tileCount);

  float near = max(uCameraParams.x, 1e-4);
  float far = max(uCameraParams.y, near + 1e-4);
  float logRatio = log(far / near);
  float scale = float(CLUSTER_Z) / logRatio;
  float bias = -(float(CLUSTER_Z) * log(near) / logRatio);
  float slice = floor(log(max(viewDepth, near)) * scale + bias);

  return ivec3(
    clamp(int(tile.x), 0, CLUSTER_X - 1),
    clamp(int(tile.y), 0, CLUSTER_Y - 1),
    clamp(int(slice), 0, CLUSTER_Z - 1)
  );
}

#ifdef USE_CLUSTERED

/** Read one entry of the packed light index list. */
int fetchLightIndex(int i) {
  int width = textureSize(uLightIndices, 0).x;
  int y = i / width;
  int x = i - y * width;
  return int(texelFetch(uLightIndices, ivec2(x, y), 0).r);
}

/** Decode the (offset, count) pair stored in a froxel. */
ivec2 getClusterLightRange(vec2 fragCoord, float viewDepth) {
  ivec3 coord = getClusterCoord(fragCoord, viewDepth);
  uint cell = texelFetch(uClusterGrid, coord, 0).r;
  int offset = int(cell >> 12u);
  int count = int(cell & 4095u);
  return ivec2(offset, min(count, MAX_LIGHTS_PER_CLUSTER));
}

/** Accumulate every punctual light assigned to this pixel's froxel. */
vec3 evaluateClusteredLights(const PixelParams px, vec2 fragCoord, float viewDepth) {
  ivec2 range = getClusterLightRange(fragCoord, viewDepth);
  vec3 result = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS_PER_CLUSTER; ++i) {
    if (i >= range.y) break;
    PunctualLight light = fetchPunctualLight(fetchLightIndex(range.x + i));
    result += evaluatePunctualLight(px, light, 1.0);
  }
  return result;
}

/** Debug helper: heat map of the light count in the froxel. */
vec3 getClusterDebugColor(vec2 fragCoord, float viewDepth) {
  ivec2 range = getClusterLightRange(fragCoord, viewDepth);
  float t = saturate(float(range.y) / 24.0);
  return mix(vec3(0.0, 0.2, 0.6), vec3(1.0, 0.15, 0.0), t);
}

#endif

/** Brute force fallback: iterate every punctual light in the scene. */
vec3 evaluateAllPunctualLights(const PixelParams px) {
  int count = min(getPunctualLightCount(), MAX_PUNCTUAL_LIGHTS);
  vec3 result = vec3(0.0);
  for (int i = 0; i < MAX_PUNCTUAL_LIGHTS; ++i) {
    if (i >= count) break;
    PunctualLight light = fetchPunctualLight(i);
    result += evaluatePunctualLight(px, light, 1.0);
  }
  return result;
}

/**
 * Single entry point used by the lit shaders: dispatches to the clustered path when
 * the grid is available and falls back to the flat loop otherwise.
 */
vec3 evaluatePunctualLights(const PixelParams px, vec2 fragCoord, float viewDepth) {
#ifdef USE_CLUSTERED
  if (isClusteredEnabled()) return evaluateClusteredLights(px, fragCoord, viewDepth);
  return evaluateAllPunctualLights(px);
#else
  return evaluateAllPunctualLights(px);
#endif
}

#endif
`;
