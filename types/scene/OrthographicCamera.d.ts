/**
 * Orthographic camera. The frustum is defined by the left / right / bottom /
 * top planes; `zoom` shrinks the visible extents around their center.
 */
export class OrthographicCamera extends Camera {
    /**
     * @param {number} [left=-1]
     * @param {number} [right=1]
     * @param {number} [top=1]
     * @param {number} [bottom=-1]
     * @param {number} [near=0.1]
     * @param {number} [far=1000]
     */
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    isOrthographicCamera: boolean;
    left: number;
    right: number;
    top: number;
    bottom: number;
    zoom: number;
    /** @private */
    private _lastLeft;
    /** @private */
    private _lastRight;
    /** @private */
    private _lastTop;
    /** @private */
    private _lastBottom;
    /** @private */
    private _lastNear;
    /** @private */
    private _lastFar;
    /** @private */
    private _lastZoom;
    /**
     * Rebuilds the projection matrix and its inverse.
     * @returns {OrthographicCamera} this
     */
    updateProjection(): OrthographicCamera;
    /**
     * Rebuilds the projection matrix only when a parameter changed.
     * @returns {OrthographicCamera} this
     */
    updateProjectionIfNeeded(): OrthographicCamera;
    /**
     * Sets every extent at once.
     * @param {number} left
     * @param {number} right
     * @param {number} top
     * @param {number} bottom
     * @param {number} near
     * @param {number} far
     * @returns {OrthographicCamera} this
     */
    setOrthographic(left: number, right: number, top: number, bottom: number, near: number, far: number): OrthographicCamera;
    /**
     * Centers the frustum around the origin with the given world height and the
     * aspect ratio of the target viewport.
     * @param {number} height World units covered vertically.
     * @param {number} aspect Width / height.
     * @returns {OrthographicCamera} this
     */
    setViewSize(height: number, aspect: number): OrthographicCamera;
}
import { Camera } from "./Camera.js";
