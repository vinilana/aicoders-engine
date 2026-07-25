import { Vec3 } from './Vec3.js';

// Module scoped scratch - never allocate on the hot path.
const _c = new Vec3();
const _e = new Vec3();

/**
 * Axis aligned bounding box defined by its min and max corners.
 * An "empty" box has min > max on at least one axis (see {@link AABB#makeEmpty}).
 */
export class AABB {
  /** @type {Vec3} */ min;
  /** @type {Vec3} */ max;

  /**
   * @param {Vec3} [min] Defaults to +Infinity (empty box).
   * @param {Vec3} [max] Defaults to -Infinity (empty box).
   */
  constructor(min, max) {
    this.min = min !== undefined ? min.clone() : new Vec3(Infinity, Infinity, Infinity);
    this.max = max !== undefined ? max.clone() : new Vec3(-Infinity, -Infinity, -Infinity);
  }

  /**
   * Resets to the "empty" state so points can be accumulated.
   * @returns {AABB}
   */
  makeEmpty() {
    this.min.x = this.min.y = this.min.z = Infinity;
    this.max.x = this.max.y = this.max.z = -Infinity;
    return this;
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }

  /**
   * @param {Vec3} min
   * @param {Vec3} max
   * @returns {AABB}
   */
  set(min, max) {
    this.min.copy(min);
    this.max.copy(max);
    return this;
  }

  /**
   * Allocation free setter used by the spatial structures.
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} maxX @param {number} maxY @param {number} maxZ
   * @returns {AABB}
   */
  setMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    this.min.x = minX; this.min.y = minY; this.min.z = minZ;
    this.max.x = maxX; this.max.y = maxY; this.max.z = maxZ;
    return this;
  }

  /**
   * @param {Vec3[]} points
   * @returns {AABB}
   */
  setFromPoints(points) {
    this.makeEmpty();
    for (let i = 0, n = points.length; i < n; i++) this.expandByPoint(points[i]);
    return this;
  }

  /**
   * Builds the box from a flat position array.
   * @param {ArrayLike<number>} array
   * @param {number} [stride=3] Components between consecutive positions.
   * @param {number} [offset=0] Index of the first X component.
   * @returns {AABB}
   */
  setFromArray(array, stride = 3, offset = 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = offset, n = array.length; i + 2 < n; i += stride) {
      const x = array[i], y = array[i + 1], z = array[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return this.setMinMax(minX, minY, minZ, maxX, maxY, maxZ);
  }

  /**
   * @param {Vec3} center
   * @param {Vec3} size Full size (not half extents).
   * @returns {AABB}
   */
  setFromCenterAndSize(center, size) {
    const hx = size.x * 0.5, hy = size.y * 0.5, hz = size.z * 0.5;
    return this.setMinMax(
      center.x - hx, center.y - hy, center.z - hz,
      center.x + hx, center.y + hy, center.z + hz
    );
  }

  /**
   * @param {Vec3} p
   * @returns {AABB}
   */
  expandByPoint(p) {
    if (p.x < this.min.x) this.min.x = p.x;
    if (p.y < this.min.y) this.min.y = p.y;
    if (p.z < this.min.z) this.min.z = p.z;
    if (p.x > this.max.x) this.max.x = p.x;
    if (p.y > this.max.y) this.max.y = p.y;
    if (p.z > this.max.z) this.max.z = p.z;
    return this;
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @returns {AABB}
   */
  expandByXYZ(x, y, z) {
    if (x < this.min.x) this.min.x = x;
    if (y < this.min.y) this.min.y = y;
    if (z < this.min.z) this.min.z = z;
    if (x > this.max.x) this.max.x = x;
    if (y > this.max.y) this.max.y = y;
    if (z > this.max.z) this.max.z = z;
    return this;
  }

  /**
   * @param {AABB} b
   * @returns {AABB}
   */
  expandByAABB(b) {
    if (b.isEmpty()) return this;
    if (b.min.x < this.min.x) this.min.x = b.min.x;
    if (b.min.y < this.min.y) this.min.y = b.min.y;
    if (b.min.z < this.min.z) this.min.z = b.min.z;
    if (b.max.x > this.max.x) this.max.x = b.max.x;
    if (b.max.y > this.max.y) this.max.y = b.max.y;
    if (b.max.z > this.max.z) this.max.z = b.max.z;
    return this;
  }

  /**
   * Grows (or shrinks, for negative values) the box on every axis.
   * @param {number} s
   * @returns {AABB}
   */
  expandByScalar(s) {
    this.min.x -= s; this.min.y -= s; this.min.z -= s;
    this.max.x += s; this.max.y += s; this.max.z += s;
    return this;
  }

  /**
   * Alias of {@link AABB#expandByAABB}.
   * @param {AABB} b
   * @returns {AABB}
   */
  union(b) {
    return this.expandByAABB(b);
  }

  /**
   * this = union(a, b)
   * @param {AABB} a
   * @param {AABB} b
   * @returns {AABB}
   */
  unionOf(a, b) {
    this.min.x = a.min.x < b.min.x ? a.min.x : b.min.x;
    this.min.y = a.min.y < b.min.y ? a.min.y : b.min.y;
    this.min.z = a.min.z < b.min.z ? a.min.z : b.min.z;
    this.max.x = a.max.x > b.max.x ? a.max.x : b.max.x;
    this.max.y = a.max.y > b.max.y ? a.max.y : b.max.y;
    this.max.z = a.max.z > b.max.z ? a.max.z : b.max.z;
    return this;
  }

  /**
   * Intersection of two boxes (may become empty).
   * @param {AABB} b
   * @returns {AABB}
   */
  intersection(b) {
    if (b.min.x > this.min.x) this.min.x = b.min.x;
    if (b.min.y > this.min.y) this.min.y = b.min.y;
    if (b.min.z > this.min.z) this.min.z = b.min.z;
    if (b.max.x < this.max.x) this.max.x = b.max.x;
    if (b.max.y < this.max.y) this.max.y = b.max.y;
    if (b.max.z < this.max.z) this.max.z = b.max.z;
    return this;
  }

  /**
   * Moves the box.
   * @param {Vec3} offset
   * @returns {AABB}
   */
  translate(offset) {
    this.min.add(offset);
    this.max.add(offset);
    return this;
  }

  /**
   * @param {Vec3} out
   * @returns {Vec3}
   */
  getCenter(out) {
    if (this.isEmpty()) return out.set(0, 0, 0);
    out.x = (this.min.x + this.max.x) * 0.5;
    out.y = (this.min.y + this.max.y) * 0.5;
    out.z = (this.min.z + this.max.z) * 0.5;
    return out;
  }

  /**
   * @param {Vec3} out
   * @returns {Vec3} Full size on each axis.
   */
  getSize(out) {
    if (this.isEmpty()) return out.set(0, 0, 0);
    out.x = this.max.x - this.min.x;
    out.y = this.max.y - this.min.y;
    out.z = this.max.z - this.min.z;
    return out;
  }

  /**
   * Writes one of the 8 corners (bit 0 = X, bit 1 = Y, bit 2 = Z).
   * @param {number} i 0..7
   * @param {Vec3} out
   * @returns {Vec3}
   */
  getCorner(i, out) {
    out.x = (i & 1) ? this.max.x : this.min.x;
    out.y = (i & 2) ? this.max.y : this.min.y;
    out.z = (i & 4) ? this.max.z : this.min.z;
    return out;
  }

  /**
   * Smallest sphere containing the box.
   * @param {import('./Sphere.js').Sphere} out
   * @returns {import('./Sphere.js').Sphere}
   */
  getBoundingSphere(out) {
    if (this.isEmpty()) {
      out.center.set(0, 0, 0);
      out.radius = -1;
      return out;
    }
    this.getCenter(out.center);
    const dx = this.max.x - this.min.x;
    const dy = this.max.y - this.min.y;
    const dz = this.max.z - this.min.z;
    out.radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    return out;
  }

  /**
   * Transforms the box by a matrix using Arvo's method: the center and the
   * extents are transformed independently (3 dot products + 3 abs dot
   * products) instead of the 8 corners.
   * @param {import('./Mat4.js').Mat4} m
   * @returns {AABB}
   */
  applyMat4(m) {
    if (this.isEmpty()) return this;
    const el = m.elements;

    const cx = (this.min.x + this.max.x) * 0.5;
    const cy = (this.min.y + this.max.y) * 0.5;
    const cz = (this.min.z + this.max.z) * 0.5;
    const ex = (this.max.x - this.min.x) * 0.5;
    const ey = (this.max.y - this.min.y) * 0.5;
    const ez = (this.max.z - this.min.z) * 0.5;

    const ncx = el[0] * cx + el[4] * cy + el[8] * cz + el[12];
    const ncy = el[1] * cx + el[5] * cy + el[9] * cz + el[13];
    const ncz = el[2] * cx + el[6] * cy + el[10] * cz + el[14];

    const nex = Math.abs(el[0]) * ex + Math.abs(el[4]) * ey + Math.abs(el[8]) * ez;
    const ney = Math.abs(el[1]) * ex + Math.abs(el[5]) * ey + Math.abs(el[9]) * ez;
    const nez = Math.abs(el[2]) * ex + Math.abs(el[6]) * ey + Math.abs(el[10]) * ez;

    this.min.x = ncx - nex; this.max.x = ncx + nex;
    this.min.y = ncy - ney; this.max.y = ncy + ney;
    this.min.z = ncz - nez; this.max.z = ncz + nez;
    return this;
  }

  /**
   * this = source transformed by m (source is left untouched).
   * @param {AABB} source
   * @param {import('./Mat4.js').Mat4} m
   * @returns {AABB}
   */
  copyTransformed(source, m) {
    return this.copy(source).applyMat4(m);
  }

  /**
   * @param {AABB} b
   * @returns {boolean}
   */
  intersectsAABB(b) {
    return !(
      b.max.x < this.min.x || b.min.x > this.max.x ||
      b.max.y < this.min.y || b.min.y > this.max.y ||
      b.max.z < this.min.z || b.min.z > this.max.z
    );
  }

  /**
   * Allocation free overlap test.
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} maxX @param {number} maxY @param {number} maxZ
   * @returns {boolean}
   */
  intersectsMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    return !(
      maxX < this.min.x || minX > this.max.x ||
      maxY < this.min.y || minY > this.max.y ||
      maxZ < this.min.z || minZ > this.max.z
    );
  }

  /**
   * @param {import('./Sphere.js').Sphere} s
   * @returns {boolean}
   */
  intersectsSphere(s) {
    const c = s.center;
    const x = c.x < this.min.x ? this.min.x : (c.x > this.max.x ? this.max.x : c.x);
    const y = c.y < this.min.y ? this.min.y : (c.y > this.max.y ? this.max.y : c.y);
    const z = c.z < this.min.z ? this.min.z : (c.z > this.max.z ? this.max.z : c.z);
    const dx = x - c.x, dy = y - c.y, dz = z - c.z;
    return (dx * dx + dy * dy + dz * dz) <= s.radius * s.radius;
  }

  /**
   * Slab test against a ray (no allocation, no division per slab).
   * @param {import('./Ray.js').Ray} ray
   * @param {number} [maxDist=Infinity]
   * @returns {boolean}
   */
  intersectsRay(ray, maxDist = Infinity) {
    const o = ray.origin, d = ray.direction;
    let tmin = 0;
    let tmax = maxDist;

    // X slab
    if (d.x !== 0) {
      const inv = 1 / d.x;
      let t1 = (this.min.x - o.x) * inv;
      let t2 = (this.max.x - o.x) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    } else if (o.x < this.min.x || o.x > this.max.x) {
      return false;
    }

    // Y slab
    if (d.y !== 0) {
      const inv = 1 / d.y;
      let t1 = (this.min.y - o.y) * inv;
      let t2 = (this.max.y - o.y) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    } else if (o.y < this.min.y || o.y > this.max.y) {
      return false;
    }

    // Z slab
    if (d.z !== 0) {
      const inv = 1 / d.z;
      let t1 = (this.min.z - o.z) * inv;
      let t2 = (this.max.z - o.z) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    } else if (o.z < this.min.z || o.z > this.max.z) {
      return false;
    }

    return true;
  }

  /**
   * @param {Vec3} p
   * @returns {boolean}
   */
  containsPoint(p) {
    return p.x >= this.min.x && p.x <= this.max.x &&
      p.y >= this.min.y && p.y <= this.max.y &&
      p.z >= this.min.z && p.z <= this.max.z;
  }

  /**
   * @param {AABB} b
   * @returns {boolean}
   */
  containsAABB(b) {
    return this.min.x <= b.min.x && b.max.x <= this.max.x &&
      this.min.y <= b.min.y && b.max.y <= this.max.y &&
      this.min.z <= b.min.z && b.max.z <= this.max.z;
  }

  /**
   * Closest point of the box to p.
   * @param {Vec3} p
   * @param {Vec3} out
   * @returns {Vec3}
   */
  clampPoint(p, out) {
    out.x = p.x < this.min.x ? this.min.x : (p.x > this.max.x ? this.max.x : p.x);
    out.y = p.y < this.min.y ? this.min.y : (p.y > this.max.y ? this.max.y : p.y);
    out.z = p.z < this.min.z ? this.min.z : (p.z > this.max.z ? this.max.z : p.z);
    return out;
  }

  /**
   * @param {Vec3} p
   * @returns {number} 0 when the point is inside.
   */
  distanceToPoint(p) {
    const dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x);
    const dy = Math.max(this.min.y - p.y, 0, p.y - this.max.y);
    const dz = Math.max(this.min.z - p.z, 0, p.z - this.max.z);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * @param {Vec3} p
   * @returns {number} Squared distance, 0 when inside.
   */
  distanceToPointSq(p) {
    const dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x);
    const dy = Math.max(this.min.y - p.y, 0, p.y - this.max.y);
    const dz = Math.max(this.min.z - p.z, 0, p.z - this.max.z);
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Surface area (SAH cost metric used by the BVH builders).
   * @returns {number}
   */
  surfaceArea() {
    if (this.isEmpty()) return 0;
    const dx = this.max.x - this.min.x;
    const dy = this.max.y - this.min.y;
    const dz = this.max.z - this.min.z;
    return 2 * (dx * dy + dy * dz + dz * dx);
  }

  /** @returns {number} */
  volume() {
    if (this.isEmpty()) return 0;
    return (this.max.x - this.min.x) * (this.max.y - this.min.y) * (this.max.z - this.min.z);
  }

  /**
   * @param {AABB} b
   * @returns {AABB}
   */
  copy(b) {
    this.min.copy(b.min);
    this.max.copy(b.max);
    return this;
  }

  /** @returns {AABB} */
  clone() {
    const b = new AABB();
    b.min.copy(this.min);
    b.max.copy(this.max);
    return b;
  }

  /**
   * @param {AABB} b
   * @returns {boolean}
   */
  equals(b) {
    return this.min.equals(b.min) && this.max.equals(b.max);
  }

  /**
   * Builds the box that contains a sphere.
   * @param {import('./Sphere.js').Sphere} s
   * @returns {AABB}
   */
  setFromSphere(s) {
    _c.copy(s.center);
    _e.setScalar(s.radius);
    this.min.subVectors(_c, _e);
    this.max.addVectors(_c, _e);
    return this;
  }
}
