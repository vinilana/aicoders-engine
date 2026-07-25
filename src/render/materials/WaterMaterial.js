/**
 * Water surface.
 *
 * The vertex shader displaces the surface with **the same wave function the
 * physics uses**, ported line for line from `WaterVolume.surfaceHeightAt`. That
 * is the whole point of this material existing rather than a tinted plane: if
 * the crest you see is not the crest that pushes the boat, everything floating
 * looks subtly wrong and no amount of shader polish fixes it. `syncFromVolume`
 * copies the parameters across so the two cannot drift apart.
 *
 * Normals are analytic — the derivative of that same function — so the lighting
 * is exact instead of approximated from a normal map, and the surface stays
 * correct at any wave scale.
 *
 * Shading is deliberately not PBR-through-the-standard-path: water is dominated
 * by Fresnel and a single sharp sun glint, and modelling it directly is both
 * cheaper and more convincing than feeding a roughness of 0.02 into the general
 * purpose shader.
 */

import { ShaderMaterial } from './ShaderMaterial.js';
import { Color } from '../../math/Color.js';

/**
 * Wave field shared by the vertex shader and the physics.
 * Keep in sync with `WaterVolume.surfaceHeightAt` / `WaterVolume` docs.
 */
const WAVE_GLSL = `
// uWaveParams = (amplitude, wavelength, speed, time)
float waterHeight(vec2 p) {
  if (uWaveParams.x <= 0.0) return 0.0;
  float k = 6.28318530718 / max(uWaveParams.y, 1e-4);
  float t = uWaveParams.w * uWaveParams.z;
  return sin(p.x * k + t) * uWaveParams.x * 0.6
       + sin((p.y * 0.83 + p.x * 0.31) * k - t * 0.85) * uWaveParams.x * 0.4;
}

// Analytic normal: the exact gradient of waterHeight, not a finite difference.
vec3 waterNormal(vec2 p) {
  if (uWaveParams.x <= 0.0) return vec3(0.0, 1.0, 0.0);
  float k = 6.28318530718 / max(uWaveParams.y, 1e-4);
  float t = uWaveParams.w * uWaveParams.z;
  float c1 = cos(p.x * k + t) * uWaveParams.x * 0.6 * k;
  float c2 = cos((p.y * 0.83 + p.x * 0.31) * k - t * 0.85) * uWaveParams.x * 0.4 * k;
  float dhdx = c1 + c2 * 0.31;
  float dhdz = c2 * 0.83;
  return normalize(vec3(-dhdx, 1.0, -dhdz));
}
`;

const WATER_VERTEX = `#version 300 es
#include <camera_ubo>

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV0;

uniform mat4 uModelMatrix;
uniform vec4 uWaveParams;

out vec3 vWorldPos;
out vec2 vUV0;
out float vRim;

${WAVE_GLSL}

void main() {
  vec4 world = uModelMatrix * vec4(aPosition, 1.0);

  // Only the top cap rides the waves; the thin rim underneath stays put so the
  // disc does not tear itself open at the shoreline.
  float top = step(0.5, aNormal.y);
  vRim = top;
  world.y += waterHeight(world.xz) * top;

  vWorldPos = world.xyz;
  vUV0 = aUV0;
  gl_Position = uViewProj * world;
}
`;

const WATER_FRAGMENT = `#version 300 es
#include <common>
#include <camera_ubo>
#include <lights_ubo>
#include <fog>

#ifdef USE_TONEMAP
#include <tonemap>
uniform float uExposure;
#endif

// rgb = deep water colour, a = base opacity
uniform vec4 uDeepColor;
// rgb = grazing / sky reflection colour, a = fresnel exponent
uniform vec4 uSkyColor;
// x = specular strength, y = shininess, z = ripple strength, w = ripple scale
uniform vec4 uSurfaceParams;
uniform vec4 uWaveParams;

in vec3 vWorldPos;
in vec2 vUV0;
in float vRim;

layout(location = 0) out vec4 fragColor;

${WAVE_GLSL}

/**
 * High frequency detail on top of the physical wave. Purely visual — it is far
 * below the scale anything floats at, so it does not belong in the physics.
 */
vec3 rippleNormal(vec2 p, float t) {
  float s = uSurfaceParams.w;
  float a = uSurfaceParams.z;
  if (a <= 0.0) return vec3(0.0, 1.0, 0.0);
  float dx = cos(p.x * s + t * 1.7) * a + cos((p.x * 0.7 + p.y * 1.3) * s * 1.9 - t * 2.3) * a * 0.6;
  float dz = cos(p.y * s * 1.1 - t * 1.9) * a + cos((p.x * 1.1 - p.y * 0.6) * s * 1.7 + t * 2.1) * a * 0.6;
  return normalize(vec3(-dx, 1.0, -dz));
}

void main() {
  vec3 viewDir = normalize(uCameraPos.xyz - vWorldPos);

  // The wave normal is evaluated PER FRAGMENT from the world position, not
  // interpolated from the vertices. Interpolating ties the shading to how finely
  // the surface happens to be tessellated: on a coarse mesh the normal barely
  // varies, the specular lobe then covers the whole surface at once, and the
  // water turns into a white sheet. Evaluating the closed form here makes the
  // lighting identical at any tessellation.
  vec3 waveN = waterNormal(vWorldPos.xz);
  vec3 ripple = rippleNormal(vWorldPos.xz, uWaveParams.w);
  vec3 n = normalize(waveN + vec3(ripple.x, 0.0, ripple.z));
  // Seen from underneath the surface faces the other way.
  if (!gl_FrontFacing) n = -n;

  float ndv = saturate(dot(n, viewDir));

  // Schlick Fresnel: water is nearly transparent looking straight down and a
  // mirror at grazing angles. This single term is what sells the material.
  float fresnel = pow(1.0 - ndv, max(uSkyColor.a, 0.1));
  fresnel = mix(0.02, 1.0, fresnel);

  vec3 color = mix(uDeepColor.rgb, uSkyColor.rgb, fresnel);

  // Sun glint. A sharp Blinn-Phong lobe reads as sunlight on water far better
  // than a broad rough specular.
  if (getDirectionalLightCount() > 0) {
    vec3 lightDir = normalize(uDirLightDir[0].xyz);
    // 'half' e palavra reservada em GLSL ES; nomear assim nao compila.
    vec3 halfVec = normalize(lightDir + viewDir);
    float spec = pow(saturate(dot(n, halfVec)), max(uSurfaceParams.y, 1.0));
    color += uDirLightColor[0].rgb * spec * uSurfaceParams.x;

    // A little diffuse wrap so the body of the water still responds to the sun
    // angle at dawn and dusk.
    float wrap = saturate(dot(n, lightDir) * 0.5 + 0.5);
    color += uDeepColor.rgb * uDirLightColor[0].rgb * wrap * 0.25;
  }

  color += getAmbientLight() * uDeepColor.rgb * 0.5;

  // More opaque at grazing angles, clearer straight down.
  float alpha = mix(uDeepColor.a, 1.0, fresnel * 0.85);

#ifdef USE_FOG
  color = applyFog(color, length(vWorldPos - uCameraPos.xyz), vWorldPos);
#endif

#ifdef USE_TONEMAP
  float exposure = uExposure > 0.0 ? uExposure : 1.0;
  color = linearToSRGB(tonemapACESNarkowicz(color * exposure));
#endif

  fragColor = vec4(color, alpha);
}
`;

/**
 * Animated water surface material.
 */
export class WaterMaterial extends ShaderMaterial {
  /**
   * @param {Object} [options]
   * @param {Color} [options.deepColor] Body colour of the water.
   * @param {Color} [options.skyColor] Colour reflected at grazing angles.
   * @param {number} [options.opacity=0.72] Opacity looking straight down.
   * @param {number} [options.fresnelPower=4] Sharpness of the Fresnel falloff.
   * @param {number} [options.specular=1.6] Sun glint strength.
   * @param {number} [options.shininess=220] Sun glint tightness.
   * @param {number} [options.rippleStrength=0.06] Fine ripple amplitude.
   * @param {number} [options.rippleScale=2.4] Fine ripple frequency.
   */
  constructor(options = {}) {
    super({
      shaderName: 'water_surface',
      vertex: WATER_VERTEX,
      fragment: WATER_FRAGMENT,
      uniforms: {
        uWaveParams: new Float32Array([0, 8, 1.1, 0]),
        uDeepColor: new Float32Array([0.02, 0.09, 0.14, 0.72]),
        uSkyColor: new Float32Array([0.36, 0.55, 0.78, 4]),
        uSurfaceParams: new Float32Array([0.9, 420, 0.06, 2.4]),
      },
    });

    this.name = 'water';
    this.transparent = true;
    this.alphaMode = 'blend';
    this.blending = 'normal';
    // Water writes depth so two chunks of surface do not z-fight, and is drawn
    // from both sides so it is visible from underneath.
    this.depthWrite = true;
    this.side = 'double';
    this.renderOrder = 20;
    this.castShadow = false;
    this.receiveShadow = false;

    /** @private */
    this._wave = this.uniforms.uWaveParams;
    /** @private */
    this._deep = this.uniforms.uDeepColor;
    /** @private */
    this._sky = this.uniforms.uSkyColor;
    /** @private */
    this._surface = this.uniforms.uSurfaceParams;

    if (options.deepColor !== undefined) this.setDeepColor(options.deepColor);
    if (options.skyColor !== undefined) this.setSkyColor(options.skyColor);
    if (options.opacity !== undefined) this._deep[3] = options.opacity;
    if (options.fresnelPower !== undefined) this._sky[3] = options.fresnelPower;
    if (options.specular !== undefined) this._surface[0] = options.specular;
    if (options.shininess !== undefined) this._surface[1] = options.shininess;
    if (options.rippleStrength !== undefined) this._surface[2] = options.rippleStrength;
    if (options.rippleScale !== undefined) this._surface[3] = options.rippleScale;
  }

  /**
   * Copies the wave parameters from the physics volume, so the rendered crest
   * is the crest that pushes floating bodies.
   * @param {import('../../physics/WaterVolume.js').WaterVolume} volume
   * @returns {WaterMaterial} this
   */
  syncFromVolume(volume) {
    if (volume === null || volume === undefined) return this;
    this._wave[0] = volume.waveAmplitude;
    this._wave[1] = volume.waveLength;
    this._wave[2] = volume.waveSpeed;
    this._wave[3] = volume.time;
    return this;
  }

  /**
   * Advances the animation clock directly, for surfaces with no physics volume.
   * @param {number} time Seconds.
   * @returns {WaterMaterial} this
   */
  setTime(time) {
    this._wave[3] = time;
    return this;
  }

  /** @param {Color} color */
  setDeepColor(color) {
    this._deep[0] = color.r; this._deep[1] = color.g; this._deep[2] = color.b;
    return this;
  }

  /** @param {Color} color */
  setSkyColor(color) {
    this._sky[0] = color.r; this._sky[1] = color.g; this._sky[2] = color.b;
    return this;
  }

  /** @param {number} value */
  setOpacityBase(value) {
    this._deep[3] = value;
    return this;
  }
}

export { WAVE_GLSL };
