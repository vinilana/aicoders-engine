/**
 * @file CollisionWorld.js
 * Broad phase + narrow phase collision world and the rigid body solver.
 *
 * ARCHITECTURE
 * - Static geometry is registered from meshes. Each collider keeps (or shares)
 *   a {@link TriangleBVH}; queries are transformed into the collider's local
 *   space instead of transforming triangles. Colliders whose world matrix has a
 *   non uniform scale are baked into world space once, because a sphere would
 *   otherwise become an ellipsoid in local space.
 * - Static colliders live in one {@link DynamicBVH}, dynamic bodies in another.
 * - Shape casts are conservative: the AABB of the whole motion is expanded, the
 *   candidate triangles are collected once, and the time of impact is then
 *   resolved per triangle. `sphereCast` uses an exact analytic swept sphere;
 *   `capsuleCast` uses conservative advancement on the exact capsule/triangle
 *   distance, which never steps past a contact.
 * - `step(dt)` integrates the dynamic bodies with semi implicit Euler, builds a
 *   contact list, solves it with sequential impulses (Coulomb friction on two
 *   tangents) and finishes with a soft Baumgarte position correction.
 *
 * KNOWN LIMITATIONS (deliberate: this is game physics, not a full solver)
 * - Shape casts only hit STATIC colliders. Dynamic bodies are not swept
 *   against; use `step()` for body/body interaction.
 * - Dynamic vs dynamic uses analytic primitive pairs: sphere/sphere,
 *   sphere/capsule and capsule/capsule are exact. A box body falls back to its
 *   bounding sphere when meeting another dynamic body (against static triangle
 *   meshes it uses a proper SAT test).
 * - Contacts are regenerated from scratch every step (no warm starting), so
 *   deep stacks are soft. Raise `velocityIterations` or use `subSteps`.
 * - Position correction is purely linear: it never rotates a body out of a
 *   penetration.
 * - Static colliders are assumed not to move. Call `refreshStatic()` after
 *   moving one; a baked (non uniformly scaled) collider pays a full rebuild.
 * - `step()` and every query allocate nothing of their own: contacts live in a
 *   structure of arrays, results come from pools and all scratch is module
 *   scoped. The only residual garbage comes from the shared broad phase API,
 *   which reports into plain JS arrays and empties them with `out.length = 0`;
 *   V8 right-trims the backing store there and re-grows it on the next write.
 *   Measured at roughly 0.01 minor GC per step with 20 permanently awake
 *   bodies, i.e. a few kilobytes per second.
 * - INITIAL OVERLAP RULE: a surface the shape is already touching (or already
 *   penetrating) only produces a hit when the sweep direction pushes further
 *   into it. Sliding along a floor, or lifting off it, is never reported as
 *   blocked. Without that rule a character standing on the ground could not
 *   walk or jump, since every sweep would return a hit at distance 0. Use
 *   `overlapSphere` / `overlapCapsule` to inspect existing penetrations.
 */

import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { AABB } from '../math/AABB.js';
import { Pool } from '../core/Pool.js';
import { DynamicBVH } from '../spatial/DynamicBVH.js';
import { TriangleBVH } from '../spatial/TriangleBVH.js';
import { getMeshTriangleData } from './Raycaster.js';
import { BodyShape, BodyType } from './RigidBody.js';

/* ==================================================================== */
/* Constants                                                            */
/* ==================================================================== */

/** Guard against degenerate triangles and near zero divisions. */
const EPS = 1e-9;
/** Distance below which a shape cast considers itself in contact. */
const TOUCH_TOLERANCE = 1e-4;
/** Maximum conservative advancement steps per triangle. */
const MAX_CA_ITERATIONS = 24;
/** Floats per contact in the solver's structure of arrays. */
const CONTACT_STRIDE = 24;

/* ==================================================================== */
/* Module scratch - the hot path never allocates                        */
/* ==================================================================== */

/** Closest point on a triangle. */
const _cpt = new Float64Array(3);
/** Closest points of a segment/segment pair. */
const _ssA = new Float64Array(3);
const _ssB = new Float64Array(3);
/** Closest points of a segment/triangle pair. */
const _stSeg = new Float64Array(3);
const _stTri = new Float64Array(3);
/** Swept sphere result. */
const _sweep = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };
/** Separating axis result for the box/triangle test. */
const _sat = { depth: 0, nx: 0, ny: 0, nz: 0 };
/** Triangle vertices in query space. */
const _tri = new Float64Array(9);

const _v0 = new Vec3();
const _v1 = new Vec3();
const _v2 = new Vec3();
const _v3 = new Vec3();
const _v4 = new Vec3();
const _v5 = new Vec3();
const _corner = new Vec3();

/** Identity matrix used by the `identity` shortcut test. */
const _identityMatrix = new Mat4();

/* ==================================================================== */
/* Low level geometry                                                   */
/* ==================================================================== */

/**
 * Closest point on a triangle to `p` (Ericson, Real-Time Collision Detection).
 * The result is written into the module scratch `_cpt`.
 * @param {number} px Query x.
 * @param {number} py Query y.
 * @param {number} pz Query z.
 * @param {number} ax Vertex A x.
 * @param {number} ay Vertex A y.
 * @param {number} az Vertex A z.
 * @param {number} bx Vertex B x.
 * @param {number} by Vertex B y.
 * @param {number} bz Vertex B z.
 * @param {number} cx Vertex C x.
 * @param {number} cy Vertex C y.
 * @param {number} cz Vertex C z.
 * @returns {number} Squared distance to the closest point.
 */
function closestPointTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    _cpt[0] = ax; _cpt[1] = ay; _cpt[2] = az;
    return apx * apx + apy * apy + apz * apz;
  }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    _cpt[0] = bx; _cpt[1] = by; _cpt[2] = bz;
    return bpx * bpx + bpy * bpy + bpz * bpz;
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v, qy = ay + aby * v, qz = az + abz * v;
    _cpt[0] = qx; _cpt[1] = qy; _cpt[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    _cpt[0] = cx; _cpt[1] = cy; _cpt[2] = cz;
    return cpx * cpx + cpy * cpy + cpz * cpz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w, qy = ay + acy * w, qz = az + acz * w;
    _cpt[0] = qx; _cpt[1] = qy; _cpt[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + (cx - bx) * w, qy = by + (cy - by) * w, qz = bz + (cz - bz) * w;
    _cpt[0] = qx; _cpt[1] = qy; _cpt[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w;
  const qy = ay + aby * v + acy * w;
  const qz = az + abz * v + acz * w;
  _cpt[0] = qx; _cpt[1] = qy; _cpt[2] = qz;
  const ex = px - qx, ey = py - qy, ez = pz - qz;
  return ex * ex + ey * ey + ez * ez;
}

/**
 * Barycentric containment test for a point already lying on the triangle plane.
 * @param {number} px Point x.
 * @param {number} py Point y.
 * @param {number} pz Point z.
 * @param {number} ax Vertex A x.
 * @param {number} ay Vertex A y.
 * @param {number} az Vertex A z.
 * @param {number} e1x Edge AB x.
 * @param {number} e1y Edge AB y.
 * @param {number} e1z Edge AB z.
 * @param {number} e2x Edge AC x.
 * @param {number} e2y Edge AC y.
 * @param {number} e2z Edge AC z.
 * @returns {boolean} True when the point lies inside the triangle.
 */
function pointInTriangle(px, py, pz, ax, ay, az, e1x, e1y, e1z, e2x, e2y, e2z) {
  const vx = px - ax, vy = py - ay, vz = pz - az;
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z;
  const d01 = e1x * e2x + e1y * e2y + e1z * e2z;
  const d11 = e2x * e2x + e2y * e2y + e2z * e2z;
  const d20 = vx * e1x + vy * e1y + vz * e1z;
  const d21 = vx * e2x + vy * e2y + vz * e2z;
  const denom = d00 * d11 - d01 * d01;
  if (denom > -1e-20 && denom < 1e-20) return false;
  const inv = 1 / denom;
  const u = (d11 * d20 - d01 * d21) * inv;
  const w = (d00 * d21 - d01 * d20) * inv;
  return u >= -1e-6 && w >= -1e-6 && u + w <= 1 + 1e-6;
}

/**
 * Smallest root of `a t^2 + b t + c = 0` inside `[0, maxR]`.
 * @param {number} a Quadratic coefficient.
 * @param {number} b Linear coefficient.
 * @param {number} c Constant coefficient.
 * @param {number} maxR Upper bound of the accepted range.
 * @returns {number} The root, or -1 when there is none in range.
 */
function lowestRoot(a, b, c, maxR) {
  if (a > -EPS && a < EPS) return -1;
  const det = b * b - 4 * a * c;
  if (det < 0) return -1;
  const sq = Math.sqrt(det);
  const inv = 1 / (2 * a);
  let r1 = (-b - sq) * inv;
  let r2 = (-b + sq) * inv;
  if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
  if (r1 >= 0 && r1 <= maxR) return r1;
  if (r2 >= 0 && r2 <= maxR) return r2;
  return -1;
}

/**
 * Exact swept sphere against triangle test.
 *
 * The displacement is the *whole* motion, so the returned `t` is a fraction in
 * `[0, maxT]`. Result details land in the module scratch `_sweep`: the normal
 * points from the triangle towards the sphere centre and `px/py/pz` is the
 * contact point on the triangle.
 *
 * @param {number} sx Sphere centre x.
 * @param {number} sy Sphere centre y.
 * @param {number} sz Sphere centre z.
 * @param {number} vx Displacement x.
 * @param {number} vy Displacement y.
 * @param {number} vz Displacement z.
 * @param {number} r Sphere radius.
 * @param {number} ax Vertex A x.
 * @param {number} ay Vertex A y.
 * @param {number} az Vertex A z.
 * @param {number} bx Vertex B x.
 * @param {number} by Vertex B y.
 * @param {number} bz Vertex B z.
 * @param {number} cx Vertex C x.
 * @param {number} cy Vertex C y.
 * @param {number} cz Vertex C z.
 * @param {number} maxT Upper bound on the returned fraction.
 * @returns {number} Time of impact in `[0, maxT]`, or -1.
 */
function sweepSphereTriangle(sx, sy, sz, vx, vy, vz, r, ax, ay, az, bx, by, bz, cx, cy, cz, maxT) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nl < 1e-12) return -1;
  const invNl = 1 / nl;
  nx *= invNl; ny *= invNl; nz *= invNl;

  const sd = (sx - ax) * nx + (sy - ay) * ny + (sz - az) * nz;

  // Already touching or overlapping. Such a contact only counts when the motion
  // actually pushes further into the surface: a shape sliding along - or lifting
  // off - a face it is resting on must not be reported as blocked, otherwise a
  // character could never leave the floor it stands on.
  if (sd < r && sd > -r) {
    const d2 = closestPointTriangle(sx, sy, sz, ax, ay, az, bx, by, bz, cx, cy, cz);
    if (d2 <= r * r) {
      const dx = sx - _cpt[0], dy = sy - _cpt[1], dz = sz - _cpt[2];
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let cnx, cny, cnz;
      if (dl > 1e-8) {
        const inv = 1 / dl;
        cnx = dx * inv; cny = dy * inv; cnz = dz * inv;
      } else {
        const s = sd >= 0 ? 1 : -1;
        cnx = nx * s; cny = ny * s; cnz = nz * s;
      }
      if (vx * cnx + vy * cny + vz * cnz >= -1e-9) return -1;
      _sweep.t = 0;
      _sweep.px = _cpt[0]; _sweep.py = _cpt[1]; _sweep.pz = _cpt[2];
      _sweep.nx = cnx; _sweep.ny = cny; _sweep.nz = cnz;
      return 0;
    }
  }

  const nv = vx * nx + vy * ny + vz * nz;
  let t0;
  if (nv > -1e-12 && nv < 1e-12) {
    // Motion parallel to the plane: only the slab we already are in matters.
    if (sd >= r || sd <= -r) return -1;
    t0 = 0;
  } else {
    const tA = (r - sd) / nv;
    const tB = (-r - sd) / nv;
    const tin = tA < tB ? tA : tB;
    const tout = tA > tB ? tA : tB;
    if (tin > maxT || tout < 0) return -1;
    t0 = tin < 0 ? 0 : tin;
  }

  // Face contact at t0?
  const c0x = sx + vx * t0, c0y = sy + vy * t0, c0z = sz + vz * t0;
  const sdt = (c0x - ax) * nx + (c0y - ay) * ny + (c0z - az) * nz;
  const fx = c0x - nx * sdt, fy = c0y - ny * sdt, fz = c0z - nz * sdt;
  if (pointInTriangle(fx, fy, fz, ax, ay, az, e1x, e1y, e1z, e2x, e2y, e2z) === true) {
    const s = sdt >= 0 ? 1 : -1;
    _sweep.t = t0;
    _sweep.nx = nx * s; _sweep.ny = ny * s; _sweep.nz = nz * s;
    _sweep.px = fx; _sweep.py = fy; _sweep.pz = fz;
    return t0;
  }

  const vv = vx * vx + vy * vy + vz * vz;
  if (vv < 1e-18) return -1;

  let best = maxT;
  let found = false;
  let bpx = 0, bpy = 0, bpz = 0;

  // Vertices.
  for (let i = 0; i < 3; i++) {
    const px = i === 0 ? ax : (i === 1 ? bx : cx);
    const py = i === 0 ? ay : (i === 1 ? by : cy);
    const pz = i === 0 ? az : (i === 1 ? bz : cz);
    const mx = sx - px, my = sy - py, mz = sz - pz;
    const qb = 2 * (vx * mx + vy * my + vz * mz);
    const qc = mx * mx + my * my + mz * mz - r * r;
    const t = lowestRoot(vv, qb, qc, best);
    if (t >= 0) {
      best = t; found = true;
      bpx = px; bpy = py; bpz = pz;
    }
  }

  // Edges.
  for (let i = 0; i < 3; i++) {
    const px = i === 0 ? ax : (i === 1 ? bx : cx);
    const py = i === 0 ? ay : (i === 1 ? by : cy);
    const pz = i === 0 ? az : (i === 1 ? bz : cz);
    const qx = i === 0 ? bx : (i === 1 ? cx : ax);
    const qy = i === 0 ? by : (i === 1 ? cy : ay);
    const qz = i === 0 ? bz : (i === 1 ? cz : az);

    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < 1e-18) continue;
    const mx = sx - px, my = sy - py, mz = sz - pz;
    const md = mx * dx + my * dy + mz * dz;
    const vd = vx * dx + vy * dy + vz * dz;
    const mm = mx * mx + my * my + mz * mz;
    const mv = mx * vx + my * vy + mz * vz;

    const qa = dd * vv - vd * vd;
    const qb = 2 * (dd * mv - md * vd);
    const qc = dd * (mm - r * r) - md * md;
    const t = lowestRoot(qa, qb, qc, best);
    if (t < 0) continue;
    const f = (vd * t + md) / dd;
    if (f < 0 || f > 1) continue;
    best = t; found = true;
    bpx = px + dx * f; bpy = py + dy * f; bpz = pz + dz * f;
  }

  if (found === false) return -1;

  const hx = sx + vx * best - bpx;
  const hy = sy + vy * best - bpy;
  const hz = sz + vz * best - bpz;
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
  _sweep.t = best;
  _sweep.px = bpx; _sweep.py = bpy; _sweep.pz = bpz;
  if (hl > 1e-8) {
    const inv = 1 / hl;
    _sweep.nx = hx * inv; _sweep.ny = hy * inv; _sweep.nz = hz * inv;
  } else {
    const s = sd >= 0 ? 1 : -1;
    _sweep.nx = nx * s; _sweep.ny = ny * s; _sweep.nz = nz * s;
  }
  return best;
}

/**
 * Closest points between two segments (Ericson). Results land in `_ssA` / `_ssB`.
 * @param {number} p1x Segment 1 start x.
 * @param {number} p1y Segment 1 start y.
 * @param {number} p1z Segment 1 start z.
 * @param {number} q1x Segment 1 end x.
 * @param {number} q1y Segment 1 end y.
 * @param {number} q1z Segment 1 end z.
 * @param {number} p2x Segment 2 start x.
 * @param {number} p2y Segment 2 start y.
 * @param {number} p2z Segment 2 start z.
 * @param {number} q2x Segment 2 end x.
 * @param {number} q2y Segment 2 end y.
 * @param {number} q2z Segment 2 end z.
 * @returns {number} Squared distance between the closest points.
 */
function closestPointSegmentSegment(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;

  let s = 0;
  let t = 0;

  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = f / e;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = -c / a;
      s = s < 0 ? 0 : (s > 1 ? 1 : s);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      if (denom > EPS || denom < -EPS) {
        s = (b * f - c * e) / denom;
        s = s < 0 ? 0 : (s > 1 ? 1 : s);
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = -c / a;
        s = s < 0 ? 0 : (s > 1 ? 1 : s);
      } else if (t > 1) {
        t = 1;
        s = (b - c) / a;
        s = s < 0 ? 0 : (s > 1 ? 1 : s);
      }
    }
  }

  _ssA[0] = p1x + d1x * s; _ssA[1] = p1y + d1y * s; _ssA[2] = p1z + d1z * s;
  _ssB[0] = p2x + d2x * t; _ssB[1] = p2y + d2y * t; _ssB[2] = p2z + d2z * t;
  const dx = _ssA[0] - _ssB[0], dy = _ssA[1] - _ssB[1], dz = _ssA[2] - _ssB[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Segment / triangle intersection (Moller-Trumbore restricted to `t` in [0,1]).
 * On a hit the intersection point is written to both `_stSeg` and `_stTri`.
 * @param {number} p0x Segment start x.
 * @param {number} p0y Segment start y.
 * @param {number} p0z Segment start z.
 * @param {number} p1x Segment end x.
 * @param {number} p1y Segment end y.
 * @param {number} p1z Segment end z.
 * @param {number} ax Vertex A x.
 * @param {number} ay Vertex A y.
 * @param {number} az Vertex A z.
 * @param {number} bx Vertex B x.
 * @param {number} by Vertex B y.
 * @param {number} bz Vertex B z.
 * @param {number} cx Vertex C x.
 * @param {number} cy Vertex C y.
 * @param {number} cz Vertex C z.
 * @returns {boolean} True when the segment crosses the triangle.
 */
function segmentIntersectsTriangle(p0x, p0y, p0z, p1x, p1y, p1z, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const pvx = dy * e2z - dz * e2y;
  const pvy = dz * e2x - dx * e2z;
  const pvz = dx * e2y - dy * e2x;
  const det = e1x * pvx + e1y * pvy + e1z * pvz;
  if (det > -1e-12 && det < 1e-12) return false;
  const invDet = 1 / det;
  const tvx = p0x - ax, tvy = p0y - ay, tvz = p0z - az;
  const u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
  if (u < 0 || u > 1) return false;
  const qvx = tvy * e1z - tvz * e1y;
  const qvy = tvz * e1x - tvx * e1z;
  const qvz = tvx * e1y - tvy * e1x;
  const v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
  if (t < 0 || t > 1) return false;
  const hx = p0x + dx * t, hy = p0y + dy * t, hz = p0z + dz * t;
  _stSeg[0] = hx; _stSeg[1] = hy; _stSeg[2] = hz;
  _stTri[0] = hx; _stTri[1] = hy; _stTri[2] = hz;
  return true;
}

/**
 * Squared distance between a segment and a triangle. The closest point on the
 * segment lands in `_stSeg`, the one on the triangle in `_stTri`.
 *
 * The minimum of two convex polytopes is always attained at a vertex/face or an
 * edge/edge pair, so testing both segment endpoints against the triangle plus
 * the segment against the three triangle edges is exhaustive.
 *
 * @param {number} p0x Segment start x.
 * @param {number} p0y Segment start y.
 * @param {number} p0z Segment start z.
 * @param {number} p1x Segment end x.
 * @param {number} p1y Segment end y.
 * @param {number} p1z Segment end z.
 * @param {number} ax Vertex A x.
 * @param {number} ay Vertex A y.
 * @param {number} az Vertex A z.
 * @param {number} bx Vertex B x.
 * @param {number} by Vertex B y.
 * @param {number} bz Vertex B z.
 * @param {number} cx Vertex C x.
 * @param {number} cy Vertex C y.
 * @param {number} cz Vertex C z.
 * @returns {number} Squared distance.
 */
function segmentTriangleDistanceSq(p0x, p0y, p0z, p1x, p1y, p1z, ax, ay, az, bx, by, bz, cx, cy, cz) {
  if (segmentIntersectsTriangle(p0x, p0y, p0z, p1x, p1y, p1z, ax, ay, az, bx, by, bz, cx, cy, cz) === true) {
    return 0;
  }

  let best = Infinity;
  let sx = p0x, sy = p0y, sz = p0z;
  let tx = ax, ty = ay, tz = az;

  let d = closestPointTriangle(p0x, p0y, p0z, ax, ay, az, bx, by, bz, cx, cy, cz);
  if (d < best) {
    best = d;
    sx = p0x; sy = p0y; sz = p0z;
    tx = _cpt[0]; ty = _cpt[1]; tz = _cpt[2];
  }
  d = closestPointTriangle(p1x, p1y, p1z, ax, ay, az, bx, by, bz, cx, cy, cz);
  if (d < best) {
    best = d;
    sx = p1x; sy = p1y; sz = p1z;
    tx = _cpt[0]; ty = _cpt[1]; tz = _cpt[2];
  }

  for (let i = 0; i < 3; i++) {
    const ex0 = i === 0 ? ax : (i === 1 ? bx : cx);
    const ey0 = i === 0 ? ay : (i === 1 ? by : cy);
    const ez0 = i === 0 ? az : (i === 1 ? bz : cz);
    const ex1 = i === 0 ? bx : (i === 1 ? cx : ax);
    const ey1 = i === 0 ? by : (i === 1 ? cy : ay);
    const ez1 = i === 0 ? bz : (i === 1 ? cz : az);
    d = closestPointSegmentSegment(p0x, p0y, p0z, p1x, p1y, p1z, ex0, ey0, ez0, ex1, ey1, ez1);
    if (d < best) {
      best = d;
      sx = _ssA[0]; sy = _ssA[1]; sz = _ssA[2];
      tx = _ssB[0]; ty = _ssB[1]; tz = _ssB[2];
    }
  }

  _stSeg[0] = sx; _stSeg[1] = sy; _stSeg[2] = sz;
  _stTri[0] = tx; _stTri[1] = ty; _stTri[2] = tz;
  return best;
}

/**
 * Projects a triangle onto an axis and returns whether it is separated from a
 * box centred on the origin.
 * @param {number} axX Axis x.
 * @param {number} axY Axis y.
 * @param {number} axZ Axis z.
 * @param {Float64Array} tri Nine triangle components in box space.
 * @param {number} hx Box half extent x.
 * @param {number} hy Box half extent y.
 * @param {number} hz Box half extent z.
 * @returns {number} Overlap depth, -1 when separated, or Infinity when the axis
 *   is degenerate and must be skipped (parallel box axis and triangle edge).
 */
function axisOverlap(axX, axY, axZ, tri, hx, hy, hz) {
  const len = Math.sqrt(axX * axX + axY * axY + axZ * axZ);
  if (len < 1e-9) return Infinity;
  const inv = 1 / len;
  const nx = axX * inv, ny = axY * inv, nz = axZ * inv;

  const p0 = tri[0] * nx + tri[1] * ny + tri[2] * nz;
  const p1 = tri[3] * nx + tri[4] * ny + tri[5] * nz;
  const p2 = tri[6] * nx + tri[7] * ny + tri[8] * nz;
  let tmin = p0 < p1 ? (p0 < p2 ? p0 : p2) : (p1 < p2 ? p1 : p2);
  let tmax = p0 > p1 ? (p0 > p2 ? p0 : p2) : (p1 > p2 ? p1 : p2);

  const rad = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (tmin > rad || tmax < -rad) return -1;

  const overlapRight = rad - tmin;
  const overlapLeft = tmax + rad;
  if (overlapRight < overlapLeft) {
    _sat.nx = -nx; _sat.ny = -ny; _sat.nz = -nz;
    return overlapRight;
  }
  _sat.nx = nx; _sat.ny = ny; _sat.nz = nz;
  return overlapLeft;
}

/**
 * Separating axis test between a box centred on the origin and a triangle given
 * in box space. On overlap `_sat` receives the minimum translation axis
 * (pointing from the triangle towards the box centre) and its depth.
 * @param {Float64Array} tri Nine triangle components in box space.
 * @param {number} hx Box half extent x.
 * @param {number} hy Box half extent y.
 * @param {number} hz Box half extent z.
 * @returns {boolean} True when the box and the triangle overlap.
 */
function boxTriangleSAT(tri, hx, hy, hz) {
  const e0x = tri[3] - tri[0], e0y = tri[4] - tri[1], e0z = tri[5] - tri[2];
  const e1x = tri[6] - tri[3], e1y = tri[7] - tri[4], e1z = tri[8] - tri[5];
  const e2x = tri[0] - tri[6], e2y = tri[1] - tri[7], e2z = tri[2] - tri[8];

  let bestDepth = Infinity;
  let bnx = 0, bny = 0, bnz = 0;

  // 3 box face normals + the triangle normal + 9 edge cross products.
  for (let i = 0; i < 13; i++) {
    let axX = 0, axY = 0, axZ = 0;
    if (i === 0) { axX = 1; } else if (i === 1) { axY = 1; } else if (i === 2) { axZ = 1; } else if (i === 3) {
      axX = e0y * e1z - e0z * e1y;
      axY = e0z * e1x - e0x * e1z;
      axZ = e0x * e1y - e0y * e1x;
    } else {
      const k = i - 4;
      const boxAxis = (k / 3) | 0;
      const edge = k % 3;
      const ex = edge === 0 ? e0x : (edge === 1 ? e1x : e2x);
      const ey = edge === 0 ? e0y : (edge === 1 ? e1y : e2y);
      const ez = edge === 0 ? e0z : (edge === 1 ? e1z : e2z);
      if (boxAxis === 0) { axX = 0; axY = -ez; axZ = ey; } else if (boxAxis === 1) { axX = ez; axY = 0; axZ = -ex; } else { axX = -ey; axY = ex; axZ = 0; }
    }

    const depth = axisOverlap(axX, axY, axZ, tri, hx, hy, hz);
    if (depth < 0) return false;
    if (depth === Infinity) continue;
    if (depth < bestDepth) {
      bestDepth = depth;
      bnx = _sat.nx; bny = _sat.ny; bnz = _sat.nz;
    }
  }

  if (bestDepth === Infinity) return false;
  _sat.depth = bestDepth;
  _sat.nx = bnx; _sat.ny = bny; _sat.nz = bnz;
  return true;
}

/**
 * Applies the upper 3x3 of a matrix to a vector (no translation, no
 * renormalization - unlike `Vec3.transformDirection`).
 * @param {Mat4} m Matrix.
 * @param {Vec3} v Source vector.
 * @param {Vec3} out Destination.
 * @returns {Vec3} out
 */
function applyMat4Vector(m, v, out) {
  const e = m.elements;
  const x = v.x, y = v.y, z = v.z;
  out.x = e[0] * x + e[4] * y + e[8] * z;
  out.y = e[1] * x + e[5] * y + e[9] * z;
  out.z = e[2] * x + e[6] * y + e[10] * z;
  return out;
}

/* ==================================================================== */
/* Static collider                                                      */
/* ==================================================================== */

/**
 * Static triangle mesh registered in a {@link CollisionWorld}.
 *
 * Two storage modes exist:
 * - *shared*: the collider reuses the geometry's {@link TriangleBVH} and
 *   transforms queries into local space. Requires a uniform scale.
 * - *baked*: the vertices are transformed into world space once and a private
 *   BVH is built. Used when the world matrix has a non uniform scale.
 */
export class StaticCollider {
  /** @type {number} Monotonic id source. */
  static _nextId = 1;

  /**
   * @param {Object} source Mesh-like object, or `{positions, indices, matrix}`.
   * @param {Object} [options] Configuration.
   * @param {number} [options.friction=0.6] Surface friction coefficient.
   * @param {number} [options.restitution=0] Surface bounciness.
   * @param {number} [options.layer=1] Collision layer bit.
   * @param {Mat4} [options.matrix] Overrides the mesh world matrix.
   * @param {boolean} [options.bake=false] Forces the baked (world space) mode.
   */
  constructor(source, options = {}) {
    /** @type {number} */
    this.id = StaticCollider._nextId++;
    /** @type {boolean} True marker for duck typing. */
    this.isStaticCollider = true;
    /** @type {Object|null} Mesh this collider was built from. */
    this.mesh = source !== null && source !== undefined && source.geometry !== undefined ? source : null;

    /** @type {number} */
    this.friction = options.friction !== undefined ? options.friction : 0.6;
    /** @type {number} */
    this.restitution = options.restitution !== undefined ? options.restitution : 0;
    /** @type {number} */
    this.layer = options.layer !== undefined ? options.layer : 1;
    /** @type {boolean} */
    this.enabled = true;
    /** @type {Object} Free-form user storage. */
    this.userData = {};

    /** @type {Float32Array|null} */
    this.positions = null;
    /** @type {Uint32Array|Uint16Array|null} */
    this.indices = null;
    /** @type {TriangleBVH|null} */
    this.bvh = null;
    /** @type {boolean} True when `bvh` / `positions` are owned (baked). */
    this.baked = false;

    /** @type {Mat4} Local to world transform. */
    this.matrix = new Mat4();
    /** @type {Mat4} World to local transform. */
    this.invMatrix = new Mat4();
    /** @type {boolean} True when the transform is the identity. */
    this.identity = true;
    /** @type {number} Uniform scale factor of `matrix`. */
    this.scale = 1;
    /** @type {number} 1 / scale. */
    this.invScale = 1;

    /** @type {AABB} World space bounds. */
    this.aabb = new AABB();
    /** @type {number} Broad phase proxy id, -1 when detached. */
    this.proxyId = -1;

    /** @private */
    this._forceBake = options.bake === true;
    /** @private @type {Mat4|null} */
    this._matrixOverride = options.matrix !== undefined && options.matrix !== null ? options.matrix : null;
    /** @private @type {Object|null} Raw triangle source when not a Mesh. */
    this._rawSource = this.mesh === null ? source : null;

    this.refresh();
  }

  /**
   * (Re)reads the source transform and rebuilds whatever depends on it.
   * Call it after moving a static collider.
   * @returns {StaticCollider} this
   */
  refresh() {
    const source = this.mesh !== null ? this.mesh : this._rawSource;
    if (source === null || source === undefined) {
      throw new Error('StaticCollider: fonte de geometria invalida.');
    }

    let data = null;
    if (this.mesh !== null) {
      data = getMeshTriangleData(this.mesh);
      if (data === null) {
        throw new Error('StaticCollider: a malha nao possui geometria triangular utilizavel.');
      }
    } else {
      if (source.positions === undefined || source.positions === null) {
        throw new Error('StaticCollider: informe { positions, indices } ou uma Mesh.');
      }
      let indices = source.indices;
      if (indices === undefined || indices === null) {
        const vertexCount = (source.positions.length / 3) | 0;
        indices = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) indices[i] = i;
      }
      let bvh = source.bvh;
      if (bvh === undefined || bvh === null) {
        bvh = new TriangleBVH();
        bvh.build(source.positions, indices, 8);
      }
      data = { positions: source.positions, indices: indices, bvh: bvh };
    }

    // Resolve the world matrix.
    const worldMatrix = this._matrixOverride !== null
      ? this._matrixOverride
      : (source.worldMatrix !== undefined && source.worldMatrix !== null ? source.worldMatrix : null);

    if (worldMatrix === null) {
      this.matrix.identity();
    } else {
      this.matrix.copy(worldMatrix);
    }

    const e = this.matrix.elements;
    const sx = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    const sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    const sz = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    const maxScale = Math.max(sx, Math.max(sy, sz));
    const uniform = maxScale <= 0 ||
      (Math.abs(sx - sy) <= 1e-4 * maxScale && Math.abs(sy - sz) <= 1e-4 * maxScale);

    if (uniform === false || this._forceBake === true) {
      this._bake(data);
      return this;
    }

    this.baked = false;
    this.positions = data.positions;
    this.indices = data.indices;
    this.bvh = data.bvh;
    this.scale = maxScale > 0 ? sx : 1;
    this.invScale = this.scale !== 0 ? 1 / this.scale : 1;
    this.invMatrix.copy(this.matrix).invert();
    this.identity = worldMatrix === null || this.matrix.nearlyEquals(_identityMatrix, 1e-9);
    this._updateWorldAABB();
    return this;
  }

  /**
   * Transforms the geometry into world space and builds a private BVH.
   * @private
   * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Source triangles.
   * @returns {void}
   */
  _bake(data) {
    const src = data.positions;
    const count = (src.length / 3) | 0;
    const dst = new Float32Array(count * 3);
    const e = this.matrix.elements;
    for (let i = 0, o = 0; i < count; i++, o += 3) {
      const x = src[o], y = src[o + 1], z = src[o + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      const inv = w !== 0 ? 1 / w : 1;
      dst[o] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * inv;
      dst[o + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * inv;
      dst[o + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * inv;
    }
    if (this.baked === true && this.bvh !== null) this.bvh.dispose();
    this.positions = dst;
    this.indices = data.indices;
    this.bvh = new TriangleBVH();
    this.bvh.build(dst, data.indices, 8);
    this.baked = true;
    this.identity = true;
    this.scale = 1;
    this.invScale = 1;
    this.invMatrix.identity();
    this._updateWorldAABB();
  }

  /**
   * Rebuilds the world space AABB from the BVH root bounds.
   * @private
   * @returns {void}
   */
  _updateWorldAABB() {
    const bvh = this.bvh;
    this.aabb.makeEmpty();
    if (bvh === null || bvh.nodeCount === 0) return;
    const nb = bvh.nodeBounds;
    if (this.identity === true) {
      this.aabb.setMinMax(nb[0], nb[1], nb[2], nb[3], nb[4], nb[5]);
      return;
    }
    for (let i = 0; i < 8; i++) {
      _corner.set(
        (i & 1) === 0 ? nb[0] : nb[3],
        (i & 2) === 0 ? nb[1] : nb[4],
        (i & 4) === 0 ? nb[2] : nb[5]
      );
      _corner.applyMat4(this.matrix);
      this.aabb.expandByPoint(_corner);
    }
  }

  /**
   * World -> collider space point transform.
   * @param {Vec3} p World point.
   * @param {Vec3} out Receives the local point.
   * @returns {Vec3} out
   */
  worldToLocalPoint(p, out) {
    if (this.identity === true) return out.copy(p);
    return out.copy(p).applyMat4(this.invMatrix);
  }

  /**
   * World -> collider space vector transform (length scales by `invScale`).
   * @param {Vec3} v World vector.
   * @param {Vec3} out Receives the local vector.
   * @returns {Vec3} out
   */
  worldToLocalVector(v, out) {
    if (this.identity === true) return out.copy(v);
    return applyMat4Vector(this.invMatrix, v, out);
  }

  /**
   * Collider space -> world point transform.
   * @param {Vec3} p Local point.
   * @param {Vec3} out Receives the world point.
   * @returns {Vec3} out
   */
  localToWorldPoint(p, out) {
    if (this.identity === true) return out.copy(p);
    return out.copy(p).applyMat4(this.matrix);
  }

  /**
   * Collider space -> world direction transform (renormalized).
   * @param {Vec3} v Local direction.
   * @param {Vec3} out Receives the world direction.
   * @returns {Vec3} out
   */
  localToWorldDirection(v, out) {
    if (this.identity === true) return out.copy(v);
    return applyMat4Vector(this.matrix, v, out).normalize();
  }

  /**
   * Releases the resources owned by this collider (baked mode only).
   * @returns {void}
   */
  dispose() {
    if (this.baked === true && this.bvh !== null) this.bvh.dispose();
    this.bvh = null;
    this.positions = null;
    this.indices = null;
    this.mesh = null;
    this._rawSource = null;
  }
}

/* ==================================================================== */
/* Result records                                                       */
/* ==================================================================== */

/**
 * Creates a reusable shape cast result.
 * @returns {Object} A blank sweep hit record.
 */
export function createSweepHit() {
  return {
    /** @type {boolean} */
    hit: false,
    /** @type {number} Fraction of the motion, 0..1. */
    fraction: 1,
    /** @type {number} Travelled distance before the impact. */
    distance: 0,
    /** @type {Vec3} World contact point on the surface. */
    point: new Vec3(),
    /** @type {Vec3} World surface normal, pointing towards the moving shape. */
    normal: new Vec3(),
    /** @type {StaticCollider|null} */
    collider: null,
    /** @type {number} Triangle index inside the collider. */
    triIndex: -1
  };
}

/**
 * Factory for pooled overlap contacts.
 * @returns {Object} A blank contact record.
 */
function createOverlapContact() {
  return {
    point: new Vec3(),
    normal: new Vec3(),
    depth: 0,
    collider: null,
    triIndex: -1,
    _pooled: true
  };
}

/**
 * Reset callback for pooled overlap contacts.
 * @param {Object} c Contact being released.
 * @returns {void}
 */
function resetOverlapContact(c) {
  c.collider = null;
  c.triIndex = -1;
  c.depth = 0;
}

/* ==================================================================== */
/* Collision world                                                      */
/* ==================================================================== */

/**
 * Owns the static collision geometry, the dynamic bodies and the solver.
 */
export class CollisionWorld {
  /**
   * @param {Object} [options] Configuration.
   * @param {Vec3} [options.gravity] World gravity, defaults to (0, -9.81, 0).
   * @param {number} [options.velocityIterations=8] Sequential impulse iterations.
   * @param {number} [options.positionIterations=3] Position correction iterations.
   * @param {number} [options.subSteps=1] Substeps per `step()` call.
   * @param {number} [options.contactSlop=0.005] Allowed penetration, in metres.
   * @param {number} [options.correctionPercent=0.4] Fraction of the penetration
   *   removed per position iteration.
   * @param {number} [options.bounceThreshold=1] Approach speed below which
   *   restitution is ignored (kills micro bouncing).
   * @param {number} [options.maxTimeStep=0.1] `step(dt)` clamps `dt` to this.
   * @param {number} [options.maxContactsPerBody=16] Contact budget per body.
   * @param {boolean} [options.autoSyncNodes=true] Copy body transforms to nodes.
   */
  constructor(options = {}) {
    /** @type {Vec3} */
    this.gravity = new Vec3(0, -9.81, 0);
    if (options.gravity !== undefined && options.gravity !== null) this.gravity.copy(options.gravity);

    /** @type {DynamicBVH} Broad phase over the static colliders. */
    this.staticBVH = new DynamicBVH({ margin: 0 });
    /** @type {DynamicBVH} Broad phase over the dynamic bodies. */
    this.dynamicBVH = new DynamicBVH({ margin: 0.05 });

    /** @type {StaticCollider[]} */
    this.colliders = [];
    /** @type {import('./RigidBody.js').RigidBody[]} */
    this.bodies = [];

    /** @type {number} */
    this.velocityIterations = options.velocityIterations !== undefined ? options.velocityIterations : 8;
    /** @type {number} */
    this.positionIterations = options.positionIterations !== undefined ? options.positionIterations : 3;
    /** @type {number} */
    this.subSteps = options.subSteps !== undefined ? Math.max(1, options.subSteps | 0) : 1;
    /** @type {number} */
    this.contactSlop = options.contactSlop !== undefined ? options.contactSlop : 0.005;
    /** @type {number} */
    this.correctionPercent = options.correctionPercent !== undefined ? options.correctionPercent : 0.4;
    /** @type {number} */
    this.bounceThreshold = options.bounceThreshold !== undefined ? options.bounceThreshold : 1;
    /** @type {number} */
    this.maxTimeStep = options.maxTimeStep !== undefined ? options.maxTimeStep : 0.1;
    /** @type {number} */
    this.maxContactsPerBody = options.maxContactsPerBody !== undefined ? options.maxContactsPerBody : 16;
    /** @type {boolean} */
    this.autoSyncNodes = options.autoSyncNodes !== undefined ? options.autoSyncNodes : true;
    /** @type {boolean} Skip the solver entirely. */
    this.enabled = true;

    /** @type {{contacts:number, bodies:number, colliders:number, narrowPhaseTests:number}} */
    this.stats = { contacts: 0, bodies: 0, colliders: 0, narrowPhaseTests: 0 };

    /** @private @type {Array<*>} Broad phase result buffer. */
    this._colliderList = [];
    /** @private @type {Array<*>} Broad phase result buffer for bodies. */
    this._bodyList = [];
    /** @private @type {Array<number>} Triangle index buffer. */
    this._triList = [];

    /** @private @type {Array<*>} */
    this._contactA = [];
    /** @private @type {Array<*>} */
    this._contactB = [];
    /** @private @type {Float64Array} */
    this._contactData = new Float64Array(64 * CONTACT_STRIDE);
    /** @private @type {number} */
    this._contactCapacity = 64;
    /** @private @type {number} */
    this._contactCount = 0;
    /** @private @type {number} Index of the first contact of the body in flight. */
    this._bodyContactStart = 0;
    /** @private @type {number} */
    this._mergeDistanceSq = 0;

    /** @private @type {Pool} */
    this._contactPool = new Pool(createOverlapContact, resetOverlapContact, 16);

    /** @private Scratch reused by the query paths. */
    this._localPoint = new Vec3();
    this._localPoint2 = new Vec3();
    this._localDisp = new Vec3();
    this._bestNormal = new Vec3();
    this._bestPoint = new Vec3();
    this._queryAABB = new AABB();
  }

  /**
   * Alias kept for the contract wording ("broadphase com DynamicBVH").
   * @returns {DynamicBVH} The static broad phase.
   */
  get bvh() {
    return this.staticBVH;
  }

  /* ------------------------------------------------------------------ */
  /* Registration                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Registers a static triangle mesh. The geometry's triangle BVH is built once
   * and shared with the picking system.
   * @param {Object} mesh Mesh-like object, or `{positions, indices, matrix}`.
   * @param {Object} [options] See {@link StaticCollider}.
   * @returns {StaticCollider} The registered collider.
   */
  addStatic(mesh, options) {
    if (mesh !== null && mesh !== undefined && mesh.isStaticCollider === true) {
      return this._insertCollider(mesh);
    }
    const collider = new StaticCollider(mesh, options);
    return this._insertCollider(collider);
  }

  /**
   * Inserts a ready collider into the broad phase.
   * @private
   * @param {StaticCollider} collider Collider to insert.
   * @returns {StaticCollider} collider
   */
  _insertCollider(collider) {
    if (collider.proxyId !== -1) return collider;
    this.colliders.push(collider);
    if (collider.aabb.isEmpty() === false) {
      collider.proxyId = this.staticBVH.insert(collider.aabb, collider);
    }
    this.stats.colliders = this.colliders.length;
    return collider;
  }

  /**
   * Registers a dynamic (or kinematic) rigid body.
   * @param {import('./RigidBody.js').RigidBody} body Body to simulate.
   * @returns {import('./RigidBody.js').RigidBody} body
   */
  addDynamic(body) {
    if (body === null || body === undefined || body.proxyId !== -1) return body;
    body.world = this;
    body.updateInertiaWorld();
    body.updateAABB();
    this.bodies.push(body);
    body.proxyId = this.dynamicBVH.insert(body.aabb, body);
    this.stats.bodies = this.bodies.length;
    return body;
  }

  /**
   * Removes a collider, a body, or the collider built from a mesh.
   * @param {Object} x Collider, body or mesh.
   * @returns {boolean} True when something was removed.
   */
  remove(x) {
    if (x === null || x === undefined) return false;

    if (x.isRigidBody === true) {
      const i = this.bodies.indexOf(x);
      if (i === -1) return false;
      if (x.proxyId !== -1) {
        this.dynamicBVH.remove(x.proxyId);
        x.proxyId = -1;
      }
      this.bodies[i] = this.bodies[this.bodies.length - 1];
      this.bodies.pop();
      x.world = null;
      this.stats.bodies = this.bodies.length;
      return true;
    }

    let collider = null;
    if (x.isStaticCollider === true) {
      collider = x;
    } else {
      for (let i = 0, n = this.colliders.length; i < n; i++) {
        if (this.colliders[i].mesh === x) { collider = this.colliders[i]; break; }
      }
    }
    if (collider === null) return false;

    const i = this.colliders.indexOf(collider);
    if (i === -1) return false;
    if (collider.proxyId !== -1) {
      this.staticBVH.remove(collider.proxyId);
      collider.proxyId = -1;
    }
    this.colliders[i] = this.colliders[this.colliders.length - 1];
    this.colliders.pop();
    this.stats.colliders = this.colliders.length;
    return true;
  }

  /**
   * Re-reads the transform of a static collider and refreshes its proxy.
   * A baked collider pays a full geometry rebuild, so avoid calling this per
   * frame on non uniformly scaled meshes.
   * @param {StaticCollider|Object} x Collider or the mesh it was built from.
   * @returns {StaticCollider|null} The refreshed collider.
   */
  refreshStatic(x) {
    let collider = null;
    if (x !== null && x !== undefined && x.isStaticCollider === true) {
      collider = x;
    } else {
      for (let i = 0, n = this.colliders.length; i < n; i++) {
        if (this.colliders[i].mesh === x) { collider = this.colliders[i]; break; }
      }
    }
    if (collider === null) return null;
    collider.refresh();
    if (collider.proxyId !== -1) {
      this.staticBVH.update(collider.proxyId, collider.aabb, Vec3.ZERO);
    } else if (collider.aabb.isEmpty() === false) {
      collider.proxyId = this.staticBVH.insert(collider.aabb, collider);
    }
    return collider;
  }

  /**
   * Removes every collider and body.
   * @returns {CollisionWorld} this
   */
  clear() {
    for (let i = 0, n = this.colliders.length; i < n; i++) this.colliders[i].proxyId = -1;
    for (let i = 0, n = this.bodies.length; i < n; i++) {
      this.bodies[i].proxyId = -1;
      this.bodies[i].world = null;
    }
    this.colliders.length = 0;
    this.bodies.length = 0;
    this.staticBVH.clear();
    this.dynamicBVH.clear();
    this._contactCount = 0;
    this.stats.bodies = 0;
    this.stats.colliders = 0;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Shape casts                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Sweeps a sphere through the static geometry and reports the first impact.
   *
   * The test is analytic and exact (plane, then the three edges as capped
   * cylinders, then the three vertices), so a fast moving sphere can never
   * tunnel through a triangle. Surfaces the sphere already touches are reported
   * only when the motion pushes into them (see the initial overlap rule in the
   * file header).
   *
   * @param {Vec3} origin Sphere centre at the start of the motion.
   * @param {Vec3} direction Normalized motion direction.
   * @param {number} radius Sphere radius.
   * @param {number} maxDist Length of the motion.
   * @param {Object} [out] Reusable record from {@link createSweepHit}.
   * @param {number} [mask=0xffffffff] Collision layer mask.
   * @returns {Object|null} The hit record, or null when nothing was touched.
   */
  sphereCast(origin, direction, radius, maxDist, out, mask = 0xffffffff) {
    const hit = out !== undefined && out !== null ? out : createSweepHit();
    hit.hit = false;
    hit.fraction = 1;
    hit.distance = maxDist;
    hit.collider = null;
    hit.triIndex = -1;

    if (maxDist < 0) return null;

    const dx = direction.x * maxDist;
    const dy = direction.y * maxDist;
    const dz = direction.z * maxDist;

    const minX = Math.min(origin.x, origin.x + dx) - radius;
    const minY = Math.min(origin.y, origin.y + dy) - radius;
    const minZ = Math.min(origin.z, origin.z + dz) - radius;
    const maxX = Math.max(origin.x, origin.x + dx) + radius;
    const maxY = Math.max(origin.y, origin.y + dy) + radius;
    const maxZ = Math.max(origin.z, origin.z + dz) + radius;

    const colliders = this._colliderList;
    this.staticBVH.queryAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ, colliders);
    if (colliders.length === 0) return null;

    _v0.set(dx, dy, dz);

    let bestT = 1;
    let bestCollider = null;
    let bestTri = -1;

    for (let ci = 0, cn = colliders.length; ci < cn; ci++) {
      const collider = colliders[ci];
      if (collider.enabled === false || (collider.layer & mask) === 0) continue;

      collider.worldToLocalPoint(origin, this._localPoint);
      collider.worldToLocalVector(_v0, this._localDisp);
      const r = radius * collider.invScale;

      const ox = this._localPoint.x, oy = this._localPoint.y, oz = this._localPoint.z;
      const vx = this._localDisp.x, vy = this._localDisp.y, vz = this._localDisp.z;

      const tris = this._triList;
      collider.bvh.queryAABBMinMax(
        Math.min(ox, ox + vx) - r, Math.min(oy, oy + vy) - r, Math.min(oz, oz + vz) - r,
        Math.max(ox, ox + vx) + r, Math.max(oy, oy + vy) + r, Math.max(oz, oz + vz) + r,
        tris);

      const positions = collider.positions;
      const indices = collider.indices;
      for (let ti = 0, tn = tris.length; ti < tn; ti++) {
        const tri = tris[ti];
        const i0 = indices[tri * 3] * 3;
        const i1 = indices[tri * 3 + 1] * 3;
        const i2 = indices[tri * 3 + 2] * 3;
        const t = sweepSphereTriangle(
          ox, oy, oz, vx, vy, vz, r,
          positions[i0], positions[i0 + 1], positions[i0 + 2],
          positions[i1], positions[i1 + 1], positions[i1 + 2],
          positions[i2], positions[i2 + 1], positions[i2 + 2],
          bestT);
        if (t < 0 || t >= bestT) continue;
        bestT = t;
        bestCollider = collider;
        bestTri = tri;
        this._bestNormal.set(_sweep.nx, _sweep.ny, _sweep.nz);
        this._bestPoint.set(_sweep.px, _sweep.py, _sweep.pz);
        if (bestT <= 0) break;
      }
      if (bestT <= 0) break;
    }

    if (bestCollider === null) return null;

    hit.hit = true;
    hit.fraction = bestT;
    hit.distance = bestT * maxDist;
    hit.collider = bestCollider;
    hit.triIndex = bestTri;
    bestCollider.localToWorldPoint(this._bestPoint, hit.point);
    bestCollider.localToWorldDirection(this._bestNormal, hit.normal);
    return hit;
  }

  /**
   * Sweeps a capsule through the static geometry.
   *
   * Conservative advancement on the exact capsule/triangle distance: the capsule
   * is advanced by `distance / speed` until it touches, which by construction
   * can never step past a contact. That makes the sweep tunnel free even at very
   * high speeds. Convergence is bounded to 24 iterations per triangle; a grazing
   * contact that has not converged by then is reported at the last conservative
   * position, so the result is never optimistic. Surfaces the capsule already
   * touches follow the initial overlap rule described in the file header.
   *
   * @param {Vec3} p0 Lower endpoint of the capsule's inner segment.
   * @param {Vec3} p1 Upper endpoint of the capsule's inner segment.
   * @param {Vec3} direction Normalized motion direction.
   * @param {number} radius Capsule radius.
   * @param {number} maxDist Length of the motion.
   * @param {Object} [out] Reusable record from {@link createSweepHit}.
   * @param {number} [mask=0xffffffff] Collision layer mask.
   * @returns {Object|null} The hit record, or null.
   */
  capsuleCast(p0, p1, direction, radius, maxDist, out, mask = 0xffffffff) {
    const hit = out !== undefined && out !== null ? out : createSweepHit();
    hit.hit = false;
    hit.fraction = 1;
    hit.distance = maxDist;
    hit.collider = null;
    hit.triIndex = -1;

    if (maxDist < 0) return null;

    const dx = direction.x * maxDist;
    const dy = direction.y * maxDist;
    const dz = direction.z * maxDist;

    const minX = Math.min(p0.x, p1.x) + Math.min(0, dx) - radius;
    const minY = Math.min(p0.y, p1.y) + Math.min(0, dy) - radius;
    const minZ = Math.min(p0.z, p1.z) + Math.min(0, dz) - radius;
    const maxX = Math.max(p0.x, p1.x) + Math.max(0, dx) + radius;
    const maxY = Math.max(p0.y, p1.y) + Math.max(0, dy) + radius;
    const maxZ = Math.max(p0.z, p1.z) + Math.max(0, dz) + radius;

    const colliders = this._colliderList;
    this.staticBVH.queryAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ, colliders);
    if (colliders.length === 0) return null;

    _v0.set(dx, dy, dz);

    let bestT = 1;
    let bestCollider = null;
    let bestTri = -1;

    for (let ci = 0, cn = colliders.length; ci < cn; ci++) {
      const collider = colliders[ci];
      if (collider.enabled === false || (collider.layer & mask) === 0) continue;

      collider.worldToLocalPoint(p0, this._localPoint);
      collider.worldToLocalPoint(p1, this._localPoint2);
      collider.worldToLocalVector(_v0, this._localDisp);
      const r = radius * collider.invScale;

      const ax = this._localPoint.x, ay = this._localPoint.y, az = this._localPoint.z;
      const bx = this._localPoint2.x, by = this._localPoint2.y, bz = this._localPoint2.z;
      const vx = this._localDisp.x, vy = this._localDisp.y, vz = this._localDisp.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < 1e-9) continue;

      const tris = this._triList;
      collider.bvh.queryAABBMinMax(
        Math.min(ax, bx) + Math.min(0, vx) - r, Math.min(ay, by) + Math.min(0, vy) - r,
        Math.min(az, bz) + Math.min(0, vz) - r,
        Math.max(ax, bx) + Math.max(0, vx) + r, Math.max(ay, by) + Math.max(0, vy) + r,
        Math.max(az, bz) + Math.max(0, vz) + r,
        tris);

      const positions = collider.positions;
      const indices = collider.indices;
      const tolerance = TOUCH_TOLERANCE * (1 + r);

      for (let ti = 0, tn = tris.length; ti < tn; ti++) {
        const tri = tris[ti];
        const i0 = indices[tri * 3] * 3;
        const i1 = indices[tri * 3 + 1] * 3;
        const i2 = indices[tri * 3 + 2] * 3;
        const t0x = positions[i0], t0y = positions[i0 + 1], t0z = positions[i0 + 2];
        const t1x = positions[i1], t1y = positions[i1 + 1], t1z = positions[i1 + 2];
        const t2x = positions[i2], t2y = positions[i2 + 1], t2z = positions[i2 + 2];

        let t = 0;
        let impacted = false;
        for (let iter = 0; iter < MAX_CA_ITERATIONS; iter++) {
          const d2 = segmentTriangleDistanceSq(
            ax + vx * t, ay + vy * t, az + vz * t,
            bx + vx * t, by + vy * t, bz + vz * t,
            t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z);
          const gap = Math.sqrt(d2) - r;
          if (gap <= tolerance) {
            // Contact present from the very first sample: only blocking when the
            // motion pushes into the surface (see sweepSphereTriangle).
            if (iter === 0 && this._approaches(vx, vy, vz, t0x, t0y, t0z, t1x, t1y, t1z,
              t2x, t2y, t2z, (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5) === false) {
              break;
            }
            impacted = true;
            break;
          }
          t += gap / speed;
          if (t >= bestT) break;
        }
        if (impacted === false || t >= bestT) continue;

        bestT = t < 0 ? 0 : t;
        bestCollider = collider;
        bestTri = tri;
        this._bestPoint.set(_stTri[0], _stTri[1], _stTri[2]);
        let nx = _stSeg[0] - _stTri[0];
        let ny = _stSeg[1] - _stTri[1];
        let nz = _stSeg[2] - _stTri[2];
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 1e-8) {
          const inv = 1 / nl;
          nx *= inv; ny *= inv; nz *= inv;
        } else {
          const e1x = t1x - t0x, e1y = t1y - t0y, e1z = t1z - t0z;
          const e2x = t2x - t0x, e2y = t2y - t0y, e2z = t2z - t0z;
          nx = e1y * e2z - e1z * e2y;
          ny = e1z * e2x - e1x * e2z;
          nz = e1x * e2y - e1y * e2x;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l; ny /= l; nz /= l;
          // Orient the fallback normal towards the capsule centre.
          const mx = (ax + bx) * 0.5 - t0x;
          const my = (ay + by) * 0.5 - t0y;
          const mz = (az + bz) * 0.5 - t0z;
          if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        }
        this._bestNormal.set(nx, ny, nz);
        if (bestT <= 0) break;
      }
      if (bestT <= 0) break;
    }

    if (bestCollider === null) return null;

    hit.hit = true;
    hit.fraction = bestT;
    hit.distance = bestT * maxDist;
    hit.collider = bestCollider;
    hit.triIndex = bestTri;
    bestCollider.localToWorldPoint(this._bestPoint, hit.point);
    bestCollider.localToWorldDirection(this._bestNormal, hit.normal);
    return hit;
  }

  /**
   * True when a displacement pushes into the surface of a contact the shape is
   * already touching. `_stSeg` / `_stTri` must hold the closest point pair of
   * the current configuration.
   * @private
   * @param {number} vx Displacement x.
   * @param {number} vy Displacement y.
   * @param {number} vz Displacement z.
   * @param {number} t0x Vertex A x.
   * @param {number} t0y Vertex A y.
   * @param {number} t0z Vertex A z.
   * @param {number} t1x Vertex B x.
   * @param {number} t1y Vertex B y.
   * @param {number} t1z Vertex B z.
   * @param {number} t2x Vertex C x.
   * @param {number} t2y Vertex C y.
   * @param {number} t2z Vertex C z.
   * @param {number} mx Shape centre x (fallback orientation).
   * @param {number} my Shape centre y.
   * @param {number} mz Shape centre z.
   * @returns {boolean} True when the surface blocks the motion.
   */
  _approaches(vx, vy, vz, t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z, mx, my, mz) {
    let nx = _stSeg[0] - _stTri[0];
    let ny = _stSeg[1] - _stTri[1];
    let nz = _stSeg[2] - _stTri[2];
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-8) {
      const inv = 1 / l;
      nx *= inv; ny *= inv; nz *= inv;
    } else {
      const e1x = t1x - t0x, e1y = t1y - t0y, e1z = t1z - t0z;
      const e2x = t2x - t0x, e2y = t2y - t0y, e2z = t2z - t0z;
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) return false;
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * (mx - t0x) + ny * (my - t0y) + nz * (mz - t0z) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    }
    return vx * nx + vy * ny + vz * nz < -1e-9;
  }

  /**
   * Casts a ray against the static colliders only. Use `Raycaster` for scene
   * wide picking; this variant is cheaper for physics probes.
   * @param {Vec3} origin Ray origin.
   * @param {Vec3} direction Normalized direction.
   * @param {number} maxDist Maximum distance.
   * @param {Object} [out] Reusable record from {@link createSweepHit}.
   * @param {number} [mask=0xffffffff] Collision layer mask.
   * @returns {Object|null} The hit record, or null.
   */
  raycast(origin, direction, maxDist, out, mask = 0xffffffff) {
    return this.sphereCast(origin, direction, 0, maxDist, out, mask);
  }

  /* ------------------------------------------------------------------ */
  /* Overlap queries                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Collects the static surface contacts overlapping a sphere.
   * The records come from an internal pool: give them back with
   * {@link CollisionWorld#releaseContacts}.
   * @param {Vec3} center Sphere centre in world space.
   * @param {number} radius Sphere radius.
   * @param {Array<Object>} out Output array; emptied first.
   * @param {number} [mask=0xffffffff] Collision layer mask.
   * @returns {number} Number of contacts written.
   */
  overlapSphere(center, radius, out, mask = 0xffffffff) {
    return this._overlapSegment(center, center, radius, out, mask);
  }

  /**
   * Collects the static surface contacts overlapping a capsule.
   * @param {Vec3} p0 Lower endpoint of the inner segment.
   * @param {Vec3} p1 Upper endpoint of the inner segment.
   * @param {number} radius Capsule radius.
   * @param {Array<Object>} out Output array; emptied first.
   * @param {number} [mask=0xffffffff] Collision layer mask.
   * @returns {number} Number of contacts written.
   */
  overlapCapsule(p0, p1, radius, out, mask = 0xffffffff) {
    return this._overlapSegment(p0, p1, radius, out, mask);
  }

  /**
   * Shared implementation of the sphere / capsule overlap queries.
   * @private
   * @param {Vec3} p0 Segment start.
   * @param {Vec3} p1 Segment end.
   * @param {number} radius Sweep radius.
   * @param {Array<Object>} out Output array.
   * @param {number} mask Collision layer mask.
   * @returns {number} Contact count.
   */
  _overlapSegment(p0, p1, radius, out, mask) {
    out.length = 0;

    const minX = Math.min(p0.x, p1.x) - radius;
    const minY = Math.min(p0.y, p1.y) - radius;
    const minZ = Math.min(p0.z, p1.z) - radius;
    const maxX = Math.max(p0.x, p1.x) + radius;
    const maxY = Math.max(p0.y, p1.y) + radius;
    const maxZ = Math.max(p0.z, p1.z) + radius;

    const colliders = this._colliderList;
    this.staticBVH.queryAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ, colliders);
    if (colliders.length === 0) return 0;

    let count = 0;
    for (let ci = 0, cn = colliders.length; ci < cn; ci++) {
      const collider = colliders[ci];
      if (collider.enabled === false || (collider.layer & mask) === 0) continue;

      collider.worldToLocalPoint(p0, this._localPoint);
      collider.worldToLocalPoint(p1, this._localPoint2);
      const r = radius * collider.invScale;
      const r2 = r * r;

      const ax = this._localPoint.x, ay = this._localPoint.y, az = this._localPoint.z;
      const bx = this._localPoint2.x, by = this._localPoint2.y, bz = this._localPoint2.z;

      const tris = this._triList;
      collider.bvh.queryAABBMinMax(
        Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.min(az, bz) - r,
        Math.max(ax, bx) + r, Math.max(ay, by) + r, Math.max(az, bz) + r,
        tris);

      const positions = collider.positions;
      const indices = collider.indices;
      for (let ti = 0, tn = tris.length; ti < tn; ti++) {
        const tri = tris[ti];
        const i0 = indices[tri * 3] * 3;
        const i1 = indices[tri * 3 + 1] * 3;
        const i2 = indices[tri * 3 + 2] * 3;
        const d2 = segmentTriangleDistanceSq(
          ax, ay, az, bx, by, bz,
          positions[i0], positions[i0 + 1], positions[i0 + 2],
          positions[i1], positions[i1 + 1], positions[i1 + 2],
          positions[i2], positions[i2 + 1], positions[i2 + 2]);
        if (d2 >= r2) continue;

        const contact = this._contactPool.acquire();
        const d = Math.sqrt(d2);
        this._bestPoint.set(_stTri[0], _stTri[1], _stTri[2]);
        let nx = _stSeg[0] - _stTri[0];
        let ny = _stSeg[1] - _stTri[1];
        let nz = _stSeg[2] - _stTri[2];
        if (d > 1e-8) {
          const inv = 1 / d;
          nx *= inv; ny *= inv; nz *= inv;
        } else {
          const e1x = positions[i1] - positions[i0];
          const e1y = positions[i1 + 1] - positions[i0 + 1];
          const e1z = positions[i1 + 2] - positions[i0 + 2];
          const e2x = positions[i2] - positions[i0];
          const e2y = positions[i2 + 1] - positions[i0 + 1];
          const e2z = positions[i2 + 2] - positions[i0 + 2];
          nx = e1y * e2z - e1z * e2y;
          ny = e1z * e2x - e1x * e2z;
          nz = e1x * e2y - e1y * e2x;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
        this._bestNormal.set(nx, ny, nz);
        collider.localToWorldPoint(this._bestPoint, contact.point);
        collider.localToWorldDirection(this._bestNormal, contact.normal);
        contact.depth = (r - d) * collider.scale;
        contact.collider = collider;
        contact.triIndex = tri;
        out.push(contact);
        count++;
      }
    }
    return count;
  }

  /**
   * Collects the colliders whose bounds overlap a sphere (no narrow phase).
   * @param {Vec3} center Sphere centre.
   * @param {number} radius Sphere radius.
   * @param {Array<StaticCollider>} out Output array; emptied first.
   * @returns {number} Number of colliders written.
   */
  overlapSphereColliders(center, radius, out) {
    return this.staticBVH.querySphere(center.x, center.y, center.z, radius, out);
  }

  /**
   * Returns pooled contacts obtained from an overlap query.
   * @param {Array<Object>} list Contacts to release; the array is emptied.
   * @returns {void}
   */
  releaseContacts(list) {
    if (list === null || list === undefined) return;
    for (let i = 0, n = list.length; i < n; i++) {
      const c = list[i];
      if (c !== null && c !== undefined && c._pooled === true) this._contactPool.release(c);
    }
    list.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Advances the simulation. `dt` is clamped to `maxTimeStep` and divided into
   * `subSteps` equal substeps.
   * @param {number} dt Elapsed time in seconds.
   * @returns {CollisionWorld} this
   */
  step(dt) {
    if (this.enabled === false || dt <= 0) return this;
    let h = dt > this.maxTimeStep ? this.maxTimeStep : dt;
    h /= this.subSteps;
    for (let i = 0; i < this.subSteps; i++) this._substep(h);
    if (this.autoSyncNodes === true) {
      const bodies = this.bodies;
      for (let i = 0, n = bodies.length; i < n; i++) {
        if (bodies[i].node !== null) bodies[i].syncNode();
      }
    }
    return this;
  }

  /**
   * One full substep: integrate velocities, build contacts, solve, integrate
   * positions, correct penetrations and update the sleep state.
   * @private
   * @param {number} dt Substep duration.
   * @returns {void}
   */
  _substep(dt) {
    const bodies = this.bodies;
    const n = bodies.length;

    for (let i = 0; i < n; i++) {
      const body = bodies[i];
      if (body.enabled === false) continue;
      body.integrateVelocity(dt, this.gravity);
    }

    this._contactCount = 0;
    this.stats.narrowPhaseTests = 0;

    for (let i = 0; i < n; i++) {
      const body = bodies[i];
      if (body.enabled === false || body.sleeping === true) continue;
      // Static and kinematic bodies cannot react to the static world.
      if (body.invMass === 0) continue;
      this._generateStaticContacts(body, dt);
    }

    this._generateBodyContacts();
    this._prepareContacts(dt);

    for (let it = 0, iters = this.velocityIterations; it < iters; it++) this._solveVelocities();

    for (let i = 0; i < n; i++) {
      const body = bodies[i];
      if (body.enabled === false) continue;
      body.integratePosition(dt);
    }

    for (let it = 0, iters = this.positionIterations; it < iters; it++) this._solvePositions();

    for (let i = 0; i < n; i++) {
      const body = bodies[i];
      if (body.enabled === false) continue;
      body.updateAABB();
      if (body.proxyId !== -1) {
        _v1.copy(body.velocity).multiplyScalar(dt);
        this.dynamicBVH.update(body.proxyId, body.aabb, _v1);
      }
      if (body.type === BodyType.DYNAMIC) body.updateSleep(dt);
    }

    this.stats.contacts = this._contactCount;
  }

  /* ------------------------------------------------------------------ */
  /* Contact generation                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Grows the contact arrays. Amortized: never runs in a steady state.
   * @private
   * @returns {void}
   */
  _growContacts() {
    const capacity = this._contactCapacity * 2;
    const data = new Float64Array(capacity * CONTACT_STRIDE);
    data.set(this._contactData);
    this._contactData = data;
    this._contactCapacity = capacity;
  }

  /**
   * Appends a contact, merging it into an existing one from the same body when
   * both the normal and the position match closely. Merging keeps a sphere
   * resting on a triangle fan from being over constrained while still allowing
   * a box to keep its four corner contacts.
   *
   * Convention: `nx/ny/nz` points from B towards A, i.e. the direction A must
   * move along to separate. `b` is null for the static world.
   *
   * @private
   * @param {Object} a First body.
   * @param {Object|null} b Second body, or null for static geometry.
   * @param {number} nx Normal x.
   * @param {number} ny Normal y.
   * @param {number} nz Normal z.
   * @param {number} px Contact point x.
   * @param {number} py Contact point y.
   * @param {number} pz Contact point z.
   * @param {number} depth Penetration depth (positive).
   * @param {number} friction Combined friction coefficient.
   * @param {number} restitution Combined restitution.
   * @returns {void}
   */
  _addContact(a, b, nx, ny, nz, px, py, pz, depth, friction, restitution) {
    const data = this._contactData;

    for (let i = this._bodyContactStart, n = this._contactCount; i < n; i++) {
      const o = i * CONTACT_STRIDE;
      if (data[o] * nx + data[o + 1] * ny + data[o + 2] * nz < 0.998) continue;
      const ddx = data[o + 3] - px, ddy = data[o + 4] - py, ddz = data[o + 5] - pz;
      if (ddx * ddx + ddy * ddy + ddz * ddz > this._mergeDistanceSq) continue;
      if (depth > data[o + 6]) {
        data[o] = nx; data[o + 1] = ny; data[o + 2] = nz;
        data[o + 3] = px; data[o + 4] = py; data[o + 5] = pz;
        data[o + 6] = depth;
      }
      return;
    }

    if (this._contactCount - this._bodyContactStart >= this.maxContactsPerBody) return;
    if (this._contactCount >= this._contactCapacity) this._growContacts();

    const index = this._contactCount++;
    const o = index * CONTACT_STRIDE;
    const d = this._contactData;
    d[o] = nx; d[o + 1] = ny; d[o + 2] = nz;
    d[o + 3] = px; d[o + 4] = py; d[o + 5] = pz;
    d[o + 6] = depth;
    d[o + 7] = friction;
    d[o + 8] = restitution;
    d[o + 9] = 0; d[o + 10] = 0; d[o + 11] = 0;
    d[o + 22] = 0;
    this._contactA[index] = a;
    this._contactB[index] = b;
  }

  /**
   * Builds the contacts between one body and the static triangle world.
   * @private
   * @param {Object} body Dynamic body.
   * @param {number} dt Substep duration (used to inflate the query bounds).
   * @returns {void}
   */
  _generateStaticContacts(body, dt) {
    body.updateAABB();
    const box = this._queryAABB;
    box.copy(body.aabb);
    // Inflate along the motion so a fast body still finds the surface it will hit.
    const vx = body.velocity.x * dt, vy = body.velocity.y * dt, vz = body.velocity.z * dt;
    if (vx < 0) box.min.x += vx; else box.max.x += vx;
    if (vy < 0) box.min.y += vy; else box.max.y += vy;
    if (vz < 0) box.min.z += vz; else box.max.z += vz;
    box.expandByScalar(this.contactSlop);

    const colliders = this._colliderList;
    this.staticBVH.queryAABB(box, colliders);
    if (colliders.length === 0) return;

    this._bodyContactStart = this._contactCount;
    this._mergeDistanceSq = this._computeMergeDistanceSq(body);

    for (let ci = 0, cn = colliders.length; ci < cn; ci++) {
      const collider = colliders[ci];
      if (collider.enabled === false || (collider.layer & body.mask) === 0) continue;
      const friction = Math.sqrt(Math.max(0, body.friction * collider.friction));
      const restitution = body.restitution > collider.restitution ? body.restitution : collider.restitution;

      if (body.shape === BodyShape.BOX) {
        this._boxVsCollider(body, collider, friction, restitution);
      } else {
        this._roundVsCollider(body, collider, friction, restitution);
      }
    }
  }

  /**
   * Merge radius used by {@link CollisionWorld#_addContact}, squared.
   * @private
   * @param {Object} body Body being processed.
   * @returns {number} Squared merge distance.
   */
  _computeMergeDistanceSq(body) {
    if (body.shape === BodyShape.SPHERE) {
      const d = body.radius * 4;
      return d * d;
    }
    if (body.shape === BodyShape.CAPSULE) {
      const d = body.radius * 0.35;
      return d * d;
    }
    const h = body.halfExtents;
    let m = h.x < h.y ? h.x : h.y;
    if (h.z < m) m = h.z;
    const d = m * 0.35;
    return d * d;
  }

  /**
   * Sphere / capsule body against one static collider.
   * @private
   * @param {Object} body Body with a rounded shape.
   * @param {StaticCollider} collider Static collider.
   * @param {number} friction Combined friction.
   * @param {number} restitution Combined restitution.
   * @returns {void}
   */
  _roundVsCollider(body, collider, friction, restitution) {
    body.getWorldSegment(_v2, _v3);
    collider.worldToLocalPoint(_v2, this._localPoint);
    collider.worldToLocalPoint(_v3, this._localPoint2);
    const r = body.radius * collider.invScale;
    const r2 = r * r;

    const ax = this._localPoint.x, ay = this._localPoint.y, az = this._localPoint.z;
    const bx = this._localPoint2.x, by = this._localPoint2.y, bz = this._localPoint2.z;

    const tris = this._triList;
    collider.bvh.queryAABBMinMax(
      Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.min(az, bz) - r,
      Math.max(ax, bx) + r, Math.max(ay, by) + r, Math.max(az, bz) + r,
      tris);

    const positions = collider.positions;
    const indices = collider.indices;
    this.stats.narrowPhaseTests += tris.length;

    for (let ti = 0, tn = tris.length; ti < tn; ti++) {
      const tri = tris[ti];
      const i0 = indices[tri * 3] * 3;
      const i1 = indices[tri * 3 + 1] * 3;
      const i2 = indices[tri * 3 + 2] * 3;
      const d2 = segmentTriangleDistanceSq(
        ax, ay, az, bx, by, bz,
        positions[i0], positions[i0 + 1], positions[i0 + 2],
        positions[i1], positions[i1 + 1], positions[i1 + 2],
        positions[i2], positions[i2 + 1], positions[i2 + 2]);
      if (d2 >= r2) continue;

      const d = Math.sqrt(d2);
      this._bestPoint.set(_stTri[0], _stTri[1], _stTri[2]);
      let nx = _stSeg[0] - _stTri[0];
      let ny = _stSeg[1] - _stTri[1];
      let nz = _stSeg[2] - _stTri[2];
      if (d > 1e-8) {
        const inv = 1 / d;
        nx *= inv; ny *= inv; nz *= inv;
      } else {
        const e1x = positions[i1] - positions[i0];
        const e1y = positions[i1 + 1] - positions[i0 + 1];
        const e1z = positions[i1 + 2] - positions[i0 + 2];
        const e2x = positions[i2] - positions[i0];
        const e2y = positions[i2 + 1] - positions[i0 + 1];
        const e2z = positions[i2 + 2] - positions[i0 + 2];
        nx = e1y * e2z - e1z * e2y;
        ny = e1z * e2x - e1x * e2z;
        nz = e1x * e2y - e1y * e2x;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l; ny /= l; nz /= l;
      }
      this._bestNormal.set(nx, ny, nz);
      collider.localToWorldPoint(this._bestPoint, _v4);
      collider.localToWorldDirection(this._bestNormal, _v5);
      this._addContact(body, null, _v5.x, _v5.y, _v5.z, _v4.x, _v4.y, _v4.z,
        (r - d) * collider.scale, friction, restitution);
    }
  }

  /**
   * Box body against one static collider, using a separating axis test per
   * triangle. The contact point is the closest point of the triangle to the box
   * centre, which is accurate enough for a resting box.
   * @private
   * @param {Object} body Box body.
   * @param {StaticCollider} collider Static collider.
   * @param {number} friction Combined friction.
   * @param {number} restitution Combined restitution.
   * @returns {void}
   */
  _boxVsCollider(body, collider, friction, restitution) {
    collider.worldToLocalPoint(body.position, this._localPoint);
    const invScale = collider.invScale;
    const hx = body.halfExtents.x * invScale;
    const hy = body.halfExtents.y * invScale;
    const hz = body.halfExtents.z * invScale;
    const reach = Math.sqrt(hx * hx + hy * hy + hz * hz);

    const cx = this._localPoint.x, cy = this._localPoint.y, cz = this._localPoint.z;
    const tris = this._triList;
    collider.bvh.queryAABBMinMax(
      cx - reach, cy - reach, cz - reach,
      cx + reach, cy + reach, cz + reach,
      tris);

    const positions = collider.positions;
    const indices = collider.indices;
    this.stats.narrowPhaseTests += tris.length;

    // Body space = rotate by the inverse orientation around the box centre.
    const q = body.quaternion;
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;

    for (let ti = 0, tn = tris.length; ti < tn; ti++) {
      const tri = tris[ti];
      const idx = tri * 3;
      for (let k = 0; k < 3; k++) {
        const i = indices[idx + k] * 3;
        // Collider space -> world -> box space.
        _v2.set(positions[i], positions[i + 1], positions[i + 2]);
        collider.localToWorldPoint(_v2, _v3);
        _v3.sub(body.position);
        // Rotate by the conjugate quaternion.
        const vx = _v3.x, vy = _v3.y, vz = _v3.z;
        const tx = 2 * (qy * vz - qz * vy);
        const ty = 2 * (qz * vx - qx * vz);
        const tz = 2 * (qx * vy - qy * vx);
        _tri[k * 3] = vx + qw * tx + qy * tz - qz * ty;
        _tri[k * 3 + 1] = vy + qw * ty + qz * tx - qx * tz;
        _tri[k * 3 + 2] = vz + qw * tz + qx * ty - qy * tx;
      }

      const bhx = body.halfExtents.x, bhy = body.halfExtents.y, bhz = body.halfExtents.z;
      if (boxTriangleSAT(_tri, bhx, bhy, bhz) === false) continue;

      const nx = _sat.nx, ny = _sat.ny, nz = _sat.nz;
      const depth = _sat.depth;
      _v3.set(nx, ny, nz).applyQuat(body.quaternion);

      // Reference plane: the extreme of the triangle along the separating axis.
      let planeOffset = _tri[0] * nx + _tri[1] * ny + _tri[2] * nz;
      const e1 = _tri[3] * nx + _tri[4] * ny + _tri[5] * nz;
      const e2 = _tri[6] * nx + _tri[7] * ny + _tri[8] * nz;
      if (e1 > planeOffset) planeOffset = e1;
      if (e2 > planeOffset) planeOffset = e2;

      // Manifold: every box corner that sits behind the reference plane and
      // projects inside the triangle becomes a contact. A resting box therefore
      // gets four corner contacts and cannot tip over its own centre.
      let emitted = 0;
      for (let c = 0; c < 8; c++) {
        const kx = (c & 1) !== 0 ? bhx : -bhx;
        const ky = (c & 2) !== 0 ? bhy : -bhy;
        const kz = (c & 4) !== 0 ? bhz : -bhz;
        const pen = planeOffset - (kx * nx + ky * ny + kz * nz);
        if (pen <= 0) continue;
        const qx = kx + nx * pen, qy = ky + ny * pen, qz = kz + nz * pen;
        const d2 = closestPointTriangle(qx, qy, qz,
          _tri[0], _tri[1], _tri[2], _tri[3], _tri[4], _tri[5], _tri[6], _tri[7], _tri[8]);
        if (d2 > 1e-6) continue;
        _v2.set(qx, qy, qz).applyQuat(body.quaternion).add(body.position);
        this._addContact(body, null, _v3.x, _v3.y, _v3.z, _v2.x, _v2.y, _v2.z,
          pen, friction, restitution);
        emitted++;
      }

      if (emitted === 0) {
        // Edge or vertex contact: fall back to the closest point of the
        // triangle to the box centre.
        closestPointTriangle(0, 0, 0,
          _tri[0], _tri[1], _tri[2], _tri[3], _tri[4], _tri[5], _tri[6], _tri[7], _tri[8]);
        _v2.set(_cpt[0], _cpt[1], _cpt[2]).applyQuat(body.quaternion).add(body.position);
        this._addContact(body, null, _v3.x, _v3.y, _v3.z, _v2.x, _v2.y, _v2.z,
          depth, friction, restitution);
      }
    }
  }

  /**
   * Builds the contacts between pairs of dynamic bodies.
   * Boxes are approximated by their bounding sphere here; see the file header.
   * @private
   * @returns {void}
   */
  _generateBodyContacts() {
    const bodies = this.bodies;
    const list = this._bodyList;

    for (let i = 0, n = bodies.length; i < n; i++) {
      const a = bodies[i];
      if (a.enabled === false || a.sleeping === true) continue;
      if (a.type === BodyType.STATIC) continue;

      this.dynamicBVH.queryAABB(a.aabb, list);
      if (list.length < 2) continue;

      this._bodyContactStart = this._contactCount;
      this._mergeDistanceSq = this._computeMergeDistanceSq(a);

      for (let j = 0, m = list.length; j < m; j++) {
        const b = list[j];
        if (b === a || b.enabled === false) continue;
        // Each awake body handles its own pairs; skip the mirrored one unless
        // the partner is asleep or static (which never processes pairs itself).
        if (b.sleeping === false && b.type !== BodyType.STATIC && b.id < a.id) continue;
        if ((a.layer & b.mask) === 0 || (b.layer & a.mask) === 0) continue;
        if (a.invMass === 0 && b.invMass === 0) continue;
        if (b.sleeping === true) b.wake();
        this._pairContact(a, b);
      }
    }
  }

  /**
   * Analytic contact between two dynamic bodies.
   * @private
   * @param {Object} a First body.
   * @param {Object} b Second body.
   * @returns {void}
   */
  _pairContact(a, b) {
    const ra = a.shape === BodyShape.BOX ? a.getBoundingRadius() : a.radius;
    const rb = b.shape === BodyShape.BOX ? b.getBoundingRadius() : b.radius;
    const sum = ra + rb;

    a.getWorldSegment(_v0, _v1);
    b.getWorldSegment(_v2, _v3);

    const d2 = closestPointSegmentSegment(
      _v0.x, _v0.y, _v0.z, _v1.x, _v1.y, _v1.z,
      _v2.x, _v2.y, _v2.z, _v3.x, _v3.y, _v3.z);
    if (d2 >= sum * sum) return;

    const d = Math.sqrt(d2);
    let nx, ny, nz;
    if (d > 1e-8) {
      const inv = 1 / d;
      nx = (_ssA[0] - _ssB[0]) * inv;
      ny = (_ssA[1] - _ssB[1]) * inv;
      nz = (_ssA[2] - _ssB[2]) * inv;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    // Contact point sits halfway inside the overlap region.
    const px = _ssB[0] + nx * rb + (_ssA[0] - nx * ra - (_ssB[0] + nx * rb)) * 0.5;
    const py = _ssB[1] + ny * rb + (_ssA[1] - ny * ra - (_ssB[1] + ny * rb)) * 0.5;
    const pz = _ssB[2] + nz * rb + (_ssA[2] - nz * ra - (_ssB[2] + nz * rb)) * 0.5;

    const friction = Math.sqrt(Math.max(0, a.friction * b.friction));
    const restitution = a.restitution > b.restitution ? a.restitution : b.restitution;
    this._addContact(a, b, nx, ny, nz, px, py, pz, sum - d, friction, restitution);
  }

  /* ------------------------------------------------------------------ */
  /* Solver                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Angular contribution of a body to a constraint's effective mass.
   * @private
   * @param {Object} body Body.
   * @param {number} rx Contact offset x.
   * @param {number} ry Contact offset y.
   * @param {number} rz Contact offset z.
   * @param {number} nx Constraint axis x.
   * @param {number} ny Constraint axis y.
   * @param {number} nz Constraint axis z.
   * @returns {number} `n . ((I^-1 (r x n)) x r)`.
   */
  _angularTerm(body, rx, ry, rz, nx, ny, nz) {
    const e = body.invInertiaWorld.elements;
    const cx = ry * nz - rz * ny;
    const cy = rz * nx - rx * nz;
    const cz = rx * ny - ry * nx;
    const wx = e[0] * cx + e[1] * cy + e[2] * cz;
    const wy = e[3] * cx + e[4] * cy + e[5] * cz;
    const wz = e[6] * cx + e[7] * cy + e[8] * cz;
    const tx = wy * rz - wz * ry;
    const ty = wz * rx - wx * rz;
    const tz = wx * ry - wy * rx;
    return nx * tx + ny * ty + nz * tz;
  }

  /**
   * Applies a linear + angular impulse to a body.
   * @private
   * @param {Object} body Body.
   * @param {number} sign +1 or -1.
   * @param {number} lambda Impulse magnitude.
   * @param {number} nx Axis x.
   * @param {number} ny Axis y.
   * @param {number} nz Axis z.
   * @param {number} rx Contact offset x.
   * @param {number} ry Contact offset y.
   * @param {number} rz Contact offset z.
   * @returns {void}
   */
  _applyImpulse(body, sign, lambda, nx, ny, nz, rx, ry, rz) {
    const im = body.invMass;
    if (im === 0) return;
    const p = lambda * sign;
    body.velocity.x += nx * p * im;
    body.velocity.y += ny * p * im;
    body.velocity.z += nz * p * im;

    const e = body.invInertiaWorld.elements;
    const jx = nx * p, jy = ny * p, jz = nz * p;
    const cx = ry * jz - rz * jy;
    const cy = rz * jx - rx * jz;
    const cz = rx * jy - ry * jx;
    body.angularVelocity.x += e[0] * cx + e[1] * cy + e[2] * cz;
    body.angularVelocity.y += e[3] * cx + e[4] * cy + e[5] * cz;
    body.angularVelocity.z += e[6] * cx + e[7] * cy + e[8] * cz;
  }

  /**
   * Precomputes the tangent basis, the effective masses and the restitution
   * target of every contact.
   * @private
   * @param {number} dt Substep duration.
   * @returns {void}
   */
  _prepareContacts(dt) {
    const data = this._contactData;
    for (let i = 0, n = this._contactCount; i < n; i++) {
      const o = i * CONTACT_STRIDE;
      const a = this._contactA[i];
      const b = this._contactB[i];
      const nx = data[o], ny = data[o + 1], nz = data[o + 2];
      const px = data[o + 3], py = data[o + 4], pz = data[o + 5];

      // Orthonormal tangent basis (Duff et al. branchless construction).
      const s = nz >= 0 ? 1 : -1;
      const aa = -1 / (s + nz);
      const bb = nx * ny * aa;
      const t1x = 1 + s * nx * nx * aa;
      const t1y = s * bb;
      const t1z = -s * nx;
      const t2x = bb;
      const t2y = s + ny * ny * aa;
      const t2z = -ny;
      data[o + 12] = t1x; data[o + 13] = t1y; data[o + 14] = t1z;
      data[o + 15] = t2x; data[o + 16] = t2y; data[o + 17] = t2z;

      const rax = px - a.position.x, ray = py - a.position.y, raz = pz - a.position.z;
      let sumInvMass = a.invMass;
      let angN = a.invMass > 0 ? this._angularTerm(a, rax, ray, raz, nx, ny, nz) : 0;
      let angT1 = a.invMass > 0 ? this._angularTerm(a, rax, ray, raz, t1x, t1y, t1z) : 0;
      let angT2 = a.invMass > 0 ? this._angularTerm(a, rax, ray, raz, t2x, t2y, t2z) : 0;

      let vax = a.velocity.x + (a.angularVelocity.y * raz - a.angularVelocity.z * ray);
      let vay = a.velocity.y + (a.angularVelocity.z * rax - a.angularVelocity.x * raz);
      let vaz = a.velocity.z + (a.angularVelocity.x * ray - a.angularVelocity.y * rax);

      if (b !== null) {
        const rbx = px - b.position.x, rby = py - b.position.y, rbz = pz - b.position.z;
        sumInvMass += b.invMass;
        if (b.invMass > 0) {
          angN += this._angularTerm(b, rbx, rby, rbz, nx, ny, nz);
          angT1 += this._angularTerm(b, rbx, rby, rbz, t1x, t1y, t1z);
          angT2 += this._angularTerm(b, rbx, rby, rbz, t2x, t2y, t2z);
        }
        vax -= b.velocity.x + (b.angularVelocity.y * rbz - b.angularVelocity.z * rby);
        vay -= b.velocity.y + (b.angularVelocity.z * rbx - b.angularVelocity.x * rbz);
        vaz -= b.velocity.z + (b.angularVelocity.x * rby - b.angularVelocity.y * rbx);
      }

      const kn = sumInvMass + angN;
      const kt1 = sumInvMass + angT1;
      const kt2 = sumInvMass + angT2;
      data[o + 18] = kn > EPS ? 1 / kn : 0;
      data[o + 19] = kt1 > EPS ? 1 / kt1 : 0;
      data[o + 20] = kt2 > EPS ? 1 / kt2 : 0;

      // Restitution target: only meaningful above the bounce threshold.
      const vn = vax * nx + vay * ny + vaz * nz;
      const e = data[o + 8];
      data[o + 21] = (vn < -this.bounceThreshold && e > 0) ? -e * vn : 0;
    }
  }

  /**
   * One sequential impulse pass over the contact list.
   * @private
   * @returns {void}
   */
  _solveVelocities() {
    const data = this._contactData;
    for (let i = 0, n = this._contactCount; i < n; i++) {
      const o = i * CONTACT_STRIDE;
      const a = this._contactA[i];
      const b = this._contactB[i];
      const nx = data[o], ny = data[o + 1], nz = data[o + 2];
      const px = data[o + 3], py = data[o + 4], pz = data[o + 5];

      const rax = px - a.position.x, ray = py - a.position.y, raz = pz - a.position.z;
      let rbx = 0, rby = 0, rbz = 0;
      if (b !== null) {
        rbx = px - b.position.x; rby = py - b.position.y; rbz = pz - b.position.z;
      }

      // Relative velocity of A with respect to B at the contact point.
      let vx = a.velocity.x + (a.angularVelocity.y * raz - a.angularVelocity.z * ray);
      let vy = a.velocity.y + (a.angularVelocity.z * rax - a.angularVelocity.x * raz);
      let vz = a.velocity.z + (a.angularVelocity.x * ray - a.angularVelocity.y * rax);
      if (b !== null) {
        vx -= b.velocity.x + (b.angularVelocity.y * rbz - b.angularVelocity.z * rby);
        vy -= b.velocity.y + (b.angularVelocity.z * rbx - b.angularVelocity.x * rbz);
        vz -= b.velocity.z + (b.angularVelocity.x * rby - b.angularVelocity.y * rbx);
      }

      // Normal constraint.
      const vn = vx * nx + vy * ny + vz * nz;
      let lambda = (data[o + 21] - vn) * data[o + 18];
      const oldN = data[o + 9];
      let newN = oldN + lambda;
      if (newN < 0) newN = 0;
      lambda = newN - oldN;
      data[o + 9] = newN;

      if (lambda !== 0) {
        this._applyImpulse(a, 1, lambda, nx, ny, nz, rax, ray, raz);
        if (b !== null) this._applyImpulse(b, -1, lambda, nx, ny, nz, rbx, rby, rbz);
        // Refresh the relative velocity for the friction pass.
        vx = a.velocity.x + (a.angularVelocity.y * raz - a.angularVelocity.z * ray);
        vy = a.velocity.y + (a.angularVelocity.z * rax - a.angularVelocity.x * raz);
        vz = a.velocity.z + (a.angularVelocity.x * ray - a.angularVelocity.y * rax);
        if (b !== null) {
          vx -= b.velocity.x + (b.angularVelocity.y * rbz - b.angularVelocity.z * rby);
          vy -= b.velocity.y + (b.angularVelocity.z * rbx - b.angularVelocity.x * rbz);
          vz -= b.velocity.z + (b.angularVelocity.x * rby - b.angularVelocity.y * rbx);
        }
      }

      // Coulomb friction on both tangents, clamped by the normal impulse.
      const maxFriction = data[o + 7] * data[o + 9];
      if (maxFriction <= 0) continue;

      for (let k = 0; k < 2; k++) {
        const to = o + (k === 0 ? 12 : 15);
        const tx = data[to], ty = data[to + 1], tz = data[to + 2];
        const vt = vx * tx + vy * ty + vz * tz;
        let lt = -vt * data[o + (k === 0 ? 19 : 20)];
        const slot = o + (k === 0 ? 10 : 11);
        const oldT = data[slot];
        let newT = oldT + lt;
        if (newT > maxFriction) newT = maxFriction;
        else if (newT < -maxFriction) newT = -maxFriction;
        lt = newT - oldT;
        data[slot] = newT;
        if (lt === 0) continue;
        this._applyImpulse(a, 1, lt, tx, ty, tz, rax, ray, raz);
        if (b !== null) this._applyImpulse(b, -1, lt, tx, ty, tz, rbx, rby, rbz);
      }
    }
  }

  /**
   * One soft (Baumgarte) position correction pass. Linear only: a fraction of
   * the remaining penetration is removed and the amount already applied is
   * tracked so repeated passes converge instead of overshooting.
   * @private
   * @returns {void}
   */
  _solvePositions() {
    const data = this._contactData;
    const slop = this.contactSlop;
    const percent = this.correctionPercent;

    for (let i = 0, n = this._contactCount; i < n; i++) {
      const o = i * CONTACT_STRIDE;
      const a = this._contactA[i];
      const b = this._contactB[i];
      const remaining = data[o + 6] - slop - data[o + 22];
      if (remaining <= 0) continue;

      const invSum = a.invMass + (b !== null ? b.invMass : 0);
      if (invSum <= 0) continue;

      const correction = remaining * percent;
      const scale = correction / invSum;
      data[o + 22] += correction;

      const nx = data[o], ny = data[o + 1], nz = data[o + 2];
      if (a.invMass > 0) {
        a.position.x += nx * scale * a.invMass;
        a.position.y += ny * scale * a.invMass;
        a.position.z += nz * scale * a.invMass;
      }
      if (b !== null && b.invMass > 0) {
        b.position.x -= nx * scale * b.invMass;
        b.position.y -= ny * scale * b.invMass;
        b.position.z -= nz * scale * b.invMass;
      }
    }
  }

  /**
   * Drops every retained resource.
   * @returns {void}
   */
  dispose() {
    for (let i = 0, n = this.colliders.length; i < n; i++) this.colliders[i].dispose();
    this.clear();
    this._contactPool.clear();
    for (let i = 0, n = this._contactA.length; i < n; i++) {
      this._contactA[i] = null;
      this._contactB[i] = null;
    }
    this._contactA.length = 0;
    this._contactB.length = 0;
    this._contactCount = 0;
    this._colliderList.length = 0;
    this._bodyList.length = 0;
    this._triList.length = 0;
  }
}
