import { EPSILON } from './MathUtils.js';
import { Vec3 } from './Vec3.js';

// Module scoped scratch - never allocate on the hot path.
const _diff = new Vec3();
const _edge1 = new Vec3();
const _edge2 = new Vec3();
const _pvec = new Vec3();
const _qvec = new Vec3();
const _tvec = new Vec3();

/**
 * Ray defined by an origin and a (normally unit length) direction.
 * All intersection methods return the parametric distance `t` along the ray,
 * or -1 when there is no hit.
 */
export class Ray {
  /** @type {Vec3} */ origin;
  /** @type {Vec3} */ direction;

  /**
   * @param {Vec3} [origin] Defaults to the world origin.
   * @param {Vec3} [direction] Defaults to (0, 0, -1).
   */
  constructor(origin, direction) {
    this.origin = origin !== undefined ? origin.clone() : new Vec3(0, 0, 0);
    this.direction = direction !== undefined ? direction.clone() : new Vec3(0, 0, -1);
  }

  /**
   * @param {Vec3} origin
   * @param {Vec3} direction Should be normalized.
   * @returns {Ray}
   */
  set(origin, direction) {
    this.origin.copy(origin);
    this.direction.copy(direction);
    return this;
  }

  /**
   * Allocation free setter.
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz
   * @returns {Ray}
   */
  setValues(ox, oy, oz, dx, dy, dz) {
    this.origin.set(ox, oy, oz);
    this.direction.set(dx, dy, dz);
    return this;
  }

  /**
   * Point at parametric distance t.
   * @param {number} t
   * @param {Vec3} [out] Reused when given.
   * @returns {Vec3}
   */
  at(t, out) {
    const p = out !== undefined && out !== null ? out : new Vec3();
    p.x = this.origin.x + this.direction.x * t;
    p.y = this.origin.y + this.direction.y * t;
    p.z = this.origin.z + this.direction.z * t;
    return p;
  }

  /**
   * Points the ray towards a target position.
   * @param {Vec3} target
   * @returns {Ray}
   */
  lookAt(target) {
    this.direction.copy(target).sub(this.origin).normalize();
    return this;
  }

  /**
   * Moves the origin along the direction.
   * @param {number} t
   * @returns {Ray}
   */
  advance(t) {
    this.origin.addScaled(this.direction, t);
    return this;
  }

  /**
   * @param {Ray} r
   * @returns {Ray}
   */
  copy(r) {
    this.origin.copy(r.origin);
    this.direction.copy(r.direction);
    return this;
  }

  /** @returns {Ray} */
  clone() {
    return new Ray(this.origin, this.direction);
  }

  /**
   * Transforms the ray by a matrix (direction is renormalized).
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Ray}
   */
  applyMat4(m) {
    this.origin.applyMat4(m);
    this.direction.transformDirection(m);
    return this;
  }

  /**
   * Closest point of the ray (t >= 0) to p.
   * @param {Vec3} p
   * @param {Vec3} out
   * @returns {Vec3}
   */
  closestPointToPoint(p, out) {
    _diff.subVectors(p, this.origin);
    const t = _diff.dot(this.direction);
    if (t < 0) return out.copy(this.origin);
    out.copy(this.direction).multiplyScalar(t).add(this.origin);
    return out;
  }

  /**
   * Squared distance from the ray (t >= 0) to a point.
   * @param {Vec3} p
   * @returns {number}
   */
  distanceSqToPoint(p) {
    _diff.subVectors(p, this.origin);
    const t = _diff.dot(this.direction);
    if (t < 0) return this.origin.distanceToSq(p);
    // |diff|^2 - t^2 (valid for a unit direction)
    const dsq = _diff.lengthSq() - t * t;
    return dsq > 0 ? dsq : 0;
  }

  /**
   * Distance from the ray (t >= 0) to a point.
   * @param {Vec3} p
   * @returns {number}
   */
  distanceToPoint(p) {
    return Math.sqrt(this.distanceSqToPoint(p));
  }

  /**
   * Slab intersection against an axis aligned box. Divisions are computed
   * once per axis and zero direction components are handled explicitly.
   * @param {import('./AABB.js').AABB} aabb
   * @param {{x:number,y:number,z:number}} [out] Receives the hit point.
   * @returns {number} Entry distance (tmax when the origin is inside), or -1.
   */
  intersectAABB(aabb, out) {
    const o = this.origin, d = this.direction;
    const mn = aabb.min, mx = aabb.max;
    let tmin = -Infinity;
    let tmax = Infinity;

    if (d.x !== 0) {
      const inv = 1 / d.x;
      let t1 = (mn.x - o.x) * inv;
      let t2 = (mx.x - o.x) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    } else if (o.x < mn.x || o.x > mx.x) {
      return -1;
    }

    if (d.y !== 0) {
      const inv = 1 / d.y;
      let t1 = (mn.y - o.y) * inv;
      let t2 = (mx.y - o.y) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    } else if (o.y < mn.y || o.y > mx.y) {
      return -1;
    }

    if (d.z !== 0) {
      const inv = 1 / d.z;
      let t1 = (mn.z - o.z) * inv;
      let t2 = (mx.z - o.z) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    } else if (o.z < mn.z || o.z > mx.z) {
      return -1;
    }

    if (tmax < 0) return -1;
    const t = tmin >= 0 ? tmin : tmax;
    if (out !== undefined && out !== null) {
      out.x = o.x + d.x * t;
      out.y = o.y + d.y * t;
      out.z = o.z + d.z * t;
    }
    return t;
  }

  /**
   * Boolean version of {@link Ray#intersectAABB}.
   * @param {import('./AABB.js').AABB} aabb
   * @returns {boolean}
   */
  intersectsAABB(aabb) {
    return this.intersectAABB(aabb, null) !== -1;
  }

  /**
   * @param {import('./Sphere.js').Sphere} s
   * @param {{x:number,y:number,z:number}} [out] Receives the hit point.
   * @returns {number} Distance to the first hit, or -1.
   */
  intersectSphere(s, out) {
    _diff.subVectors(s.center, this.origin);
    const tca = _diff.dot(this.direction);
    const d2 = _diff.lengthSq() - tca * tca;
    const r2 = s.radius * s.radius;
    if (d2 > r2) return -1;

    const thc = Math.sqrt(r2 - d2);
    const t0 = tca - thc;
    const t1 = tca + thc;
    if (t1 < 0) return -1;

    const t = t0 < 0 ? t1 : t0;
    if (out !== undefined && out !== null) {
      out.x = this.origin.x + this.direction.x * t;
      out.y = this.origin.y + this.direction.y * t;
      out.z = this.origin.z + this.direction.z * t;
    }
    return t;
  }

  /**
   * @param {import('./Sphere.js').Sphere} s
   * @returns {boolean}
   */
  intersectsSphere(s) {
    return this.distanceSqToPoint(s.center) <= s.radius * s.radius;
  }

  /**
   * @param {import('./Plane.js').Plane} p
   * @returns {number} Distance to the plane, or -1 when parallel / behind.
   */
  intersectPlane(p) {
    const n = p.normal;
    const denom = n.x * this.direction.x + n.y * this.direction.y + n.z * this.direction.z;
    const dist = n.x * this.origin.x + n.y * this.origin.y + n.z * this.origin.z + p.constant;

    if (denom === 0) {
      // Parallel: only a hit when the origin lies on the plane.
      return dist === 0 ? 0 : -1;
    }

    const t = -dist / denom;
    return t >= 0 ? t : -1;
  }

  /**
   * @param {import('./Plane.js').Plane} p
   * @returns {boolean}
   */
  intersectsPlane(p) {
    const n = p.normal;
    const dist = n.x * this.origin.x + n.y * this.origin.y + n.z * this.origin.z + p.constant;
    if (dist === 0) return true;
    const denom = n.x * this.direction.x + n.y * this.direction.y + n.z * this.direction.z;
    return denom * dist < 0;
  }

  /**
   * Moller-Trumbore triangle intersection.
   * @param {Vec3} a
   * @param {Vec3} b
   * @param {Vec3} c
   * @param {boolean} [backfaceCulling=false] Ignores triangles facing away.
   * @param {{t?:number,u?:number,v?:number,x?:number,y?:number,z?:number}} [out]
   *   When given, receives `t`, the barycentrics `u`/`v` and the hit point `x`/`y`/`z`.
   * @returns {number} Distance to the hit, or -1.
   */
  intersectTriangle(a, b, c, backfaceCulling = false, out) {
    _edge1.subVectors(b, a);
    _edge2.subVectors(c, a);
    _pvec.crossVectors(this.direction, _edge2);

    const det = _edge1.dot(_pvec);
    let u, v, t;

    if (backfaceCulling) {
      if (det < EPSILON) return -1;

      _tvec.subVectors(this.origin, a);
      u = _tvec.dot(_pvec);
      if (u < 0 || u > det) return -1;

      _qvec.crossVectors(_tvec, _edge1);
      v = this.direction.dot(_qvec);
      if (v < 0 || u + v > det) return -1;

      t = _edge2.dot(_qvec);
      const invDet = 1 / det;
      t *= invDet;
      u *= invDet;
      v *= invDet;
    } else {
      if (det > -EPSILON && det < EPSILON) return -1;

      const invDet = 1 / det;
      _tvec.subVectors(this.origin, a);
      u = _tvec.dot(_pvec) * invDet;
      if (u < 0 || u > 1) return -1;

      _qvec.crossVectors(_tvec, _edge1);
      v = this.direction.dot(_qvec) * invDet;
      if (v < 0 || u + v > 1) return -1;

      t = _edge2.dot(_qvec) * invDet;
    }

    if (t < 0) return -1;

    if (out !== undefined && out !== null) {
      out.t = t;
      out.u = u;
      out.v = v;
      out.x = this.origin.x + this.direction.x * t;
      out.y = this.origin.y + this.direction.y * t;
      out.z = this.origin.z + this.direction.z * t;
    }
    return t;
  }

  /**
   * @param {Ray} r
   * @returns {boolean}
   */
  equals(r) {
    return this.origin.equals(r.origin) && this.direction.equals(r.direction);
  }
}
