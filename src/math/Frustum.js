import { Plane } from './Plane.js';

/**
 * View frustum stored as 6 planes whose normals point INWARDS, so a point is
 * inside when every `distanceToPoint` is >= 0.
 *
 * Plane order: 0 left, 1 right, 2 bottom, 3 top, 4 near, 5 far.
 */
export class Frustum {
  /** @type {Plane[]} */ planes;

  constructor() {
    this.planes = [
      new Plane(), new Plane(), new Plane(),
      new Plane(), new Plane(), new Plane()
    ];
  }

  /**
   * Extracts the 6 planes from a COLUMN MAJOR view-projection matrix using
   * the Gribb-Hartmann method, then normalizes them (so distances are real
   * world units, which the BVH and shadow code rely on).
   * @param {import('./Mat4.js').Mat4} m viewProjection matrix.
   * @returns {Frustum}
   */
  setFromProjectionMatrix(m) {
    const e = m.elements;
    // Rows of the matrix (column major storage).
    const r0x = e[0], r0y = e[4], r0z = e[8], r0w = e[12];
    const r1x = e[1], r1y = e[5], r1z = e[9], r1w = e[13];
    const r2x = e[2], r2y = e[6], r2z = e[10], r2w = e[14];
    const r3x = e[3], r3y = e[7], r3z = e[11], r3w = e[15];

    const p = this.planes;
    p[0].setComponents(r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w).normalize(); // left
    p[1].setComponents(r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w).normalize(); // right
    p[2].setComponents(r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w).normalize(); // bottom
    p[3].setComponents(r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w).normalize(); // top
    p[4].setComponents(r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w).normalize(); // near
    p[5].setComponents(r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w).normalize(); // far

    return this;
  }

  /**
   * @param {Frustum} f
   * @returns {Frustum}
   */
  copy(f) {
    for (let i = 0; i < 6; i++) this.planes[i].copy(f.planes[i]);
    return this;
  }

  /** @returns {Frustum} */
  clone() {
    return new Frustum().copy(this);
  }

  /**
   * @param {import('./Sphere.js').Sphere} sphere
   * @returns {boolean} False only when the sphere is fully outside.
   */
  intersectsSphere(sphere) {
    const c = sphere.center;
    const negRadius = -sphere.radius;
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const pl = p[i];
      const n = pl.normal;
      if (n.x * c.x + n.y * c.y + n.z * c.z + pl.constant < negRadius) return false;
    }
    return true;
  }

  /**
   * @param {import('./AABB.js').AABB} aabb
   * @returns {boolean} False only when the box is fully outside.
   */
  intersectsAABB(aabb) {
    const mn = aabb.min, mx = aabb.max;
    return this.intersectsAABBMinMax(mn.x, mn.y, mn.z, mx.x, mx.y, mx.z);
  }

  /**
   * Allocation free "positive vertex" test used by the BVH traversal.
   * For every plane only the box corner farthest along the plane normal is
   * evaluated; when it lies behind the plane the whole box is outside.
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} maxX @param {number} maxY @param {number} maxZ
   * @returns {boolean} False only when the box is fully outside.
   */
  intersectsAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const pl = p[i];
      const n = pl.normal;
      const nx = n.x, ny = n.y, nz = n.z;
      const px = nx > 0 ? maxX : minX;
      const py = ny > 0 ? maxY : minY;
      const pz = nz > 0 ? maxZ : minZ;
      if (nx * px + ny * py + nz * pz + pl.constant < 0) return false;
    }
    return true;
  }

  /**
   * Conservative "fully inside" test: true when the box needs no further
   * per-child culling (the BVH accepts whole subtrees with it).
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} maxX @param {number} maxY @param {number} maxZ
   * @returns {boolean}
   */
  containsAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const pl = p[i];
      const n = pl.normal;
      const nx = n.x, ny = n.y, nz = n.z;
      // Negative vertex: the corner nearest to the plane.
      const px = nx > 0 ? minX : maxX;
      const py = ny > 0 ? minY : maxY;
      const pz = nz > 0 ? minZ : maxZ;
      if (nx * px + ny * py + nz * pz + pl.constant < 0) return false;
    }
    return true;
  }

  /**
   * @param {import('./Vec3.js').Vec3} p
   * @returns {boolean}
   */
  containsPoint(p) {
    const pl = this.planes;
    for (let i = 0; i < 6; i++) {
      const plane = pl[i];
      const n = plane.normal;
      if (n.x * p.x + n.y * p.y + n.z * p.z + plane.constant < 0) return false;
    }
    return true;
  }

  /**
   * Sphere test that also reports full containment.
   * @param {import('./Sphere.js').Sphere} sphere
   * @returns {number} -1 outside, 0 intersecting, 1 fully inside.
   */
  classifySphere(sphere) {
    const c = sphere.center;
    const r = sphere.radius;
    const p = this.planes;
    let inside = 1;
    for (let i = 0; i < 6; i++) {
      const pl = p[i];
      const n = pl.normal;
      const d = n.x * c.x + n.y * c.y + n.z * c.z + pl.constant;
      if (d < -r) return -1;
      if (d < r) inside = 0;
    }
    return inside;
  }
}
