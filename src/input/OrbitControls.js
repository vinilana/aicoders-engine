/**
 * @fileoverview Orbit camera controller: spherical rotation with frame-rate
 * independent exponential damping (inertia), camera-plane panning, dolly zoom,
 * angle/distance limits and full touch support (1 finger rotates, 2 fingers
 * pinch-zoom and pan).
 *
 * The controller owns its own pointer listeners so it can be used without the
 * Input class. It assumes the engine convention: right-handed, Y up, camera
 * looking down its local -Z axis.
 */

import { Vec3 } from '../math/Vec3.js';
import { clamp, DEG2RAD, EPSILON } from '../math/MathUtils.js';

/** Idle state. */
const STATE_NONE = 0;
/** Single pointer rotating. */
const STATE_ROTATE = 1;
/** Single pointer dollying (middle mouse). */
const STATE_DOLLY = 2;
/** Single pointer panning. */
const STATE_PAN = 3;
/** Two pointers: pinch zoom plus pan. */
const STATE_TOUCH_ZOOM_PAN = 4;

/** Base dolly step per wheel notch. */
const DOLLY_BASE = 0.95;
/** Smallest allowed orbit radius. */
const MIN_RADIUS = 1e-4;

/** Scratch vectors, reused every frame (never allocate in update). */
const _offset = new Vec3();
const _right = new Vec3();
const _up = new Vec3();
const _pan = new Vec3();

/**
 * Tracked pointer used by the controller.
 */
class OrbitPointer {
  constructor() {
    /** @type {number} */
    this.id = -1;
    /** @type {number} */
    this.x = 0;
    /** @type {number} */
    this.y = 0;
    /** @type {string} */
    this.type = 'mouse';
  }
}

/**
 * Damping-based orbit camera controller.
 */
export class OrbitControls {
  /**
   * @param {import('../scene/Camera.js').Camera} camera Camera to drive.
   * @param {HTMLElement} domElement Element listened to for pointer events.
   */
  constructor(camera, domElement) {
    /** @type {*} Controlled camera. */
    this.camera = camera;
    /** @type {*} Element the controller listens to. */
    this.domElement = domElement || null;

    /** @type {boolean} Master switch. */
    this.enabled = true;
    /** @type {Vec3} Orbit centre (goal, freely writable by the user). */
    this.target = new Vec3(0, 0, 0);

    /** @type {boolean} Smooth follow of the goal values. */
    this.enableDamping = true;
    /** @type {number} Fraction of the remaining error closed per 60Hz frame. */
    this.dampingFactor = 0.08;

    /** @type {number} Minimum orbit distance. */
    this.minDistance = 0.05;
    /** @type {number} Maximum orbit distance. */
    this.maxDistance = 1e6;
    /** @type {number} Minimum polar angle in radians (0 = straight above). */
    this.minPolarAngle = 0.000001;
    /** @type {number} Maximum polar angle in radians (PI = straight below). */
    this.maxPolarAngle = Math.PI - 0.000001;
    /** @type {number} Minimum azimuth angle in radians (-Infinity for free). */
    this.minAzimuthAngle = -Infinity;
    /** @type {number} Maximum azimuth angle in radians (Infinity for free). */
    this.maxAzimuthAngle = Infinity;

    /** @type {boolean} */
    this.enableRotate = true;
    /** @type {boolean} */
    this.enablePan = true;
    /** @type {boolean} */
    this.enableZoom = true;

    /** @type {number} Radians of rotation per element height dragged. */
    this.rotateSpeed = 1;
    /** @type {number} Dolly multiplier per wheel notch. */
    this.zoomSpeed = 1;
    /** @type {number} Pan multiplier. */
    this.panSpeed = 1;
    /** @type {boolean} Pan along the camera plane instead of the ground plane. */
    this.screenSpacePanning = true;

    /** @type {boolean} Continuous azimuth rotation. */
    this.autoRotate = false;
    /** @type {number} Auto rotation speed in radians per second. */
    this.autoRotateSpeed = 0.35;

    /**
     * Mouse button roles. Values: 'rotate' | 'dolly' | 'pan' | 'none'.
     * @type {{left:string, middle:string, right:string}}
     */
    this.mouseButtons = { left: 'rotate', middle: 'dolly', right: 'pan' };

    /** @type {number} Current (damped) azimuth angle. */
    this._theta = 0;
    /** @type {number} Current (damped) polar angle. */
    this._phi = Math.PI * 0.5;
    /** @type {number} Current (damped) radius. */
    this._radius = 1;
    /** @type {number} Goal azimuth angle. */
    this._goalTheta = 0;
    /** @type {number} Goal polar angle. */
    this._goalPhi = Math.PI * 0.5;
    /** @type {number} Goal radius. */
    this._goalRadius = 1;
    /** @type {Vec3} Damped orbit centre actually used by the camera. */
    this._smoothTarget = new Vec3();

    /** @type {number} Active interaction state. */
    this._state = STATE_NONE;
    /** @type {OrbitPointer[]} Active pointers. */
    this._pointers = [];
    /** @type {OrbitPointer[]} Pointer pool. */
    this._pointerPool = [];
    /** @type {number} Previous pinch distance. */
    this._prevPinch = 0;
    /** @type {number} Previous centroid X. */
    this._prevCenterX = 0;
    /** @type {number} Previous centroid Y. */
    this._prevCenterY = 0;

    /** @type {Vec3} Saved target for reset(). */
    this._savedTarget = new Vec3();
    /** @type {number} Saved azimuth for reset(). */
    this._savedTheta = 0;
    /** @type {number} Saved polar for reset(). */
    this._savedPhi = Math.PI * 0.5;
    /** @type {number} Saved radius for reset(). */
    this._savedRadius = 1;

    /** @type {Array<*>} Registered listeners, for dispose(). */
    this._listeners = [];

    this._syncFromCamera();
    this._smoothTarget.copy(this.target);
    this.saveState();
    this._bindHandlers();
    this._attach();
    this.updateCameraTransform();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * Derives the spherical coordinates from the camera's current position.
   * @private
   */
  _syncFromCamera() {
    const cam = this.camera;
    if (!cam || !cam.position) return;
    const dx = cam.position.x - this.target.x;
    const dy = cam.position.y - this.target.y;
    const dz = cam.position.z - this.target.z;
    let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < MIN_RADIUS) r = 1;
    this._radius = r;
    this._goalRadius = r;
    this._theta = Math.atan2(dx, dz);
    this._goalTheta = this._theta;
    this._phi = Math.acos(clamp(dy / r, -1, 1));
    this._goalPhi = this._phi;
  }

  /**
   * Creates the bound handler closures once.
   * @private
   */
  _bindHandlers() {
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onWheel = (e) => this._handleWheel(e);
    this._onContextMenu = (e) => { if (this.enabled) e.preventDefault(); };
  }

  /**
   * Registers a removable listener.
   * @param {*} el Event target.
   * @param {string} type Event name.
   * @param {Function} fn Handler.
   * @param {Object|boolean} [opts] addEventListener options.
   * @private
   */
  _addListener(el, type, fn, opts) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, fn, opts);
    this._listeners.push(el, type, fn, opts);
  }

  /**
   * Attaches the pointer listeners. No-op when headless.
   * @private
   */
  _attach() {
    const el = this.domElement;
    if (!el) return;
    if (el.style) el.style.touchAction = 'none';
    const passive = { passive: true };
    const active = { passive: false };
    this._addListener(el, 'pointerdown', this._onPointerDown, active);
    this._addListener(el, 'pointermove', this._onPointerMove, passive);
    this._addListener(el, 'pointerup', this._onPointerUp, passive);
    this._addListener(el, 'pointercancel', this._onPointerUp, passive);
    this._addListener(el, 'lostpointercapture', this._onPointerUp, passive);
    this._addListener(el, 'wheel', this._onWheel, active);
    this._addListener(el, 'contextmenu', this._onContextMenu, active);
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------

  /**
   * @param {number} id Pointer identifier.
   * @returns {OrbitPointer|null} Tracked pointer or null.
   * @private
   */
  _findPointer(id) {
    const p = this._pointers;
    for (let i = 0, n = p.length; i < n; i++) {
      if (p[i].id === id) return p[i];
    }
    return null;
  }

  /**
   * @param {PointerEvent} e Event.
   * @private
   */
  _handlePointerDown(e) {
    if (!this.enabled) return;
    const el = this.domElement;
    if (el && typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        // Capture is a convenience; ignore browsers that refuse it.
      }
    }
    let p = this._findPointer(e.pointerId);
    if (p === null) {
      p = this._pointerPool.length > 0 ? this._pointerPool.pop() : new OrbitPointer();
      p.id = e.pointerId !== undefined ? e.pointerId : 0;
      this._pointers.push(p);
    }
    p.x = e.clientX;
    p.y = e.clientY;
    p.type = e.pointerType || 'mouse';

    if (this._pointers.length === 1) {
      if (p.type === 'mouse') {
        const role = e.button === 0 ? this.mouseButtons.left
          : (e.button === 1 ? this.mouseButtons.middle : this.mouseButtons.right);
        if (role === 'rotate' && this.enableRotate) this._state = STATE_ROTATE;
        else if (role === 'dolly' && this.enableZoom) this._state = STATE_DOLLY;
        else if (role === 'pan' && this.enablePan) this._state = STATE_PAN;
        else this._state = STATE_NONE;
      } else {
        this._state = this.enableRotate ? STATE_ROTATE : STATE_NONE;
      }
    } else if (this._pointers.length === 2) {
      this._state = STATE_TOUCH_ZOOM_PAN;
      this._resetGestureReference();
    } else {
      this._state = STATE_NONE;
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * Rebases the two-pointer gesture reference values.
   * @private
   */
  _resetGestureReference() {
    const a = this._pointers[0];
    const b = this._pointers[1];
    if (a === undefined || b === undefined) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    this._prevPinch = Math.sqrt(dx * dx + dy * dy);
    this._prevCenterX = (a.x + b.x) * 0.5;
    this._prevCenterY = (a.y + b.y) * 0.5;
  }

  /**
   * @param {PointerEvent} e Event.
   * @private
   */
  _handlePointerMove(e) {
    if (!this.enabled || this._state === STATE_NONE) return;
    const p = this._findPointer(e.pointerId);
    if (p === null) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this._state === STATE_TOUCH_ZOOM_PAN) {
      const a = this._pointers[0];
      const b = this._pointers[1];
      if (a === undefined || b === undefined) return;
      const ddx = b.x - a.x;
      const ddy = b.y - a.y;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (this.enableZoom && this._prevPinch > EPSILON && dist > EPSILON) {
        this.dolly(this._prevPinch / dist);
      }
      this._prevPinch = dist;
      const cx = (a.x + b.x) * 0.5;
      const cy = (a.y + b.y) * 0.5;
      if (this.enablePan) this.pan(cx - this._prevCenterX, cy - this._prevCenterY);
      this._prevCenterX = cx;
      this._prevCenterY = cy;
      return;
    }

    if (this._state === STATE_ROTATE) this.rotate(dx, dy);
    else if (this._state === STATE_PAN) this.pan(dx, dy);
    else if (this._state === STATE_DOLLY) this.dolly(Math.pow(DOLLY_BASE, -dy * 0.02 * this.zoomSpeed));
  }

  /**
   * @param {PointerEvent} e Event.
   * @private
   */
  _handlePointerUp(e) {
    const list = this._pointers;
    for (let i = 0, n = list.length; i < n; i++) {
      if (list[i].id === e.pointerId) {
        this._pointerPool.push(list[i]);
        list.splice(i, 1);
        break;
      }
    }
    const el = this.domElement;
    if (el && typeof el.releasePointerCapture === 'function' && e.pointerId !== undefined) {
      try {
        if (typeof el.hasPointerCapture !== 'function' || el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
      } catch (err) {
        // Nothing to release.
      }
    }
    if (list.length === 0) {
      this._state = STATE_NONE;
    } else if (list.length === 1) {
      this._state = this.enableRotate ? STATE_ROTATE : STATE_NONE;
    } else {
      this._state = STATE_TOUCH_ZOOM_PAN;
      this._resetGestureReference();
    }
  }

  /**
   * @param {WheelEvent} e Event.
   * @private
   */
  _handleWheel(e) {
    if (!this.enabled || !this.enableZoom) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const mode = e.deltaMode;
    const px = e.deltaY * (mode === 1 ? 16 : (mode === 2 ? 400 : 1));
    let notches = px / 100;
    if (notches > 8) notches = 8;
    else if (notches < -8) notches = -8;
    this.dolly(Math.pow(DOLLY_BASE, -notches * this.zoomSpeed));
  }

  // ---------------------------------------------------------------------------
  // Public manipulation
  // ---------------------------------------------------------------------------

  /**
   * Height in CSS pixels of the controlled element (used to normalize drags).
   * @returns {number} Element height, never zero.
   * @private
   */
  _elementHeight() {
    const el = this.domElement;
    if (el) {
      if (el.clientHeight) return el.clientHeight;
      if (el.height) return el.height;
    }
    return 600;
  }

  /**
   * Width in CSS pixels of the controlled element.
   * @returns {number} Element width, never zero.
   * @private
   */
  _elementWidth() {
    const el = this.domElement;
    if (el) {
      if (el.clientWidth) return el.clientWidth;
      if (el.width) return el.width;
    }
    return 800;
  }

  /**
   * Rotates the orbit goal by a pixel drag.
   * @param {number} dxPixels Horizontal drag in pixels.
   * @param {number} dyPixels Vertical drag in pixels.
   */
  rotate(dxPixels, dyPixels) {
    if (!this.enableRotate) return;
    const h = this._elementHeight();
    const k = (Math.PI * 2 * this.rotateSpeed) / h;
    this._goalTheta -= dxPixels * k;
    this._goalPhi -= dyPixels * k;
    this._clampGoals();
  }

  /**
   * Pans the orbit centre by a pixel drag along the camera plane.
   * @param {number} dxPixels Horizontal drag in pixels.
   * @param {number} dyPixels Vertical drag in pixels.
   */
  pan(dxPixels, dyPixels) {
    if (!this.enablePan) return;
    const cam = this.camera;
    const h = this._elementHeight();
    let worldPerPixel;
    if (cam && typeof cam.fov === 'number') {
      const zoom = typeof cam.zoom === 'number' && cam.zoom > 0 ? cam.zoom : 1;
      worldPerPixel = (2 * this._goalRadius * Math.tan(cam.fov * DEG2RAD * 0.5) / zoom) / h;
    } else if (cam && typeof cam.top === 'number' && typeof cam.bottom === 'number') {
      const zoom = typeof cam.zoom === 'number' && cam.zoom > 0 ? cam.zoom : 1;
      worldPerPixel = ((cam.top - cam.bottom) / zoom) / h;
    } else {
      worldPerPixel = (2 * this._goalRadius * 0.4142) / h;
    }
    const amountX = -dxPixels * worldPerPixel * this.panSpeed;
    const amountY = dyPixels * worldPerPixel * this.panSpeed;

    const st = Math.sin(this._goalTheta);
    const ct = Math.cos(this._goalTheta);
    const sp = Math.sin(this._goalPhi);
    const cp = Math.cos(this._goalPhi);

    _right.set(ct, 0, -st);
    if (this.screenSpacePanning) {
      _up.set(-cp * st, sp, -cp * ct);
    } else {
      _up.set(-st, 0, -ct);
    }
    _pan.set(
      _right.x * amountX + _up.x * amountY,
      _right.y * amountX + _up.y * amountY,
      _right.z * amountX + _up.z * amountY
    );
    this.target.x += _pan.x;
    this.target.y += _pan.y;
    this.target.z += _pan.z;
  }

  /**
   * Multiplies the goal orbit distance.
   * @param {number} factor Values below 1 move the camera closer.
   */
  dolly(factor) {
    if (!this.enableZoom || !(factor > 0)) return;
    this._goalRadius *= factor;
    this._clampGoals();
  }

  /**
   * Clamps the goal spherical coordinates against the configured limits.
   * @private
   */
  _clampGoals() {
    this._goalPhi = clamp(this._goalPhi, this.minPolarAngle, this.maxPolarAngle);
    if (this.minAzimuthAngle > -Infinity || this.maxAzimuthAngle < Infinity) {
      this._goalTheta = clamp(this._goalTheta, this.minAzimuthAngle, this.maxAzimuthAngle);
    }
    let r = this._goalRadius;
    if (r < this.minDistance) r = this.minDistance;
    if (r > this.maxDistance) r = this.maxDistance;
    if (r < MIN_RADIUS) r = MIN_RADIUS;
    this._goalRadius = r;
  }

  /**
   * Stores the current configuration so `reset()` can restore it.
   */
  saveState() {
    this._savedTarget.copy(this.target);
    this._savedTheta = this._goalTheta;
    this._savedPhi = this._goalPhi;
    this._savedRadius = this._goalRadius;
  }

  /**
   * Restores the configuration captured by `saveState()`.
   */
  reset() {
    this.target.copy(this._savedTarget);
    this._smoothTarget.copy(this._savedTarget);
    this._goalTheta = this._savedTheta;
    this._goalPhi = this._savedPhi;
    this._goalRadius = this._savedRadius;
    this._theta = this._savedTheta;
    this._phi = this._savedPhi;
    this._radius = this._savedRadius;
    this._state = STATE_NONE;
    this.updateCameraTransform();
  }

  /**
   * Current distance between camera and orbit centre.
   * @returns {number} Distance in world units.
   */
  getDistance() {
    return this._radius;
  }

  /**
   * Sets the goal orbit distance.
   * @param {number} distance Distance in world units.
   */
  setDistance(distance) {
    this._goalRadius = distance;
    this._clampGoals();
  }

  /**
   * Current polar angle in radians.
   * @returns {number} Polar angle.
   */
  getPolarAngle() {
    return this._phi;
  }

  /**
   * Current azimuth angle in radians.
   * @returns {number} Azimuth angle.
   */
  getAzimuthalAngle() {
    return this._theta;
  }

  /**
   * Sets both spherical goal angles at once.
   * @param {number} azimuth Azimuth in radians.
   * @param {number} polar Polar angle in radians.
   */
  setAngles(azimuth, polar) {
    this._goalTheta = azimuth;
    this._goalPhi = polar;
    this._clampGoals();
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  /**
   * Advances damping and writes the resulting transform to the camera.
   * @param {number} [dt=1/60] Frame time in seconds.
   * @returns {boolean} Whether the camera transform changed this frame.
   */
  update(dt) {
    if (!this.enabled) return false;
    const step = dt !== undefined && dt > 0 ? (dt > 0.25 ? 0.25 : dt) : 1 / 60;

    if (this.autoRotate && this._state === STATE_NONE) {
      this._goalTheta -= this.autoRotateSpeed * step;
      this._clampGoals();
    }

    let t = 1;
    if (this.enableDamping) {
      const f = clamp(this.dampingFactor, 0.0001, 1);
      const lambda = -Math.log(1 - f) * 60;
      t = 1 - Math.exp(-lambda * step);
    }

    let dTheta = this._goalTheta - this._theta;
    const dPhi = this._goalPhi - this._phi;
    const dRadius = this._goalRadius - this._radius;
    const dtx = this.target.x - this._smoothTarget.x;
    const dty = this.target.y - this._smoothTarget.y;
    const dtz = this.target.z - this._smoothTarget.z;

    this._theta += dTheta * t;
    this._phi += dPhi * t;
    this._radius += dRadius * t;
    this._smoothTarget.x += dtx * t;
    this._smoothTarget.y += dty * t;
    this._smoothTarget.z += dtz * t;

    // Snap when the residual error is imperceptible so the loop settles.
    if (dTheta < EPSILON && dTheta > -EPSILON) this._theta = this._goalTheta;
    if (dPhi < EPSILON && dPhi > -EPSILON) this._phi = this._goalPhi;
    if (dRadius < EPSILON && dRadius > -EPSILON) this._radius = this._goalRadius;

    // Keep the angles bounded to avoid precision loss after long sessions.
    if (this._theta > Math.PI * 4 || this._theta < -Math.PI * 4) {
      const wrap = Math.PI * 2 * Math.round(this._theta / (Math.PI * 2));
      this._theta -= wrap;
      this._goalTheta -= wrap;
    }

    const changed = (dTheta * dTheta + dPhi * dPhi + dRadius * dRadius +
      dtx * dtx + dty * dty + dtz * dtz) > EPSILON * EPSILON;
    this.updateCameraTransform();
    return changed;
  }

  /**
   * Writes position and orientation to the camera from the current spherical
   * state. The orientation is built analytically (Qy(theta) * Qx(phi - PI/2)),
   * which stays stable at the poles where a look-at basis degenerates.
   */
  updateCameraTransform() {
    const cam = this.camera;
    if (!cam || !cam.position || !cam.quaternion) return;

    const sp = Math.sin(this._phi);
    const cp = Math.cos(this._phi);
    const st = Math.sin(this._theta);
    const ct = Math.cos(this._theta);
    const r = this._radius;

    _offset.set(r * sp * st, r * cp, r * sp * ct);
    cam.position.set(
      this._smoothTarget.x + _offset.x,
      this._smoothTarget.y + _offset.y,
      this._smoothTarget.z + _offset.z
    );

    const halfTheta = this._theta * 0.5;
    const halfPitch = (this._phi - Math.PI * 0.5) * 0.5;
    const sy = Math.sin(halfTheta);
    const cy = Math.cos(halfTheta);
    const sx = Math.sin(halfPitch);
    const cx = Math.cos(halfPitch);
    cam.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx);

    cam.matrixWorldNeedsUpdate = true;
    if (cam.matrixAutoUpdate === false && typeof cam.updateMatrix === 'function') {
      cam.updateMatrix();
    }
  }

  /**
   * Removes every listener and clears pointer tracking.
   */
  dispose() {
    const l = this._listeners;
    for (let i = 0; i < l.length; i += 4) {
      const el = l[i];
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(l[i + 1], l[i + 2], l[i + 3]);
      }
    }
    l.length = 0;
    this._pointers.length = 0;
    this._pointerPool.length = 0;
    this._state = STATE_NONE;
    this.enabled = false;
  }
}
