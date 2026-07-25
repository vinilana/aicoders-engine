/**
 * @file RigidBody.js
 * Rigid body used by {@link CollisionWorld}.
 *
 * The integrator is semi-implicit (symplectic) Euler: forces update the
 * velocities first, the solver then corrects those velocities, and the
 * positions are integrated last. That ordering is what makes a stack of boxes
 * settle instead of jittering.
 *
 * KNOWN LIMITATIONS (this is game physics, not a research grade solver)
 * - The inertia tensor is diagonal in body space (sphere, box and capsule are
 *   all principal-axis aligned), so no product-of-inertia terms exist.
 * - Contacts are solved one at a time with sequential impulses. Deep stacks
 *   need more iterations and never converge exactly.
 * - Rotational friction (rolling / spinning resistance) is not modelled; a
 *   sphere on a slope keeps rolling forever unless `angularDamping` stops it.
 * - There is no continuous collision detection for rigid bodies: a small fast
 *   body can tunnel through thin geometry. Use `CharacterController` (which
 *   sweeps) or raise the world's substep count for those objects.
 */

import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat3 } from '../math/Mat3.js';
import { AABB } from '../math/AABB.js';

/** Body simulation modes. */
export const BodyType = Object.freeze({
  /** Moved by forces and impulses. */
  DYNAMIC: 'dynamic',
  /** Moved by the user, pushes dynamic bodies but is never pushed back. */
  KINEMATIC: 'kinematic',
  /** Never moves; infinite mass. */
  STATIC: 'static'
});

/** Supported collision shapes. */
export const BodyShape = Object.freeze({
  SPHERE: 'sphere',
  BOX: 'box',
  CAPSULE: 'capsule'
});

/** Module scoped scratch. */
const _v = new Vec3();
const _r = new Vec3();

/**
 * Dynamic body with mass, inertia and a primitive collision shape.
 */
export class RigidBody {
  /** @type {number} Monotonic id source. */
  static _nextId = 1;

  /**
   * @param {Object} [options] Configuration.
   * @param {number} [options.mass=1] Mass in kilograms; 0 makes the body static.
   * @param {string} [options.shape='sphere'] `'sphere'`, `'box'` or `'capsule'`.
   * @param {number} [options.radius=0.5] Sphere / capsule radius.
   * @param {number} [options.height=1] Capsule cylindrical section length.
   * @param {Vec3|{x:number,y:number,z:number}} [options.halfExtents] Box half size.
   * @param {Vec3} [options.position] Initial world position.
   * @param {Quat} [options.quaternion] Initial world orientation.
   * @param {Vec3} [options.velocity] Initial linear velocity.
   * @param {number} [options.restitution=0.2] Bounciness, 0..1.
   * @param {number} [options.friction=0.5] Coulomb friction coefficient.
   * @param {number} [options.linearDamping=0.01] Linear velocity decay rate.
   * @param {number} [options.angularDamping=0.05] Angular velocity decay rate.
   * @param {number} [options.gravityScale=1] Per body gravity multiplier.
   * @param {string} [options.type='dynamic'] See {@link BodyType}.
   * @param {boolean} [options.allowSleep=true] Let the body fall asleep.
   * @param {Object} [options.node] Node3D kept in sync by `syncNode()`.
   * @param {number} [options.layer=1] Collision layer bit.
   * @param {number} [options.mask=0xffffffff] Layers this body collides with.
   */
  constructor(options = {}) {
    /** @type {number} */
    this.id = RigidBody._nextId++;
    /** @type {string} */
    this.name = options.name !== undefined ? options.name : '';
    /** @type {boolean} True marker for duck typing. */
    this.isRigidBody = true;

    /** @type {string} See {@link BodyType}. */
    this.type = options.type !== undefined ? options.type : BodyType.DYNAMIC;
    /** @type {string} See {@link BodyShape}. */
    this.shape = options.shape !== undefined ? options.shape : BodyShape.SPHERE;

    /** @type {number} Sphere / capsule radius. */
    this.radius = options.radius !== undefined ? options.radius : 0.5;
    /** @type {number} Length of the capsule's cylindrical section. */
    this.height = options.height !== undefined ? options.height : 1;
    /** @type {Vec3} Box half extents. */
    this.halfExtents = new Vec3(0.5, 0.5, 0.5);
    if (options.halfExtents !== undefined && options.halfExtents !== null) {
      this.halfExtents.set(options.halfExtents.x, options.halfExtents.y, options.halfExtents.z);
    }

    /** @type {Vec3} World position of the centre of mass. */
    this.position = new Vec3();
    if (options.position !== undefined && options.position !== null) this.position.copy(options.position);
    /** @type {Quat} World orientation. */
    this.quaternion = new Quat();
    if (options.quaternion !== undefined && options.quaternion !== null) this.quaternion.copy(options.quaternion);

    /** @type {Vec3} Linear velocity, world space, m/s. */
    this.velocity = new Vec3();
    if (options.velocity !== undefined && options.velocity !== null) this.velocity.copy(options.velocity);
    /** @type {Vec3} Angular velocity, world space, rad/s. */
    this.angularVelocity = new Vec3();
    if (options.angularVelocity !== undefined && options.angularVelocity !== null) {
      this.angularVelocity.copy(options.angularVelocity);
    }

    /** @type {Vec3} Force accumulator, cleared by `integratePosition`. */
    this.force = new Vec3();
    /** @type {Vec3} Torque accumulator, cleared by `integratePosition`. */
    this.torque = new Vec3();

    /** @type {number} */
    this.mass = 1;
    /** @type {number} 1 / mass, 0 for static and kinematic bodies. */
    this.invMass = 0;
    /** @type {Vec3} Diagonal inertia tensor in body space. */
    this.inertia = new Vec3(1, 1, 1);
    /** @type {Vec3} Component wise inverse of `inertia`. */
    this.invInertia = new Vec3();
    /** @type {Mat3} R * diag(invInertia) * R^T, refreshed every step. */
    this.invInertiaWorld = new Mat3();

    /** @type {number} Bounciness, 0 (dead) .. 1 (elastic). */
    this.restitution = options.restitution !== undefined ? options.restitution : 0.2;
    /** @type {number} Coulomb friction coefficient. */
    this.friction = options.friction !== undefined ? options.friction : 0.5;
    /** @type {number} Linear damping rate (1 / seconds). */
    this.linearDamping = options.linearDamping !== undefined ? options.linearDamping : 0.01;
    /** @type {number} Angular damping rate (1 / seconds). */
    this.angularDamping = options.angularDamping !== undefined ? options.angularDamping : 0.05;
    /** @type {number} Per body gravity multiplier. */
    this.gravityScale = options.gravityScale !== undefined ? options.gravityScale : 1;
    /** @type {boolean} Locks the orientation (useful for characters and pickups). */
    this.fixedRotation = options.fixedRotation === true;

    /** @type {boolean} */
    this.allowSleep = options.allowSleep !== undefined ? options.allowSleep : true;
    /** @type {boolean} */
    this.sleeping = false;
    /** @type {number} Seconds spent below the sleep thresholds. */
    this.sleepTimer = 0;
    /** @type {number} m/s below which the body counts as still. */
    this.sleepLinearThreshold = options.sleepLinearThreshold !== undefined ? options.sleepLinearThreshold : 0.06;
    /** @type {number} rad/s below which the body counts as still. */
    this.sleepAngularThreshold = options.sleepAngularThreshold !== undefined ? options.sleepAngularThreshold : 0.12;
    /** @type {number} Seconds of stillness before falling asleep. */
    this.sleepDelay = options.sleepDelay !== undefined ? options.sleepDelay : 0.5;

    /** @type {boolean} Excluded from the simulation while false. */
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    /** @type {number} Collision layer bit. */
    this.layer = options.layer !== undefined ? options.layer : 1;
    /** @type {number} Layers this body collides with. */
    this.mask = options.mask !== undefined ? options.mask : 0xffffffff;

    /** @type {Object|null} Node3D whose transform mirrors this body. */
    this.node = options.node !== undefined ? options.node : null;
    /** @type {Object} Free-form user storage. */
    this.userData = {};

    /** @type {AABB} World bounds, refreshed by `updateAABB()`. */
    this.aabb = new AABB();
    /** @type {number} Broad phase proxy id inside the world, -1 when detached. */
    this.proxyId = -1;
    /** @type {Object|null} Owning CollisionWorld. */
    this.world = null;

    this.setMass(options.mass !== undefined ? options.mass : 1);
    this.updateInertiaWorld();
    this.updateAABB();
  }

  /* ------------------------------------------------------------------ */
  /* Mass properties                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Sets the mass and recomputes the inertia tensor for the current shape.
   * A mass of 0 (or a non dynamic type) yields an immovable body.
   * @param {number} mass Mass in kilograms.
   * @returns {RigidBody} this
   */
  setMass(mass) {
    this.mass = mass > 0 ? mass : 0;
    const movable = this.type === BodyType.DYNAMIC && this.mass > 0;
    this.invMass = movable ? 1 / this.mass : 0;
    this.computeInertia();
    return this;
  }

  /**
   * Recomputes `inertia` / `invInertia` from the shape and the current mass.
   * Called automatically by `setMass` and the shape setters.
   * @returns {RigidBody} this
   */
  computeInertia() {
    const m = this.mass;
    const movable = this.invMass > 0 && this.fixedRotation === false;

    if (m <= 0) {
      this.inertia.set(0, 0, 0);
      this.invInertia.set(0, 0, 0);
      return this;
    }

    if (this.shape === BodyShape.BOX) {
      const hx = this.halfExtents.x, hy = this.halfExtents.y, hz = this.halfExtents.z;
      const k = m / 3;
      this.inertia.set(
        k * (hy * hy + hz * hz),
        k * (hx * hx + hz * hz),
        k * (hx * hx + hy * hy)
      );
    } else if (this.shape === BodyShape.CAPSULE) {
      const r = this.radius;
      const h = this.height;
      const cylVolume = Math.PI * r * r * h;
      const capVolume = (4 / 3) * Math.PI * r * r * r;
      const total = cylVolume + capVolume;
      const mc = total > 0 ? m * (cylVolume / total) : m;
      const mh = total > 0 ? m * (capVolume / total) : 0;
      // Axis of symmetry is +Y.
      const iy = 0.5 * mc * r * r + 0.4 * mh * r * r;
      // Hemisphere transverse term: the 9r^2/64 of the parallel axis shift cancels.
      const ix = mc * (h * h / 12 + r * r / 4) + mh * (0.4 * r * r + 0.25 * h * h + 0.375 * h * r);
      this.inertia.set(ix, iy, ix);
    } else {
      const i = 0.4 * m * this.radius * this.radius;
      this.inertia.set(i, i, i);
    }

    if (movable === false) {
      this.invInertia.set(0, 0, 0);
    } else {
      this.invInertia.set(
        this.inertia.x > 0 ? 1 / this.inertia.x : 0,
        this.inertia.y > 0 ? 1 / this.inertia.y : 0,
        this.inertia.z > 0 ? 1 / this.inertia.z : 0
      );
    }
    return this;
  }

  /**
   * Rebuilds `invInertiaWorld` = R * diag(invInertia) * R^T.
   * The result is symmetric, so its storage order does not matter.
   * @returns {RigidBody} this
   */
  updateInertiaWorld() {
    const e = this.invInertiaWorld.elements;
    const ix = this.invInertia.x, iy = this.invInertia.y, iz = this.invInertia.z;

    if (ix === 0 && iy === 0 && iz === 0) {
      for (let i = 0; i < 9; i++) e[i] = 0;
      return this;
    }

    const q = this.quaternion;
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    // Rotation matrix rows.
    const r00 = 1 - (yy + zz), r01 = xy - wz, r02 = xz + wy;
    const r10 = xy + wz, r11 = 1 - (xx + zz), r12 = yz - wx;
    const r20 = xz - wy, r21 = yz + wx, r22 = 1 - (xx + yy);

    e[0] = r00 * ix * r00 + r01 * iy * r01 + r02 * iz * r02;
    e[1] = r00 * ix * r10 + r01 * iy * r11 + r02 * iz * r12;
    e[2] = r00 * ix * r20 + r01 * iy * r21 + r02 * iz * r22;
    e[3] = e[1];
    e[4] = r10 * ix * r10 + r11 * iy * r11 + r12 * iz * r12;
    e[5] = r10 * ix * r20 + r11 * iy * r21 + r12 * iz * r22;
    e[6] = e[2];
    e[7] = e[5];
    e[8] = r20 * ix * r20 + r21 * iy * r21 + r22 * iz * r22;
    return this;
  }

  /**
   * Switches the collision shape and refreshes the mass properties.
   * @param {string} shape See {@link BodyShape}.
   * @param {Object} [dims] `{radius, height, halfExtents}`.
   * @returns {RigidBody} this
   */
  setShape(shape, dims) {
    this.shape = shape;
    if (dims !== undefined && dims !== null) {
      if (dims.radius !== undefined) this.radius = dims.radius;
      if (dims.height !== undefined) this.height = dims.height;
      if (dims.halfExtents !== undefined && dims.halfExtents !== null) {
        this.halfExtents.set(dims.halfExtents.x, dims.halfExtents.y, dims.halfExtents.z);
      }
    }
    this.computeInertia();
    this.updateInertiaWorld();
    this.updateAABB();
    return this;
  }

  /**
   * Radius of the sphere that fully contains the shape, centred on the body.
   * @returns {number} Bounding radius.
   */
  getBoundingRadius() {
    if (this.shape === BodyShape.BOX) {
      const h = this.halfExtents;
      return Math.sqrt(h.x * h.x + h.y * h.y + h.z * h.z);
    }
    if (this.shape === BodyShape.CAPSULE) return this.radius + this.height * 0.5;
    return this.radius;
  }

  /**
   * Writes the world space endpoints of a capsule's inner segment. For a sphere
   * both endpoints collapse onto the centre; for a box the segment spans the
   * local Y axis of the box (used only by the broad phase).
   * @param {Vec3} out0 Receives the lower endpoint.
   * @param {Vec3} out1 Receives the upper endpoint.
   * @returns {void}
   */
  getWorldSegment(out0, out1) {
    if (this.shape !== BodyShape.CAPSULE) {
      out0.copy(this.position);
      out1.copy(this.position);
      return;
    }
    const half = this.height * 0.5;
    _v.set(0, half, 0).applyQuat(this.quaternion);
    out0.copy(this.position).sub(_v);
    out1.copy(this.position).add(_v);
  }

  /* ------------------------------------------------------------------ */
  /* Forces                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Accumulates a force (N) for the next integration step.
   * @param {Vec3} f Force in world space.
   * @param {Vec3} [worldPoint] Application point; the centre of mass when omitted.
   * @returns {RigidBody} this
   */
  applyForce(f, worldPoint) {
    if (this.invMass === 0) return this;
    this.force.add(f);
    if (worldPoint !== undefined && worldPoint !== null) {
      _r.subVectors(worldPoint, this.position);
      this.torque.x += _r.y * f.z - _r.z * f.y;
      this.torque.y += _r.z * f.x - _r.x * f.z;
      this.torque.z += _r.x * f.y - _r.y * f.x;
    }
    this.wake();
    return this;
  }

  /**
   * Accumulates a torque (N*m).
   * @param {Vec3} t Torque in world space.
   * @returns {RigidBody} this
   */
  applyTorque(t) {
    if (this.invMass === 0) return this;
    this.torque.add(t);
    this.wake();
    return this;
  }

  /**
   * Applies an instantaneous impulse (N*s): the velocity changes immediately.
   * @param {Vec3} j Impulse in world space.
   * @param {Vec3} [at] World space application point; the centre of mass when omitted.
   * @returns {RigidBody} this
   */
  applyImpulse(j, at) {
    if (this.invMass === 0) return this;
    this.velocity.addScaled(j, this.invMass);
    if (at !== undefined && at !== null) {
      _r.subVectors(at, this.position);
      const tx = _r.y * j.z - _r.z * j.y;
      const ty = _r.z * j.x - _r.x * j.z;
      const tz = _r.x * j.y - _r.y * j.x;
      const e = this.invInertiaWorld.elements;
      this.angularVelocity.x += e[0] * tx + e[1] * ty + e[2] * tz;
      this.angularVelocity.y += e[3] * tx + e[4] * ty + e[5] * tz;
      this.angularVelocity.z += e[6] * tx + e[7] * ty + e[8] * tz;
    }
    this.wake();
    return this;
  }

  /**
   * Applies an angular impulse (N*m*s).
   * @param {Vec3} t Angular impulse in world space.
   * @returns {RigidBody} this
   */
  applyTorqueImpulse(t) {
    if (this.invMass === 0) return this;
    const e = this.invInertiaWorld.elements;
    this.angularVelocity.x += e[0] * t.x + e[1] * t.y + e[2] * t.z;
    this.angularVelocity.y += e[3] * t.x + e[4] * t.y + e[5] * t.z;
    this.angularVelocity.z += e[6] * t.x + e[7] * t.y + e[8] * t.z;
    this.wake();
    return this;
  }

  /**
   * Velocity of a world space point rigidly attached to the body.
   * @param {Vec3} worldPoint Point in world space.
   * @param {Vec3} out Receives the velocity.
   * @returns {Vec3} out
   */
  getPointVelocity(worldPoint, out) {
    const rx = worldPoint.x - this.position.x;
    const ry = worldPoint.y - this.position.y;
    const rz = worldPoint.z - this.position.z;
    const w = this.angularVelocity;
    out.x = this.velocity.x + (w.y * rz - w.z * ry);
    out.y = this.velocity.y + (w.z * rx - w.x * rz);
    out.z = this.velocity.z + (w.x * ry - w.y * rx);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Integration                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Full semi-implicit Euler step (velocity then position). `CollisionWorld`
   * calls the two halves separately so the contact solver can run in between.
   * @param {number} dt Time step in seconds.
   * @param {Vec3} [gravity] World gravity; none is applied when omitted.
   * @returns {RigidBody} this
   */
  integrate(dt, gravity) {
    this.integrateVelocity(dt, gravity);
    this.integratePosition(dt);
    return this;
  }

  /**
   * First half of the step: applies gravity, the accumulated force / torque and
   * the damping, then clears the accumulators.
   *
   * Damping uses the unconditionally stable implicit form `v /= 1 + k * dt`,
   * which behaves like an exponential decay without ever flipping the sign at
   * large time steps.
   *
   * @param {number} dt Time step in seconds.
   * @param {Vec3} [gravity] World gravity.
   * @returns {RigidBody} this
   */
  integrateVelocity(dt, gravity) {
    if (this.invMass === 0 || this.sleeping === true || this.enabled === false) {
      this.force.set(0, 0, 0);
      this.torque.set(0, 0, 0);
      return this;
    }

    const im = this.invMass;
    const v = this.velocity;
    v.x += this.force.x * im * dt;
    v.y += this.force.y * im * dt;
    v.z += this.force.z * im * dt;

    if (gravity !== undefined && gravity !== null && this.gravityScale !== 0) {
      const g = this.gravityScale * dt;
      v.x += gravity.x * g;
      v.y += gravity.y * g;
      v.z += gravity.z * g;
    }

    if (this.fixedRotation === false) {
      const e = this.invInertiaWorld.elements;
      const tx = this.torque.x, ty = this.torque.y, tz = this.torque.z;
      const w = this.angularVelocity;
      w.x += (e[0] * tx + e[1] * ty + e[2] * tz) * dt;
      w.y += (e[3] * tx + e[4] * ty + e[5] * tz) * dt;
      w.z += (e[6] * tx + e[7] * ty + e[8] * tz) * dt;
    } else {
      this.angularVelocity.set(0, 0, 0);
    }

    if (this.linearDamping > 0) {
      const d = 1 / (1 + this.linearDamping * dt);
      v.x *= d; v.y *= d; v.z *= d;
    }
    if (this.angularDamping > 0 && this.fixedRotation === false) {
      const d = 1 / (1 + this.angularDamping * dt);
      const w = this.angularVelocity;
      w.x *= d; w.y *= d; w.z *= d;
    }

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    return this;
  }

  /**
   * Second half of the step: advances the transform with the solved velocities.
   * Kinematic bodies are advanced too, so scripted platforms keep moving.
   * @param {number} dt Time step in seconds.
   * @returns {RigidBody} this
   */
  integratePosition(dt) {
    if (this.enabled === false || this.sleeping === true) return this;
    if (this.type === BodyType.STATIC) return this;

    this.position.addScaled(this.velocity, dt);

    if (this.fixedRotation === false) {
      const w = this.angularVelocity;
      if (w.x !== 0 || w.y !== 0 || w.z !== 0) {
        const q = this.quaternion;
        const half = dt * 0.5;
        const dx = half * (w.x * q.w + w.y * q.z - w.z * q.y);
        const dy = half * (w.y * q.w + w.z * q.x - w.x * q.z);
        const dz = half * (w.z * q.w + w.x * q.y - w.y * q.x);
        const dw = half * (-w.x * q.x - w.y * q.y - w.z * q.z);
        q.x += dx; q.y += dy; q.z += dz; q.w += dw;
        q.normalize();
        this.updateInertiaWorld();
      }
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Bounds and sleeping                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuilds the world space AABB of the shape.
   * @returns {AABB} The refreshed bounds.
   */
  updateAABB() {
    const p = this.position;
    const box = this.aabb;

    if (this.shape === BodyShape.BOX) {
      const q = this.quaternion;
      const x = q.x, y = q.y, z = q.z, w = q.w;
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      const hx = this.halfExtents.x, hy = this.halfExtents.y, hz = this.halfExtents.z;
      // Projection of the OBB onto the world axes = |R| * halfExtents.
      const ex = Math.abs(1 - (yy + zz)) * hx + Math.abs(xy - wz) * hy + Math.abs(xz + wy) * hz;
      const ey = Math.abs(xy + wz) * hx + Math.abs(1 - (xx + zz)) * hy + Math.abs(yz - wx) * hz;
      const ez = Math.abs(xz - wy) * hx + Math.abs(yz + wx) * hy + Math.abs(1 - (xx + yy)) * hz;
      box.min.set(p.x - ex, p.y - ey, p.z - ez);
      box.max.set(p.x + ex, p.y + ey, p.z + ez);
      return box;
    }

    if (this.shape === BodyShape.CAPSULE) {
      const half = this.height * 0.5;
      _v.set(0, half, 0).applyQuat(this.quaternion);
      const r = this.radius;
      const ax = Math.abs(_v.x), ay = Math.abs(_v.y), az = Math.abs(_v.z);
      box.min.set(p.x - ax - r, p.y - ay - r, p.z - az - r);
      box.max.set(p.x + ax + r, p.y + ay + r, p.z + az + r);
      return box;
    }

    const r = this.radius;
    box.min.set(p.x - r, p.y - r, p.z - r);
    box.max.set(p.x + r, p.y + r, p.z + r);
    return box;
  }

  /**
   * Wakes the body up and restarts its sleep timer.
   * @returns {RigidBody} this
   */
  wake() {
    if (this.sleeping === true) this.sleeping = false;
    this.sleepTimer = 0;
    return this;
  }

  /**
   * Puts the body to sleep, zeroing its velocities.
   * @returns {RigidBody} this
   */
  sleep() {
    this.sleeping = true;
    this.sleepTimer = this.sleepDelay;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    return this;
  }

  /**
   * Advances the sleep timer and puts the body to sleep once it has been below
   * the motion thresholds for `sleepDelay` seconds.
   * @param {number} dt Time step in seconds.
   * @returns {boolean} True when the body is asleep after the update.
   */
  updateSleep(dt) {
    if (this.allowSleep === false || this.invMass === 0) {
      this.sleepTimer = 0;
      return false;
    }
    if (this.sleeping === true) return true;

    const lin = this.sleepLinearThreshold;
    const ang = this.sleepAngularThreshold;
    if (this.velocity.lengthSq() > lin * lin || this.angularVelocity.lengthSq() > ang * ang) {
      this.sleepTimer = 0;
      return false;
    }

    this.sleepTimer += dt;
    if (this.sleepTimer >= this.sleepDelay) {
      this.sleep();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Scene graph binding                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Copies the body transform into a scene node.
   * @param {Object} [node] Target node; `this.node` when omitted.
   * @returns {RigidBody} this
   */
  syncNode(node) {
    const target = node !== undefined && node !== null ? node : this.node;
    if (target === null || target === undefined) return this;
    target.position.copy(this.position);
    target.quaternion.copy(this.quaternion);
    target.matrixWorldNeedsUpdate = true;
    return this;
  }

  /**
   * Reads the transform back from a scene node (useful for kinematic bodies
   * driven by animation).
   * @param {Object} [node] Source node; `this.node` when omitted.
   * @returns {RigidBody} this
   */
  readNode(node) {
    const source = node !== undefined && node !== null ? node : this.node;
    if (source === null || source === undefined) return this;
    this.position.copy(source.position);
    this.quaternion.copy(source.quaternion);
    this.updateInertiaWorld();
    this.updateAABB();
    return this;
  }

  /**
   * Teleports the body, clearing the accumulated forces.
   * @param {Vec3} position New world position.
   * @param {Quat} [quaternion] New world orientation.
   * @returns {RigidBody} this
   */
  teleport(position, quaternion) {
    this.position.copy(position);
    if (quaternion !== undefined && quaternion !== null) this.quaternion.copy(quaternion);
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    this.updateInertiaWorld();
    this.updateAABB();
    this.wake();
    return this;
  }

  /**
   * Replaces the linear velocity.
   * @param {number} x Velocity x.
   * @param {number} y Velocity y.
   * @param {number} z Velocity z.
   * @returns {RigidBody} this
   */
  setVelocity(x, y, z) {
    this.velocity.set(x, y, z);
    this.wake();
    return this;
  }

  /**
   * Replaces the angular velocity.
   * @param {number} x Angular velocity x.
   * @param {number} y Angular velocity y.
   * @param {number} z Angular velocity z.
   * @returns {RigidBody} this
   */
  setAngularVelocity(x, y, z) {
    this.angularVelocity.set(x, y, z);
    this.wake();
    return this;
  }
}
