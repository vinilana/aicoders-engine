/**
 * Standard perspective camera.
 *
 * `fov` is the vertical field of view in degrees, `zoom` scales it the same way
 * a real lens would. Projection parameters are plain fields: they are compared
 * against a cached copy once per frame so the matrix is only rebuilt when one of
 * them actually changed.
 */
export class PerspectiveCamera extends Camera {
    /**
     * @param {number} [fov=50] Vertical field of view in degrees.
     * @param {number} [aspect=1] Width / height.
     * @param {number} [near=0.1]
     * @param {number} [far=1000]
     */
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    isPerspectiveCamera: boolean;
    fov: number;
    aspect: number;
    zoom: number;
    /** Film gauge in millimeters, used by the focal length helpers. */
    filmGauge: number;
    /** @private */
    private _lastFov;
    /** @private */
    private _lastAspect;
    /** @private */
    private _lastNear;
    /** @private */
    private _lastFar;
    /** @private */
    private _lastZoom;
    /**
     * Rebuilds the projection matrix and its inverse.
     * @returns {PerspectiveCamera} this
     */
    updateProjection(): PerspectiveCamera;
    /**
     * Rebuilds the projection matrix only when a parameter changed.
     * @returns {PerspectiveCamera} this
     */
    updateProjectionIfNeeded(): PerspectiveCamera;
    /**
     * Sets every projection parameter at once.
     * @param {number} fov Degrees.
     * @param {number} aspect
     * @param {number} near
     * @param {number} far
     * @returns {PerspectiveCamera} this
     */
    setPerspective(fov: number, aspect: number, near: number, far: number): PerspectiveCamera;
    /**
     * @param {number} width
     * @param {number} height
     * @returns {PerspectiveCamera} this
     */
    setAspectFromSize(width: number, height: number): PerspectiveCamera;
    /**
     * Effective vertical field of view in radians, zoom included.
     * @returns {number}
     */
    getEffectiveFOV(): number;
    /**
     * Film height in millimeters for the current aspect ratio.
     * @returns {number}
     */
    getFilmHeight(): number;
    /**
     * Film width in millimeters for the current aspect ratio.
     * @returns {number}
     */
    getFilmWidth(): number;
    /**
     * Focal length in millimeters equivalent to the current field of view.
     * @returns {number}
     */
    getFocalLength(): number;
    /**
     * Sets the field of view from a focal length in millimeters.
     * @param {number} focalLength
     * @returns {PerspectiveCamera} this
     */
    setFocalLength(focalLength: number): PerspectiveCamera;
}
import { Camera } from "./Camera.js";
