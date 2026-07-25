/**
 * The 'Lights' (binding 1), 'Shadows' (binding 2) and 'Fog' (binding 3) std140
 * uniform blocks. The layout mirrors UniformBuffers - do not reorder members.
 * The blocks are always declared: an unused block is stripped by the compiler and
 * never shows up in the program reflection, so declaring them costs nothing.
 * Include with '#include <lights_ubo>'.
 */
export const lights_ubo = `
#ifndef LIGHTS_UBO_GLSL_INCLUDED
#define LIGHTS_UBO_GLSL_INCLUDED

// Number of directional light slots physically present in the UBO. This is a hard
// layout constant and must stay in sync with UniformBuffers.lights.
#define DIR_LIGHT_SLOTS 4

#ifndef MAX_DIR_LIGHTS
#define MAX_DIR_LIGHTS 4
#endif

#ifndef MAX_PUNCTUAL_LIGHTS
#define MAX_PUNCTUAL_LIGHTS 256
#endif

layout(std140) uniform Lights {
  vec4 uAmbient;                        // rgb = ambient colour, w = ambient intensity
  vec4 uDirLightDir[DIR_LIGHT_SLOTS];   // xyz = direction TOWARDS the light, w = castShadow flag
  vec4 uDirLightColor[DIR_LIGHT_SLOTS]; // rgb = colour * intensity, w = shadow index
  vec4 uLightCounts;                    // x = dirCount, y = punctualCount, z = clusterEnabled, w = unused
};

layout(std140) uniform Shadows {
  mat4 uCascadeMatrix[4];   // world -> cascade clip space
  vec4 uCascadeSplits;      // far view distance of each cascade (positive, ascending)
  vec4 uShadowParams;       // x = texel size, y = depth bias, z = normal bias, w = softness
  vec4 uShadowParams2;      // x = cascade count, y = pcf radius, z = cascade blend width, w = fade distance
};

layout(std140) uniform Fog {
  vec4 uFogColor;           // rgb = fog colour (linear), w = maximum fog opacity
  vec4 uFogParams;          // x = mode (0 linear, 1 exp, 2 exp2), y = near or density, z = far, w = height falloff
};

/** Ambient irradiance already scaled by its intensity. */
vec3 getAmbientLight() { return uAmbient.rgb * uAmbient.w; }

/** Number of active directional lights, clamped to the physical slot count. */
int getDirectionalLightCount() {
  return int(clamp(uLightCounts.x, 0.0, float(DIR_LIGHT_SLOTS)));
}

/** Number of active punctual (point + spot) lights. */
int getPunctualLightCount() {
  return int(max(uLightCounts.y, 0.0));
}

/** True when the clustered light assignment textures are valid this frame. */
bool isClusteredEnabled() { return uLightCounts.z > 0.5; }

/** Number of shadow cascades actually rendered this frame. */
int getCascadeCount() { return int(clamp(uShadowParams2.x, 1.0, 4.0)); }

#endif
`;
