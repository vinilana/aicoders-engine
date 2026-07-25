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
    /** @type {{node: Node3D, distance: number, hysteresis: number}[]} */
    levels: {
        node: Node3D;
        distance: number;
        hysteresis: number;
    }[];
    /** Beyond this distance every level is hidden. */
    maxDistance: number;
    /** Scales the measured distance, useful to bias quality globally. */
    distanceScale: number;
    /** When false `update()` stops touching the `visible` flags. */
    autoUpdateVisibility: boolean;
    /** @private Index of the level currently displayed, -1 when culled. */
    private _currentLevel;
    /**
     * Registers a level. The node becomes a child of this LOD.
     * @param {Node3D} node
     * @param {number} distance Distance at which this level starts being used.
     * @param {number} [hysteresis=0.05] Fraction of `distance` used as dead band.
     * @returns {LOD} this
     */
    addLevel(node: Node3D, distance: number, hysteresis?: number): LOD;
    /**
     * Shows only the current level.
     * @private
     */
    private _applyVisibility;
    /**
     * Removes a level by node.
     * @param {Node3D} node
     * @returns {LOD} this
     */
    removeLevel(node: Node3D): LOD;
    /**
     * @returns {number} Index of the visible level, -1 when nothing is shown.
     */
    getCurrentLevel(): number;
    /**
     * @returns {Node3D|null} Node of the visible level.
     */
    getCurrentNode(): Node3D | null;
    /**
     * @param {number} distance
     * @returns {Node3D|null} Node that would be used at that distance.
     */
    getObjectForDistance(distance: number): Node3D | null;
    /**
     * Picks the level matching the camera distance and updates the visibility
     * flags. World matrices must be up to date.
     * @param {import('./Camera.js').Camera} camera
     * @returns {LOD} this
     */
    update(camera: import('./Camera.js').Camera): LOD;
}
import { Node3D } from "./Node3D.js";
