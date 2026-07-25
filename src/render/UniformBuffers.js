/**
 * UniformBuffers - the four std140 uniform blocks every shader in the engine
 * shares, packed by hand into one Float32Array per block.
 *
 * Design
 *  - One `Float32Array` per block is the single source of truth. Writes go
 *    through comparison helpers that widen a dirty float range, so `bufferSubData`
 *    only ever ships the bytes that actually changed (a camera that did not move
 *    costs zero driver calls).
 *  - Nothing is allocated per frame: every scratch vector lives at module scope.
 *  - The binding points are FIXED engine wide (Camera 0, Lights 1, Shadows 2,
 *    Fog 3) and mirror `chunks/camera_ubo.glsl.js` + `chunks/lights_ubo.glsl.js`
 *    byte for byte. Reordering a member here breaks every shader.
 *
 * ---------------------------------------------------------------------------
 * std140 LAYOUTS (offsets computed by hand, in BYTES, floats in parentheses)
 * ---------------------------------------------------------------------------
 * std140 rules used below: a `mat4` is 4 column vectors of 16 bytes (64 bytes,
 * base alignment 16), a `vec4` is 16 bytes aligned to 16, and an array of `vec4`
 * or `mat4` has no extra padding because the element stride is already 16 bytes
 * aligned. Every member of these blocks is therefore naturally packed with no
 * hidden padding at all - that is exactly why the layout only uses vec4/mat4.
 *
 * block Camera (binding 0) - 384 bytes / 96 floats
 *   mat4 uView            offset   0  (floats  0.. 15)
 *   mat4 uProj            offset  64  (floats 16.. 31)
 *   mat4 uViewProj        offset 128  (floats 32.. 47)
 *   mat4 uInvView         offset 192  (floats 48.. 63)
 *   mat4 uInvProj         offset 256  (floats 64.. 79)
 *   vec4 uCameraPos       offset 320  (floats 80.. 83)   xyz = world pos, w = 1
 *   vec4 uCameraParams    offset 336  (floats 84.. 87)   near, far, 1/(far-near), fovY
 *   vec4 uResolution      offset 352  (floats 88.. 91)   w, h, 1/w, 1/h
 *   vec4 uTimeParams      offset 368  (floats 92.. 95)   elapsed, delta, frame, unused
 *
 * block Lights (binding 1) - 160 bytes / 40 floats
 *   vec4 uAmbient         offset   0  (floats  0..  3)   rgb + intensity
 *   vec4 uDirLightDir[4]  offset  16  (floats  4.. 19)   xyz = TOWARDS light, w = castShadow
 *   vec4 uDirLightColor[4]offset  80  (floats 20.. 35)   rgb * intensity, w = shadowIndex
 *   vec4 uLightCounts     offset 144  (floats 36.. 39)   dirCount, punctualCount, clusterEnabled, unused
 *
 * block Shadows (binding 2) - 304 bytes / 76 floats
 *   mat4 uCascadeMatrix[4]offset   0  (floats  0.. 63)   world -> cascade clip space
 *   vec4 uCascadeSplits   offset 256  (floats 64.. 67)   far view distance per cascade
 *   vec4 uShadowParams    offset 272  (floats 68.. 71)   texelSize, depthBias, normalBias, softness
 *   vec4 uShadowParams2   offset 288  (floats 72.. 75)   cascadeCount, pcfRadius, blendWidth, fadeDistance
 *
 * block Fog (binding 3) - 32 bytes / 8 floats
 *   vec4 uFogColor        offset   0  (floats  0..  3)   rgb linear, w = max opacity
 *   vec4 uFogParams       offset  16  (floats  4..  7)   mode, near|density, far, heightFalloff
 * ---------------------------------------------------------------------------
 */

import { GLBuffer } from './Buffer.js';
import { Vec3 } from '../math/Vec3.js';

/** Fixed std140 binding points, per the architecture contract. */
export const UBO_BINDING_POINTS = {
  Camera: 0,
  Lights: 1,
  Shadows: 2,
  Fog: 3
};

/** Float offsets inside the `Camera` block. */
export const CAMERA_OFFSETS = {
  view: 0,
  proj: 16,
  viewProj: 32,
  invView: 48,
  invProj: 64,
  cameraPos: 80,
  cameraParams: 84,
  resolution: 88,
  timeParams: 92
};
/** Total float count of the `Camera` block (384 bytes). */
export const CAMERA_FLOATS = 96;

/** Float offsets inside the `Lights` block. */
export const LIGHTS_OFFSETS = {
  ambient: 0,
  dirLightDir: 4,
  dirLightColor: 20,
  lightCounts: 36
};
/** Total float count of the `Lights` block (160 bytes). */
export const LIGHTS_FLOATS = 40;
/** Directional light slots physically present in the block (mirrors DIR_LIGHT_SLOTS). */
export const DIR_LIGHT_SLOTS = 4;

/** Float offsets inside the `Shadows` block. */
export const SHADOWS_OFFSETS = {
  cascadeMatrix: 0,
  cascadeSplits: 64,
  shadowParams: 68,
  shadowParams2: 72
};
/** Total float count of the `Shadows` block (304 bytes). */
export const SHADOWS_FLOATS = 76;
/** Cascade slots physically present in the block. */
export const CASCADE_SLOTS = 4;

/** Float offsets inside the `Fog` block. */
export const FOG_OFFSETS = {
  color: 0,
  params: 4
};
/** Total float count of the `Fog` block (32 bytes). */
export const FOG_FLOATS = 8;

/** Fog mode name -> numeric code understood by `chunks/fog.glsl.js`. */
const FOG_MODES = { linear: 0, exp: 1, exponential: 1, exp2: 2 };

/** Module scope scratch, reused by every instance - never allocate per frame. */
const _dir = new Vec3();
const _identity = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
]);

/**
 * Reads a numeric field from a source object, falling back when it is missing.
 * @param {Object|null} source
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function num(source, name, fallback) {
  if (source === null || source === undefined) return fallback;
  const value = source[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * One std140 uniform block: a CPU mirror, its GPU buffer and a dirty float range.
 */
export class UniformBlock {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {string} name Block name as declared in GLSL.
   * @param {number} binding Fixed binding point.
   * @param {number} floatCount Size of the block in floats.
   * @param {Object} [state] StateCache used for the internal binds.
   */
  constructor(gl, name, binding, floatCount, state) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {string} */
    this.name = name;
    /** @type {number} */
    this.binding = binding;
    /** @type {Float32Array} CPU mirror of the block. */
    this.data = new Float32Array(floatCount);
    /** @type {number} Block size in bytes. */
    this.byteLength = floatCount * 4;
    /** @type {Object|null} */
    this.state = state || null;
    /** @type {GLBuffer} */
    this.buffer = new GLBuffer(gl, 'uniform', 'dynamic');
    /** @private First dirty float (inclusive). */
    this._dirtyMin = 0;
    /** @private Last dirty float (exclusive). */
    this._dirtyMax = 0;
    /** @type {number} Bumped on every real upload. */
    this.uploads = 0;

    this.buffer.setData(this.data, this.state);
  }

  /**
   * Marks a float range dirty.
   * @param {number} start Inclusive float index.
   * @param {number} end Exclusive float index.
   */
  markDirty(start, end) {
    if (this._dirtyMax <= this._dirtyMin) {
      this._dirtyMin = start;
      this._dirtyMax = end;
      return;
    }
    if (start < this._dirtyMin) this._dirtyMin = start;
    if (end > this._dirtyMax) this._dirtyMax = end;
  }

  /** Marks the whole block dirty (used after a context restore). */
  markAll() {
    this._dirtyMin = 0;
    this._dirtyMax = this.data.length;
  }

  /**
   * Writes one float, marking it dirty only when the value really changed.
   *
   * The comparison happens AFTER the store, against the previous slot value:
   * `data` is a Float32Array, so writing rounds the double to float32 and
   * comparing the incoming double directly would report a change on every single
   * frame for any value that is not exactly representable (1/800, 0.1, ...).
   *
   * @param {number} index Float index.
   * @param {number} value
   * @returns {boolean} true when the mirror changed
   */
  setFloat(index, value) {
    const data = this.data;
    const previous = data[index];
    data[index] = value;
    if (data[index] === previous) return false;
    this.markDirty(index, index + 1);
    return true;
  }

  /**
   * Writes a vec4.
   * @param {number} offset Float offset of the vector.
   * @param {number} x @param {number} y @param {number} z @param {number} w
   * @returns {boolean} true when the mirror changed
   */
  setVec4(offset, x, y, z, w) {
    const data = this.data;
    const p0 = data[offset];
    const p1 = data[offset + 1];
    const p2 = data[offset + 2];
    const p3 = data[offset + 3];
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = z;
    data[offset + 3] = w;
    if (data[offset] === p0 && data[offset + 1] === p1 &&
        data[offset + 2] === p2 && data[offset + 3] === p3) {
      return false;
    }
    this.markDirty(offset, offset + 4);
    return true;
  }

  /**
   * Writes a column major mat4 from a Mat4 or a raw Float32Array.
   * @param {number} offset Float offset of the matrix.
   * @param {Object|Float32Array} matrix
   * @param {number} [srcOffset=0] Float offset inside `matrix`.
   * @returns {boolean} true when the mirror changed
   */
  setMat4(offset, matrix, srcOffset = 0) {
    const src = matrix.elements !== undefined ? matrix.elements : matrix;
    const data = this.data;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < 16; i++) {
      const slot = offset + i;
      const previous = data[slot];
      data[slot] = src[srcOffset + i];
      if (data[slot] !== previous) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    if (lo < 0) return false;
    this.markDirty(offset + lo, offset + hi + 1);
    return true;
  }

  /**
   * Copies a run of floats.
   * @param {number} offset Destination float offset.
   * @param {ArrayLike<number>} src
   * @param {number} count Floats to copy.
   * @param {number} [srcOffset=0]
   * @returns {boolean} true when the mirror changed
   */
  setFloats(offset, src, count, srcOffset = 0) {
    const data = this.data;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < count; i++) {
      const slot = offset + i;
      const previous = data[slot];
      data[slot] = src[srcOffset + i];
      if (data[slot] !== previous) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    if (lo < 0) return false;
    this.markDirty(offset + lo, offset + hi + 1);
    return true;
  }

  /**
   * Ships the dirty range to the GPU.
   * @param {Object} [state] StateCache.
   * @returns {boolean} true when the driver was touched
   */
  upload(state) {
    const start = this._dirtyMin;
    const end = this._dirtyMax;
    if (end <= start) return false;
    this._dirtyMin = 0;
    this._dirtyMax = 0;
    this.buffer.setSubData(this.data, start * 4, start, end - start, state || this.state);
    this.uploads++;
    return true;
  }

  /**
   * Uploads the dirty range and binds the block to its fixed binding point.
   * @param {Object} state StateCache.
   * @returns {UniformBlock} this
   */
  bind(state) {
    this.upload(state);
    const st = state || this.state;
    if (st) st.bindUBO(this.binding, this.buffer.id);
    return this;
  }

  /** Releases the GPU buffer. */
  dispose(state) {
    this.buffer.dispose(state || this.state);
  }
}

/**
 * Owns the four engine wide uniform blocks and knows how to fill them from the
 * scene objects.
 */
export class UniformBuffers {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object} state StateCache instance.
   */
  constructor(gl, state) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object} */
    this.state = state || null;

    /** @type {UniformBlock} binding 0 */
    this.camera = new UniformBlock(gl, 'Camera', UBO_BINDING_POINTS.Camera, CAMERA_FLOATS, state);
    /** @type {UniformBlock} binding 1 */
    this.lights = new UniformBlock(gl, 'Lights', UBO_BINDING_POINTS.Lights, LIGHTS_FLOATS, state);
    /** @type {UniformBlock} binding 2 */
    this.shadows = new UniformBlock(gl, 'Shadows', UBO_BINDING_POINTS.Shadows, SHADOWS_FLOATS, state);
    /** @type {UniformBlock} binding 3 */
    this.fog = new UniformBlock(gl, 'Fog', UBO_BINDING_POINTS.Fog, FOG_FLOATS, state);

    // A shader compiled with USE_SHADOWS but rendered before the shadow mapper
    // ever ran must still sample something sane: identity cascade matrices and a
    // zero cascade count make every shadow lookup return "fully lit".
    for (let i = 0; i < CASCADE_SLOTS; i++) {
      this.shadows.setMat4(SHADOWS_OFFSETS.cascadeMatrix + i * 16, _identity);
    }
    this.shadows.setVec4(SHADOWS_OFFSETS.shadowParams, 1 / 2048, -0.0005, 0.02, 1);
    this.shadows.setVec4(SHADOWS_OFFSETS.shadowParams2, 0, 1, 0.1, 0);
    this.fog.setVec4(FOG_OFFSETS.color, 1, 1, 1, 1);
    this.fog.setVec4(FOG_OFFSETS.params, 0, 1, 1000, 0);
    this.lights.setVec4(LIGHTS_OFFSETS.lightCounts, 0, 0, 0, 0);

    /** @type {boolean} True while the scene has fog enabled. */
    this.fogEnabled = false;
    /** @type {number} Directional lights written by the last updateLights(). */
    this.dirLightCount = 0;
    /** @type {number} Punctual lights reported by the last updateLights(). */
    this.punctualLightCount = 0;
  }

  /* --------------------------------------------------------------------- *
   * Camera                                                                 *
   * --------------------------------------------------------------------- */

  /**
   * Fills the `Camera` block.
   *
   * `uInvView` is the camera world matrix (the exact inverse of the view matrix)
   * and `uCameraParams.w` is derived from the projection matrix so the value is
   * right for any camera, including hand authored projections.
   *
   * @param {Object} camera Camera with viewMatrix / projectionMatrix / worldMatrix.
   * @param {number} width Framebuffer width in pixels.
   * @param {number} height Framebuffer height in pixels.
   * @param {Object|number|null} [time] Time instance, elapsed seconds, or null.
   * @returns {UniformBuffers} this
   */
  updateCamera(camera, width, height, time) {
    const block = this.camera;
    const o = CAMERA_OFFSETS;

    block.setMat4(o.view, camera.viewMatrix);
    block.setMat4(o.proj, camera.projectionMatrix);
    block.setMat4(o.viewProj, camera.viewProjectionMatrix);
    block.setMat4(o.invView, camera.worldMatrix);
    block.setMat4(o.invProj, camera.projectionMatrixInverse);

    const w = camera.worldMatrix.elements;
    block.setVec4(o.cameraPos, w[12], w[13], w[14], 1);

    const near = camera.near;
    const far = camera.far;
    const range = far - near;
    const p = camera.projectionMatrix.elements;
    // e[11] === -1 marks a perspective projection, where e[5] === 1 / tan(fovY/2).
    const fovY = (p[11] === -1 && p[5] > 0) ? 2 * Math.atan(1 / p[5]) : 0;
    block.setVec4(o.cameraParams, near, far, range !== 0 ? 1 / range : 0, fovY);

    const fw = width > 0 ? width : 1;
    const fh = height > 0 ? height : 1;
    block.setVec4(o.resolution, fw, fh, 1 / fw, 1 / fh);

    let elapsed = 0;
    let delta = 0;
    let frame = 0;
    if (typeof time === 'number') {
      elapsed = time;
    } else if (time !== null && time !== undefined) {
      elapsed = num(time, 'elapsed', 0);
      delta = num(time, 'delta', 0);
      frame = num(time, 'frame', 0);
    }
    block.setVec4(o.timeParams, elapsed, delta, frame, 0);

    return this;
  }

  /* --------------------------------------------------------------------- *
   * Lights                                                                 *
   * --------------------------------------------------------------------- */

  /**
   * Fills the `Lights` block from a LightManager (or any object exposing
   * `dirLights` / `punctualLights` arrays).
   *
   * @param {Object|null} lightManager `{ dirLights, punctualLights }`
   * @param {Object|null} [scene] Scene, read for the ambient term.
   * @param {boolean} [clusterEnabled=false] Whether the clustered path is live.
   * @returns {UniformBuffers} this
   */
  updateLights(lightManager, scene, clusterEnabled = false) {
    const block = this.lights;
    const o = LIGHTS_OFFSETS;

    // --- ambient ---------------------------------------------------------
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let ai = 0;
    const ambientSource = (lightManager && lightManager.ambientLight) ||
      (scene && scene.ambientLight) || null;
    if (ambientSource) {
      ar = num(ambientSource, 'r', 0);
      ag = num(ambientSource, 'g', 0);
      ab = num(ambientSource, 'b', 0);
      ai = lightManager && typeof lightManager.ambientIntensity === 'number'
        ? lightManager.ambientIntensity
        : num(scene, 'ambientIntensity', 0);
    }
    block.setVec4(o.ambient, ar, ag, ab, ai);

    // --- directional lights ---------------------------------------------
    const dirLights = (lightManager && lightManager.dirLights) || null;
    const dirCount = dirLights ? Math.min(dirLights.length, DIR_LIGHT_SLOTS) : 0;

    for (let i = 0; i < DIR_LIGHT_SLOTS; i++) {
      const dirOffset = o.dirLightDir + i * 4;
      const colorOffset = o.dirLightColor + i * 4;
      if (i >= dirCount) {
        block.setVec4(dirOffset, 0, 1, 0, 0);
        block.setVec4(colorOffset, 0, 0, 0, -1);
        continue;
      }

      const light = dirLights[i];
      if (typeof light.getDirectionToLight === 'function') {
        light.getDirectionToLight(_dir);
      } else if (typeof light.getDirection === 'function') {
        light.getDirection(_dir).negate();
      } else {
        _dir.set(0, 1, 0);
      }
      const casts = light.castShadow === true ? 1 : 0;
      block.setVec4(dirOffset, _dir.x, _dir.y, _dir.z, casts);

      const color = light.color;
      const intensity = typeof light.intensity === 'number' ? light.intensity : 1;
      const shadowIndex = typeof light.shadowIndex === 'number' ? light.shadowIndex : -1;
      block.setVec4(
        colorOffset,
        (color ? color.r : 1) * intensity,
        (color ? color.g : 1) * intensity,
        (color ? color.b : 1) * intensity,
        shadowIndex
      );
    }

    const punctual = (lightManager && lightManager.punctualLights) || null;
    const punctualCount = punctual ? punctual.length : 0;
    block.setVec4(o.lightCounts, dirCount, punctualCount, clusterEnabled ? 1 : 0, 0);

    this.dirLightCount = dirCount;
    this.punctualLightCount = punctualCount;
    return this;
  }

  /* --------------------------------------------------------------------- *
   * Shadows                                                                *
   * --------------------------------------------------------------------- */

  /**
   * Fills the `Shadows` block from a ShadowMapper.
   *
   * Every field is probed with a fallback, so a shadow mapper that only exposes
   * `cascadeMatrices` + `splits` (the contract minimum) still produces a valid
   * block; richer implementations can publish `shadowParams` / `shadowParams2`
   * Float32Arrays or the individual scalars listed below.
   *
   * @param {Object|null} shadowMapper
   * @returns {UniformBuffers} this
   */
  updateShadows(shadowMapper) {
    const block = this.shadows;
    const o = SHADOWS_OFFSETS;

    if (shadowMapper === null || shadowMapper === undefined) {
      block.setVec4(o.shadowParams2, 0, 1, 0.1, 0);
      return this;
    }

    const matrices = shadowMapper.cascadeMatrices || null;
    const cascadeCount = Math.min(
      Math.max(1, Math.round(num(shadowMapper, 'cascadeCount', num(shadowMapper, 'cascades', 1)))),
      CASCADE_SLOTS
    );

    for (let i = 0; i < CASCADE_SLOTS; i++) {
      const offset = o.cascadeMatrix + i * 16;
      if (matrices !== null && matrices.length >= (i + 1) * 16) {
        block.setMat4(offset, matrices, i * 16);
      } else {
        block.setMat4(offset, _identity);
      }
    }

    const splits = shadowMapper.splits || null;
    block.setVec4(
      o.cascadeSplits,
      splits && splits.length > 0 ? splits[0] : 0,
      splits && splits.length > 1 ? splits[1] : 0,
      splits && splits.length > 2 ? splits[2] : 0,
      splits && splits.length > 3 ? splits[3] : 0
    );

    const params = shadowMapper.shadowParams || null;
    if (params !== null && params.length >= 4) {
      block.setVec4(o.shadowParams, params[0], params[1], params[2], params[3]);
    } else {
      const mapSize = num(shadowMapper, 'mapSize', 2048);
      block.setVec4(
        o.shadowParams,
        num(shadowMapper, 'texelSize', mapSize > 0 ? 1 / mapSize : 0),
        num(shadowMapper, 'bias', -0.0005),
        num(shadowMapper, 'normalBias', 0.02),
        num(shadowMapper, 'softness', 1)
      );
    }

    const params2 = shadowMapper.shadowParams2 || null;
    if (params2 !== null && params2.length >= 4) {
      block.setVec4(o.shadowParams2, params2[0], params2[1], params2[2], params2[3]);
    } else {
      block.setVec4(
        o.shadowParams2,
        cascadeCount,
        num(shadowMapper, 'pcfRadius', 1),
        num(shadowMapper, 'cascadeBlendWidth', num(shadowMapper, 'blendWidth', 0.1)),
        num(shadowMapper, 'shadowFadeDistance', num(shadowMapper, 'fadeDistance', 0))
      );
    }

    return this;
  }

  /**
   * Zeroes the cascade count so every shader treats the scene as fully lit.
   * @returns {UniformBuffers} this
   */
  disableShadows() {
    const data = this.shadows.data;
    const o = SHADOWS_OFFSETS.shadowParams2;
    this.shadows.setVec4(o, 0, data[o + 1], data[o + 2], data[o + 3]);
    return this;
  }

  /* --------------------------------------------------------------------- *
   * Fog                                                                    *
   * --------------------------------------------------------------------- */

  /**
   * Fills the `Fog` block from `scene.fog`.
   * @param {Object|null} scene
   * @returns {boolean} true when fog is enabled this frame
   */
  updateFog(scene) {
    const fog = scene !== null && scene !== undefined ? scene.fog : null;
    const block = this.fog;
    const o = FOG_OFFSETS;

    if (fog === null || fog === undefined) {
      this.fogEnabled = false;
      // Mode stays valid but the density collapses to zero, so a shader compiled
      // with USE_FOG that renders one frame after the fog was removed is a no-op.
      block.setVec4(o.params, 0, 1e30, 1e30, 0);
      return false;
    }

    const color = fog.color;
    block.setVec4(
      o.color,
      color ? color.r : 1,
      color ? color.g : 1,
      color ? color.b : 1,
      num(fog, 'maxOpacity', 1)
    );

    const mode = FOG_MODES[fog.mode] !== undefined ? FOG_MODES[fog.mode] : 0;
    const nearOrDensity = mode === 0 ? num(fog, 'near', 1) : num(fog, 'density', 0.02);
    block.setVec4(
      o.params,
      mode,
      nearOrDensity,
      num(fog, 'far', 1000),
      num(fog, 'heightFalloff', 0)
    );

    this.fogEnabled = true;
    return true;
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle                                                              *
   * --------------------------------------------------------------------- */

  /**
   * Uploads every dirty range and binds the four blocks to their binding points.
   * @param {Object} [state] StateCache override.
   * @returns {UniformBuffers} this
   */
  bindAll(state) {
    const st = state || this.state;
    this.camera.bind(st);
    this.lights.bind(st);
    this.shadows.bind(st);
    this.fog.bind(st);
    return this;
  }

  /**
   * Uploads every dirty range without binding.
   * @param {Object} [state] StateCache override.
   * @returns {UniformBuffers} this
   */
  uploadAll(state) {
    const st = state || this.state;
    this.camera.upload(st);
    this.lights.upload(st);
    this.shadows.upload(st);
    this.fog.upload(st);
    return this;
  }

  /**
   * Forces a full re-upload of every block. Call it after a context restore.
   * @returns {UniformBuffers} this
   */
  invalidate() {
    this.camera.markAll();
    this.lights.markAll();
    this.shadows.markAll();
    this.fog.markAll();
    return this;
  }

  /** @type {number} Total GPU bytes held by the four blocks. */
  get memoryBytes() {
    return this.camera.byteLength + this.lights.byteLength +
      this.shadows.byteLength + this.fog.byteLength;
  }

  /** Releases every GPU buffer. */
  dispose(state) {
    const st = state || this.state;
    this.camera.dispose(st);
    this.lights.dispose(st);
    this.shadows.dispose(st);
    this.fog.dispose(st);
  }
}
