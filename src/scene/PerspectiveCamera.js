import { Camera } from './Camera.js';
import { DEG2RAD, RAD2DEG } from '../math/MathUtils.js';

/**
 * Standard perspective camera.
 *
 * `fov` is the vertical field of view in degrees, `zoom` scales it the same way
 * a real lens would. Projection parameters are plain fields: they are compared
 * against a cached copy once per frame so the matrix is only rebuilt when one of
 * them actually changed.
 */
export class PerspectiveCamera extends Camera {
  isPerspectiveCamera = true;

  fov = 50;
  aspect = 1;
  zoom = 1;

  /** Film gauge in millimeters, used by the focal length helpers. */
  filmGauge = 35;

  /** @private */
  _lastFov = NaN;
  /** @private */
  _lastAspect = NaN;
  /** @private */
  _lastNear = NaN;
  /** @private */
  _lastFar = NaN;
  /** @private */
  _lastZoom = NaN;

  /**
   * @param {number} [fov=50] Vertical field of view in degrees.
   * @param {number} [aspect=1] Width / height.
   * @param {number} [near=0.1]
   * @param {number} [far=1000]
   */
  constructor(fov = 50, aspect = 1, near = 0.1, far = 1000) {
    super('PerspectiveCamera');
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    this.updateProjection();
  }

  /**
   * Rebuilds the projection matrix and its inverse.
   * @returns {PerspectiveCamera} this
   */
  updateProjection() {
    const halfTan = Math.tan(this.fov * DEG2RAD * 0.5) / this.zoom;
    const fovY = 2 * Math.atan(halfTan);
    this.projectionMatrix.perspective(fovY, this.aspect, this.near, this.far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    this._lastFov = this.fov;
    this._lastAspect = this.aspect;
    this._lastNear = this.near;
    this._lastFar = this.far;
    this._lastZoom = this.zoom;
    this._projectionDirty = false;
    return this;
  }

  /**
   * Rebuilds the projection matrix only when a parameter changed.
   * @returns {PerspectiveCamera} this
   */
  updateProjectionIfNeeded() {
    if (this._projectionDirty === true ||
      this._lastFov !== this.fov ||
      this._lastAspect !== this.aspect ||
      this._lastNear !== this.near ||
      this._lastFar !== this.far ||
      this._lastZoom !== this.zoom) {
      this.updateProjection();
    }
    return this;
  }

  /**
   * Sets every projection parameter at once.
   * @param {number} fov Degrees.
   * @param {number} aspect
   * @param {number} near
   * @param {number} far
   * @returns {PerspectiveCamera} this
   */
  setPerspective(fov, aspect, near, far) {
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    return this.updateProjection();
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {PerspectiveCamera} this
   */
  setAspectFromSize(width, height) {
    this.aspect = height > 0 ? width / height : 1;
    return this;
  }

  /**
   * Effective vertical field of view in radians, zoom included.
   * @returns {number}
   */
  getEffectiveFOV() {
    return 2 * Math.atan(Math.tan(this.fov * DEG2RAD * 0.5) / this.zoom);
  }

  /**
   * Film height in millimeters for the current aspect ratio.
   * @returns {number}
   */
  getFilmHeight() {
    return this.filmGauge / Math.max(this.aspect, 1);
  }

  /**
   * Film width in millimeters for the current aspect ratio.
   * @returns {number}
   */
  getFilmWidth() {
    return this.filmGauge * Math.min(this.aspect, 1);
  }

  /**
   * Focal length in millimeters equivalent to the current field of view.
   * @returns {number}
   */
  getFocalLength() {
    const vExtentSlope = Math.tan(this.fov * DEG2RAD * 0.5);
    return 0.5 * this.getFilmHeight() / vExtentSlope;
  }

  /**
   * Sets the field of view from a focal length in millimeters.
   * @param {number} focalLength
   * @returns {PerspectiveCamera} this
   */
  setFocalLength(focalLength) {
    const vExtentSlope = 0.5 * this.getFilmHeight() / focalLength;
    this.fov = RAD2DEG * 2 * Math.atan(vExtentSlope);
    return this.updateProjection();
  }
}
