/**
 * @file CharacterController.js
 * Kinematic capsule character with collide-and-slide movement.
 *
 * The controller never uses the rigid body solver: it sweeps its capsule with
 * {@link CollisionWorld#capsuleCast} and resolves the motion geometrically.
 * Because every move is a swept test, a character can never tunnel through a
 * wall, no matter how fast it travels or how large the frame time is.
 *
 * The capsule is always kept `contactOffset` metres away from every surface
 * (the "skin"). That single rule is what removes the classic jitter: a purely
 * horizontal sweep along a floor the capsule is *touching* would otherwise
 * report an impact at distance 0 forever and the character would never move.
 *
 * MOVE PIPELINE (one call to `move`)
 *   0. depenetrate  - push out of anything the capsule already overlaps
 *   1. up phase     - vertical motion while rising, with ceiling detection
 *   2. lateral      - collide-and-slide, with a step-up retry when blocked
 *   3. down phase   - collide-and-slide while falling
 *   4. ground probe - detect the floor and snap to it (stairs, ramp crests)
 *
 * KNOWN LIMITATIONS
 * - `position` is the FEET position (the base of the capsule), not its centre.
 * - The character is kinematic: it pushes nothing. Rigid bodies do not react to
 *   it, and moving platforms do not carry it (parent the controller yourself
 *   and call `teleport` with the platform delta).
 * - Only static colliders are swept against; dynamic bodies are ignored.
 * - The up axis is fixed for the lifetime of a move: no walking on walls.
 * - The skin makes the capsule float `contactOffset` above the ground (a couple
 *   of centimetres, and up to ~3x that on a steep walkable ramp, because the
 *   lateral sweep measures the skin along the motion and not along the surface
 *   normal). Lower `contactOffset` for a tighter fit, at the cost of robustness.
 * - Climbing a step keeps the requested horizontal speed but the vertical gain
 *   is applied in one frame, so a very tall `stepOffset` produces a visible pop.
 */

import { Vec3 } from '../math/Vec3.js';
import { DEG2RAD } from '../math/MathUtils.js';
import { createSweepHit } from './CollisionWorld.js';

/** Smallest displacement worth sweeping, in metres. */
const MIN_MOVE = 1e-6;

/**
 * Capsule character controller driven by `move(desiredVelocity, dt)`.
 */
export class CharacterController {
  /**
   * @param {import('./CollisionWorld.js').CollisionWorld} world Collision world.
   * @param {Object} [options] Configuration.
   * @param {number} [options.radius=0.35] Capsule radius.
   * @param {number} [options.height=1.8] Total capsule height, caps included.
   * @param {number} [options.crouchHeight] Height used while crouching.
   * @param {number} [options.stepOffset=0.35] Tallest step that can be climbed.
   * @param {number} [options.slopeLimit=50] Walkable slope limit, in degrees.
   * @param {number} [options.contactOffset=0.02] Skin width kept around the capsule.
   * @param {number} [options.maxIterations=5] Collide-and-slide iterations.
   * @param {number} [options.gravity] Acceleration along `-up`; taken from the
   *   world when omitted.
   * @param {Vec3} [options.up] Up axis, defaults to (0, 1, 0).
   * @param {Vec3} [options.position] Initial feet position.
   * @param {number} [options.mask=0xffffffff] Collision layer mask.
   * @param {boolean} [options.applyGravity=true] Let the controller own the
   *   vertical velocity.
   */
  constructor(world, options = {}) {
    /** @type {import('./CollisionWorld.js').CollisionWorld} */
    this.world = world;
    /** @type {boolean} True marker for duck typing. */
    this.isCharacterController = true;

    /** @type {Vec3} Up axis of the capsule. */
    this.up = new Vec3(0, 1, 0);
    if (options.up !== undefined && options.up !== null) this.up.copy(options.up).normalize();

    /** @type {Vec3} Feet position (base of the capsule). */
    this.position = new Vec3();
    if (options.position !== undefined && options.position !== null) this.position.copy(options.position);
    /** @type {Vec3} Current world velocity. */
    this.velocity = new Vec3();
    /** @type {Vec3} Velocity requested by `update(dt)`. */
    this.desiredVelocity = new Vec3();

    /** @type {number} */
    this.radius = options.radius !== undefined ? options.radius : 0.35;
    /** @type {number} Total height, hemispherical caps included. */
    this.height = options.height !== undefined ? options.height : 1.8;
    /** @type {number} */
    this.standHeight = this.height;
    /** @type {number} */
    this.crouchHeight = options.crouchHeight !== undefined ? options.crouchHeight : this.height * 0.55;
    /** @type {boolean} */
    this.crouching = false;

    /** @type {number} Tallest step the character can climb. */
    this.stepOffset = options.stepOffset !== undefined ? options.stepOffset : 0.35;
    /** @type {number} Walkable slope limit, in degrees. */
    this.slopeLimit = options.slopeLimit !== undefined ? options.slopeLimit : 50;
    /** @type {number} Skin width kept between the capsule and every surface. */
    this.contactOffset = options.contactOffset !== undefined ? options.contactOffset : 0.02;
    /** @type {number} Collide-and-slide iterations per phase. */
    this.maxIterations = options.maxIterations !== undefined ? Math.max(1, options.maxIterations | 0) : 5;
    /** @type {number} Depenetration passes run before each move. */
    this.depenetrationIterations = options.depenetrationIterations !== undefined
      ? Math.max(0, options.depenetrationIterations | 0) : 2;
    /** @type {number} Extra downward probe used to stay glued to the floor. */
    this.groundSnapDistance = options.groundSnapDistance !== undefined
      ? options.groundSnapDistance : this.stepOffset;
    /**
     * Downward speed kept while grounded. The default 0 relies purely on the
     * ground snap of `_probeGround`, which is what keeps the capsule from
     * sinking back into a step it has just climbed.
     * @type {number}
     */
    this.groundStickSpeed = options.groundStickSpeed !== undefined ? options.groundStickSpeed : 0;
    /** @type {number} Acceleration applied while sliding down a steep slope. */
    this.slideAcceleration = options.slideAcceleration !== undefined ? options.slideAcceleration : 12;
    /** @type {number} Terminal fall speed. */
    this.maxFallSpeed = options.maxFallSpeed !== undefined ? options.maxFallSpeed : 55;
    /** @type {number} Collision layer mask. */
    this.mask = options.mask !== undefined ? options.mask : 0xffffffff;
    /** @type {boolean} The controller integrates gravity itself. */
    this.applyGravity = options.applyGravity !== undefined ? options.applyGravity : true;
    /** @type {boolean} */
    this.enabled = true;

    /** @type {number} Gravity along `-up`, negative. */
    this.gravity = -9.81;
    if (options.gravity !== undefined) {
      this.gravity = options.gravity;
    } else if (world !== null && world !== undefined && world.gravity !== undefined) {
      this.gravity = world.gravity.dot(this.up);
    }

    /** @type {boolean} True while standing on a walkable surface. */
    this.isGrounded = false;
    /** @type {Vec3} Normal of the surface the character stands on. */
    this.groundNormal = new Vec3(0, 1, 0);
    /** @type {Object|null} Collider the character stands on. */
    this.groundCollider = null;
    /** @type {boolean} True when a steep, non walkable surface was hit below. */
    this.onSteepSlope = false;
    /** @type {Vec3} Normal of that steep surface. */
    this.steepNormal = new Vec3(0, 1, 0);
    /** @type {boolean} True when the last move bumped into a ceiling. */
    this.hitCeiling = false;
    /** @type {boolean} True when the last move was blocked by a wall. */
    this.hitWall = false;
    /** @type {Vec3} Normal of that wall. */
    this.wallNormal = new Vec3();
    /** @type {Vec3} Displacement actually applied by the last move. */
    this.lastDisplacement = new Vec3();
    /** @type {Object|null} Node3D kept in sync by `syncNode()`. */
    this.node = options.node !== undefined ? options.node : null;
    /** @type {number} Vertical offset applied when writing to `node`. */
    this.nodeOffset = options.nodeOffset !== undefined ? options.nodeOffset : 0;

    /** @private Cosine of the slope limit. */
    this._minGroundDot = Math.cos(this.slopeLimit * DEG2RAD);
    /** @private True on the frame a jump was requested. */
    this._jumped = false;
    /** @private Set by `_slideMove` when a non walkable surface blocked it. */
    this._blockedByWall = false;
    /** @private Distance covered by the last `_moveAxis` call. */
    this._axisDistance = 0;
    /** @private True when the last move mounted a step. */
    this._steppedUp = false;

    /** @private Scratch - the move path never allocates. */
    this._p0 = new Vec3();
    this._p1 = new Vec3();
    this._dir = new Vec3();
    this._disp = new Vec3();
    this._tmp = new Vec3();
    this._tmp2 = new Vec3();
    this._start = new Vec3();
    this._flatEnd = new Vec3();
    this._stepSave = new Vec3();
    this._plane1 = new Vec3();
    this._plane2 = new Vec3();
    this._down = new Vec3();
    this._hit = createSweepHit();
    this._probeHit = createSweepHit();
    this._contacts = [];
  }

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Writes the endpoints of the capsule's inner segment for a given feet
   * position.
   * @param {Vec3} feet Feet position.
   * @param {Vec3} out0 Receives the lower sphere centre.
   * @param {Vec3} out1 Receives the upper sphere centre.
   * @returns {void}
   */
  getSegmentAt(feet, out0, out1) {
    const up = this.up;
    const r = this.radius;
    const top = this.height - r;
    out0.set(feet.x + up.x * r, feet.y + up.y * r, feet.z + up.z * r);
    out1.set(feet.x + up.x * top, feet.y + up.y * top, feet.z + up.z * top);
    if (top < r) out1.copy(out0);
  }

  /**
   * Writes the endpoints of the capsule's inner segment at the current position.
   * @param {Vec3} out0 Receives the lower sphere centre.
   * @param {Vec3} out1 Receives the upper sphere centre.
   * @returns {void}
   */
  getSegment(out0, out1) {
    this.getSegmentAt(this.position, out0, out1);
  }

  /**
   * Centre of the capsule in world space.
   * @param {Vec3} out Receives the centre.
   * @returns {Vec3} out
   */
  getCenter(out) {
    const h = this.height * 0.5;
    out.set(
      this.position.x + this.up.x * h,
      this.position.y + this.up.y * h,
      this.position.z + this.up.z * h
    );
    return out;
  }

  /**
   * Sets the walkable slope limit.
   * @param {number} degrees Slope limit in degrees.
   * @returns {CharacterController} this
   */
  setSlopeLimit(degrees) {
    this.slopeLimit = degrees;
    this._minGroundDot = Math.cos(degrees * DEG2RAD);
    return this;
  }

  /**
   * Changes the capsule height, keeping the feet in place.
   * @param {number} height New total height.
   * @returns {CharacterController} this
   */
  setHeight(height) {
    this.height = Math.max(height, this.radius * 2);
    return this;
  }

  /**
   * True when the surface normal is shallow enough to stand on.
   * @param {number} nx Normal x.
   * @param {number} ny Normal y.
   * @param {number} nz Normal z.
   * @returns {boolean} Walkability.
   */
  isWalkable(nx, ny, nz) {
    return nx * this.up.x + ny * this.up.y + nz * this.up.z >= this._minGroundDot;
  }

  /* ------------------------------------------------------------------ */
  /* Public actions                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Requests a jump. Ignored when the character is not grounded.
   * @param {number} speed Initial upward speed, in m/s.
   * @param {boolean} [force=false] Jump even when airborne.
   * @returns {boolean} True when the jump was accepted.
   */
  jump(speed, force = false) {
    if (this.isGrounded === false && force === false) return false;
    const up = this.up;
    const vv = this.velocity.dot(up);
    this.velocity.addScaled(up, speed - vv);
    this.isGrounded = false;
    this._jumped = true;
    return true;
  }

  /**
   * Crouches or stands up. Standing up is refused when the headroom is blocked.
   * @param {boolean} enable True to crouch.
   * @returns {boolean} True when the state changed.
   */
  crouch(enable) {
    if (enable === this.crouching) return false;
    if (enable === true) {
      this.crouching = true;
      this.height = Math.max(this.crouchHeight, this.radius * 2);
      return true;
    }
    if (this.canStandUp() === false) return false;
    this.crouching = false;
    this.height = this.standHeight;
    return true;
  }

  /**
   * Checks whether the character has enough headroom to stand up.
   * @returns {boolean} True when standing up is possible.
   */
  canStandUp() {
    const world = this.world;
    if (world === null || world === undefined) return true;
    const previous = this.height;
    this.height = this.standHeight;
    this.getSegment(this._p0, this._p1);
    const count = world.overlapCapsule(this._p0, this._p1, this.radius, this._contacts, this.mask);
    world.releaseContacts(this._contacts);
    this.height = previous;
    return count === 0;
  }

  /**
   * Teleports the character, clearing its velocity and ground state.
   * @param {Vec3} position New feet position.
   * @returns {CharacterController} this
   */
  teleport(position) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.isGrounded = false;
    this.onSteepSlope = false;
    this.groundCollider = null;
    return this;
  }

  /**
   * Copies the character position into a scene node.
   * @param {Object} [node] Target node; `this.node` when omitted.
   * @returns {CharacterController} this
   */
  syncNode(node) {
    const target = node !== undefined && node !== null ? node : this.node;
    if (target === null || target === undefined) return this;
    target.position.set(
      this.position.x + this.up.x * this.nodeOffset,
      this.position.y + this.up.y * this.nodeOffset,
      this.position.z + this.up.z * this.nodeOffset
    );
    target.matrixWorldNeedsUpdate = true;
    return this;
  }

  /**
   * Engine friendly entry point: moves with `desiredVelocity`.
   * @param {number} dt Frame time in seconds.
   * @returns {CharacterController} this
   */
  update(dt) {
    return this.move(this.desiredVelocity, dt);
  }

  /* ------------------------------------------------------------------ */
  /* Movement                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Main entry point. Moves the capsule by `desiredVelocity * dt`, resolving
   * every collision along the way.
   *
   * With `applyGravity` enabled (the default) only the horizontal part of
   * `desiredVelocity` is honoured; the vertical component is owned by the
   * controller (gravity + {@link CharacterController#jump}). With it disabled
   * the vector is used verbatim, which is what a flying or swimming character
   * wants.
   *
   * @param {Vec3} desiredVelocity Requested world velocity, in m/s.
   * @param {number} dt Frame time in seconds.
   * @returns {CharacterController} this
   */
  move(desiredVelocity, dt) {
    if (this.enabled === false || dt <= 0) return this;
    const world = this.world;
    if (world === null || world === undefined) {
      this.position.addScaled(desiredVelocity, dt);
      return this;
    }

    const up = this.up;
    const wasGrounded = this.isGrounded;

    this.hitCeiling = false;
    this.hitWall = false;
    this._steppedUp = false;
    this.wallNormal.set(0, 0, 0);
    this._start.copy(this.position);

    /* ---- velocity bookkeeping ---------------------------------------- */
    if (this.applyGravity === true) {
      let vv = this.velocity.dot(up);
      const dvUp = desiredVelocity.dot(up);

      // Horizontal target from the request.
      this._tmp.set(
        desiredVelocity.x - up.x * dvUp,
        desiredVelocity.y - up.y * dvUp,
        desiredVelocity.z - up.z * dvUp
      );

      // Sliding down a steep face: remove the uphill part and accelerate down.
      if (this.onSteepSlope === true && wasGrounded === false) {
        const n = this.steepNormal;
        const into = this._tmp.dot(n);
        if (into < 0) this._tmp.addScaled(n, -into);
        this._tmp2.set(-n.x, -n.y, -n.z);
        const d = this._tmp2.dot(up);
        this._tmp2.addScaled(up, -d);
        const len = this._tmp2.length();
        if (len > 1e-5) this._tmp.addScaled(this._tmp2, this.slideAcceleration * dt / len);
      }

      vv += this.gravity * dt;
      // While grounded the vertical velocity is fully owned by the ground: the
      // upward component a slide up a ramp leaves behind is an artifact of the
      // plane projection, and keeping it would launch the character off the
      // slope the moment it turns around ("ski jump").
      if (wasGrounded === true && this._jumped === false) vv = -this.groundStickSpeed;
      if (vv < -this.maxFallSpeed) vv = -this.maxFallSpeed;

      this.velocity.set(
        this._tmp.x + up.x * vv,
        this._tmp.y + up.y * vv,
        this._tmp.z + up.z * vv
      );
    } else {
      this.velocity.copy(desiredVelocity);
    }

    this._jumped = false;
    this.isGrounded = false;
    this.onSteepSlope = false;
    this.groundCollider = null;

    /* ---- 0. depenetration -------------------------------------------- */
    this._depenetrate();

    /* ---- split the displacement -------------------------------------- */
    const vUp = this.velocity.dot(up);
    const vertical = vUp * dt;
    this._disp.set(
      (this.velocity.x - up.x * vUp) * dt,
      (this.velocity.y - up.y * vUp) * dt,
      (this.velocity.z - up.z * vUp) * dt
    );

    /* ---- 1. up phase -------------------------------------------------- */
    if (vertical > MIN_MOVE) {
      const hit = this._moveAxis(up.x, up.y, up.z, vertical);
      if (hit !== null && hit.normal.dot(up) < -0.1) {
        this.hitCeiling = true;
        const vv = this.velocity.dot(up);
        if (vv > 0) this.velocity.addScaled(up, -vv);
      }
    }

    /* ---- 2. lateral phase (with a step-up retry) ---------------------- */
    const hx = this._disp.x, hy = this._disp.y, hz = this._disp.z;
    const reqLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (reqLen > MIN_MOVE) {
      this._tmp.copy(this.position);
      this._slideMove(hx, hy, hz, false);
      this._flatEnd.copy(this.position);
      const flatProgress = this._horizontalDistanceSq(this._tmp, this._flatEnd);

      if (this._blockedByWall === true && this.stepOffset > 0 && wasGrounded === true) {
        this._tryStepUp(hx, hy, hz, reqLen, flatProgress);
      }
    }

    /* ---- 3. down phase ------------------------------------------------ */
    if (vertical < -MIN_MOVE) {
      this._slideMove(up.x * vertical, up.y * vertical, up.z * vertical, true);
    }

    /* ---- 4. ground probe and snap ------------------------------------- */
    this._probeGround(wasGrounded);

    this.lastDisplacement.subVectors(this.position, this._start);
    if (this.node !== null) this.syncNode();
    return this;
  }

  /**
   * Step-up retry, run only when the lateral slide was stopped by a wall while
   * the character was grounded.
   *
   * The capsule is raised by `stepOffset`, pushed forward and dropped back
   * down. The forward probe travels at least one radius, because a per frame
   * displacement smaller than the capsule radius would leave the capsule
   * hanging on the convex edge of the step and the landing would be rejected as
   * "too steep". Once the landing is validated the horizontal advance is
   * clamped back to what the caller actually asked for, so mounting a step
   * never teleports the character forward.
   *
   * @private
   * @param {number} hx Requested displacement x.
   * @param {number} hy Requested displacement y.
   * @param {number} hz Requested displacement z.
   * @param {number} reqLen Length of the requested displacement.
   * @param {number} flatProgress Squared horizontal progress of the flat slide.
   * @returns {boolean} True when the stepped result was kept.
   */
  _tryStepUp(hx, hy, hz, reqLen, flatProgress) {
    const up = this.up;
    this.position.copy(this._tmp);

    const climbed = this._moveAxisDistance(up.x, up.y, up.z, this.stepOffset);
    if (climbed <= this.contactOffset) {
      this.position.copy(this._flatEnd);
      return false;
    }

    const minReach = this.radius + this.contactOffset * 2;
    const scale = reqLen >= minReach ? 1 : minReach / reqLen;
    this._slideMove(hx * scale, hy * scale, hz * scale, false);

    if (this._horizontalDistanceSq(this._tmp, this.position) <= flatProgress + 1e-9) {
      this.position.copy(this._flatEnd);
      return false;
    }

    const down = this._moveAxis(-up.x, -up.y, -up.z, climbed + this.contactOffset * 2);
    if (down === null || this.isWalkable(down.normal.x, down.normal.y, down.normal.z) === false) {
      this.position.copy(this._flatEnd);
      return false;
    }

    this.groundNormal.copy(down.normal);
    this.groundCollider = down.collider;
    this.isGrounded = true;
    this._steppedUp = true;

    // Clamp the horizontal advance back to the requested distance, keeping the
    // height we climbed to.
    this._tmp2.subVectors(this.position, this._tmp);
    const gain = this._tmp2.dot(up);
    let ax = this._tmp2.x - up.x * gain;
    let ay = this._tmp2.y - up.y * gain;
    let az = this._tmp2.z - up.z * gain;
    const advanced = Math.sqrt(ax * ax + ay * ay + az * az);
    if (advanced > reqLen && advanced > 1e-9) {
      const k = reqLen / advanced;
      ax *= k; ay *= k; az *= k;
      this._stepSave.copy(this.position);
      this.position.set(
        this._tmp.x + ax + up.x * gain,
        this._tmp.y + ay + up.y * gain,
        this._tmp.z + az + up.z * gain
      );
      // Reject the clamp when it would leave the capsule inside something.
      this.getSegment(this._p0, this._p1);
      const overlaps = this.world.overlapCapsule(this._p0, this._p1, this.radius, this._contacts, this.mask);
      this.world.releaseContacts(this._contacts);
      if (overlaps > 0) this.position.copy(this._stepSave);
    }
    return true;
  }

  /**
   * Squared distance between two points, ignoring the up axis.
   * @private
   * @param {Vec3} a First point.
   * @param {Vec3} b Second point.
   * @returns {number} Squared horizontal distance.
   */
  _horizontalDistanceSq(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = dx * this.up.x + dy * this.up.y + dz * this.up.z;
    const px = dx - this.up.x * d, py = dy - this.up.y * d, pz = dz - this.up.z * d;
    return px * px + py * py + pz * pz;
  }

  /**
   * Pushes the capsule out of anything it currently overlaps.
   * @private
   * @returns {void}
   */
  _depenetrate() {
    const world = this.world;
    const contacts = this._contacts;
    for (let pass = 0; pass < this.depenetrationIterations; pass++) {
      this.getSegment(this._p0, this._p1);
      const count = world.overlapCapsule(this._p0, this._p1, this.radius, contacts, this.mask);
      if (count === 0) {
        world.releaseContacts(contacts);
        return;
      }
      for (let i = 0; i < count; i++) {
        const c = contacts[i];
        const push = c.depth + this.contactOffset;
        if (push <= 0) continue;
        this.position.addScaled(c.normal, push);
        // Kill the velocity component that pushes back into the surface.
        const vn = this.velocity.dot(c.normal);
        if (vn < 0) this.velocity.addScaled(c.normal, -vn);
      }
      world.releaseContacts(contacts);
    }
  }

  /**
   * Sweeps the capsule along a fixed axis without sliding.
   * @private
   * @param {number} dx Axis x (unit length).
   * @param {number} dy Axis y.
   * @param {number} dz Axis z.
   * @param {number} distance Distance to travel.
   * @returns {Object|null} The blocking hit, or null when the move completed.
   */
  _moveAxis(dx, dy, dz, distance) {
    this._axisDistance = 0;
    if (distance <= MIN_MOVE) return null;
    this.getSegment(this._p0, this._p1);
    this._dir.set(dx, dy, dz);
    const hit = this.world.capsuleCast(
      this._p0, this._p1, this._dir, this.radius,
      distance + this.contactOffset, this._hit, this.mask);

    if (hit === null) {
      this.position.x += dx * distance;
      this.position.y += dy * distance;
      this.position.z += dz * distance;
      this._axisDistance = distance;
      return null;
    }

    let advance = hit.distance - this.contactOffset;
    if (advance < 0) advance = 0;
    if (advance > distance) advance = distance;
    this.position.x += dx * advance;
    this.position.y += dy * advance;
    this.position.z += dz * advance;
    this._axisDistance = advance;
    return hit;
  }

  /**
   * {@link CharacterController#_moveAxis} returning the travelled distance.
   * @private
   * @param {number} dx Axis x.
   * @param {number} dy Axis y.
   * @param {number} dz Axis z.
   * @param {number} distance Distance to travel.
   * @returns {number} Distance actually covered.
   */
  _moveAxisDistance(dx, dy, dz, distance) {
    this._moveAxis(dx, dy, dz, distance);
    return this._axisDistance;
  }

  /**
   * Collide-and-slide. The displacement is consumed over several sweeps, each
   * one projecting the remainder onto the plane it just hit. Two planes are
   * remembered so a corner produces a crease slide instead of a dead stop.
   *
   * @private
   * @param {number} dx Displacement x.
   * @param {number} dy Displacement y.
   * @param {number} dz Displacement z.
   * @param {boolean} allowVertical Keep the up component produced by a slide;
   *   false makes walls unclimbable (used for the lateral phase).
   * @returns {void}
   */
  _slideMove(dx, dy, dz, allowVertical) {
    this._blockedByWall = false;

    const world = this.world;
    const up = this.up;
    let planes = 0;
    let grazes = 0;
    let remainX = dx, remainY = dy, remainZ = dz;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const length = Math.sqrt(remainX * remainX + remainY * remainY + remainZ * remainZ);
      if (length <= MIN_MOVE) return;

      const inv = 1 / length;
      this._dir.set(remainX * inv, remainY * inv, remainZ * inv);
      this.getSegment(this._p0, this._p1);

      const hit = world.capsuleCast(
        this._p0, this._p1, this._dir, this.radius,
        length + this.contactOffset, this._hit, this.mask);

      if (hit === null) {
        this.position.x += remainX;
        this.position.y += remainY;
        this.position.z += remainZ;
        return;
      }

      const n = hit.normal;
      let advance = hit.distance - this.contactOffset;
      if (advance < 0) advance = 0;
      if (advance > length) advance = length;

      // A contact the motion does not actually push into (already touching a
      // wall while walking alongside it) must not consume the whole move: nudge
      // the capsule back to its skin distance and sweep again.
      if (advance <= 1e-9 && this._dir.dot(n) > -1e-4) {
        grazes++;
        if (grazes > 2) return;
        this.position.addScaled(n, this.contactOffset);
        continue;
      }

      this.position.x += this._dir.x * advance;
      this.position.y += this._dir.y * advance;
      this.position.z += this._dir.z * advance;

      const walkable = this.isWalkable(n.x, n.y, n.z);
      if (walkable === true) {
        this.isGrounded = true;
        this.groundNormal.copy(n);
        this.groundCollider = hit.collider;
      } else if (n.dot(up) < -0.1) {
        this.hitCeiling = true;
      } else {
        this._blockedByWall = true;
        this.hitWall = true;
        this.wallNormal.copy(n);
        // Only a surface that actually leans (not a vertical wall) counts as a
        // slope the character should slide down.
        if (n.dot(up) > 0.1) {
          this.onSteepSlope = true;
          this.steepNormal.copy(n);
        }
      }

      // Remaining motion, projected onto the plane just hit.
      const left = length - advance;
      remainX = this._dir.x * left;
      remainY = this._dir.y * left;
      remainZ = this._dir.z * left;
      let d = remainX * n.x + remainY * n.y + remainZ * n.z;
      remainX -= n.x * d;
      remainY -= n.y * d;
      remainZ -= n.z * d;

      // Never let a wall push the character upwards during the lateral phase.
      if (allowVertical === false && walkable === false) {
        const vUp = remainX * up.x + remainY * up.y + remainZ * up.z;
        if (vUp > 0) {
          remainX -= up.x * vUp;
          remainY -= up.y * vUp;
          remainZ -= up.z * vUp;
        }
      }

      // Kill the velocity that pushes into the surface.
      const vn = this.velocity.dot(n);
      if (vn < 0) this.velocity.addScaled(n, -vn);

      if (planes === 0) {
        this._plane1.copy(n);
        planes = 1;
      } else {
        // Corner: slide along the crease of the two planes instead of stopping.
        d = remainX * this._plane1.x + remainY * this._plane1.y + remainZ * this._plane1.z;
        if (d < 0) {
          this._plane2.copy(n);
          this._tmp2.crossVectors(this._plane1, this._plane2);
          const len = this._tmp2.length();
          if (len > 1e-6) {
            this._tmp2.multiplyScalar(1 / len);
            const along = remainX * this._tmp2.x + remainY * this._tmp2.y + remainZ * this._tmp2.z;
            remainX = this._tmp2.x * along;
            remainY = this._tmp2.y * along;
            remainZ = this._tmp2.z * along;
          } else {
            return;
          }
        }
        this._plane1.copy(n);
      }
    }
  }

  /**
   * Probes downwards to detect the floor and, when the character was already
   * grounded, snaps to it. The snap is what keeps a character glued to stairs
   * and ramps instead of taking off at every crest.
   * @private
   * @param {boolean} wasGrounded Ground state before the move.
   * @returns {void}
   */
  _probeGround(wasGrounded) {
    const up = this.up;
    const rising = this.velocity.dot(up) > 0.01;
    let probe = this.contactOffset * 3;
    // A character that has just been placed on a step by `_tryStepUp` must not
    // be snapped straight back down to whatever lies below it.
    if (wasGrounded === true && rising === false && this._steppedUp === false) {
      probe += this.groundSnapDistance;
    }

    this.getSegment(this._p0, this._p1);
    this._down.set(-up.x, -up.y, -up.z);
    let hit = this.world.capsuleCast(
      this._p0, this._p1, this._down, this.radius, probe, this._probeHit, this.mask);

    if (hit === null) return;

    let shrinkComp = 0;
    if (this.isWalkable(hit.normal.x, hit.normal.y, hit.normal.z) === false) {
      // The first thing found is the convex edge the character is walking off.
      // Retry with a thinner capsule so the edge falls out of reach and the real
      // floor below is seen; the reduced radius is compensated afterwards.
      const shrunk = this.radius * 0.5;
      const extra = this.radius - shrunk;
      hit = this.world.capsuleCast(
        this._p0, this._p1, this._down, shrunk, probe + extra * 2, this._probeHit, this.mask);
      if (hit === null) return;
      if (this.isWalkable(hit.normal.x, hit.normal.y, hit.normal.z) === false) {
        if (this.isGrounded === false && hit.normal.dot(up) > 0.1) {
          this.onSteepSlope = true;
          this.steepNormal.copy(hit.normal);
        }
        return;
      }
      const cosine = hit.normal.dot(up);
      shrinkComp = extra / (cosine > 0.2 ? cosine : 0.2);
    }

    // The probe travels along -up while the skin is measured along the surface
    // normal, so the vertical stop distance has to be divided by cos(slope).
    // Without it the capsule hovers 1/cos above a ramp instead of `contactOffset`.
    const nUp = hit.normal.dot(up);
    let advance = hit.distance - shrinkComp - this.contactOffset / (nUp > 0.2 ? nUp : 0.2);
    if (advance < 0) advance = 0;
    if (advance > probe) return;
    // Only snap downwards when we were already walking; a falling character
    // must be allowed to keep falling until it truly lands.
    if (rising === false && (wasGrounded === true || advance <= this.contactOffset * 2)) {
      this.position.addScaled(this._down, advance);
      this.isGrounded = true;
      this.groundNormal.copy(hit.normal);
      this.groundCollider = hit.collider;
      this.onSteepSlope = false;
      const vv = this.velocity.dot(up);
      if (vv < 0) this.velocity.addScaled(up, -vv);
    }
  }

  /**
   * Drops the references held by the controller.
   * @returns {void}
   */
  dispose() {
    if (this.world !== null && this.world !== undefined) this.world.releaseContacts(this._contacts);
    this._contacts.length = 0;
    this.world = null;
    this.node = null;
    this.groundCollider = null;
  }
}
