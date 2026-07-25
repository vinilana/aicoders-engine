/**
 * The voxel surface shader.
 *
 * Deliberately *not* PBR. A voxel world reads best with the lighting model
 * Minecraft established: light is baked per vertex by the flood fill, ambient
 * occlusion is baked per corner by the mesher, and the only runtime shading is a
 * fixed brightness per face axis. That gives flat, readable surfaces, costs
 * almost nothing per fragment, and — crucially — stays correct in caves where a
 * directional sun would light nothing at all.
 *
 * The vertex format is compact: position, an Int8 normal, a UV that runs 0..N
 * across a greedy quad, and one RGBA byte carrying (ao, skyLight, blockLight,
 * atlasLayer). Everything else comes from the engine's shared UBOs.
 */

import { ShaderMaterial } from '../../../src/render/materials/ShaderMaterial.js';

const VOXEL_VERTEX = `#version 300 es
#include <camera_ubo>

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV0;
layout(location = 4) in vec4 aColor;

uniform mat4 uModelMatrix;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV0;
out vec3 vBaked;      // x = ambient occlusion, y = sky light, z = block light
flat out float vLayer;

void main() {
  vec4 world = uModelMatrix * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  // Chunk meshes are axis aligned and never rotated, so the normal needs no
  // normal matrix; it arrives as a unit vector straight from the mesher.
  vNormal = aNormal;
  vUV0 = aUV0;
  vBaked = aColor.rgb;
  // The layer was packed as a normalised byte; recover the integer exactly.
  vLayer = floor(aColor.a * 255.0 + 0.5);
  gl_Position = uViewProj * world;
}
`;

const VOXEL_FRAGMENT = `#version 300 es
#include <common>
#include <camera_ubo>
#include <lights_ubo>
#include <fog>

#ifdef USE_TONEMAP
#include <tonemap>
uniform float uExposure;
#endif

uniform mediump sampler2DArray uAtlas;

// x = daylight 0..1, y = alpha cutoff, z = block light gain, w = minimum ambient
uniform vec4 uVoxelParams;
// rgb = torch colour, a = underwater amount 0..1
uniform vec4 uVoxelTint;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV0;
in vec3 vBaked;
flat in float vLayer;

layout(location = 0) out vec4 fragColor;

/**
 * Fixed shading per face axis. Without this every cube silhouette collapses
 * into a single flat colour and the world becomes unreadable.
 */
float faceShade(vec3 n) {
  if (n.y > 0.5) return 1.0;
  if (n.y < -0.5) return 0.45;
  return abs(n.x) > 0.5 ? 0.72 : 0.86;
}

/**
 * Light falloff curve. A linear ramp from level 15 to 0 looks washed out; this
 * is the classic hyperbolic curve, which keeps mid levels dark enough that a
 * torch actually reads as a pool of light.
 */
float lightCurve(float l) {
  return l / (4.0 - 3.0 * l);
}

void main() {
  vec4 albedo = texture(uAtlas, vec3(vUV0, vLayer));

#ifdef ALPHA_MODE_MASK
  if (albedo.a < uVoxelParams.y) discard;
#endif

  float ao = vBaked.x;
  float sky = lightCurve(vBaked.y);
  float torch = lightCurve(vBaked.z);

  vec3 n = normalize(vNormal);
  float shade = faceShade(n);

  // Sun colour comes from the scene's directional light so the day/night cycle
  // drives the world tint for free.
  vec3 sunColor = getDirectionalLightCount() > 0 ? uDirLightColor[0].rgb : vec3(1.0);
  float daylight = uVoxelParams.x;

  vec3 lit = sunColor * (sky * daylight)
           + uVoxelTint.rgb * (torch * uVoxelParams.z)
           + getAmbientLight() * max(sky, uVoxelParams.w);

  lit *= shade * ao;

  vec3 color = albedo.rgb * lit;

  // Underwater: shift towards deep blue and crush the range a little.
  if (uVoxelTint.a > 0.0) {
    vec3 deep = vec3(0.10, 0.26, 0.42);
    color = mix(color, color * deep * 3.0, uVoxelTint.a * 0.75);
  }

#ifdef USE_FOG
  color = applyFog(color, length(vWorldPos - uCameraPos.xyz), vWorldPos);
#endif

#ifdef USE_TONEMAP
  // Drawing straight to the default framebuffer: no post chain will encode for
  // us, so exposure, tone curve and sRGB have to happen here.
  float exposure = uExposure > 0.0 ? uExposure : 1.0;
  color = linearToSRGB(tonemapACESNarkowicz(color * exposure));
#endif

  fragColor = vec4(color, albedo.a);
}
`;

/**
 * Material for chunk geometry.
 */
export class VoxelMaterial extends ShaderMaterial {
  /**
   * @param {Object} [options]
   * @param {import('../../../src/render/Texture.js').Texture} [options.atlas]
   * @param {boolean} [options.water=false] Configures the transparent variant.
   */
  constructor(options = {}) {
    const water = options.water === true;

    super({
      // One shared program for both variants; the defines differ, not the source.
      shaderName: water ? 'voxel_water' : 'voxel_opaque',
      vertex: VOXEL_VERTEX,
      fragment: VOXEL_FRAGMENT,
      uniforms: {
        uAtlas: options.atlas || null,
        uVoxelParams: new Float32Array([1, 0.5, 1.15, 0.06]),
        uVoxelTint: new Float32Array([1.0, 0.72, 0.42, 0.0]),
      },
    });

    this.name = water ? 'voxel-water' : 'voxel-opaque';

    if (water) {
      this.transparent = true;
      this.alphaMode = 'blend';
      this.blending = 'normal';
      // Water keeps writing depth: without it the surface z-fights with itself
      // where two chunks meet. Double sided so the surface is visible from below.
      this.depthWrite = true;
      this.side = 'double';
      this.renderOrder = 10;
    } else {
      // Leaves and glass are alpha tested, so the opaque pass needs the cutout
      // define. Everything else has alpha 1 and is unaffected.
      this.alphaMode = 'mask';
      this.alphaTest = 0.5;
      this.side = 'front';
    }

    this.castShadow = false;
    this.receiveShadow = false;

    /** @private */
    this._params = this.uniforms.uVoxelParams;
    /** @private */
    this._tint = this.uniforms.uVoxelTint;
  }

  /**
   * @param {import('../../../src/render/Texture.js').Texture} texture
   */
  setAtlas(texture) {
    this.uniforms.uAtlas = texture;
    return this;
  }

  /**
   * @param {number} value 0 = night, 1 = noon.
   */
  setDaylight(value) {
    this._params[0] = value;
    return this;
  }

  /**
   * @param {number} value Ambient floor so caves are never pure black.
   */
  setMinAmbient(value) {
    this._params[3] = value;
    return this;
  }

  /**
   * @param {number} gain Multiplier on block (torch) light.
   */
  setBlockLightGain(gain) {
    this._params[2] = gain;
    return this;
  }

  /**
   * @param {number} amount 0..1 underwater blend.
   */
  setUnderwater(amount) {
    this._tint[3] = amount;
    return this;
  }

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  setTorchColor(r, g, b) {
    this._tint[0] = r;
    this._tint[1] = g;
    this._tint[2] = b;
    return this;
  }
}
