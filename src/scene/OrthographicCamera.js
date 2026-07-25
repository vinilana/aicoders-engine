import { Camera } from './Camera.js';

/**
 * Orthographic camera. The frustum is defined by the left / right / bottom /
 * top planes; `zoom` shrinks the visible extents around their center.
 */
export class OrthographicCamera extends Camera {
  isOrthographicCamera = true;

  left = -1;
  right = 1;
  top = 1;
  bottom = -1;
  zoom = 1;

  /** @private */
  _lastLeft = NaN;
  /** @private */
  _lastRight = NaN;
  /** @private */
  _lastTop = NaN;
  /** @private */
  _lastBottom = NaN;
  /** @private */
  _lastNear = NaN;
  /** @private */
  _lastFar = NaN;
  /** @private */
  _lastZoom = NaN;

  /**
   * @param {number} [left=-1]
   * @param {number} [right=1]
   * @param {number} [top=1]
   * @param {number} [bottom=-1]
   * @param {number} [near=0.1]
   * @param {number} [far=1000]
   */
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 1000) {
    super('OrthographicCamera');
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    this.near = near;
    this.far = far;
    this.updateProjection();
  }

  /**
   * Rebuilds the projection matrix and its inverse.
   * @returns {OrthographicCamera} this
   */
  updateProjection() {
    const invZoom = this.zoom !== 0 ? 1 / this.zoom : 1;
    const cx = (this.right + this.left) * 0.5;
    const cy = (this.top + this.bottom) * 0.5;
    const dx = (this.right - this.left) * 0.5 * invZoom;
    const dy = (this.top - this.bottom) * 0.5 * invZoom;
    this.projectionMatrix.orthographic(cx - dx, cx + dx, cy - dy, cy + dy, this.near, this.far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    this._lastLeft = this.left;
    this._lastRight = this.right;
    this._lastTop = this.top;
    this._lastBottom = this.bottom;
    this._lastNear = this.near;
    this._lastFar = this.far;
    this._lastZoom = this.zoom;
    this._projectionDirty = false;
    return this;
  }

  /**
   * Rebuilds the projection matrix only when a parameter changed.
   * @returns {OrthographicCamera} this
   */
  updateProjectionIfNeeded() {
    if (this._projectionDirty === true ||
      this._lastLeft !== this.left ||
      this._lastRight !== this.right ||
      this._lastTop !== this.top ||
      this._lastBottom !== this.bottom ||
      this._lastNear !== this.near ||
      this._lastFar !== this.far ||
      this._lastZoom !== this.zoom) {
      this.updateProjection();
    }
    return this;
  }

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
  setOrthographic(left, right, top, bottom, near, far) {
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    this.near = near;
    this.far = far;
    return this.updateProjection();
  }

  /**
   * Centers the frustum around the origin with the given world height and the
   * aspect ratio of the target viewport.
   * @param {number} height World units covered vertically.
   * @param {number} aspect Width / height.
   * @returns {OrthographicCamera} this
   */
  setViewSize(height, aspect) {
    const halfH = height * 0.5;
    const halfW = halfH * aspect;
    this.left = -halfW;
    this.right = halfW;
    this.top = halfH;
    this.bottom = -halfH;
    return this;
  }
}
