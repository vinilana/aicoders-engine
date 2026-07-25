import { Node3D } from './Node3D.js';
import { Vec3 } from '../math/Vec3.js';

const _camPos = new Vec3();
const _objPos = new Vec3();

/**
 * Level of detail switch.
 *
 * Levels are sorted by ascending switch distance. Each level carries a
 * hysteresis ratio: a level is only entered once the distance goes past
 * `distance * (1 + hysteresis)` and only left once it falls back below
 * `distance * (1 - hysteresis)`, which removes the flickering that a plain
 * threshold produces when the camera hovers around a switch point.
 */
export class LOD extends Node3D {
  isLOD = true;

  /** @type {{node: Node3D, distance: number, hysteresis: number}[]} */
  levels = [];

  /** Beyond this distance every level is hidden. */
  maxDistance = Infinity;

  /** Scales the measured distance, useful to bias quality globally. */
  distanceScale = 1;

  /** When false `update()` stops touching the `visible` flags. */
  autoUpdateVisibility = true;

  /** @private Index of the level currently displayed, -1 when culled. */
  _currentLevel = -1;

  /**
   * @param {string} [name='LOD']
   */
  constructor(name = 'LOD') {
    super(name);
  }

  /**
   * Registers a level. The node becomes a child of this LOD.
   * @param {Node3D} node
   * @param {number} distance Distance at which this level starts being used.
   * @param {number} [hysteresis=0.05] Fraction of `distance` used as dead band.
   * @returns {LOD} this
   */
  addLevel(node, distance, hysteresis = 0.05) {
    const d = distance < 0 ? 0 : distance;
    const levels = this.levels;
    let index = 0;
    for (let n = levels.length; index < n; index++) {
      if (levels[index].distance > d) break;
    }
    levels.splice(index, 0, { node: node, distance: d, hysteresis: hysteresis });
    this.add(node);
    this._currentLevel = 0;
    this._applyVisibility();
    return this;
  }

  /**
   * Shows only the current level.
   * @private
   */
  _applyVisibility() {
    if (this.autoUpdateVisibility !== true) return;
    const levels = this.levels;
    const current = this._currentLevel;
    for (let i = 0, n = levels.length; i < n; i++) levels[i].node.visible = i === current;
  }

  /**
   * Removes a level by node.
   * @param {Node3D} node
   * @returns {LOD} this
   */
  removeLevel(node) {
    const levels = this.levels;
    for (let i = 0, n = levels.length; i < n; i++) {
      if (levels[i].node === node) {
        levels.splice(i, 1);
        this.remove(node);
        if (this._currentLevel >= levels.length) this._currentLevel = levels.length - 1;
        this._applyVisibility();
        break;
      }
    }
    return this;
  }

  /**
   * @returns {number} Index of the visible level, -1 when nothing is shown.
   */
  getCurrentLevel() {
    return this._currentLevel;
  }

  /**
   * @returns {Node3D|null} Node of the visible level.
   */
  getCurrentNode() {
    const level = this.levels[this._currentLevel];
    return level !== undefined ? level.node : null;
  }

  /**
   * @param {number} distance
   * @returns {Node3D|null} Node that would be used at that distance.
   */
  getObjectForDistance(distance) {
    const levels = this.levels;
    if (levels.length === 0) return null;
    let index = 0;
    for (let i = 1, n = levels.length; i < n; i++) {
      if (distance >= levels[i].distance) index = i;
      else break;
    }
    return levels[index].node;
  }

  /**
   * Picks the level matching the camera distance and updates the visibility
   * flags. World matrices must be up to date.
   * @param {import('./Camera.js').Camera} camera
   * @returns {LOD} this
   */
  update(camera) {
    const levels = this.levels;
    const count = levels.length;
    if (count === 0) return this;

    camera.getWorldPosition(_camPos);
    this.getWorldPosition(_objPos);
    const scale = this.distanceScale !== 0 ? this.distanceScale : 1;
    const distance = _camPos.distanceTo(_objPos) / scale;

    let target = -1;
    if (distance <= this.maxDistance) {
      const current = this._currentLevel;
      target = 0;
      for (let i = 1; i < count; i++) {
        const level = levels[i];
        const band = level.distance * level.hysteresis;
        // Entering a coarser level costs a bit more distance than staying in it.
        const threshold = i > current ? level.distance + band : level.distance - band;
        if (distance >= threshold) target = i;
        else break;
      }
    }

    if (target === this._currentLevel) return this;
    this._currentLevel = target;
    this._applyVisibility();
    return this;
  }

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    this.levels.length = 0;
    this._currentLevel = -1;
  }
}
