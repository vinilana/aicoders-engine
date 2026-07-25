/**
 * The 'sky' program: a procedural atmosphere.
 *
 * Single scattering through an exponential atmosphere, with Rayleigh and Mie terms
 * evaluated separately:
 *
 *   1. the relative air mass along the view ray and along the sun ray are obtained
 *      from a Kasten-Young style approximation of the optical path;
 *   2. sunlight is attenuated on the way in by the sun ray extinction, which is
 *      what reddens the light near sunrise and sunset;
 *   3. that light is redistributed towards the eye by the Rayleigh (wavelength
 *      dependent, 1 + cos^2) and Henyey-Greenstein (forward peaked) phase
 *      functions, weighted by how much of it the view ray actually intercepts;
 *   4. a small fraction of unattenuated light is mixed back in as a stand in for
 *      multiple scattering, so twilight and the anti solar sky do not collapse to
 *      black the way pure single scattering always does.
 *
 * On top of that come the solar disc, a virtual ground plane below the horizon and
 * an optional fbm cloud layer projected onto a flat sky dome.
 *
 * The geometry is a unit cube (createSkyboxCube) rendered with the camera
 * translation stripped and `gl_Position.z = gl_Position.w`, which pins every
 * fragment to the far plane. It therefore needs depthFunc LEQUAL and depthWrite
 * off, both of which SkyMaterial sets.
 *
 * Output is linear HDR, like every other lit shader.
 */

/** Vertex stage. */
export const vertex = `#version 300 es

#include <common>
#include <camera_ubo>

layout(location = 0) in vec3 aPosition;

out vec3 vDirection;

void main() {
  // The cube position doubles as the world space view direction.
  vDirection = aPosition;

  // Drop the translation: the sky is infinitely far away, only orientation matters.
  mat4 rotationOnlyView = mat4(mat3(uView));
  vec4 clipPosition = uProj * (rotationOnlyView * vec4(aPosition, 1.0));

  // z = w puts the fragment exactly on the far plane after the perspective divide.
  gl_Position = clipPosition.xyww;
}
`;

/** Fragment stage. */
export const fragment = `#version 300 es
precision highp float;
precision highp int;

#include <common>
#include <camera_ubo>

#ifdef USE_CLOUDS
#include <noise>
#endif
#ifdef USE_TONEMAP
#include <tonemap>
#endif

in vec3 vDirection;

uniform vec3 uSunDirection;  // unit vector pointing towards the sun
uniform vec3 uSunColor;      // linear tint of the solar disc
uniform vec4 uSunParams;     // x = irradiance scale, y = disc brightness,
                             // z = cos(angular radius), w = edge softness (cosine units)
uniform vec4 uSkyParams;     // x = rayleigh, y = mie, z = mie anisotropy g, w = turbidity
uniform vec4 uSkyParams2;    // x = exposure, y = multiple scattering, z = ground fade, w = unused
uniform vec3 uGroundColor;   // linear albedo of the virtual ground

#ifdef USE_CLOUDS
uniform vec4 uCloudParams;   // x = scale, y = speed, z = coverage, w = opacity
uniform vec3 uCloudColor;
#endif

#ifdef USE_TONEMAP
uniform float uExposure;
#endif

layout(location = 0) out vec4 outColor;

const vec3 UP_AXIS = vec3(0.0, 1.0, 0.0);

// Rayleigh scattering coefficients at sea level for the sRGB primaries, in m^-1.
const vec3 BETA_RAYLEIGH = vec3(5.804543e-6, 1.3562911e-5, 3.0265902e-5);
// Mie base coefficients before turbidity and the artist multiplier are applied.
const vec3 BETA_MIE_BASE = vec3(7.98550e-4, 1.206390e-3, 1.770310e-3);

// Equivalent thickness of a homogeneous atmosphere with the same optical depth.
const float RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const float MIE_ZENITH_LENGTH = 1.25e3;

// Scene referred solar irradiance and the constant that maps the model output into
// a comfortable HDR range (roughly 1.0 for a clear daytime horizon).
const float SUN_IRRADIANCE = 1000.0;
const float SKY_SCALE = 0.025;

/** Rayleigh phase function, normalized over the sphere. */
float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

/** Henyey-Greenstein phase function, the standard cheap stand in for Mie. */
float henyeyGreensteinPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return ((1.0 - g2) / (4.0 * PI)) * inversesqrt(denom) / denom;
}

/**
 * Relative air mass for a ray leaving the ground at a given zenith cosine.
 * 1 straight up, about 38 at the horizon, following Kasten and Young.
 */
float relativeAirMass(float cosZenith) {
  float c = clamp(cosZenith, 0.0, 1.0);
  float zenithDegrees = degrees(acos(c));
  return 1.0 / (c + 0.15 * pow(max(93.885 - zenithDegrees, 1e-3), -1.253));
}

/** Solar irradiance, faded out over the few degrees around the horizon. */
float sunIrradiance(float cosSunZenith) {
  return SUN_IRRADIANCE * smoothstep(-0.12, 0.02, cosSunZenith);
}

void main() {
  vec3 direction = safeNormalize(vDirection);
  vec3 sunDirection = safeNormalize(uSunDirection);

  float cosViewZenith = dot(direction, UP_AXIS);
  float cosSunZenith = dot(sunDirection, UP_AXIS);
  float cosTheta = dot(direction, sunDirection);

  // ------------------------------------------------------------- scattering set
  float turbidity = max(uSkyParams.w, 1.0);
  vec3 betaRayleigh = BETA_RAYLEIGH * max(uSkyParams.x, 0.0);
  vec3 betaMie = BETA_MIE_BASE * (0.2 * turbidity) * max(uSkyParams.y, 0.0);
  vec3 betaTotal = max(betaRayleigh + betaMie, vec3(1e-12));

  vec3 zenithOpticalDepth = betaRayleigh * RAYLEIGH_ZENITH_LENGTH + betaMie * MIE_ZENITH_LENGTH;

  // Extinction along the view ray, and along the ray the sunlight travelled.
  vec3 viewExtinction = exp(-zenithOpticalDepth * relativeAirMass(cosViewZenith));
  vec3 sunExtinction = exp(-zenithOpticalDepth * relativeAirMass(cosSunZenith));

  float sunE = sunIrradiance(cosSunZenith) * max(uSunParams.x, 0.0);

  // Cheap multiple scattering: without it the sky turns black the moment the sun
  // ray extinction becomes strong, which is exactly when twilight should glow.
  float multiScatter = saturate(uSkyParams2.y);
  vec3 incidentLight = mix(sunExtinction, vec3(1.0), multiScatter) * sunE;

  // ------------------------------------------------------------------ in-scatter
  vec3 scatterRayleigh = betaRayleigh * rayleighPhase(cosTheta);
  vec3 scatterMie = betaMie * henyeyGreensteinPhase(cosTheta, clamp(uSkyParams.z, -0.95, 0.95));
  vec3 scatterRatio = (scatterRayleigh + scatterMie) / betaTotal;

  // (1 - extinction) is how much of the beam the view ray managed to intercept.
  vec3 color = incidentLight * scatterRatio * (1.0 - viewExtinction);

  // ----------------------------------------------------------------- solar disc
  float discSoftness = max(uSunParams.w, 1e-6);
  float disc = smoothstep(uSunParams.z - discSoftness, uSunParams.z + discSoftness, cosTheta);
  color += uSunColor * (sunE * max(uSunParams.y, 0.0)) * viewExtinction * disc;

  color *= SKY_SCALE;

  // ---------------------------------------------------------------------- ground
  float groundFade = max(uSkyParams2.z, 1e-4);
  float groundBlend = saturate(-cosViewZenith / groundFade);
  groundBlend = groundBlend * groundBlend * (3.0 - 2.0 * groundBlend);
  if (groundBlend > 0.0) {
    // Lit by the horizon sky plus a direct term that follows the sun elevation.
    vec3 ground = uGroundColor * (color * 0.6 + vec3(sunE * SKY_SCALE * 0.02 * saturate(cosSunZenith)));
    color = mix(color, ground, groundBlend);
  }

  // ---------------------------------------------------------------------- clouds
#ifdef USE_CLOUDS
  float cloudMask = smoothstep(0.015, 0.22, cosViewZenith);
  if (cloudMask > 0.0) {
    // Project the view ray onto a flat layer: cheap, and the perspective stretch
    // near the horizon is exactly what a real cloud deck looks like.
    vec2 plane = direction.xz / max(cosViewZenith, 0.015);
    vec2 cloudUV = plane * max(uCloudParams.x, 1e-3) + uTimeParams.x * uCloudParams.y * vec2(1.0, 0.35);

    float coverage = saturate(uCloudParams.z);
    float shape = fbm2(cloudUV, 5);
    float density = saturate((shape - (1.0 - coverage)) / max(coverage * 0.6, 1e-3)) * cloudMask;

    if (density > 0.0) {
      float cloudLuminance = sunE * SKY_SCALE * 0.08;
      float sunGlow = pow(saturate(cosTheta) * 0.5 + 0.5, 6.0);
      vec3 litSide = uCloudColor * (0.45 + 0.55 * sunGlow) * cloudLuminance;
      vec3 shadedSide = uCloudColor * 0.30 * cloudLuminance;
      vec3 cloud = mix(shadedSide, litSide, saturate(density * 1.6));
      color = mix(color, cloud, saturate(density * uCloudParams.w));
    }
  }
#endif

  color *= max(uSkyParams2.x, 0.0);

#ifdef USE_TONEMAP
  float exposure = uExposure > 0.0 ? uExposure : 1.0;
  color = linearToSRGB(tonemapACESNarkowicz(color * exposure));
#endif

  outColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

/** Name this program is registered under in the ShaderLib. */
export const name = 'sky';

/**
 * Register the sky program on a shader library.
 * @param {import('../ShaderLib.js').ShaderLib} shaderLib
 * @returns {import('../ShaderLib.js').ShaderLib} the same library
 */
export function register(shaderLib) {
  shaderLib.register(name, { vertex, fragment });
  return shaderLib;
}
