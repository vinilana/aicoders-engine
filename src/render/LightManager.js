/**
 * Per frame light collection, culling, ranking and shadow slot assignment.
 *
 * `collect()` walks the flat light list kept by the Scene (falling back to a
 * traversal for plain Node3D roots), rejects anything invisible, unlit or
 * outside the camera layers, frustum culls the influence volume of every
 * punctual light, ranks what survives by perceptual importance and finally
 * hands out shadow slots.
 *
 * The result is split exactly the way the renderer consumes it:
 *  - `dirLights`      go into the `Lights` uniform block (4 slots)
 *  - `punctualLights` go into the clustered light data texture, already sorted
 *                     by importance so that a froxel which overflows keeps the
 *                     lights that matter
 *
 * Everything is done in place on reused arrays: the steady state allocates
 * nothing.
 */

import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';
import { Sphere } from '../math/Sphere.js';

/** Module scoped scratch, never allocated per frame. */
const _sphere = new Sphere(undefined, 1);
const _dir = new Vec3();
const _center = new Vec3();

/** Rec. 709 luma weights, used to rank lights by perceived brightness. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Descending importance comparator. `_importance` is written by
 * `LightManager.collect()` right before the sort.
 * @param {import('../scene/Light.js').Light} a
 * @param {import('../scene/Light.js').Light} b
 * @returns {number}
 */
function compareImportance(a, b) {
  return b._importance - a._importance;
}

/**
 * True when the node and every ancestor up to the root are visible.
 * @param {import('../scene/Node3D.js').Node3D} node
 * @returns {boolean}
 */
function isBranchVisible(node) {
  let current = node;
  while (current !== null && current !== undefined) {
    if (current.visible === false) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Collects and ranks the lights that affect a frame.
 */
export class LightManager {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxDirLights=4] Directional slots in the Lights UBO.
   * @param {number} [options.maxPunctualLights=1024] Point + spot lights kept per frame.
   *   `options.maxLights` is accepted as an alias, so passing a Renderer straight
   *   in (`new LightManager(renderer)`) inherits its clustered light budget.
   * @param {number} [options.maxShadowedDirectional=1] Directional shadow slots.
   * @param {number} [options.maxShadowedPunctual=0] Punctual shadow slots.
   * @param {boolean} [options.cullPunctual=true] Frustum cull punctual lights.
   */
  constructor(options = {}) {
    /** @type {number} */
    this.maxDirLights = Math.max(1, options.maxDirLights !== undefined ? options.maxDirLights | 0 : 4);
    const punctualBudget = options.maxPunctualLights !== undefined
      ? options.maxPunctualLights
      : (options.maxLights !== undefined ? options.maxLights : 1024);
    /** @type {number} */
    this.maxPunctualLights = Math.max(0, punctualBudget | 0);
    /** @type {number} */
    this.maxShadowedDirectional = Math.max(0,
      options.maxShadowedDirectional !== undefined ? options.maxShadowedDirectional | 0 : 1);
    /** @type {number} */
    this.maxShadowedPunctual = Math.max(0,
      options.maxShadowedPunctual !== undefined ? options.maxShadowedPunctual | 0 : 0);
    /** @type {boolean} */
    this.cullPunctual = options.cullPunctual !== false;

    /**
     * Directional lights of this frame, strongest first.
     * @type {import('../scene/Light.js').Light[]}
     */
    this.dirLights = [];
    /**
     * Point and spot lights of this frame, most important first.
     * @type {import('../scene/Light.js').Light[]}
     */
    this.punctualLights = [];
    /**
     * Lights that own a shadow slot, directional ones first.
     * @type {import('../scene/Light.js').Light[]}
     */
    this.shadowLights = [];

    /** @type {number} Directional + punctual lights kept this frame. */
    this.visibleCount = 0;

    /**
     * Set by the renderer once ClusteredLighting reports its state. Mirrored
     * into `uLightCounts.z` by UniformBuffers.
     * @type {boolean}
     */
    this.clusterEnabled = false;

    /** @type {Color} Ambient irradiance colour copied from the scene. */
    this.ambientColor = new Color(0, 0, 0);
    /**
     * Same instance as `ambientColor`, under the name UniformBuffers looks for.
     * @type {Color}
     */
    this.ambientLight = this.ambientColor;
    /** @type {number} Ambient intensity copied from the scene. */
    this.ambientIntensity = 0;

    /**
     * Collection statistics of the last `collect()`.
     * @type {{total: number, directional: number, punctual: number,
     *         culled: number, skipped: number, dropped: number, shadowed: number}}
     */
    this.stats = {
      total: 0,
      directional: 0,
      punctual: 0,
      culled: 0,
      skipped: 0,
      dropped: 0,
      shadowed: 0
    };

    /** @private Camera of the collection in progress. */
    this._camera = null;
    /** @private Camera world position of the collection in progress. */
    this._eye = new Vec3();
    /** @private Bound traversal callback, created once. */
    this._visitBound = (node) => this._visit(node);
  }

  /* ------------------------------------------------------------------ */
  /* Collection                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Clears the frame state without touching the configuration.
   * @returns {LightManager} this
   */
  reset() {
    this.dirLights.length = 0;
    this.punctualLights.length = 0;
    this.shadowLights.length = 0;
    this.visibleCount = 0;
    const stats = this.stats;
    stats.total = 0;
    stats.directional = 0;
    stats.punctual = 0;
    stats.culled = 0;
    stats.skipped = 0;
    stats.dropped = 0;
    stats.shadowed = 0;
    return this;
  }

  /**
   * Rebuilds `dirLights` / `punctualLights` for this frame.
   *
   * The camera must already have an up to date world matrix, view matrix and
   * frustum (the renderer does that before calling in).
   *
   * @param {import('../scene/Scene.js').Scene} scene
   * @param {import('../scene/Camera.js').Camera} camera
   * @returns {LightManager} this
   */
  collect(scene, camera) {
    this.reset();
    this._camera = camera;

    if (scene === null || scene === undefined) return this;

    if (scene.ambientLight !== undefined && scene.ambientLight !== null) {
      this.ambientColor.copy(scene.ambientLight);
    } else {
      this.ambientColor.set(0, 0, 0);
    }
    this.ambientIntensity = scene.ambientIntensity !== undefined ? scene.ambientIntensity : 0;

    if (camera !== null && camera !== undefined) {
      const e = camera.worldMatrix.elements;
      this._eye.set(e[12], e[13], e[14]);
    } else {
      this._eye.set(0, 0, 0);
    }

    const list = scene.lights;
    if (Array.isArray(list)) {
      for (let i = 0, n = list.length; i < n; i++) this._visit(list[i]);
    } else if (typeof scene.traverse === 'function') {
      scene.traverse(this._visitBound);
    }

    this.sortByImportance(camera);
    this._assignShadowIndices();

    const stats = this.stats;
    stats.directional = this.dirLights.length;
    stats.punctual = this.punctualLights.length;
    this.visibleCount = stats.directional + stats.punctual;
    this._camera = null;
    return this;
  }

  /**
   * Tests one node and pushes it into the right bucket.
   * @param {import('../scene/Node3D.js').Node3D} node
   * @private
   */
  _visit(node) {
    if (node === null || node === undefined || node.isLight !== true) return;

    const stats = this.stats;
    stats.total++;

    if (isBranchVisible(node) === false) {
      stats.skipped++;
      return;
    }

    const camera = this._camera;
    if (camera !== null && camera !== undefined && (node.layers & camera.layers) === 0) {
      stats.skipped++;
      return;
    }

    const color = node.color;
    const luma = color.r * LUMA_R + color.g * LUMA_G + color.b * LUMA_B;
    const power = luma * node.intensity;
    if (!(power > 0)) {
      stats.skipped++;
      return;
    }

    if (node.type === 'directional') {
      // Every directional is kept for now: `sortByImportance` ranks them and
      // then applies `maxDirLights`, so the brightest ones win the UBO slots.
      node._importance = power;
      this.dirLights.push(node);
      return;
    }

    if (this.maxPunctualLights === 0) {
      stats.dropped++;
      return;
    }

    const m = node.worldMatrix.elements;
    const px = m[12];
    const py = m[13];
    const pz = m[14];

    let radius = typeof node.getInfluenceRadius === 'function' ? node.getInfluenceRadius() : node.range;
    if (!(radius > 0) || !Number.isFinite(radius)) radius = node.range > 0 ? node.range : 1;

    // Bounding volume: the influence sphere for a point light, the tight sphere
    // of the spot cone for a spot light.
    let bx = px;
    let by = py;
    let bz = pz;
    let bRadius = radius;

    if (node.type === 'spot') {
      const cosHalf = node.outerConeCos;
      if (cosHalf > 0.5 && typeof node.getDirection === 'function') {
        // The sphere through the apex and the cap rim is tighter than the range sphere.
        const d = radius / (2 * cosHalf);
        node.getDirection(_dir);
        bx = px + _dir.x * d;
        by = py + _dir.y * d;
        bz = pz + _dir.z * d;
        bRadius = d;
      }
    }

    if (this.cullPunctual === true && camera !== null && camera !== undefined && camera.frustum) {
      _sphere.setValues(bx, by, bz, bRadius);
      if (camera.frustum.intersectsSphere(_sphere) === false) {
        stats.culled++;
        return;
      }
    }

    // Importance: radiant power attenuated by the distance from the camera to
    // the surface of the influence volume, so a light the camera sits inside of
    // always wins.
    const dx = bx - this._eye.x;
    const dy = by - this._eye.y;
    const dz = bz - this._eye.z;
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz) - bRadius;
    if (distance < 0) distance = 0;
    node._importance = power / (1 + distance * distance);

    this.punctualLights.push(node);
  }

  /* ------------------------------------------------------------------ */
  /* Ranking and shadow slots                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Sorts both buckets by descending importance and applies the punctual cap.
   * Called by `collect()`; exposed so a renderer can re-rank after moving the
   * camera without collecting again.
   * @param {import('../scene/Camera.js').Camera} [camera] Re-evaluates the ranking when given.
   * @returns {LightManager} this
   */
  sortByImportance(camera) {
    const standalone = camera !== null && camera !== undefined && this._camera === null;
    if (standalone === true) {
      // Standalone call: refresh the scores against the new camera position.
      const e = camera.worldMatrix.elements;
      this._eye.set(e[12], e[13], e[14]);
      const lights = this.punctualLights;
      for (let i = 0, n = lights.length; i < n; i++) {
        const light = lights[i];
        const color = light.color;
        const power = (color.r * LUMA_R + color.g * LUMA_G + color.b * LUMA_B) * light.intensity;
        light.getWorldPosition(_center);
        let radius = typeof light.getInfluenceRadius === 'function' ? light.getInfluenceRadius() : light.range;
        if (!(radius > 0) || !Number.isFinite(radius)) radius = 1;
        let distance = _center.distanceTo(this._eye) - radius;
        if (distance < 0) distance = 0;
        light._importance = power / (1 + distance * distance);
      }
    }

    if (this.dirLights.length > 1) this.dirLights.sort(compareImportance);
    if (this.punctualLights.length > 1) this.punctualLights.sort(compareImportance);

    if (this.dirLights.length > this.maxDirLights) {
      this.stats.dropped += this.dirLights.length - this.maxDirLights;
      this.dirLights.length = this.maxDirLights;
    }
    if (this.punctualLights.length > this.maxPunctualLights) {
      this.stats.dropped += this.punctualLights.length - this.maxPunctualLights;
      this.punctualLights.length = this.maxPunctualLights;
    }

    // A standalone re-rank can change who deserves a shadow slot; `collect()`
    // assigns them right after this call, so it must not do the work twice.
    if (standalone === true) this._assignShadowIndices();
    return this;
  }

  /**
   * Hands out shadow slots to the most important casters and clears the rest.
   * @private
   */
  _assignShadowIndices() {
    const shadowLights = this.shadowLights;
    shadowLights.length = 0;
    let assigned = 0;

    const dirLights = this.dirLights;
    for (let i = 0, n = dirLights.length; i < n; i++) {
      const light = dirLights[i];
      if (light.castShadow === true && assigned < this.maxShadowedDirectional) {
        light.shadowIndex = assigned++;
        shadowLights.push(light);
      } else {
        light.shadowIndex = -1;
      }
    }

    let punctualAssigned = 0;
    const punctualLights = this.punctualLights;
    for (let i = 0, n = punctualLights.length; i < n; i++) {
      const light = punctualLights[i];
      if (light.castShadow === true && punctualAssigned < this.maxShadowedPunctual) {
        light.shadowIndex = punctualAssigned++;
        shadowLights.push(light);
      } else {
        light.shadowIndex = -1;
      }
    }

    this.stats.shadowed = shadowLights.length;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  /** @returns {number} Directional lights kept this frame. */
  getDirectionalCount() {
    return this.dirLights.length;
  }

  /** @returns {number} Punctual lights kept this frame. */
  getPunctualCount() {
    return this.punctualLights.length;
  }

  /**
   * Directional light that owns the cascaded shadow map, if any.
   * @returns {import('../scene/Light.js').Light|null}
   */
  getPrimaryShadowLight() {
    const lights = this.dirLights;
    for (let i = 0, n = lights.length; i < n; i++) {
      if (lights[i].shadowIndex >= 0) return lights[i];
    }
    return null;
  }

  /**
   * Strongest directional light of the frame, shadow casting or not.
   * @returns {import('../scene/Light.js').Light|null}
   */
  getKeyLight() {
    return this.dirLights.length > 0 ? this.dirLights[0] : null;
  }

  /** @returns {boolean} True when at least one directional shadow was assigned. */
  hasDirectionalShadow() {
    return this.getPrimaryShadowLight() !== null;
  }

  /**
   * Writes the direction TOWARDS a light, which is what the shading equations
   * and the `Lights` uniform block expect.
   * @param {import('../scene/Light.js').Light} light
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getDirectionToLight(light, out) {
    if (typeof light.getDirectionToLight === 'function') return light.getDirectionToLight(out);
    return light.getWorldDirection(out).negate();
  }

  /** Drops every reference held by the manager. */
  dispose() {
    this.reset();
    this._camera = null;
  }
}
