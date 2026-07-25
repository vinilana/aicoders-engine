/**
 * Fluid volumes: buoyancy, drag and currents.
 *
 * A volume is a box region with a surface plane on top. What makes an object
 * float is not a flag but Archimedes' principle applied for real: the upward
 * force equals the weight of the displaced fluid, so a body rises, sinks or sits
 * at equilibrium purely as a consequence of its density relative to the fluid's.
 * A crate of half the fluid's density settles with exactly half its volume under
 * the surface, without anyone scripting it.
 *
 * The submerged fraction is therefore the number everything depends on, and it
 * is computed smoothly (analytically for spheres, by integrating along the axis
 * for capsules). A stepped approximation would make floating objects jitter at
 * the waterline, which is the classic tell of a fake buoyancy implementation.
 *
 * Units are the engine's own: `density` is only ever compared against a body's
 * mass over its volume, so any consistent scale works.
 */

import { Vec3 } from '../math/Vec3.js';
import { AABB } from '../math/AABB.js';
import { clamp } from '../math/MathUtils.js';

const _v = new Vec3();
const _p0 = new Vec3();
const _p1 = new Vec3();

/** Samples taken along a capsule axis when integrating its submerged volume. */
const CAPSULE_SAMPLES = 12;

/**
 * A box of fluid with a wavy surface.
 */
export class WaterVolume {
  /**
   * @param {Object} [options]
   * @param {Vec3|{x:number,y:number,z:number}} [options.min] Lower corner.
   * @param {Vec3|{x:number,y:number,z:number}} [options.max] Upper corner; its
   *   `y` is the still water level unless `surfaceY` is given.
   * @param {number} [options.surfaceY] Explicit still water level.
   * @param {number} [options.density=1] Fluid density. A body whose mass over
   *   volume is below this floats, above it sinks, equal to it hangs neutral.
   * @param {number} [options.linearDrag=1.6] Velocity proportional drag.
   * @param {number} [options.quadraticDrag=0.9] Velocity squared drag.
   * @param {number} [options.angularDrag=2.2] Rotational drag.
   * @param {Vec3} [options.flow] Current velocity; bodies are dragged towards it.
   * @param {number} [options.waveAmplitude=0] Surface displacement amplitude.
   * @param {number} [options.waveLength=8] Distance between wave crests.
   * @param {number} [options.waveSpeed=1.1] Crest travel speed.
   */
  constructor(options = {}) {
    /** @type {boolean} Duck typing marker. */
    this.isWaterVolume = true;
    /** @type {string} */
    this.name = options.name !== undefined ? options.name : 'water';
    /** @type {boolean} */
    this.enabled = true;

    /** @type {AABB} Region occupied by the fluid. */
    this.aabb = new AABB();
    if (options.min !== undefined && options.max !== undefined) {
      this.aabb.min.set(options.min.x, options.min.y, options.min.z);
      this.aabb.max.set(options.max.x, options.max.y, options.max.z);
    }

    /** @type {number} Still water level. */
    this.surfaceY = options.surfaceY !== undefined ? options.surfaceY : this.aabb.max.y;

    /** @type {number} */
    this.density = options.density !== undefined ? options.density : 1;
    /** @type {number} */
    this.linearDrag = options.linearDrag !== undefined ? options.linearDrag : 1.6;
    /** @type {number} */
    this.quadraticDrag = options.quadraticDrag !== undefined ? options.quadraticDrag : 0.9;
    /** @type {number} */
    this.angularDrag = options.angularDrag !== undefined ? options.angularDrag : 2.2;

    /** @type {Vec3} Current velocity the fluid drags bodies towards. */
    this.flow = new Vec3();
    if (options.flow !== undefined) this.flow.set(options.flow.x, options.flow.y, options.flow.z);

    /** @type {number} */
    this.waveAmplitude = options.waveAmplitude !== undefined ? options.waveAmplitude : 0;
    /** @type {number} */
    this.waveLength = options.waveLength !== undefined ? options.waveLength : 8;
    /** @type {number} */
    this.waveSpeed = options.waveSpeed !== undefined ? options.waveSpeed : 1.1;

    /** @type {number} Seconds, advanced by the world; drives the waves. */
    this.time = 0;
  }

  /**
   * Builds a volume from a centre and size.
   * @param {number} cx
   * @param {number} cy Centre height; the surface ends up at `cy + sy / 2`.
   * @param {number} cz
   * @param {number} sx
   * @param {number} sy
   * @param {number} sz
   * @param {Object} [options]
   * @returns {WaterVolume}
   */
  static fromBox(cx, cy, cz, sx, sy, sz, options = {}) {
    const half = { x: sx * 0.5, y: sy * 0.5, z: sz * 0.5 };
    return new WaterVolume(Object.assign({}, options, {
      min: { x: cx - half.x, y: cy - half.y, z: cz - half.z },
      max: { x: cx + half.x, y: cy + half.y, z: cz + half.z },
    }));
  }

  /**
   * Surface height at a horizontal position. Matches the vertex displacement a
   * water shader should apply, so physics and rendering agree on where the
   * waterline is.
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  surfaceHeightAt(x, z) {
    if (this.waveAmplitude === 0) return this.surfaceY;
    const k = (Math.PI * 2) / (this.waveLength > 1e-4 ? this.waveLength : 1e-4);
    const t = this.time * this.waveSpeed;
    // Two crossed waves, so the surface is not a single marching ripple.
    return this.surfaceY
      + Math.sin(x * k + t) * this.waveAmplitude * 0.6
      + Math.sin((z * 0.83 + x * 0.31) * k - t * 0.85) * this.waveAmplitude * 0.4;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {boolean} true when the point is inside the fluid.
   */
  containsPoint(x, y, z) {
    const min = this.aabb.min;
    const max = this.aabb.max;
    if (x < min.x || x > max.x || z < min.z || z > max.z) return false;
    if (y < min.y) return false;
    return y <= this.surfaceHeightAt(x, z);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} depth below the surface, negative above it.
   */
  depthAt(x, y, z) {
    return this.surfaceHeightAt(x, z) - y;
  }

  /**
   * Fraction of a sphere below the surface.
   *
   * Exact, via the spherical cap volume — smooth all the way from just touching
   * the surface to fully submerged, which is what keeps a floating body from
   * buzzing at the waterline.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} radius
   * @returns {number} 0..1
   */
  sphereSubmergedFraction(cx, cy, cz, radius) {
    if (radius <= 0) return 0;
    const min = this.aabb.min;
    const max = this.aabb.max;
    // Cheap horizontal rejection first.
    if (cx + radius < min.x || cx - radius > max.x) return 0;
    if (cz + radius < min.z || cz - radius > max.z) return 0;
    if (cy - radius > this.surfaceHeightAt(cx, cz)) return 0;
    if (cy + radius < min.y) return 0;

    const surface = this.surfaceHeightAt(cx, cz);
    const h = clamp(surface - (cy - radius), 0, radius * 2);
    if (h <= 0) return 0;
    if (h >= radius * 2) return 1;
    // Spherical cap volume h^2 (3r - h) / 3, over the full sphere 4/3 r^3.
    return (h * h * (3 * radius - h)) / (4 * radius * radius * radius);
  }

  /**
   * Fraction of a capsule below the surface.
   *
   * Integrated along the axis as a series of spheres, so it stays smooth and
   * handles any orientation. A closed form exists only for capsules that are
   * exactly vertical or exactly horizontal, and a body that floats is rarely
   * either.
   *
   * @param {Vec3} p0 First segment endpoint.
   * @param {Vec3} p1 Second segment endpoint.
   * @param {number} radius
   * @returns {number} 0..1
   */
  capsuleSubmergedFraction(p0, p1, radius) {
    if (radius <= 0) return 0;

    let sum = 0;
    const n = CAPSULE_SAMPLES;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      const z = p0.z + (p1.z - p0.z) * t;
      sum += this.sphereSubmergedFraction(x, y, z, radius);
    }
    return sum / n;
  }

  /**
   * Fraction of an axis aligned box below the surface.
   *
   * For a rotated box this uses the world AABB, which overestimates near the
   * corners. Documented rather than hidden: crates in a pond read fine, a long
   * plank tilted 45 degrees will float slightly high.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} hx Half extent.
   * @param {number} hy
   * @param {number} hz
   * @returns {number} 0..1
   */
  boxSubmergedFraction(cx, cy, cz, hx, hy, hz) {
    const min = this.aabb.min;
    const max = this.aabb.max;
    if (cx + hx < min.x || cx - hx > max.x) return 0;
    if (cz + hz < min.z || cz - hz > max.z) return 0;
    if (cy + hy < min.y) return 0;

    const surface = this.surfaceHeightAt(cx, cz);
    const height = hy * 2;
    if (height <= 0) return 0;
    return clamp((surface - (cy - hy)) / height, 0, 1);
  }

  /**
   * Submerged fraction of a rigid body, dispatched on its shape.
   * @param {import('./RigidBody.js').RigidBody} body
   * @returns {number} 0..1
   */
  bodySubmergedFraction(body) {
    if (this.enabled === false) return 0;
    const p = body.position;

    if (body.shape === 'capsule') {
      body.getWorldSegment(_p0, _p1);
      return this.capsuleSubmergedFraction(_p0, _p1, body.radius);
    }
    if (body.shape === 'box') {
      const h = body.halfExtents;
      return this.boxSubmergedFraction(p.x, p.y, p.z, h.x, h.y, h.z);
    }
    return this.sphereSubmergedFraction(p.x, p.y, p.z, body.radius);
  }

  /**
   * Volume of a rigid body, used to turn its mass into a density.
   * @param {import('./RigidBody.js').RigidBody} body
   * @returns {number}
   */
  static bodyVolume(body) {
    const r = body.radius;
    if (body.shape === 'box') {
      const h = body.halfExtents;
      return 8 * h.x * h.y * h.z;
    }
    if (body.shape === 'capsule') {
      // Cylinder plus the two hemispherical caps.
      const cylinder = Math.PI * r * r * Math.max(0, body.height - r * 2);
      return cylinder + (4 / 3) * Math.PI * r * r * r;
    }
    return (4 / 3) * Math.PI * r * r * r;
  }

  /**
   * Applies buoyancy, drag and current to a body for one step.
   *
   * Forces rather than velocity assignments: that is what lets a crate bob,
   * overshoot and settle instead of snapping to the waterline, and it composes
   * correctly with gravity, contacts and any other force acting the same frame.
   *
   * @param {import('./RigidBody.js').RigidBody} body
   * @param {Vec3} gravity
   * @param {number} dt
   * @returns {number} the submerged fraction that was applied, 0..1
   */
  applyToBody(body, gravity, dt) {
    if (this.enabled === false || body.invMass === 0) return 0;

    const submerged = this.bodySubmergedFraction(body);
    if (submerged <= 0) return 0;

    const volume = WaterVolume.bodyVolume(body);
    const gMag = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z);

    // Archimedes: weight of the displaced fluid, opposing gravity.
    //
    // Written straight into the force accumulator rather than through
    // applyForce, which wakes the body. Buoyancy is present every single step,
    // so routing it through applyForce would keep every floating object awake
    // forever and sleep would never do anything for a pond full of crates.
    if (gMag > 1e-6) {
      const magnitude = this.density * volume * submerged * gMag;
      body.force.x -= gravity.x / gMag * magnitude;
      body.force.y -= gravity.y / gMag * magnitude;
      body.force.z -= gravity.z / gMag * magnitude;
    }

    // Drag, relative to the current so a river carries things along.
    const rvx = body.velocity.x - this.flow.x;
    const rvy = body.velocity.y - this.flow.y;
    const rvz = body.velocity.z - this.flow.z;
    const speed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);

    if (speed > 1e-5) {
      const area = Math.PI * body.radius * body.radius;
      const k = (this.linearDrag + this.quadraticDrag * speed) * submerged * area;
      body.force.x -= rvx * k;
      body.force.y -= rvy * k;
      body.force.z -= rvz * k;
    }

    // Rotational damping, applied as an exponential decay so it is stable at
    // any step size rather than exploding when dt grows.
    if (this.angularDrag > 0 && body.fixedRotation !== true) {
      const decay = Math.exp(-this.angularDrag * submerged * dt);
      body.angularVelocity.multiplyScalar(decay);
    }

    return submerged;
  }
}
