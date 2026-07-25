/**
 * Post processing shader programs.
 *
 * Every pass draws the same full screen triangle, so they all share one vertex
 * shader. The fragment shaders are written against the fixed chunk library
 * (`common`, `tonemap`, `depth`, `camera_ubo`) and are compiled through
 * ShaderLib, which means a permutation is only ever built once.
 *
 * Registered names:
 *   post_copy             straight blit, used when the chain is disabled
 *   post_bloom_prefilter  threshold with a soft knee + 13 tap downsample to 1/2
 *   post_bloom_down       13 tap Call of Duty (Jimenez) downsample
 *   post_bloom_up         9 tap tent upsample, additively blended
 *   post_ssao             16 sample hemisphere SSAO reconstructed from depth
 *   post_blur             separable bilateral blur (used on the SSAO buffer)
 *   post_composite        exposure -> bloom/AO mix -> tone map -> sRGB
 *   post_fxaa             FXAA 3.11 + vignette + chromatic aberration + grain
 *
 * Texture units used by the chain (post processing owns the whole unit range
 * while it runs, every bind still goes through StateCache):
 *   0 uSource   1 uBloomTexture   2 uAOTexture   3 uDepthTexture   4 uNoiseTexture
 */

/** Shared full screen triangle vertex stage. */
export const POST_VERTEX = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;

out vec2 vUV0;

void main() {
  vUV0 = aUV0;
  gl_Position = vec4(aPosition.xy, 0.0, 1.0);
}
`;

/** Straight copy, used when post processing is disabled but a blit is needed. */
export const POST_COPY_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uSource;
uniform vec4 uCopyScale; // rgb multiplier, w = alpha override (< 0 keeps the source alpha)

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 texel = texture(uSource, vUV0);
  fragColor = vec4(texel.rgb * uCopyScale.rgb, uCopyScale.w < 0.0 ? texel.a : uCopyScale.w);
}
`;

/**
 * Bloom prefilter: 13 tap downsample of the HDR scene into the half resolution
 * mip 0 of the bloom chain, followed by a quadratic soft knee threshold.
 *
 * uBloomFilter = (threshold, threshold - knee, 2 * knee, 0.25 / knee)
 */
export const POST_BLOOM_PREFILTER_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uSource;
uniform vec2 uTexelSize;      // 1 / source resolution
uniform vec4 uBloomFilter;    // threshold, knee curve
uniform float uClampMax;      // firefly clamp applied before thresholding

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

vec3 fetch(vec2 uv) {
  vec3 c = texture(uSource, uv).rgb;
  // Guard against NaN/Inf leaking out of the HDR buffer and against single
  // extremely bright pixels turning into a permanent bloom firefly.
  c = max(c, vec3(0.0));
  c = min(c, vec3(uClampMax));
  return c;
}

/** Karis average weight: the reciprocal of 1 + luma, in a partial (per group) form. */
float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luminance(c));
}

/** Quadratic threshold with a soft knee (Unity / Jimenez formulation). */
vec3 softThreshold(vec3 color) {
  float br = max3(color);
  float rq = clamp(br - uBloomFilter.y, 0.0, uBloomFilter.z);
  rq = uBloomFilter.w * rq * rq;
  return color * max(rq, br - uBloomFilter.x) / max(br, 1e-5);
}

void main() {
  vec2 t = uTexelSize;

  vec3 a = fetch(vUV0 + t * vec2(-2.0,  2.0));
  vec3 b = fetch(vUV0 + t * vec2( 0.0,  2.0));
  vec3 c = fetch(vUV0 + t * vec2( 2.0,  2.0));
  vec3 d = fetch(vUV0 + t * vec2(-2.0,  0.0));
  vec3 e = fetch(vUV0);
  vec3 f = fetch(vUV0 + t * vec2( 2.0,  0.0));
  vec3 g = fetch(vUV0 + t * vec2(-2.0, -2.0));
  vec3 h = fetch(vUV0 + t * vec2( 0.0, -2.0));
  vec3 i = fetch(vUV0 + t * vec2( 2.0, -2.0));
  vec3 j = fetch(vUV0 + t * vec2(-1.0,  1.0));
  vec3 k = fetch(vUV0 + t * vec2( 1.0,  1.0));
  vec3 l = fetch(vUV0 + t * vec2(-1.0, -1.0));
  vec3 m = fetch(vUV0 + t * vec2( 1.0, -1.0));

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;

  // Karis average: weight each group by its inverse luma so a single very bright
  // sample cannot dominate the downsample and flicker between frames.
  float w0 = karisWeight(g0) * 0.500;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.125;
  float wsum = max(w0 + w1 + w2 + w3 + w4, 1e-5);

  vec3 color = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / wsum;

  fragColor = vec4(softThreshold(color), 1.0);
}
`;

/** 13 tap downsample (Jimenez, Call of Duty: Advanced Warfare). */
export const POST_BLOOM_DOWN_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uSource;
uniform vec2 uTexelSize; // 1 / source resolution

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 t = uTexelSize;

  vec3 a = texture(uSource, vUV0 + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSource, vUV0 + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSource, vUV0 + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSource, vUV0 + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uSource, vUV0).rgb;
  vec3 f = texture(uSource, vUV0 + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uSource, vUV0 + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSource, vUV0 + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uSource, vUV0 + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uSource, vUV0 + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uSource, vUV0 + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uSource, vUV0 + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSource, vUV0 + t * vec2( 1.0, -1.0)).rgb;

  vec3 color = e * 0.125;
  color += (a + c + g + i) * 0.03125;
  color += (b + d + f + h) * 0.0625;
  color += (j + k + l + m) * 0.125;

  fragColor = vec4(color, 1.0);
}
`;

/**
 * 9 tap tent upsample. The result is meant to be accumulated with an additive
 * blend on top of the next larger mip, which is the classic COD bloom chain.
 */
export const POST_BLOOM_UP_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uSource;
uniform vec2 uTexelSize;  // 1 / source resolution
uniform float uRadius;    // tent radius in source texels
uniform float uScale;     // per level contribution

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 t = uTexelSize * uRadius;

  vec3 color = texture(uSource, vUV0 + t * vec2(-1.0,  1.0)).rgb * 1.0;
  color += texture(uSource, vUV0 + t * vec2( 0.0,  1.0)).rgb * 2.0;
  color += texture(uSource, vUV0 + t * vec2( 1.0,  1.0)).rgb * 1.0;
  color += texture(uSource, vUV0 + t * vec2(-1.0,  0.0)).rgb * 2.0;
  color += texture(uSource, vUV0).rgb * 4.0;
  color += texture(uSource, vUV0 + t * vec2( 1.0,  0.0)).rgb * 2.0;
  color += texture(uSource, vUV0 + t * vec2(-1.0, -1.0)).rgb * 1.0;
  color += texture(uSource, vUV0 + t * vec2( 0.0, -1.0)).rgb * 2.0;
  color += texture(uSource, vUV0 + t * vec2( 1.0, -1.0)).rgb * 1.0;

  fragColor = vec4(color * (1.0 / 16.0) * uScale, 1.0);
}
`;

/**
 * Screen space ambient occlusion.
 *
 * Position and normal are reconstructed from the depth buffer alone (no G-buffer
 * required): the normal comes from the four depth neighbours, picking the closest
 * pair on each axis so that silhouettes stay sharp. The 16 kernel samples live in
 * a tangent hemisphere rotated per pixel by a 4x4 noise texture.
 *
 * The Camera uniform block supplies uProj / uInvProj / near / far. When the block
 * has not been filled in (far == 0) the pass degrades to "no occlusion" instead of
 * producing NaNs.
 */
export const POST_SSAO_FRAGMENT = `#version 300 es
#include <common>
#include <camera_ubo>
#include <depth>

#ifndef SSAO_SAMPLES
#define SSAO_SAMPLES 16
#endif

uniform sampler2D uDepthTexture;
uniform sampler2D uNoiseTexture;
uniform vec3 uSSAOKernel[SSAO_SAMPLES];
uniform vec4 uSSAOParams;     // radius, intensity, bias, power
uniform vec2 uNoiseScale;     // aoResolution / noiseSize

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

float sampleViewZ(vec2 uv) {
  float d = texture(uDepthTexture, uv).r;
  return perspectiveDepthToViewZ(d, uCameraParams.x, uCameraParams.y);
}

vec3 viewPosAt(vec2 uv, float rawDepth) {
  return viewPositionFromDepth(uv, rawDepth, uInvProj);
}

void main() {
  // Uniform block not bound (or an orthographic camera with a degenerate range):
  // returning full visibility keeps the composite pass correct.
  if (uCameraParams.y <= 0.0) {
    fragColor = vec4(1.0);
    return;
  }

  float rawDepth = texture(uDepthTexture, vUV0).r;
  if (rawDepth >= 1.0) {
    fragColor = vec4(1.0);
    return;
  }

  vec2 texel = 1.0 / vec2(textureSize(uDepthTexture, 0));
  vec3 origin = viewPosAt(vUV0, rawDepth);

  // Normal from the four neighbours, keeping the closest sample on each axis.
  vec3 pRight = viewPosAt(vUV0 + vec2(texel.x, 0.0), texture(uDepthTexture, vUV0 + vec2(texel.x, 0.0)).r);
  vec3 pLeft  = viewPosAt(vUV0 - vec2(texel.x, 0.0), texture(uDepthTexture, vUV0 - vec2(texel.x, 0.0)).r);
  vec3 pUp    = viewPosAt(vUV0 + vec2(0.0, texel.y), texture(uDepthTexture, vUV0 + vec2(0.0, texel.y)).r);
  vec3 pDown  = viewPosAt(vUV0 - vec2(0.0, texel.y), texture(uDepthTexture, vUV0 - vec2(0.0, texel.y)).r);

  vec3 dx = abs(pRight.z - origin.z) < abs(pLeft.z - origin.z) ? (pRight - origin) : (origin - pLeft);
  vec3 dy = abs(pUp.z - origin.z) < abs(pDown.z - origin.z) ? (pUp - origin) : (origin - pDown);
  vec3 normal = normalize(cross(dx, dy));
  if (dot(normal, origin) > 0.0) normal = -normal; // face the camera

  vec3 randomVec = texture(uNoiseTexture, vUV0 * uNoiseScale).xyz * 2.0 - 1.0;
  vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 tbn = mat3(tangent, bitangent, normal);

  float radius = uSSAOParams.x;
  float bias = uSSAOParams.z;
  float occlusion = 0.0;

  for (int i = 0; i < SSAO_SAMPLES; i++) {
    vec3 samplePos = origin + tbn * uSSAOKernel[i] * radius;

    vec4 clip = uProj * vec4(samplePos, 1.0);
    if (clip.w <= 1e-6) continue; // behind (or on) the camera plane
    vec2 sampleUV = (clip.xy / clip.w) * 0.5 + 0.5;
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;

    float sceneZ = sampleViewZ(sampleUV);
    // View Z is negative: a larger (less negative) value is closer to the camera.
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(origin.z - sceneZ), 1e-4));
    occlusion += (sceneZ >= samplePos.z + bias ? 1.0 : 0.0) * rangeCheck;
  }

  float ao = 1.0 - (occlusion / float(SSAO_SAMPLES)) * uSSAOParams.y;
  ao = pow(saturate(ao), max(uSSAOParams.w, 0.01));
  fragColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * Separable bilateral blur used to clean up the SSAO buffer. Nine taps per pass
 * (a 4 texel radius on each side), weighted by a gaussian and rejected across
 * depth discontinuities so the occlusion never bleeds over a silhouette.
 */
export const POST_BLUR_FRAGMENT = `#version 300 es
#include <common>
#include <camera_ubo>
#include <depth>

uniform sampler2D uSource;
uniform sampler2D uDepthTexture;
uniform vec2 uBlurDirection;  // (texelX, 0) or (0, texelY)
uniform vec2 uBlurParams;     // x = depth sharpness, y = unused

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

const float BLUR_WEIGHTS[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);

float viewZAt(vec2 uv) {
  float d = texture(uDepthTexture, uv).r;
  return perspectiveDepthToViewZ(d, uCameraParams.x, uCameraParams.y);
}

void main() {
  float centerZ = viewZAt(vUV0);
  float sharpness = uBlurParams.x;

  float sum = texture(uSource, vUV0).r * BLUR_WEIGHTS[0];
  float weightSum = BLUR_WEIGHTS[0];

  for (int i = 1; i < 5; i++) {
    vec2 offset = uBlurDirection * float(i);

    vec2 uvA = vUV0 + offset;
    float zA = viewZAt(uvA);
    float wA = BLUR_WEIGHTS[i] * exp2(-abs(centerZ - zA) * sharpness);
    sum += texture(uSource, uvA).r * wA;
    weightSum += wA;

    vec2 uvB = vUV0 - offset;
    float zB = viewZAt(uvB);
    float wB = BLUR_WEIGHTS[i] * exp2(-abs(centerZ - zB) * sharpness);
    sum += texture(uSource, uvB).r * wB;
    weightSum += wB;
  }

  float ao = sum / max(weightSum, 1e-5);
  fragColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * HDR composite: bloom and ambient occlusion are mixed in, then exposure, the
 * tone curve and the sRGB encode produce the LDR image the final pass works on.
 *
 * Defines: USE_BLOOM, USE_SSAO.
 */
export const POST_COMPOSITE_FRAGMENT = `#version 300 es
#include <common>
#include <tonemap>

uniform sampler2D uSource;
#ifdef USE_BLOOM
uniform sampler2D uBloomTexture;
uniform vec4 uBloomParams;    // intensity, reserved, reserved, reserved
#endif
#ifdef USE_SSAO
uniform sampler2D uAOTexture;
uniform float uAOStrength;
#endif
uniform vec4 uCompositeParams; // exposure, toneMapMode, whitePoint, saturation

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

void main() {
  vec3 color = texture(uSource, vUV0).rgb;
  color = max(color, vec3(0.0));

#ifdef USE_SSAO
  float ao = texture(uAOTexture, vUV0).r;
  color *= mix(1.0, ao, saturate(uAOStrength));
#endif

#ifdef USE_BLOOM
  vec3 bloom = texture(uBloomTexture, vUV0).rgb;
  color += bloom * uBloomParams.x;
#endif

  color = applyExposure(color, uCompositeParams.x);

  int mode = int(uCompositeParams.y + 0.5);
  if (mode == TONEMAP_REINHARD) {
    color = tonemapReinhardExtended(color, max(uCompositeParams.z, 1e-3));
  } else {
    color = tonemap(color, mode);
  }

  // Optional saturation trim, applied on the tone mapped (display referred) value.
  float sat = uCompositeParams.w;
  if (abs(sat - 1.0) > 1e-4) {
    color = mix(vec3(luminance(color)), color, sat);
  }

  color = linearToSRGB(color);

  fragColor = vec4(color, 1.0);
}
`;

/**
 * Final LDR pass: FXAA 3.11 followed by the display effects that must run after
 * antialiasing (vignette, chromatic aberration, film grain).
 *
 * Defines: USE_FXAA, USE_VIGNETTE, USE_CHROMATIC_ABERRATION, USE_GRAIN.
 * The whole pass is skipped by PostProcessing when none of them is enabled.
 */
export const POST_FXAA_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uSource;
uniform vec2 uTexelSize;          // 1 / resolution
uniform vec4 uFXAAParams;         // subpixel quality, edge threshold, edge threshold min, unused
uniform vec4 uVignetteParams;     // intensity, smoothness, roundness, aspect
uniform vec4 uGrainParams;        // intensity, response, time/frame, unused
uniform float uChromaticAmount;

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

/** Perceptual luma of an already sRGB encoded colour, as FXAA expects. */
float fxaaLuma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

#ifdef USE_FXAA
#define FXAA_ITERATIONS 12
const float FXAA_QUALITY_STEP[12] = float[12](
  1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0
);

/**
 * FXAA 3.11, quality preset. Edge orientation is detected from the 3x3
 * neighbourhood, the edge is then walked in both directions until its end is
 * found, and the pixel is finally resampled at the sub texel offset that the
 * edge geometry implies. A sub pixel term recovers the high frequency detail the
 * edge pass alone would leave aliased.
 */
vec3 applyFXAA(vec2 uv, vec2 rcp, float subpixQuality, float edgeThreshold, float edgeThresholdMin) {
  vec3 colorCenter = texture(uSource, uv).rgb;
  float lumaCenter = fxaaLuma(colorCenter);

  float lumaDown  = fxaaLuma(texture(uSource, uv + vec2(0.0, -1.0) * rcp).rgb);
  float lumaUp    = fxaaLuma(texture(uSource, uv + vec2(0.0,  1.0) * rcp).rgb);
  float lumaLeft  = fxaaLuma(texture(uSource, uv + vec2(-1.0, 0.0) * rcp).rgb);
  float lumaRight = fxaaLuma(texture(uSource, uv + vec2( 1.0, 0.0) * rcp).rgb);

  float lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
  float lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));
  float lumaRange = lumaMax - lumaMin;

  // Flat enough: nothing to antialias.
  if (lumaRange < max(edgeThresholdMin, lumaMax * edgeThreshold)) return colorCenter;

  float lumaDownLeft  = fxaaLuma(texture(uSource, uv + vec2(-1.0, -1.0) * rcp).rgb);
  float lumaUpRight   = fxaaLuma(texture(uSource, uv + vec2( 1.0,  1.0) * rcp).rgb);
  float lumaUpLeft    = fxaaLuma(texture(uSource, uv + vec2(-1.0,  1.0) * rcp).rgb);
  float lumaDownRight = fxaaLuma(texture(uSource, uv + vec2( 1.0, -1.0) * rcp).rgb);

  float lumaDownUp = lumaDown + lumaUp;
  float lumaLeftRight = lumaLeft + lumaRight;
  float lumaLeftCorners = lumaDownLeft + lumaUpLeft;
  float lumaDownCorners = lumaDownLeft + lumaDownRight;
  float lumaRightCorners = lumaDownRight + lumaUpRight;
  float lumaUpCorners = lumaUpRight + lumaUpLeft;

  float edgeHorizontal =
    abs(-2.0 * lumaLeft + lumaLeftCorners) +
    abs(-2.0 * lumaCenter + lumaDownUp) * 2.0 +
    abs(-2.0 * lumaRight + lumaRightCorners);
  float edgeVertical =
    abs(-2.0 * lumaUp + lumaUpCorners) +
    abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0 +
    abs(-2.0 * lumaDown + lumaDownCorners);

  bool isHorizontal = edgeHorizontal >= edgeVertical;

  float luma1 = isHorizontal ? lumaDown : lumaLeft;
  float luma2 = isHorizontal ? lumaUp : lumaRight;
  float gradient1 = luma1 - lumaCenter;
  float gradient2 = luma2 - lumaCenter;
  bool is1Steepest = abs(gradient1) >= abs(gradient2);
  float gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

  float stepLength = isHorizontal ? rcp.y : rcp.x;
  float lumaLocalAverage = 0.0;
  if (is1Steepest) {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
  } else {
    lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
  }

  vec2 currentUv = uv;
  if (isHorizontal) currentUv.y += stepLength * 0.5;
  else currentUv.x += stepLength * 0.5;

  vec2 offset = isHorizontal ? vec2(rcp.x, 0.0) : vec2(0.0, rcp.y);
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;

  float lumaEnd1 = fxaaLuma(texture(uSource, uv1).rgb) - lumaLocalAverage;
  float lumaEnd2 = fxaaLuma(texture(uSource, uv2).rgb) - lumaLocalAverage;
  bool reached1 = abs(lumaEnd1) >= gradientScaled;
  bool reached2 = abs(lumaEnd2) >= gradientScaled;
  bool reachedBoth = reached1 && reached2;

  if (!reached1) uv1 -= offset;
  if (!reached2) uv2 += offset;

  if (!reachedBoth) {
    for (int i = 2; i < FXAA_ITERATIONS; i++) {
      if (!reached1) {
        lumaEnd1 = fxaaLuma(texture(uSource, uv1).rgb) - lumaLocalAverage;
        reached1 = abs(lumaEnd1) >= gradientScaled;
      }
      if (!reached2) {
        lumaEnd2 = fxaaLuma(texture(uSource, uv2).rgb) - lumaLocalAverage;
        reached2 = abs(lumaEnd2) >= gradientScaled;
      }
      if (reached1 && reached2) break;

      float quality = FXAA_QUALITY_STEP[i];
      if (!reached1) uv1 -= offset * quality;
      if (!reached2) uv2 += offset * quality;
    }
  }

  float distance1 = isHorizontal ? (uv.x - uv1.x) : (uv.y - uv1.y);
  float distance2 = isHorizontal ? (uv2.x - uv.x) : (uv2.y - uv.y);

  bool isDirection1 = distance1 < distance2;
  float distanceFinal = min(distance1, distance2);
  float edgeThickness = distance1 + distance2;
  float pixelOffset = -distanceFinal / max(edgeThickness, 1e-6) + 0.5;

  bool isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  bool correctVariation = ((isDirection1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaCenterSmaller;
  float finalOffset = correctVariation ? pixelOffset : 0.0;

  // Sub pixel antialiasing from the local 3x3 average.
  float lumaAverage = (1.0 / 12.0) * (2.0 * (lumaDownUp + lumaLeftRight) + lumaLeftCorners + lumaRightCorners);
  float subPixelOffset1 = saturate(abs(lumaAverage - lumaCenter) / max(lumaRange, 1e-6));
  float subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
  float subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * subpixQuality;

  finalOffset = max(finalOffset, subPixelOffsetFinal);

  vec2 finalUv = uv;
  if (isHorizontal) finalUv.y += finalOffset * stepLength;
  else finalUv.x += finalOffset * stepLength;

  return texture(uSource, finalUv).rgb;
}
#endif

#ifdef USE_GRAIN
/** Interleaved gradient noise: deterministic, no texture, no Math.random. */
float grainNoise(vec2 fragCoord, float frame) {
  vec2 p = fragCoord + 5.588238 * fract(frame * 0.6180339887);
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
#endif

void main() {
  vec2 uv = vUV0;
  vec3 color;

#ifdef USE_FXAA
  color = applyFXAA(uv, uTexelSize, uFXAAParams.x, uFXAAParams.y, uFXAAParams.z);
#else
  color = texture(uSource, uv).rgb;
#endif

#ifdef USE_CHROMATIC_ABERRATION
  // Radial split of the red and blue channels, strongest at the frame edges.
  vec2 shift = (uv - 0.5) * uChromaticAmount * 0.01;
  color.r = texture(uSource, uv + shift).r;
  color.b = texture(uSource, uv - shift).b;
#endif

#ifdef USE_VIGNETTE
  // Procedural vignette: distance from the centre, aspect corrected by
  // 'roundness' and shaped by 'smoothness'. An intensity of 0 is a no-op.
  vec2 d = abs(uv - 0.5) * (uVignetteParams.x * 3.0);
  d.x *= mix(1.0, max(uVignetteParams.w, 1e-3), saturate(uVignetteParams.z));
  d = pow(saturate(d), vec2(max(uVignetteParams.y, 1e-3) * 5.0));
  color *= saturate(1.0 - dot(d, d));
#endif

#ifdef USE_GRAIN
  float n = grainNoise(gl_FragCoord.xy, uGrainParams.z) - 0.5;
  // Grain is most visible in the mid tones, barely in the blacks and whites.
  float lum = luminance(color);
  float response = mix(1.0, 1.0 - abs(lum * 2.0 - 1.0), saturate(uGrainParams.y));
  color += n * uGrainParams.x * response;
#endif

  fragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

/**
 * Every post processing program, keyed by the name it is registered under.
 * @type {Object<string,{vertex:string, fragment:string}>}
 */
export const POST_SHADERS = {
  post_copy: { vertex: POST_VERTEX, fragment: POST_COPY_FRAGMENT },
  post_bloom_prefilter: { vertex: POST_VERTEX, fragment: POST_BLOOM_PREFILTER_FRAGMENT },
  post_bloom_down: { vertex: POST_VERTEX, fragment: POST_BLOOM_DOWN_FRAGMENT },
  post_bloom_up: { vertex: POST_VERTEX, fragment: POST_BLOOM_UP_FRAGMENT },
  post_ssao: { vertex: POST_VERTEX, fragment: POST_SSAO_FRAGMENT },
  post_blur: { vertex: POST_VERTEX, fragment: POST_BLUR_FRAGMENT },
  post_composite: { vertex: POST_VERTEX, fragment: POST_COMPOSITE_FRAGMENT },
  post_fxaa: { vertex: POST_VERTEX, fragment: POST_FXAA_FRAGMENT }
};

/** Ordered list of the registered names. @type {string[]} */
export const POST_SHADER_NAMES = Object.keys(POST_SHADERS);

/**
 * Register every post processing program on a ShaderLib.
 * Calling it more than once simply replaces the sources with identical ones.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same instance
 */
export function registerPostShaders(shaderLib) {
  if (!shaderLib || typeof shaderLib.register !== 'function') {
    throw new Error('registerPostShaders: uma ShaderLib valida e obrigatoria.');
  }
  for (let i = 0, n = POST_SHADER_NAMES.length; i < n; i++) {
    const name = POST_SHADER_NAMES[i];
    if (typeof shaderLib.has === 'function' && shaderLib.has(name)) continue;
    shaderLib.register(name, POST_SHADERS[name]);
  }
  return shaderLib;
}

/**
 * Alias of {@link registerPostShaders}, matching the `register(shaderLib)` naming
 * used by the other shader modules.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib}
 */
export function register(shaderLib) {
  return registerPostShaders(shaderLib);
}
