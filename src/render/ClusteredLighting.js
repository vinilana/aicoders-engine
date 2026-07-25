/**
 * Clustered (forward+) punctual lighting.
 *
 * The view frustum is divided into CLUSTER_X x CLUSTER_Y x CLUSTER_Z froxels:
 * the screen is tiled uniformly on X/Y and sliced exponentially on Z, using the
 * standard distribution
 *
 *   slice = floor(log(viewDepth) * scale + bias)
 *   scale = CLUSTER_Z / log(far / near)
 *   bias  = -CLUSTER_Z * log(near) / log(far / near)
 *
 * which is exactly what `chunks/cluster.glsl.js` derives from `uCameraParams`,
 * so the CPU assignment and the GPU lookup always agree. The same numbers are
 * also published as the `uClusterParams` uniform for shaders that prefer to read
 * them directly.
 *
 * Light assignment never walks the whole grid. For each light the influence
 * sphere is projected analytically to a screen space AABB (tangent cone of the
 * sphere, clipped against the near plane), which gives the exact tile range on
 * X and Y, and the view depth interval gives the slice range on Z. Only that
 * sub volume is visited, and every froxel in it gets a real sphere-vs-AABB test
 * (plus a cone-vs-sphere test for spot lights).
 *
 * GPU outputs, matching the layout documented in the cluster chunk:
 *  - `gridTexture`      usampler3D R32UI, value = (offset << 12) | count
 *  - `indexTexture`     usampler2D R32UI, packed light index list, row major
 *  - `lightDataTexture` sampler2D RGBA32F, 4 consecutive texels per light:
 *      texel 0: position.xyz (world), range
 *      texel 1: color.rgb * intensity, intensity
 *      texel 2: direction.xyz (world, spot axis pointing away from the light), innerConeCos
 *      texel 3: type, shadowIndex, decay, outerConeCos
 *
 * Every buffer is allocated once and reused: the steady state does not allocate.
 */

import { getStateCache } from './StateCache.js';
import { createTexture2D, createTexture3D } from './Texture.js';

/** Bits reserved for the light count inside a froxel cell. */
const COUNT_BITS = 12;
/** Mask of the light count field (0..4095). */
const COUNT_MASK = 0xfff;
/** Largest index list offset representable in the remaining 20 bits. */
const MAX_INDEX_OFFSET = 0xfffff;
/** Largest index list size addressable with a 20 bit offset. */
const MAX_INDEX_CAPACITY = MAX_INDEX_OFFSET + 1;
/** Light indices are stored as Uint16 in the per froxel buckets. */
const MAX_ADDRESSABLE_LIGHTS = 65535;

/** Light type tags, mirroring LIGHT_TYPE_POINT / LIGHT_TYPE_SPOT in lighting.glsl. */
const TYPE_POINT = 0;
const TYPE_SPOT = 1;

/**
 * Fixed texture units used by the clustered path. Mirrors the table in
 * Material.js and the sampler declarations of the GLSL chunks.
 * @type {{lightIndices: number, clusterGrid: number, lightData: number}}
 */
export const CLUSTER_TEXTURE_UNITS = {
  lightIndices: 7,
  clusterGrid: 9,
  lightData: 10
};

/** RGBA32F texels occupied by one light in `uLightData`. */
export const TEXELS_PER_LIGHT = 4;
/** Floats occupied by one light in `uLightData`. */
export const FLOATS_PER_LIGHT = TEXELS_PER_LIGHT * 4;

/** Scratch used by the screen space sphere projection (min, max in NDC). */
const _axis = new Float64Array(2);

/**
 * Rounds `value` up to the next multiple of `step`.
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
function roundUpTo(value, step) {
  return Math.ceil(value / step) * step;
}

/**
 * Rounds `value` down to a multiple of `step`, never below `step`.
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
function roundDownTo(value, step) {
  const v = Math.floor(value / step) * step;
  return v < step ? step : v;
}

/**
 * Analytic screen space bounds of a sphere along one axis.
 *
 * Works in the 2D plane spanned by the axis and the (positive) view depth, with
 * the eye at the origin looking down +depth. The extremes of the projection are
 * the two tangent points of the sphere silhouette; when the sphere crosses the
 * near plane those tangents may fall behind it, so the cross section of the
 * sphere at the near plane is unioned in as well. A sphere that contains the eye
 * in this plane is reported as covering the whole axis.
 *
 * @param {number} c Sphere centre along the axis, in view space.
 * @param {number} z Sphere centre depth (positive, in front of the camera).
 * @param {number} r Sphere radius.
 * @param {number} scale Projection scale for the axis (elements[0] or elements[5]).
 * @param {number} offset NDC offset for off-centre projections.
 * @param {number} near Near plane distance (positive).
 * @param {Float64Array} out Receives [minNdc, maxNdc], clamped to [-1, 1].
 * @returns {boolean} False when the sphere projects outside the axis entirely.
 */
function projectSphereAxis(c, z, r, scale, offset, near, out) {
  const len2 = c * c + z * z;
  const r2 = r * r;

  if (len2 <= r2) {
    // The eye lies inside the projected disc: no tangent exists, assume full coverage.
    out[0] = -1;
    out[1] = 1;
    return true;
  }

  let minV = Infinity;
  let maxV = -Infinity;

  const t = Math.sqrt(len2 - r2);
  const k = t / len2;
  // The two tangent points, |P| = t and P . c = t^2.
  const ax = k * (t * c + r * z);
  const az = k * (t * z - r * c);
  const bx = k * (t * c - r * z);
  const bz = k * (t * z + r * c);

  if (az >= near) {
    const p = scale * (ax / az) + offset;
    if (p < minV) minV = p;
    if (p > maxV) maxV = p;
  }
  if (bz >= near) {
    const p = scale * (bx / bz) + offset;
    if (p < minV) minV = p;
    if (p > maxV) maxV = p;
  }

  if (z - r < near) {
    // The sphere straddles the near plane: add the disc it cuts there.
    const dz = z - near;
    const rn2 = r2 - dz * dz;
    if (rn2 > 0) {
      const rn = Math.sqrt(rn2);
      const p0 = scale * ((c - rn) / near) + offset;
      const p1 = scale * ((c + rn) / near) + offset;
      if (p0 < minV) minV = p0;
      if (p0 > maxV) maxV = p0;
      if (p1 < minV) minV = p1;
      if (p1 > maxV) maxV = p1;
    } else {
      // Numerically degenerate straddle: stay conservative.
      minV = -1;
      maxV = 1;
    }
  }

  if (minV > maxV) return false;
  if (maxV < -1 || minV > 1) return false;
  out[0] = minV < -1 ? -1 : minV;
  out[1] = maxV > 1 ? 1 : maxV;
  return true;
}

/**
 * Clustered light assignment and its GPU resources.
 */
export class ClusteredLighting {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object} [options]
   * @param {number} [options.clusterX=16] Tiles on X.
   * @param {number} [options.clusterY=9] Tiles on Y.
   * @param {number} [options.clusterZ=24] Exponential depth slices.
   * @param {number} [options.maxLights=1024] Punctual lights uploaded per frame.
   * @param {number} [options.maxLightsPerCluster=64] Importance cut per froxel.
   * @param {number} [options.lightDataWidth=256] Width of uLightData, in texels.
   * @param {number} [options.indexTextureWidth=1024] Width of uLightIndices, in texels.
   * @param {number} [options.initialIndexCapacity=16384] Initial index list size.
   * @param {number} [options.maxIndexCapacity] Hard cap of the index list.
   * @param {import('./StateCache.js').StateCache} [options.state]
   */
  constructor(gl, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @private @type {import('./StateCache.js').StateCache|null} */
    this._state = options.state || getStateCache(gl) || null;

    /** @type {number} */
    this.clusterX = Math.max(1, options.clusterX !== undefined ? options.clusterX | 0 : 16);
    /** @type {number} */
    this.clusterY = Math.max(1, options.clusterY !== undefined ? options.clusterY | 0 : 9);
    /** @type {number} */
    this.clusterZ = Math.max(1, options.clusterZ !== undefined ? options.clusterZ | 0 : 24);
    /** @type {number} Total froxel count. */
    this.clusterCount = this.clusterX * this.clusterY * this.clusterZ;

    /** @type {number} */
    this.maxLights = Math.min(MAX_ADDRESSABLE_LIGHTS,
      Math.max(1, options.maxLights !== undefined ? options.maxLights | 0 : 1024));
    /** @type {number} */
    this.maxLightsPerCluster = Math.min(COUNT_MASK,
      Math.max(1, options.maxLightsPerCluster !== undefined ? options.maxLightsPerCluster | 0 : 64));

    /** @private */
    this._lightDataWidth = Math.max(4, options.lightDataWidth !== undefined ? options.lightDataWidth | 0 : 256);
    /** @private */
    this._indexWidth = Math.max(16, options.indexTextureWidth !== undefined ? options.indexTextureWidth | 0 : 1024);

    const maxIndices = options.maxIndexCapacity !== undefined
      ? options.maxIndexCapacity | 0
      : this.clusterCount * this.maxLightsPerCluster;
    /** @type {number} Upper bound of the packed index list. */
    this.maxIndexCapacity = roundDownTo(
      Math.min(MAX_INDEX_CAPACITY, Math.max(this._indexWidth, maxIndices)), this._indexWidth);

    const initialIndices = options.initialIndexCapacity !== undefined
      ? options.initialIndexCapacity | 0
      : 16384;
    const indexCapacity = Math.min(this.maxIndexCapacity,
      roundUpTo(Math.max(this._indexWidth, initialIndices), this._indexWidth));

    /* ---------------- CPU side buffers (allocated once) ---------------- */

    /** @private Packed froxel cells, x fastest then y then z. */
    this._gridData = new Uint32Array(this.clusterCount);
    /** @private Per froxel light count of the frame being built. */
    this._counts = new Uint16Array(this.clusterCount);
    /** @private Per froxel bucket of light indices, before compaction. */
    this._buckets = new Uint16Array(this.clusterCount * this.maxLightsPerCluster);
    /** @private Compacted light index list. */
    this._indexData = new Uint32Array(indexCapacity);

    const lightTexels = roundUpTo(this.maxLights * TEXELS_PER_LIGHT, this._lightDataWidth);
    /** @private RGBA32F light records. */
    this._lightData = new Float32Array(lightTexels * 4);
    /** @private Height of the light data texture, in texels. */
    this._lightDataHeight = lightTexels / this._lightDataWidth;

    /** @private View space light centres, xyz per light (z is positive depth). */
    this._viewPos = new Float32Array(this.maxLights * 3);
    /** @private View space spot axis, xyz per light (z mirrored to match _viewPos). */
    this._viewDir = new Float32Array(this.maxLights * 3);
    /** @private Effective influence radius per light. */
    this._radius = new Float32Array(this.maxLights);
    /** @private Cosine / sine of the outer cone half angle, 2 floats per light. */
    this._cone = new Float32Array(this.maxLights * 2);
    /** @private 1 for spot lights, 0 for point lights. */
    this._isSpot = new Uint8Array(this.maxLights);

    /** @private Depth of every slice boundary, clusterZ + 1 entries. */
    this._sliceDepths = new Float64Array(this.clusterZ + 1);
    /** @private View space x / depth ratio of every tile boundary. */
    this._tanX = new Float64Array(this.clusterX + 1);
    /** @private View space y / depth ratio of every tile boundary. */
    this._tanY = new Float64Array(this.clusterY + 1);

    /** @private Cached projection parameters used to rebuild the tile ratios. */
    this._cachedScaleX = NaN;
    this._cachedScaleY = NaN;
    this._cachedOffsetX = NaN;
    this._cachedOffsetY = NaN;
    /** @private Cached depth range used to rebuild the slice depths. */
    this._cachedNear = NaN;
    this._cachedFar = NaN;

    /* ---------------- GPU resources ---------------- */

    /** @type {import('./Texture.js').Texture} usampler3D R32UI froxel grid. */
    this.gridTexture = createTexture3D(gl, {
      width: this.clusterX,
      height: this.clusterY,
      depth: this.clusterZ,
      internalFormat: 'r32ui',
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
      wrapR: 'clamp',
      generateMipmaps: false,
      state: this._state
    });
    this.gridTexture.name = 'ClusterGrid';

    /** @type {import('./Texture.js').Texture} sampler2D RGBA32F light records. */
    this.lightDataTexture = createTexture2D(gl, {
      width: this._lightDataWidth,
      height: this._lightDataHeight,
      internalFormat: 'rgba32f',
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
      generateMipmaps: false,
      state: this._state
    });
    this.lightDataTexture.name = 'ClusterLightData';

    /** @type {import('./Texture.js').Texture} usampler2D R32UI packed index list. */
    this.indexTexture = createTexture2D(gl, {
      width: this._indexWidth,
      height: indexCapacity / this._indexWidth,
      internalFormat: 'r32ui',
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapS: 'clamp',
      wrapT: 'clamp',
      generateMipmaps: false,
      state: this._state
    });
    this.indexTexture.name = 'ClusterLightIndices';

    /* ---------------- Frame state ---------------- */

    /** @type {boolean} True when the grid built this frame is usable. */
    this.active = false;
    /** @type {number} Punctual lights uploaded this frame. */
    this.lightCount = 0;
    /** @type {number} Render target width recorded by the last `update()`. */
    this.screenWidth = 0;
    /** @type {number} Render target height recorded by the last `update()`. */
    this.screenHeight = 0;
    /** @private Index entries written by the last `update()`. */
    this._indexCount = 0;
    /** @type {number} Exponential slice scale published as uClusterParams.x. */
    this.sliceScale = 1;
    /** @type {number} Exponential slice bias published as uClusterParams.y. */
    this.sliceBias = 0;

    /** @private uClusterParams: sliceScale, sliceBias, near, far. */
    this._clusterParams = new Float32Array(4);
    /** @private uClusterSize: clusterX, clusterY, clusterZ, maxLightsPerCluster. */
    this._clusterSize = new Float32Array([
      this.clusterX, this.clusterY, this.clusterZ, this.maxLightsPerCluster
    ]);

    /** @private Frame-local wall clock, resolved without touching module scope. */
    this._now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

    /** @private Warned once about an exhausted index list. */
    this._warnedOverflow = false;

    /**
     * Assignment statistics of the last `update()`.
     * @type {{lights: number, assignments: number, activeClusters: number,
     *         maxClusterLights: number, droppedAssignments: number,
     *         droppedClusters: number, indexCapacity: number, cpuTimeMs: number}}
     */
    this.stats = {
      lights: 0,
      assignments: 0,
      activeClusters: 0,
      maxClusterLights: 0,
      droppedAssignments: 0,
      droppedClusters: 0,
      indexCapacity,
      cpuTimeMs: 0
    };

    this._updateClusterParams(0.1, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Shader defines this instance requires. Feed them into the material /
   * ShaderLib permutation key so the GLSL constants match the CPU grid.
   * @param {Object} [out] Optional object to write into.
   * @returns {Object}
   */
  getDefines(out) {
    const target = out || {};
    target.CLUSTER_X = this.clusterX;
    target.CLUSTER_Y = this.clusterY;
    target.CLUSTER_Z = this.clusterZ;
    target.MAX_LIGHTS_PER_CLUSTER = this.maxLightsPerCluster;
    return target;
  }

  /**
   * Changes the per froxel importance cut. Reallocates the bucket storage, so
   * call it outside of the render loop.
   * @param {number} value
   * @returns {ClusteredLighting} this
   */
  setMaxLightsPerCluster(value) {
    const clamped = Math.min(COUNT_MASK, Math.max(1, value | 0));
    if (clamped === this.maxLightsPerCluster) return this;
    this.maxLightsPerCluster = clamped;
    this._buckets = new Uint16Array(this.clusterCount * clamped);
    this._clusterSize[3] = clamped;
    return this;
  }

  /**
   * Recomputes the exponential Z distribution when the depth range changes.
   * @param {number} near
   * @param {number} far
   * @private
   */
  _updateClusterParams(near, far) {
    const n = near > 1e-4 ? near : 1e-4;
    const f = far > n + 1e-4 ? far : n + 1e-4;
    this.sliceScale = this.clusterZ / Math.log(f / n);
    this.sliceBias = -(this.clusterZ * Math.log(n) / Math.log(f / n));
    this._clusterParams[0] = this.sliceScale;
    this._clusterParams[1] = this.sliceBias;
    this._clusterParams[2] = n;
    this._clusterParams[3] = f;

    if (this._cachedNear === n && this._cachedFar === f) return;
    this._cachedNear = n;
    this._cachedFar = f;

    const depths = this._sliceDepths;
    const ratio = f / n;
    const invZ = 1 / this.clusterZ;
    for (let i = 0, count = this.clusterZ; i <= count; i++) {
      depths[i] = n * Math.pow(ratio, i * invZ);
    }
    // Guarantee exact end points so the last slice always reaches the far plane.
    depths[0] = n;
    depths[this.clusterZ] = f;
  }

  /**
   * Recomputes the view space slope of every tile boundary.
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {number} offsetX
   * @param {number} offsetY
   * @private
   */
  _updateTileSlopes(scaleX, scaleY, offsetX, offsetY) {
    if (this._cachedScaleX === scaleX && this._cachedScaleY === scaleY &&
      this._cachedOffsetX === offsetX && this._cachedOffsetY === offsetY) {
      return;
    }
    this._cachedScaleX = scaleX;
    this._cachedScaleY = scaleY;
    this._cachedOffsetX = offsetX;
    this._cachedOffsetY = offsetY;

    const tanX = this._tanX;
    const invX = 2 / this.clusterX;
    const rcpScaleX = 1 / scaleX;
    for (let i = 0, n = this.clusterX; i <= n; i++) {
      tanX[i] = (i * invX - 1 - offsetX) * rcpScaleX;
    }

    const tanY = this._tanY;
    const invY = 2 / this.clusterY;
    const rcpScaleY = 1 / scaleY;
    for (let i = 0, n = this.clusterY; i <= n; i++) {
      tanY[i] = (i * invY - 1 - offsetY) * rcpScaleY;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per frame update                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuilds the froxel assignment for this frame and uploads the used range of
   * every texture.
   *
   * `lights` must already be culled and sorted by importance (see LightManager):
   * the assignment walks it in order, so a froxel that overflows keeps the most
   * important lights and drops the rest.
   *
   * @param {import('../scene/Camera.js').Camera} camera Perspective camera.
   * @param {import('../scene/Light.js').Light[]} lights Point and spot lights.
   * @param {number} width Render target width in pixels (statistics only).
   * @param {number} height Render target height in pixels (statistics only).
   * @returns {boolean} True when the clustered path can be used this frame.
   */
  update(camera, lights, width, height) {
    const t0 = this._now();
    const stats = this.stats;
    stats.assignments = 0;
    stats.activeClusters = 0;
    stats.maxClusterLights = 0;
    stats.droppedAssignments = 0;
    stats.droppedClusters = 0;

    this.screenWidth = width | 0;
    this.screenHeight = height | 0;

    if (typeof camera.updateProjectionIfNeeded === 'function') camera.updateProjectionIfNeeded();

    const proj = camera.projectionMatrix.elements;
    const scaleX = proj[0];
    const scaleY = proj[5];
    const isPerspective = proj[11] !== 0 && scaleX !== 0 && scaleY !== 0;

    const near = camera.near > 1e-4 ? camera.near : 1e-4;
    const far = camera.far > near ? camera.far : near + 1;
    this._updateClusterParams(near, far);

    const count = this._packLights(camera, lights);
    this.lightCount = count;
    stats.lights = count;

    if (!isPerspective) {
      // The exponential Z distribution is only defined for a perspective
      // projection. Clear the grid and let the shader fall back to the flat loop.
      this._gridData.fill(0);
      this._indexCount = 0;
      this._uploadGrid();
      this._uploadLightData(count);
      this.active = false;
      stats.cpuTimeMs = this._now() - t0;
      return false;
    }

    this._updateTileSlopes(scaleX, scaleY, -proj[8], -proj[9]);

    this._counts.fill(0);
    let assignments = 0;
    for (let i = 0; i < count; i++) {
      assignments += this._assignLight(i, scaleX, scaleY, -proj[8], -proj[9], near, far);
    }
    stats.assignments = assignments;

    this._compact(assignments);

    this._uploadGrid();
    this._uploadLightData(count);
    this._uploadIndices();

    this.active = true;
    stats.cpuTimeMs = this._now() - t0;
    return true;
  }

  /**
   * Fills `_lightData` plus the view space scratch arrays.
   * @param {import('../scene/Camera.js').Camera} camera
   * @param {import('../scene/Light.js').Light[]} lights
   * @returns {number} Number of lights actually packed.
   * @private
   */
  _packLights(camera, lights) {
    const total = lights ? lights.length : 0;
    const count = total > this.maxLights ? this.maxLights : total;
    if (count === 0) return 0;

    const data = this._lightData;
    const viewPos = this._viewPos;
    const viewDir = this._viewDir;
    const radii = this._radius;
    const cone = this._cone;
    const isSpot = this._isSpot;
    const v = camera.viewMatrix.elements;

    for (let i = 0; i < count; i++) {
      const light = lights[i];
      const m = light.worldMatrix.elements;
      const px = m[12];
      const py = m[13];
      const pz = m[14];

      // Spot axis in world space: the direction the light travels, which is what
      // `getSpotAttenuation` in lighting.glsl expects.
      let dx = 0;
      let dy = 0;
      let dz = -1;
      const spot = light.type === 'spot';
      if (spot === true) {
        if (light.useTarget === true) {
          dx = light.target.x - px;
          dy = light.target.y - py;
          dz = light.target.z - pz;
        } else {
          // Local -Z of the node, in world space.
          dx = -m[8];
          dy = -m[9];
          dz = -m[10];
        }
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 1e-8) {
          const inv = 1 / len;
          dx *= inv;
          dy *= inv;
          dz *= inv;
        } else {
          dx = 0;
          dy = 0;
          dz = -1;
        }
      }

      // Effective radius: a light with range <= 0 gets the perceptual cutoff
      // radius, and that value is what we upload, so the shader window and the
      // cluster assignment always agree.
      let radius = typeof light.getInfluenceRadius === 'function'
        ? light.getInfluenceRadius()
        : light.range;
      if (!(radius > 0) || !Number.isFinite(radius)) {
        radius = light.range > 0 ? light.range : 1;
      }

      const intensity = light.intensity;
      const color = light.color;
      const outerCos = spot === true ? light.outerConeCos : -1;
      let innerCos = spot === true ? light.innerConeCos : 1;
      if (spot === true && innerCos - outerCos < 1e-4) innerCos = outerCos + 1e-4;

      const base = i * FLOATS_PER_LIGHT;
      data[base] = px;
      data[base + 1] = py;
      data[base + 2] = pz;
      data[base + 3] = radius;

      data[base + 4] = color.r * intensity;
      data[base + 5] = color.g * intensity;
      data[base + 6] = color.b * intensity;
      data[base + 7] = intensity;

      data[base + 8] = dx;
      data[base + 9] = dy;
      data[base + 10] = dz;
      data[base + 11] = innerCos;

      data[base + 12] = spot === true ? TYPE_SPOT : TYPE_POINT;
      data[base + 13] = light.shadowIndex === undefined ? -1 : light.shadowIndex;
      data[base + 14] = light.decay === undefined ? 2 : light.decay;
      data[base + 15] = outerCos;

      // View space centre, with depth mirrored to +Z (the froxel frame).
      const vx = v[0] * px + v[4] * py + v[8] * pz + v[12];
      const vy = v[1] * px + v[5] * py + v[9] * pz + v[13];
      const vz = v[2] * px + v[6] * py + v[10] * pz + v[14];
      const o3 = i * 3;
      viewPos[o3] = vx;
      viewPos[o3 + 1] = vy;
      viewPos[o3 + 2] = -vz;

      if (spot === true) {
        // Direction is a vector: rotation only, then the same depth mirror.
        const tx = v[0] * dx + v[4] * dy + v[8] * dz;
        const ty = v[1] * dx + v[5] * dy + v[9] * dz;
        const tz = v[2] * dx + v[6] * dy + v[10] * dz;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const inv = len > 1e-8 ? 1 / len : 0;
        viewDir[o3] = tx * inv;
        viewDir[o3 + 1] = ty * inv;
        viewDir[o3 + 2] = -tz * inv;
        const c = outerCos < -1 ? -1 : (outerCos > 1 ? 1 : outerCos);
        cone[i * 2] = c;
        cone[i * 2 + 1] = Math.sqrt(Math.max(0, 1 - c * c));
        isSpot[i] = 1;
      } else {
        viewDir[o3] = 0;
        viewDir[o3 + 1] = 0;
        viewDir[o3 + 2] = 1;
        cone[i * 2] = -1;
        cone[i * 2 + 1] = 0;
        isSpot[i] = 0;
      }

      radii[i] = radius;
    }

    return count;
  }

  /**
   * Assigns one light to every froxel it can reach.
   * @param {number} index Light index.
   * @param {number} scaleX Projection scale on X.
   * @param {number} scaleY Projection scale on Y.
   * @param {number} offsetX NDC offset on X.
   * @param {number} offsetY NDC offset on Y.
   * @param {number} near
   * @param {number} far
   * @returns {number} Number of froxels the light was written into.
   * @private
   */
  _assignLight(index, scaleX, scaleY, offsetX, offsetY, near, far) {
    const o3 = index * 3;
    const cx = this._viewPos[o3];
    const cy = this._viewPos[o3 + 1];
    const cd = this._viewPos[o3 + 2];
    const r = this._radius[index];

    // Depth interval, and the slice range derived from it.
    const dMin = cd - r;
    const dMax = cd + r;
    if (dMax <= near || dMin >= far) return 0;

    const scale = this.sliceScale;
    const bias = this.sliceBias;
    const zLast = this.clusterZ - 1;

    let sliceMin = Math.floor(Math.log(dMin > near ? dMin : near) * scale + bias);
    let sliceMax = Math.floor(Math.log(dMax > near ? dMax : near) * scale + bias);
    if (sliceMin < 0) sliceMin = 0;
    if (sliceMax > zLast) sliceMax = zLast;
    if (sliceMin > zLast || sliceMax < 0 || sliceMin > sliceMax) return 0;

    // Screen space tile range from the analytic sphere projection.
    if (!projectSphereAxis(cx, cd, r, scaleX, offsetX, near, _axis)) return 0;
    const ndcMinX = _axis[0];
    const ndcMaxX = _axis[1];
    if (!projectSphereAxis(cy, cd, r, scaleY, offsetY, near, _axis)) return 0;
    const ndcMinY = _axis[0];
    const ndcMaxY = _axis[1];

    const xLast = this.clusterX - 1;
    const yLast = this.clusterY - 1;

    let tileMinX = Math.floor((ndcMinX * 0.5 + 0.5) * this.clusterX);
    let tileMaxX = Math.floor((ndcMaxX * 0.5 + 0.5) * this.clusterX);
    if (tileMinX < 0) tileMinX = 0;
    if (tileMaxX > xLast) tileMaxX = xLast;
    if (tileMinX > tileMaxX) return 0;

    let tileMinY = Math.floor((ndcMinY * 0.5 + 0.5) * this.clusterY);
    let tileMaxY = Math.floor((ndcMaxY * 0.5 + 0.5) * this.clusterY);
    if (tileMinY < 0) tileMinY = 0;
    if (tileMaxY > yLast) tileMaxY = yLast;
    if (tileMinY > tileMaxY) return 0;

    const spot = this._isSpot[index] === 1;
    const coneCos = this._cone[index * 2];
    const coneSin = this._cone[index * 2 + 1];
    const dirX = this._viewDir[o3];
    const dirY = this._viewDir[o3 + 1];
    const dirZ = this._viewDir[o3 + 2];

    const depths = this._sliceDepths;
    const tanX = this._tanX;
    const tanY = this._tanY;
    const counts = this._counts;
    const buckets = this._buckets;
    const perCluster = this.maxLightsPerCluster;
    const strideY = this.clusterX;
    const strideZ = this.clusterX * this.clusterY;
    const r2 = r * r;

    let written = 0;
    let dropped = 0;

    for (let z = sliceMin; z <= sliceMax; z++) {
      const z0 = depths[z];
      const z1 = depths[z + 1];

      // Slab test on depth first: it rejects whole tile rectangles cheaply.
      let dz = 0;
      if (cd < z0) dz = z0 - cd;
      else if (cd > z1) dz = cd - z1;
      const dz2 = dz * dz;
      if (dz2 > r2) continue;

      const zBase = z * strideZ;
      const zCenter = (z0 + z1) * 0.5;
      const zHalf = (z1 - z0) * 0.5;

      for (let y = tileMinY; y <= tileMaxY; y++) {
        const ay = tanY[y];
        const by = tanY[y + 1];
        const yMin = ay < 0 ? ay * z1 : ay * z0;
        const yMax = by > 0 ? by * z1 : by * z0;

        let dy = 0;
        if (cy < yMin) dy = yMin - cy;
        else if (cy > yMax) dy = cy - yMax;
        const dzy2 = dz2 + dy * dy;
        if (dzy2 > r2) continue;

        const yBase = zBase + y * strideY;
        const yCenter = (yMin + yMax) * 0.5;
        const yHalf = (yMax - yMin) * 0.5;

        for (let x = tileMinX; x <= tileMaxX; x++) {
          const ax = tanX[x];
          const bx = tanX[x + 1];
          const xMin = ax < 0 ? ax * z1 : ax * z0;
          const xMax = bx > 0 ? bx * z1 : bx * z0;

          let dx = 0;
          if (cx < xMin) dx = xMin - cx;
          else if (cx > xMax) dx = cx - xMax;
          if (dzy2 + dx * dx > r2) continue;

          if (spot === true) {
            // Cone versus the bounding sphere of the froxel AABB. Working in the
            // (axial, radial) half plane of the cone: the mantle is the line
            // through the apex with direction (cos, sin), whose outward normal
            // is (-sin, cos), so the signed distance of the sphere centre to the
            // mantle is radial * cos - axial * sin.
            const sxc = (xMin + xMax) * 0.5;
            const xHalf = (xMax - xMin) * 0.5;
            const sr = Math.sqrt(xHalf * xHalf + yHalf * yHalf + zHalf * zHalf);
            const vx = sxc - cx;
            const vy = yCenter - cy;
            const vz = zCenter - cd;
            const axial = vx * dirX + vy * dirY + vz * dirZ;
            // Beyond the spherical cap that closes the cone.
            if (axial > sr + r) continue;
            // Entirely behind the apex (only conclusive for half angles <= 90 degrees).
            if (coneCos >= 0 && axial < -sr) continue;
            const lenSq = vx * vx + vy * vy + vz * vz;
            const radialSq = lenSq - axial * axial;
            const radial = radialSq > 0 ? Math.sqrt(radialSq) : 0;
            if (radial * coneCos - axial * coneSin > sr) continue;
          }

          const cell = yBase + x;
          const n = counts[cell];
          if (n >= perCluster) {
            dropped++;
            continue;
          }
          buckets[cell * perCluster + n] = index;
          counts[cell] = n + 1;
          written++;
        }
      }
    }

    if (dropped !== 0) this.stats.droppedAssignments += dropped;
    return written;
  }

  /**
   * Packs the per froxel buckets into the linear index list and builds the grid.
   * @param {number} assignments Total number of bucket entries.
   * @private
   */
  _compact(assignments) {
    if (assignments > this._indexData.length) this._ensureIndexCapacity(assignments);

    const counts = this._counts;
    const buckets = this._buckets;
    const indices = this._indexData;
    const grid = this._gridData;
    const perCluster = this.maxLightsPerCluster;
    const capacity = indices.length;
    const stats = this.stats;

    let offset = 0;
    let activeClusters = 0;
    let maxClusterLights = 0;
    let droppedClusters = 0;

    for (let cell = 0, n = this.clusterCount; cell < n; cell++) {
      const count = counts[cell];
      if (count === 0) {
        grid[cell] = 0;
        continue;
      }
      if (offset + count > capacity || offset > MAX_INDEX_OFFSET) {
        grid[cell] = 0;
        droppedClusters++;
        continue;
      }

      const src = cell * perCluster;
      for (let i = 0; i < count; i++) indices[offset + i] = buckets[src + i];

      grid[cell] = ((offset << COUNT_BITS) | (count & COUNT_MASK)) >>> 0;
      offset += count;
      activeClusters++;
      if (count > maxClusterLights) maxClusterLights = count;
    }

    stats.activeClusters = activeClusters;
    stats.maxClusterLights = maxClusterLights;
    stats.droppedClusters = droppedClusters;
    stats.indexCapacity = capacity;
    this._indexCount = offset;

    if (droppedClusters !== 0 && this._warnedOverflow === false) {
      this._warnedOverflow = true;
      console.warn('ClusteredLighting: lista de indices esgotada (' + capacity +
        ' entradas). Aumente maxIndexCapacity ou reduza maxLightsPerCluster.');
    }
  }

  /**
   * Grows the index list and its texture to hold at least `needed` entries.
   * @param {number} needed
   * @returns {boolean} True when the capacity is now sufficient.
   * @private
   */
  _ensureIndexCapacity(needed) {
    const current = this._indexData.length;
    if (needed <= current) return true;
    if (current >= this.maxIndexCapacity) return false;

    let capacity = current;
    while (capacity < needed && capacity < this.maxIndexCapacity) capacity *= 2;
    capacity = Math.min(this.maxIndexCapacity, roundUpTo(capacity, this._indexWidth));
    if (capacity === current) return false;

    this._indexData = new Uint32Array(capacity);
    this.indexTexture.resize(this._indexWidth, capacity / this._indexWidth);
    this.stats.indexCapacity = capacity;
    return capacity >= needed;
  }

  /**
   * Uploads the whole froxel grid (a few kilobytes).
   * @private
   */
  _uploadGrid() {
    this.gridTexture.upload(this._gridData, 0, -1);
  }

  /**
   * Uploads only the rows of `uLightData` that hold live lights.
   * @param {number} count
   * @private
   */
  _uploadLightData(count) {
    if (count <= 0) return;
    const width = this._lightDataWidth;
    let rows = Math.ceil((count * TEXELS_PER_LIGHT) / width);
    if (rows > this._lightDataHeight) rows = this._lightDataHeight;
    this.lightDataTexture.updateSubImage(0, 0, width, rows, this._lightData);
  }

  /**
   * Uploads only the rows of `uLightIndices` that hold live entries.
   * @private
   */
  _uploadIndices() {
    const used = this._indexCount;
    if (used <= 0) return;
    const width = this._indexWidth;
    const height = this.indexTexture.height;
    let rows = Math.ceil(used / width);
    if (rows > height) rows = height;
    this.indexTexture.updateSubImage(0, 0, width, rows, this._indexData);
  }

  /* ------------------------------------------------------------------ */
  /* Binding                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Binds the three textures to their fixed units and points the samplers of
   * `program` at them. The grid and index textures are bound even when the
   * clustered path is inactive: leaving an integer sampler on a unit that holds
   * a float texture is an INVALID_OPERATION at draw time.
   *
   * @param {import('./StateCache.js').StateCache} state
   * @param {import('./Program.js').Program} program
   * @returns {boolean} False when there is nothing to bind.
   */
  bind(state, program) {
    if (!program) return false;
    const st = state || this._state;

    program.setTexture('uLightData', this.lightDataTexture, CLUSTER_TEXTURE_UNITS.lightData, st);
    program.setTexture('uClusterGrid', this.gridTexture, CLUSTER_TEXTURE_UNITS.clusterGrid, st);
    program.setTexture('uLightIndices', this.indexTexture, CLUSTER_TEXTURE_UNITS.lightIndices, st);

    program.setUniform('uClusterParams', this._clusterParams);
    program.setUniform('uClusterSize', this._clusterSize);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Queries and teardown                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Froxel index of a screen pixel and a positive view depth. Mirrors
   * `getClusterCoord` in the GLSL chunk (fragment coordinates, origin bottom
   * left).
   * @param {number} fragX
   * @param {number} fragY
   * @param {number} viewDepth Positive distance along the view direction.
   * @returns {number} Linear cluster index, or -1 when the screen size is unknown.
   */
  getClusterIndex(fragX, fragY, viewDepth) {
    const w = this.screenWidth;
    const h = this.screenHeight;
    if (!(w > 0) || !(h > 0)) return -1;

    let x = Math.floor((fragX / w) * this.clusterX);
    let y = Math.floor((fragY / h) * this.clusterY);
    const near = this._cachedNear;
    let z = Math.floor(Math.log(viewDepth > near ? viewDepth : near) * this.sliceScale + this.sliceBias);

    if (x < 0) x = 0; else if (x > this.clusterX - 1) x = this.clusterX - 1;
    if (y < 0) y = 0; else if (y > this.clusterY - 1) y = this.clusterY - 1;
    if (z < 0) z = 0; else if (z > this.clusterZ - 1) z = this.clusterZ - 1;

    return x + y * this.clusterX + z * this.clusterX * this.clusterY;
  }

  /**
   * Number of lights assigned to a froxel by the last `update()`.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  getClusterLightCount(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.clusterX || y >= this.clusterY || z >= this.clusterZ) return 0;
    return this._gridData[x + y * this.clusterX + z * this.clusterX * this.clusterY] & COUNT_MASK;
  }

  /**
   * Light index stored at slot `slot` of a froxel.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} slot
   * @returns {number} Light index, or -1 when the slot is empty.
   */
  getClusterLight(x, y, z, slot) {
    if (x < 0 || y < 0 || z < 0 || x >= this.clusterX || y >= this.clusterY || z >= this.clusterZ) return -1;
    const cell = this._gridData[x + y * this.clusterX + z * this.clusterX * this.clusterY];
    const count = cell & COUNT_MASK;
    if (slot < 0 || slot >= count) return -1;
    return this._indexData[(cell >>> COUNT_BITS) + slot];
  }

  /** @type {number} Index entries written by the last `update()`. */
  get indexCount() {
    return this._indexCount;
  }

  /** @type {number} Approximate GPU footprint of the clustered resources. */
  get memoryBytes() {
    return this.gridTexture.memoryBytes + this.lightDataTexture.memoryBytes + this.indexTexture.memoryBytes;
  }

  /** Releases every GPU resource. The instance must not be used afterwards. */
  dispose() {
    const st = this._state;
    this.gridTexture.dispose(st);
    this.lightDataTexture.dispose(st);
    this.indexTexture.dispose(st);
    this.active = false;
    this.lightCount = 0;
  }
}
