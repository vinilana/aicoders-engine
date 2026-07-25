import { Vec3 } from './Vec3.js';

// Module scoped scratch - never allocate on the hot path.
const _v = new Vec3();

/**
 * Bounding sphere. A negative radius marks an "empty" sphere.
 */
export class Sphere {
  /** @type {Vec3} */ center;
  /** @type {number} */ radius;

  /**
   * @param {Vec3} [center] Defaults to the origin.
   * @param {number} [radius=-1] Negative means empty.
   */
  constructor(center, radius = -1) {
    this.center = center !== undefined ? center.clone() : new Vec3();
    this.radius = radius;
  }

  /**
   * @param {Vec3} center
   * @param {number} radius
   * @returns {Sphere}
   */
  set(center, radius) {
    this.center.copy(center);
    this.radius = radius;
    return this;
  }

  /**
   * Allocation free setter.
   * @param {number} x @param {number} y @param {number} z @param {number} radius
   * @returns {Sphere}
   */
  setValues(x, y, z, radius) {
    this.center.x = x;
    this.center.y = y;
    this.center.z = z;
    this.radius = radius;
    return this;
  }

  /**
   * Marks the sphere as empty.
   * @returns {Sphere}
   */
  makeEmpty() {
    this.center.set(0, 0, 0);
    this.radius = -1;
    return this;
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.radius < 0;
  }

  /**
   * Bounding sphere of a point cloud (average center, then max radius).
   * @param {Vec3[]} points
   * @param {Vec3} [optionalCenter]
   * @returns {Sphere}
   */
  setFromPoints(points, optionalCenter) {
    const n = points.length;
    if (n === 0) return this.makeEmpty();

    const c = this.center;
    if (optionalCenter !== undefined) {
      c.copy(optionalCenter);
    } else {
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < n; i++) {
        sx += points[i].x;
        sy += points[i].y;
        sz += points[i].z;
      }
      c.set(sx / n, sy / n, sz / n);
    }

    let maxSq = 0;
    for (let i = 0; i < n; i++) {
      const d = c.distanceToSq(points[i]);
      if (d > maxSq) maxSq = d;
    }
    this.radius = Math.sqrt(maxSq);
    return this;
  }

  /**
   * Bounding sphere of a flat position array.
   * @param {ArrayLike<number>} array
   * @param {number} [stride=3]
   * @param {number} [offset=0]
   * @returns {Sphere}
   */
  setFromArray(array, stride = 3, offset = 0) {
    const n = array.length;
    let count = 0;
    let sx = 0, sy = 0, sz = 0;
    for (let i = offset; i + 2 < n; i += stride) {
      sx += array[i];
      sy += array[i + 1];
      sz += array[i + 2];
      count++;
    }
    if (count === 0) return this.makeEmpty();

    const cx = sx / count, cy = sy / count, cz = sz / count;
    let maxSq = 0;
    for (let i = offset; i + 2 < n; i += stride) {
      const dx = array[i] - cx, dy = array[i + 1] - cy, dz = array[i + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxSq) maxSq = d;
    }
    this.center.set(cx, cy, cz);
    this.radius = Math.sqrt(maxSq);
    return this;
  }

  /**
   * Sphere circumscribing an AABB.
   * @param {import('./AABB.js').AABB} b
   * @returns {Sphere}
   */
  setFromAABB(b) {
    if (b.isEmpty()) return this.makeEmpty();
    this.center.x = (b.min.x + b.max.x) * 0.5;
    this.center.y = (b.min.y + b.max.y) * 0.5;
    this.center.z = (b.min.z + b.max.z) * 0.5;
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    this.radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    return this;
  }

  /**
   * Transforms the sphere (radius scaled by the largest axis scale).
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Sphere}
   */
  applyMat4(m) {
    this.center.applyMat4(m);
    this.radius *= m.getMaxScaleOnAxis();
    return this;
  }

  /**
   * this = source transformed by m (source is left untouched).
   * @param {Sphere} source
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Sphere}
   */
  copyTransformed(source, m) {
    return this.copy(source).applyMat4(m);
  }

  /**
   * Grows the sphere so it contains p.
   * @param {Vec3} p
   * @returns {Sphere}
   */
  expandByPoint(p) {
    if (this.isEmpty()) {
      this.center.copy(p);
      this.radius = 0;
      return this;
    }
    _v.subVectors(p, this.center);
    const lsq = _v.lengthSq();
    if (lsq > this.radius * this.radius) {
      const len = Math.sqrt(lsq);
      const delta = (len - this.radius) * 0.5;
      this.center.addScaled(_v, delta / len);
      this.radius += delta;
    }
    return this;
  }

  /**
   * Grows the sphere so it contains another sphere.
   * @param {Sphere} s
   * @returns {Sphere}
   */
  union(s) {
    if (s.isEmpty()) return this;
    if (this.isEmpty()) return this.copy(s);

    _v.subVectors(s.center, this.center);
    const dist = _v.length();
    if (dist + s.radius <= this.radius) return this;
    if (dist + this.radius <= s.radius) return this.copy(s);

    const newRadius = (this.radius + dist + s.radius) * 0.5;
    if (dist > 0) this.center.addScaled(_v, (newRadius - this.radius) / dist);
    this.radius = newRadius;
    return this;
  }

  /**
   * @param {Sphere} s
   * @returns {boolean}
   */
  intersectsSphere(s) {
    const r = this.radius + s.radius;
    return this.center.distanceToSq(s.center) <= r * r;
  }

  /**
   * @param {import('./AABB.js').AABB} b
   * @returns {boolean}
   */
  intersectsAABB(b) {
    const c = this.center;
    const x = c.x < b.min.x ? b.min.x : (c.x > b.max.x ? b.max.x : c.x);
    const y = c.y < b.min.y ? b.min.y : (c.y > b.max.y ? b.max.y : c.y);
    const z = c.z < b.min.z ? b.min.z : (c.z > b.max.z ? b.max.z : c.z);
    const dx = x - c.x, dy = y - c.y, dz = z - c.z;
    return (dx * dx + dy * dy + dz * dz) <= this.radius * this.radius;
  }

  /**
   * @param {import('./Plane.js').Plane} plane
   * @returns {boolean}
   */
  intersectsPlane(plane) {
    return Math.abs(plane.distanceToPoint(this.center)) <= this.radius;
  }

  /**
   * @param {Vec3} p
   * @returns {boolean}
   */
  containsPoint(p) {
    return this.center.distanceToSq(p) <= this.radius * this.radius;
  }

  /**
   * @param {Sphere} s
   * @returns {boolean}
   */
  containsSphere(s) {
    if (s.isEmpty()) return true;
    if (this.isEmpty()) return false;
    return this.center.distanceTo(s.center) + s.radius <= this.radius;
  }

  /**
   * Distance from the sphere surface to a point (negative when inside).
   * @param {Vec3} p
   * @returns {number}
   */
  distanceToPoint(p) {
    return this.center.distanceTo(p) - this.radius;
  }

  /**
   * Closest point of the sphere to p.
   * @param {Vec3} p
   * @param {Vec3} out
   * @returns {Vec3}
   */
  clampPoint(p, out) {
    const dSq = this.center.distanceToSq(p);
    out.copy(p);
    if (dSq > this.radius * this.radius) {
      out.sub(this.center).normalize().multiplyScalar(this.radius).add(this.center);
    }
    return out;
  }

  /**
   * @param {Vec3} offset
   * @returns {Sphere}
   */
  translate(offset) {
    this.center.add(offset);
    return this;
  }

  /**
   * @param {Sphere} s
   * @returns {Sphere}
   */
  copy(s) {
    this.center.copy(s.center);
    this.radius = s.radius;
    return this;
  }

  /** @returns {Sphere} */
  clone() {
    return new Sphere(this.center, this.radius);
  }

  /**
   * @param {Sphere} s
   * @returns {boolean}
   */
  equals(s) {
    return this.center.equals(s.center) && this.radius === s.radius;
  }
}
