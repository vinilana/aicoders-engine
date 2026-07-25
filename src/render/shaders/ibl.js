/**
 * Image based lighting generation programs.
 *
 * All of them render a full screen triangle into one face (and mip level) of a
 * cube map, except the BRDF integration which fills a plain 2D LUT. The direction
 * of the fragment is rebuilt in the vertex stage from `uCubeBasis`, a mat3 whose
 * columns are (right, up, forward) of the face being rendered, so that
 *
 *     direction = uCubeBasis * vec3(s, t, 1)
 *
 * with (s,t) the face coordinates in [-1,1]. The six matrices are built by
 * IBL.js and follow the OpenGL cube map face table exactly.
 *
 * Registered names:
 *   ibl_equirect_to_cube  equirectangular panorama -> cube map face
 *   ibl_sky               analytic Preetham style sky -> cube map face
 *   ibl_irradiance        cosine convolution (diffuse irradiance / PI)
 *   ibl_prefilter         GGX prefiltered specular radiance, one mip per call
 *   ibl_brdf              split sum DFG term (scale, bias) LUT
 *
 * Convention note: `ibl_irradiance` stores E / PI, i.e. the value that the
 * `ibl` chunk multiplies straight by the diffuse albedo. The Lambert 1/PI is
 * therefore already baked into the map.
 *
 * The quasi Monte Carlo helpers (Van der Corput / Hammersley / importance
 * sampling) are spelled out in each program that needs them rather than shared
 * through a concatenated string, so that every export stays a complete,
 * independently checkable `#version 300 es` shader.
 */

/** Vertex stage for every cube face pass: rebuilds the world direction. */
export const IBL_CUBE_VERTEX = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;

uniform mat3 uCubeBasis;

out vec3 vDirection;

void main() {
  vec2 st = aUV0 * 2.0 - 1.0;
  vDirection = uCubeBasis * vec3(st, 1.0);
  gl_Position = vec4(aPosition.xy, 0.0, 1.0);
}
`;

/** Equirectangular panorama projected onto one cube map face. */
export const IBL_EQUIRECT_FRAGMENT = `#version 300 es
#include <common>

uniform sampler2D uEquirectMap;
uniform vec4 uEquirectParams; // flipV, azimuth rotation (radians), intensity, sRGB decode

in vec3 vDirection;
layout(location = 0) out vec4 fragColor;

void main() {
  vec3 d = normalize(vDirection);

  float rotation = uEquirectParams.y;
  float c = cos(rotation);
  float s = sin(rotation);
  vec3 r = vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);

  float u = atan(r.z, r.x) * INV_PI2 + 0.5;
  float v = acos(clamp(r.y, -1.0, 1.0)) * INV_PI;
  if (uEquirectParams.x > 0.5) v = 1.0 - v;

  vec3 color = texture(uEquirectMap, vec2(u, v)).rgb;
  if (uEquirectParams.w > 0.5) color = sRGBToLinear(color);

  fragColor = vec4(max(color, vec3(0.0)) * uEquirectParams.z, 1.0);
}
`;

/**
 * Analytic sky, Preetham style single scattering with a Henyey-Greenstein Mie
 * phase, plus a sun disc, a ground half space and optional fbm clouds.
 *
 * The model is evaluated a second time for a reference configuration (sun and
 * view both at the zenith) and the result is normalised against it, so the
 * output lands in a predictable linear radiance range no matter the turbidity:
 * the zenith of a noon sky sits at `uSkyParams2.x` and everything else keeps its
 * physical ratio to it. That is what makes the generated cube map directly
 * usable as scene lighting.
 */
export const IBL_SKY_FRAGMENT = `#version 300 es
#include <common>
#include <noise>

uniform vec3 uSunDirection;   // normalized, pointing towards the sun
uniform vec4 uSkyParams;      // turbidity, rayleigh, mieCoefficient, mieDirectionalG
uniform vec4 uSkyParams2;     // zenith luminance, sun disc scale, max radiance, horizon blend
uniform vec4 uGroundColor;    // rgb + albedo weight
uniform vec4 uCloudParams;    // coverage, scale, altitude fade, time

in vec3 vDirection;
layout(location = 0) out vec4 fragColor;

const float SKY_E = 2.718281828459045;
const vec3 SKY_UP = vec3(0.0, 1.0, 0.0);
const vec3 TOTAL_RAYLEIGH = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const vec3 MIE_CONST = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
const float CUTOFF_ANGLE = 1.6110731556870734;
const float STEEPNESS = 1.5;
const float SUN_INTENSITY = 1000.0;
const float RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const float MIE_ZENITH_LENGTH = 1.25e3;
const float SUN_ANGULAR_DIAMETER_COS = 0.9999566769464483;
const float SKY_RAD_TO_DEG = 57.29577951308232;

float skySunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return SUN_INTENSITY * max(0.0, 1.0 - pow(SKY_E, -((CUTOFF_ANGLE - acos(zenithAngleCos)) / STEEPNESS)));
}

vec3 skyTotalMie(float turbidity) {
  float c = (0.2 * turbidity) * 1.0e-17;
  return 0.434 * c * MIE_CONST;
}

float skyRayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float skyHGPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 - 2.0 * g * cosTheta + g2, 1e-4);
  return (1.0 / (4.0 * PI)) * ((1.0 - g2) / (denom * sqrt(denom)));
}

/**
 * Scattered radiance along 'direction' for a sun at 'sunDir'.
 * 'withSun' adds the sun disc; it is skipped for the normalisation reference.
 */
vec3 skyRadiance(vec3 direction, vec3 sunDir, bool withSun) {
  float sunE = skySunIntensity(dot(sunDir, SKY_UP));
  float sunfade = 1.0 - clamp(1.0 - exp(sunDir.y), 0.0, 1.0);

  float rayleighCoefficient = max(uSkyParams.y - (1.0 * (1.0 - sunfade)), 0.0);
  vec3 betaR = TOTAL_RAYLEIGH * rayleighCoefficient;
  vec3 betaM = skyTotalMie(uSkyParams.x) * uSkyParams.z;

  float zenithAngle = acos(max(0.0, dot(SKY_UP, direction)));
  float denom = cos(zenithAngle) + 0.15 * pow(max(93.885 - (zenithAngle * SKY_RAD_TO_DEG), 1e-3), -1.253);
  float inverse = 1.0 / max(denom, 1e-4);
  float sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  float sM = MIE_ZENITH_LENGTH * inverse;

  vec3 fex = exp(-(betaR * sR + betaM * sM));

  float cosTheta = dot(direction, sunDir);
  vec3 betaRTheta = betaR * skyRayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaMTheta = betaM * skyHGPhase(cosTheta, uSkyParams.w);
  vec3 betaSum = max(betaR + betaM, vec3(1e-9));

  vec3 lin = pow(max(sunE * ((betaRTheta + betaMTheta) / betaSum) * (1.0 - fex), vec3(0.0)), vec3(1.5));
  lin *= mix(
    vec3(1.0),
    pow(max(sunE * ((betaRTheta + betaMTheta) / betaSum) * fex, vec3(0.0)), vec3(0.5)),
    clamp(pow(1.0 - dot(SKY_UP, sunDir), 5.0), 0.0, 1.0)
  );

  vec3 l0 = vec3(0.1) * fex;
  if (withSun) {
    float sunDisc = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, cosTheta);
    l0 += sunE * 19000.0 * fex * sunDisc * uSkyParams2.y;
  }

  return max((lin + l0) * 0.04 + vec3(0.0, 0.0003, 0.00075), vec3(0.0));
}

void main() {
  vec3 dir = normalize(vDirection);
  vec3 sunDir = normalize(uSunDirection);

  // Below the horizon the model is mirrored onto the horizon ring; the vector is
  // rebuilt with a small positive elevation so it can never degenerate to zero.
  vec3 upperDir = normalize(vec3(dir.x, max(dir.y, 1e-3), dir.z));
  vec3 sky = skyRadiance(upperDir, sunDir, true);

  // Normalisation reference: noon sky sampled at the zenith, without the disc.
  vec3 reference = skyRadiance(SKY_UP, SKY_UP, false);
  float scale = uSkyParams2.x / max(luminance(reference), 1e-4);
  sky *= scale;

  // Ground half space: a diffuse albedo lit by the sky and by the sun.
  vec3 horizonSky = skyRadiance(normalize(vec3(dir.x, 0.02, dir.z)), sunDir, false) * scale;
  float sunUp = max(dot(sunDir, SKY_UP), 0.0);
  vec3 ground = uGroundColor.rgb * (horizonSky * 0.5 + vec3(sunUp * 0.35)) * uGroundColor.w;

  float blendWidth = max(uSkyParams2.w, 1e-3);
  float horizonBlend = smoothstep(-blendWidth, blendWidth, dir.y);
  vec3 color = mix(ground, sky, horizonBlend);

  // Optional fbm cloud layer projected on a plane above the viewer.
  if (uCloudParams.x > 0.0 && dir.y > 0.0) {
    vec2 planar = dir.xz / max(dir.y, 0.08);
    vec3 samplePos = vec3(planar * uCloudParams.y, uCloudParams.w);
    float density = fbm(samplePos, 5); // value noise fbm is already in [0,1]
    float coverage = smoothstep(1.0 - uCloudParams.x, 1.0 - uCloudParams.x * 0.35 + 1e-3, density);
    // Fade the layer out towards the horizon so the projection never stretches.
    coverage *= smoothstep(0.0, uCloudParams.z, dir.y);

    float shade = mix(0.35, 1.0, saturate(dot(sunDir, SKY_UP) * 0.5 + 0.5));
    vec3 cloudColor = vec3(uSkyParams2.x) * shade * (0.6 + 0.6 * saturate(dot(dir, sunDir)));
    color = mix(color, cloudColor, saturate(coverage));
  }

  color = min(color, vec3(uSkyParams2.z));
  fragColor = vec4(color, 1.0);
}
`;

/**
 * Diffuse irradiance by cosine weighted importance sampling of the source cube.
 * The stored value is E / PI, so the shading code only has to multiply it by the
 * diffuse albedo.
 */
export const IBL_IRRADIANCE_FRAGMENT = `#version 300 es
#include <common>

uniform samplerCube uEnvMap;
uniform vec4 uConvolveParams; // sampleCount, source lod, intensity, unused

in vec3 vDirection;
layout(location = 0) out vec4 fragColor;

/** Van der Corput radical inverse in base 2. */
float radicalInverseVdC(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}

/** Hammersley point set, 'invN' is 1/sampleCount. */
vec2 hammersley(uint i, float invN) {
  return vec2(float(i) * invN, radicalInverseVdC(i));
}

/** Cosine weighted hemisphere sample around N. */
vec3 importanceSampleCosine(vec2 xi, vec3 n) {
  float phi = PI2 * xi.x;
  float cosTheta = sqrt(max(1.0 - xi.y, 0.0));
  float sinTheta = sqrt(xi.y);

  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  vec3 tangent;
  vec3 bitangent;
  branchlessONB(n, tangent, bitangent);
  return normalize(tangent * h.x + bitangent * h.y + n * h.z);
}

void main() {
  vec3 N = normalize(vDirection);

  int sampleCount = int(uConvolveParams.x + 0.5);
  float invN = 1.0 / float(max(sampleCount, 1));
  float lod = uConvolveParams.y;

  vec3 irradiance = vec3(0.0);
  for (int i = 0; i < 4096; i++) {
    if (i >= sampleCount) break;
    vec3 L = importanceSampleCosine(hammersley(uint(i), invN), N);
    irradiance += max(textureLod(uEnvMap, L, lod).rgb, vec3(0.0));
  }

  // The cosine pdf is cos(theta)/PI, so the plain mean of the samples already is
  // the integral of L*cos divided by PI.
  irradiance *= invN * uConvolveParams.z;

  fragColor = vec4(irradiance, 1.0);
}
`;

/**
 * GGX prefiltered radiance. One draw per (face, mip): the roughness of the mip
 * comes in through `uPrefilterParams`. Samples are fetched from a mip of the
 * source chosen from the sample solid angle (Karis), which removes most of the
 * high roughness noise.
 */
export const IBL_PREFILTER_FRAGMENT = `#version 300 es
#include <common>
#include <brdf>

uniform samplerCube uEnvMap;
uniform vec4 uPrefilterParams;  // perceptual roughness, sampleCount, source face size, source max lod
uniform vec2 uPrefilterParams2; // base lod (mirror case), intensity

in vec3 vDirection;
layout(location = 0) out vec4 fragColor;

/** Van der Corput radical inverse in base 2. */
float radicalInverseVdC(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}

/** Hammersley point set, 'invN' is 1/sampleCount. */
vec2 hammersley(uint i, float invN) {
  return vec2(float(i) * invN, radicalInverseVdC(i));
}

/** GGX importance sample around N; 'alpha' is the linear roughness. */
vec3 importanceSampleGGX(vec2 xi, vec3 n, float alpha) {
  float phi = PI2 * xi.x;
  float a2 = alpha * alpha;
  float cosTheta = sqrt(max((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y), 0.0));
  float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));

  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  vec3 tangent;
  vec3 bitangent;
  branchlessONB(n, tangent, bitangent);
  return normalize(tangent * h.x + bitangent * h.y + n * h.z);
}

void main() {
  vec3 N = normalize(vDirection);
  float perceptualRoughness = uPrefilterParams.x;
  float intensity = uPrefilterParams2.y;

  // Mirror level: a plain (mip biased) copy, no need to integrate anything.
  if (perceptualRoughness < 0.005) {
    fragColor = vec4(max(textureLod(uEnvMap, N, uPrefilterParams2.x).rgb, vec3(0.0)) * intensity, 1.0);
    return;
  }

  vec3 V = N;
  float alpha = perceptualRoughness * perceptualRoughness;

  int sampleCount = int(uPrefilterParams.y + 0.5);
  float invN = 1.0 / float(max(sampleCount, 1));
  float sourceSize = max(uPrefilterParams.z, 1.0);
  float maxLod = uPrefilterParams.w;
  float saTexel = 4.0 * PI / (6.0 * sourceSize * sourceSize);

  vec3 prefiltered = vec3(0.0);
  float totalWeight = 0.0;

  for (int i = 0; i < 1024; i++) {
    if (i >= sampleCount) break;

    vec3 H = importanceSampleGGX(hammersley(uint(i), invN), N, alpha);
    vec3 L = normalize(2.0 * dot(V, H) * H - V);

    float NoL = dot(N, L);
    if (NoL <= 0.0) continue;

    float NoH = saturate(dot(N, H));
    float VoH = saturate(dot(V, H));

    // Solid angle of this sample versus the solid angle of a source texel.
    float pdf = (D_GGX(NoH, alpha) * NoH / (4.0 * max(VoH, 1e-4))) + 1e-4;
    float saSample = 1.0 / (float(sampleCount) * pdf);
    float mip = clamp(0.5 * log2(saSample / saTexel), 0.0, maxLod);

    prefiltered += max(textureLod(uEnvMap, L, mip).rgb, vec3(0.0)) * NoL;
    totalWeight += NoL;
  }

  fragColor = vec4(prefiltered / max(totalWeight, 1e-4) * intensity, 1.0);
}
`;

/** Vertex stage for the flat LUT pass. */
export const IBL_QUAD_VERTEX = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;

out vec2 vUV0;

void main() {
  vUV0 = aUV0;
  gl_Position = vec4(aPosition.xy, 0.0, 1.0);
}
`;

/**
 * Split sum DFG term. x = the scale applied to F0, y = the bias, exactly what the
 * `ibl` chunk expects from `texture(uBRDFLUT, vec2(NoV, perceptualRoughness)).rg`.
 */
export const IBL_BRDF_FRAGMENT = `#version 300 es
#include <common>

uniform vec2 uBRDFParams; // sampleCount, unused

in vec2 vUV0;
layout(location = 0) out vec4 fragColor;

/** Van der Corput radical inverse in base 2. */
float radicalInverseVdC(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}

/** Hammersley point set, 'invN' is 1/sampleCount. */
vec2 hammersley(uint i, float invN) {
  return vec2(float(i) * invN, radicalInverseVdC(i));
}

/** GGX importance sample around N; 'alpha' is the linear roughness. */
vec3 importanceSampleGGX(vec2 xi, vec3 n, float alpha) {
  float phi = PI2 * xi.x;
  float a2 = alpha * alpha;
  float cosTheta = sqrt(max((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y), 0.0));
  float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));

  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  vec3 tangent;
  vec3 bitangent;
  branchlessONB(n, tangent, bitangent);
  return normalize(tangent * h.x + bitangent * h.y + n * h.z);
}

/** Smith geometry term with the IBL k = alpha / 2 remap (Karis). */
float geometrySmithIBL(float NoV, float NoL, float alpha) {
  float k = alpha * 0.5;
  float gView = NoV / (NoV * (1.0 - k) + k);
  float gLight = NoL / (NoL * (1.0 - k) + k);
  return gView * gLight;
}

void main() {
  float NoV = max(vUV0.x, 1e-3);
  float perceptualRoughness = max(vUV0.y, 1e-3);
  float alpha = perceptualRoughness * perceptualRoughness;

  vec3 V = vec3(sqrt(max(1.0 - NoV * NoV, 0.0)), 0.0, NoV);
  vec3 N = vec3(0.0, 0.0, 1.0);

  int sampleCount = int(uBRDFParams.x + 0.5);
  float invN = 1.0 / float(max(sampleCount, 1));

  float a = 0.0;
  float b = 0.0;

  for (int i = 0; i < 2048; i++) {
    if (i >= sampleCount) break;

    vec3 H = importanceSampleGGX(hammersley(uint(i), invN), N, alpha);
    vec3 L = normalize(2.0 * dot(V, H) * H - V);

    float NoL = saturate(L.z);
    if (NoL <= 0.0) continue;

    float NoH = saturate(H.z);
    float VoH = saturate(dot(V, H));

    float g = geometrySmithIBL(NoV, NoL, alpha);
    float gVis = (g * VoH) / max(NoH * NoV, 1e-6);
    float fc = pow5(1.0 - VoH);

    a += (1.0 - fc) * gVis;
    b += fc * gVis;
  }

  fragColor = vec4(a * invN, b * invN, 0.0, 1.0);
}
`;

/**
 * Every IBL program, keyed by the name it is registered under.
 * @type {Object<string,{vertex:string, fragment:string}>}
 */
export const IBL_SHADERS = {
  ibl_equirect_to_cube: { vertex: IBL_CUBE_VERTEX, fragment: IBL_EQUIRECT_FRAGMENT },
  ibl_sky: { vertex: IBL_CUBE_VERTEX, fragment: IBL_SKY_FRAGMENT },
  ibl_irradiance: { vertex: IBL_CUBE_VERTEX, fragment: IBL_IRRADIANCE_FRAGMENT },
  ibl_prefilter: { vertex: IBL_CUBE_VERTEX, fragment: IBL_PREFILTER_FRAGMENT },
  ibl_brdf: { vertex: IBL_QUAD_VERTEX, fragment: IBL_BRDF_FRAGMENT }
};

/** Ordered list of the registered names. @type {string[]} */
export const IBL_SHADER_NAMES = Object.keys(IBL_SHADERS);

/**
 * Register every IBL program on a ShaderLib.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same instance
 */
export function registerIBLShaders(shaderLib) {
  if (!shaderLib || typeof shaderLib.register !== 'function') {
    throw new Error('registerIBLShaders: uma ShaderLib valida e obrigatoria.');
  }
  for (let i = 0, n = IBL_SHADER_NAMES.length; i < n; i++) {
    const name = IBL_SHADER_NAMES[i];
    if (typeof shaderLib.has === 'function' && shaderLib.has(name)) continue;
    shaderLib.register(name, IBL_SHADERS[name]);
  }
  return shaderLib;
}

/**
 * Alias of {@link registerIBLShaders}, matching the `register(shaderLib)` naming
 * used by the other shader modules.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib}
 */
export function register(shaderLib) {
  return registerIBLShaders(shaderLib);
}
