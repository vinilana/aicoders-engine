/**
 * Headless self test for src/math.
 * Run with: node tools/test-math.mjs
 * Exits with a non zero status when any assertion fails.
 */

import {
  EPSILON, DEG2RAD, RAD2DEG, PI2, clamp, lerp, inverseLerp, smoothstep, damp,
  nextPowerOfTwo, isPowerOfTwo, seededRandom, hash32, euclideanModulo
} from '../src/math/MathUtils.js';
import { Vec2 } from '../src/math/Vec2.js';
import { Vec3 } from '../src/math/Vec3.js';
import { Vec4 } from '../src/math/Vec4.js';
import { Quat } from '../src/math/Quat.js';
import { Euler } from '../src/math/Euler.js';
import { Mat3 } from '../src/math/Mat3.js';
import { Mat4 } from '../src/math/Mat4.js';
import { Color, srgbToLinear, linearToSRGB } from '../src/math/Color.js';
import { Plane } from '../src/math/Plane.js';
import { Frustum } from '../src/math/Frustum.js';
import { AABB } from '../src/math/AABB.js';
import { Sphere } from '../src/math/Sphere.js';
import { Ray } from '../src/math/Ray.js';

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {boolean} cond
 * @param {string} label
 */
function ok(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`FAIL  ${label}`);
  }
}

/**
 * @param {number} a
 * @param {number} b
 * @param {string} label
 * @param {number} [eps=1e-5]
 */
function near(a, b, label, eps = 1e-5) {
  const good = Number.isFinite(a) && Math.abs(a - b) <= eps;
  ok(good, `${label} (got ${a}, expected ${b})`);
}

/**
 * @param {{x:number,y:number,z:number}} v
 * @param {number} x @param {number} y @param {number} z
 * @param {string} label
 * @param {number} [eps=1e-5]
 */
function nearVec3(v, x, y, z, label, eps = 1e-5) {
  const good = Math.abs(v.x - x) <= eps && Math.abs(v.y - y) <= eps && Math.abs(v.z - z) <= eps;
  ok(good, `${label} (got ${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)} expected ${x},${y},${z})`);
}

/**
 * @param {Mat4} m
 * @param {Mat4} n
 * @param {string} label
 * @param {number} [eps=1e-4]
 */
function nearMat4(m, n, label, eps = 1e-4) {
  let maxDiff = 0;
  for (let i = 0; i < 16; i++) {
    const d = Math.abs(m.elements[i] - n.elements[i]);
    if (d > maxDiff) maxDiff = d;
  }
  ok(maxDiff <= eps, `${label} (max element diff ${maxDiff})`);
}

// ---------------------------------------------------------------- MathUtils
near(DEG2RAD * 180, Math.PI, 'DEG2RAD converts 180 deg to PI');
near(RAD2DEG * Math.PI, 180, 'RAD2DEG converts PI to 180 deg');
near(PI2, Math.PI * 2, 'PI2 equals 2 PI');
ok(EPSILON > 0 && EPSILON < 1e-3, 'EPSILON is a small positive number');
near(clamp(5, 0, 1), 1, 'clamp upper bound');
near(clamp(-5, 0, 1), 0, 'clamp lower bound');
near(lerp(0, 10, 0.25), 2.5, 'lerp midpoint');
near(inverseLerp(10, 20, 12.5), 0.25, 'inverseLerp round trip');
near(smoothstep(0, 1, 0.5), 0.5, 'smoothstep midpoint');
near(smoothstep(0, 1, -3), 0, 'smoothstep clamps below');
ok(Math.abs(damp(0, 1, 10, 0.016) - (1 - Math.exp(-0.16))) < 1e-9, 'damp matches exponential form');
near(nextPowerOfTwo(100), 128, 'nextPowerOfTwo(100) is 128');
ok(isPowerOfTwo(1024) && !isPowerOfTwo(1000), 'isPowerOfTwo detects powers of two');
near(euclideanModulo(-1, 3), 2, 'euclideanModulo keeps the sign of the divisor');
{
  const rng1 = seededRandom(1234);
  const rng2 = seededRandom(1234);
  let same = true;
  let inRange = true;
  for (let i = 0; i < 32; i++) {
    const a = rng1(), b = rng2();
    if (a !== b) same = false;
    if (a < 0 || a >= 1) inRange = false;
  }
  ok(same, 'seededRandom is deterministic for the same seed');
  ok(inRange, 'seededRandom stays in [0,1)');
  ok(hash32(7) === hash32(7) && hash32(7) !== hash32(8), 'hash32 is stable and varies');
  ok(hash32(-1) >= 0, 'hash32 returns an unsigned value');
}

// --------------------------------------------------------------------- Vec2
{
  const a = new Vec2(3, 4);
  near(a.length(), 5, 'Vec2 length');
  near(a.clone().normalize().length(), 1, 'Vec2 normalize');
  near(new Vec2(1, 0).cross(new Vec2(0, 1)), 1, 'Vec2 cross of unit axes');
  near(new Vec2(1, 0).rotate(Math.PI / 2).y, 1, 'Vec2 rotate 90 degrees');
}

// --------------------------------------------------------------------- Vec3
{
  const a = new Vec3(1, 0, 0);
  const b = new Vec3(0, 1, 0);
  const c = new Vec3().crossVectors(a, b);
  nearVec3(c, 0, 0, 1, 'Vec3 cross of X and Y is Z');
  near(a.dot(b), 0, 'Vec3 dot of orthogonal axes');
  near(new Vec3(3, 4, 12).length(), 13, 'Vec3 length');
  near(new Vec3(1, 2, 3).distanceTo(new Vec3(4, 6, 15)), 13, 'Vec3 distanceTo');
  nearVec3(new Vec3(2, 0, 0).setLength(5), 5, 0, 0, 'Vec3 setLength');
  near(new Vec3(1, 1, 0).angleTo(new Vec3(1, 0, 0)), Math.PI / 4, 'Vec3 angleTo');
  nearVec3(new Vec3(1, -1, 0).reflect(new Vec3(0, 1, 0)), 1, 1, 0, 'Vec3 reflect on the ground plane');
  nearVec3(new Vec3(3, 3, 0).project(new Vec3(1, 0, 0)), 3, 0, 0, 'Vec3 project onto X');
  ok(Vec3.UP.x === 0 && Vec3.UP.y === 1 && Vec3.FORWARD.z === -1, 'Vec3 constants follow the engine convention');
  let frozen = true;
  try {
    Vec3.UP.x = 99;
    frozen = Vec3.UP.x === 0;
  } catch (e) {
    frozen = true;
  }
  ok(frozen, 'Vec3 constants are frozen');
  const sph = new Vec3().setFromSpherical(2, Math.PI / 2, 0);
  nearVec3(sph, 0, 0, 2, 'Vec3 setFromSpherical at the equator');
}

// --------------------------------------------------------------------- Vec4
{
  const v = new Vec4(1, 2, 3, 1);
  const m = new Mat4().makeTranslation(10, 20, 30);
  v.applyMat4(m);
  ok(v.x === 11 && v.y === 22 && v.z === 33 && v.w === 1, 'Vec4 applyMat4 translates points');
  const dir = new Vec4(1, 0, 0, 0).applyMat4(m);
  ok(dir.x === 1 && dir.y === 0 && dir.z === 0, 'Vec4 with w=0 ignores translation');
  near(new Vec4(1, 1, 1, 1).length(), 2, 'Vec4 length');
}

// --------------------------------------------------------------------- Mat4
{
  const m = new Mat4().set(
    1, 2, 3, 4,
    5, 6, 7, 8,
    9, 10, 11, 12,
    13, 14, 15, 16
  );
  ok(m.elements[0] === 1 && m.elements[1] === 5 && m.elements[4] === 2,
    'Mat4.set takes row major arguments and stores column major');

  const a = new Mat4().compose(new Vec3(1, 2, 3), new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.7), new Vec3(2, 2, 2));
  const inv = a.clone().invert();
  const id = new Mat4().multiplyMatrices(a, inv);
  nearMat4(id, new Mat4(), 'Mat4 invert of an affine matrix gives the identity');

  const proj = new Mat4().perspective(60 * DEG2RAD, 16 / 9, 0.1, 1000);
  const projInv = proj.clone().invert();
  nearMat4(new Mat4().multiplyMatrices(proj, projInv), new Mat4(),
    'Mat4 invert works on a projection matrix (full cofactor expansion)');

  const singular = new Mat4().set(
    1, 2, 3, 4,
    2, 4, 6, 8,
    1, 0, 1, 0,
    0, 1, 0, 1
  );
  ok(singular.clone().invert().equals(new Mat4()), 'Mat4 invert returns the identity for singular matrices');

  near(new Mat4().makeScale(2, 3, 4).determinant(), 24, 'Mat4 determinant of a scale matrix');
  near(new Mat4().makeRotationY(0.9).determinant(), 1, 'Mat4 determinant of a rotation is 1');

  // compose / decompose round trip
  const pos = new Vec3(-3, 7, 11);
  const rot = new Quat().setFromEuler(new Euler(0.3, -1.1, 0.7, 'YXZ'));
  const scl = new Vec3(2, 0.5, 3);
  const composed = new Mat4().compose(pos, rot, scl);
  const p2 = new Vec3(), q2 = new Quat(), s2 = new Vec3();
  composed.decompose(p2, q2, s2);
  nearVec3(p2, pos.x, pos.y, pos.z, 'decompose recovers the position');
  nearVec3(s2, scl.x, scl.y, scl.z, 'decompose recovers the scale', 1e-4);
  ok(Math.abs(Math.abs(q2.dot(rot)) - 1) < 1e-5, 'decompose recovers the rotation (up to sign)');
  nearMat4(new Mat4().compose(p2, q2, s2), composed, 'compose(decompose(m)) reproduces m');

  // negative scale handling
  const negScale = new Vec3(-2, 2, 2);
  const negM = new Mat4().compose(pos, rot, negScale);
  const p3 = new Vec3(), q3 = new Quat(), s3 = new Vec3();
  negM.decompose(p3, q3, s3);
  ok(s3.x < 0, 'decompose folds a mirrored matrix into a negative X scale');
  nearMat4(new Mat4().compose(p3, q3, s3), negM, 'compose(decompose(m)) reproduces a mirrored matrix');

  // transpose / multiply
  const t = new Mat4().makeTranslation(1, 2, 3);
  const r = new Mat4().makeRotationZ(Math.PI / 2);
  const tr = new Mat4().multiplyMatrices(t, r);
  const p = new Vec3(1, 0, 0).applyMat4(tr);
  nearVec3(p, 1, 3, 3, 'Mat4 multiply applies rotation before translation');
  nearMat4(new Mat4().copy(t).transpose().transpose(), t, 'Mat4 transpose is an involution');
  near(new Mat4().makeScale(3, 1, 2).getMaxScaleOnAxis(), 3, 'Mat4 getMaxScaleOnAxis');

  // view / lookAt
  const eye = new Vec3(0, 0, 10);
  const target = new Vec3(0, 0, 0);
  const world = new Mat4().lookAt(eye, target, Vec3.UP);
  const view = new Mat4().makeView(eye, target, Vec3.UP);
  nearMat4(new Mat4().multiplyMatrices(world, view), new Mat4(), 'makeView is the inverse of lookAt');
  const seen = new Vec3(0, 0, 0).applyMat4(view);
  nearVec3(seen, 0, 0, -10, 'a point in front of the camera lands on -Z in view space');

  // projection sanity
  const perspective = new Mat4().perspective(90 * DEG2RAD, 1, 1, 101);
  const nearPoint = new Vec3(0, 0, -1).applyMat4(perspective);
  const farPoint = new Vec3(0, 0, -101).applyMat4(perspective);
  near(nearPoint.z, -1, 'perspective maps the near plane to -1');
  near(farPoint.z, 1, 'perspective maps the far plane to +1', 1e-4);
  const ortho = new Mat4().orthographic(-1, 1, -1, 1, 1, 3);
  near(new Vec3(1, 1, -1).applyMat4(ortho).x, 1, 'orthographic maps the right plane to +1');
  near(new Vec3(0, 0, -3).applyMat4(ortho).z, 1, 'orthographic maps the far plane to +1');
}

// --------------------------------------------------------------------- Mat3
{
  const m4 = new Mat4().compose(new Vec3(5, 0, 0), new Quat().setFromAxisAngle(new Vec3(1, 0, 0), 0.4), new Vec3(2, 2, 2));
  const normalMatrix = new Mat3().getNormalMatrix(m4);
  const n = new Vec3(0, 1, 0).applyMat3(normalMatrix).normalize();
  const expected = new Vec3(0, 1, 0).applyQuat(new Quat().setFromAxisAngle(new Vec3(1, 0, 0), 0.4));
  nearVec3(n, expected.x, expected.y, expected.z, 'Mat3 normal matrix rotates normals correctly');

  const m3 = new Mat3().set(
    2, 0, 1,
    0, 1, 0,
    1, 0, 3
  );
  const prod = new Mat3().multiplyMatrices(m3, m3.clone().invert());
  ok(prod.nearlyEquals(new Mat3(), 1e-5), 'Mat3 invert gives the identity');
  near(m3.determinant(), 5, 'Mat3 determinant');
}

// --------------------------------------------------------------------- Quat
{
  const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
  const v = new Vec3(1, 0, 0).applyQuat(q);
  nearVec3(v, 0, 0, -1, 'Quat rotates +X to -Z around +Y (right handed)');

  const m = new Mat4().makeRotationFromQuat(q);
  const q2 = new Quat().setFromRotationMatrix(m);
  ok(Math.abs(Math.abs(q.dot(q2)) - 1) < 1e-6, 'Quat matrix round trip (Shepperd)');

  // Shepperd stability: 180 degree rotations have a zero trace branch
  const q180 = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), Math.PI);
  const m180 = new Mat4().makeRotationFromQuat(q180);
  const q180b = new Quat().setFromRotationMatrix(m180);
  ok(Math.abs(Math.abs(q180.dot(q180b)) - 1) < 1e-6, 'Quat round trip for a 180 degree rotation');
  const q180x = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), Math.PI);
  const q180xb = new Quat().setFromRotationMatrix(new Mat4().makeRotationFromQuat(q180x));
  ok(Math.abs(Math.abs(q180x.dot(q180xb)) - 1) < 1e-6, 'Quat round trip for a 180 degree X rotation');

  const qa = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0);
  const qb = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
  const qs = new Quat().slerpQuaternions(qa, qb, 0.5);
  const expected = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 4);
  ok(Math.abs(Math.abs(qs.dot(expected)) - 1) < 1e-6, 'slerp halfway equals half the angle');
  near(qs.length(), 1, 'slerp keeps the quaternion normalized');
  near(qa.angleTo(qb), Math.PI / 2, 'Quat angleTo');

  const flat = new Float32Array(4);
  Quat.slerpFlat(flat, 0, qa.toArray([], 0), 0, qb.toArray([], 0), 0, 0.5);
  ok(Math.abs(Math.abs(flat[0] * expected.x + flat[1] * expected.y + flat[2] * expected.z + flat[3] * expected.w) - 1) < 1e-5,
    'Quat.slerpFlat matches slerp');

  const inv = q.clone().invert();
  const idq = new Quat().multiplyQuaternions(q, inv);
  ok(Math.abs(idq.w - 1) < 1e-6 && Math.abs(idq.x) < 1e-6, 'Quat invert cancels the rotation');

  const u = new Quat().setFromUnitVectors(new Vec3(1, 0, 0), new Vec3(0, 0, -1));
  nearVec3(new Vec3(1, 0, 0).applyQuat(u), 0, 0, -1, 'setFromUnitVectors maps from to to');
  const flip = new Quat().setFromUnitVectors(new Vec3(1, 0, 0), new Vec3(-1, 0, 0));
  nearVec3(new Vec3(1, 0, 0).applyQuat(flip), -1, 0, 0, 'setFromUnitVectors handles opposite vectors');

  const look = new Quat().lookRotation(new Vec3(0, 0, -1), Vec3.UP);
  nearVec3(new Vec3(0, 0, -1).applyQuat(look), 0, 0, -1, 'lookRotation towards -Z is the identity rotation');
  const look2 = new Quat().lookRotation(new Vec3(1, 0, 0), Vec3.UP);
  nearVec3(new Vec3(0, 0, -1).applyQuat(look2), 1, 0, 0, 'lookRotation aims local -Z at the target direction');

  const step = new Quat().copy(qa).rotateTowards(qb, Math.PI / 4);
  near(qa.angleTo(step), Math.PI / 4, 'rotateTowards advances by the requested angle');

  // combined rotations must match matrix composition
  const qx = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), 0.6);
  const qy = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), -0.4);
  const combined = new Quat().multiplyQuaternions(qy, qx);
  const viaMat = new Mat4().multiplyMatrices(
    new Mat4().makeRotationFromQuat(qy),
    new Mat4().makeRotationFromQuat(qx)
  );
  nearMat4(new Mat4().makeRotationFromQuat(combined), viaMat, 'quaternion product matches matrix product');
}

// -------------------------------------------------------------------- Euler
{
  const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];
  let allGood = true;
  for (let i = 0; i < orders.length; i++) {
    const e = new Euler(0.31, -0.72, 1.13, orders[i]);
    const q = new Quat().setFromEuler(e);
    const e2 = new Euler().setFromQuat(q, orders[i]);
    const q2 = new Quat().setFromEuler(e2);
    if (Math.abs(Math.abs(q.dot(q2)) - 1) > 1e-5) allGood = false;
  }
  ok(allGood, 'Euler <-> Quat round trip for every rotation order');

  const e = new Euler(0, Math.PI / 2, 0, 'YXZ');
  const q = new Quat().setFromEuler(e);
  nearVec3(new Vec3(0, 0, -1).applyQuat(q), -1, 0, 0, 'Euler yaw of +90 deg turns -Z into -X');

  const m = new Euler(0.2, 0.3, 0.4, 'XYZ').toRotationMatrix(new Mat4());
  const qFromMat = new Quat().setFromRotationMatrix(m);
  const qFromEuler = new Quat().setFromEuler(new Euler(0.2, 0.3, 0.4, 'XYZ'));
  ok(Math.abs(Math.abs(qFromMat.dot(qFromEuler)) - 1) < 1e-6, 'Euler.toRotationMatrix agrees with Quat.setFromEuler');
}

// -------------------------------------------------------------------- Color
{
  const c = new Color().setHex(0xffffff);
  near(c.r, 1, 'white hex converts to linear 1');
  const mid = new Color().setHex(0x808080);
  ok(mid.r > 0.2 && mid.r < 0.24, 'mid grey sRGB maps to ~0.2159 linear');
  near(srgbToLinear(linearToSRGB(0.35)), 0.35, 'sRGB <-> linear round trip', 1e-6);
  near(srgbToLinear(0.04), 0.04 / 12.92, 'sRGB linear segment below 0.04045', 1e-9);
  near(new Color().setHex(0x808080).getHex(), 0x808080, 'Color getHex round trip', 0);
  const red = new Color().setStyle('#ff0000');
  ok(red.r === 1 && red.g === 0 && red.b === 0, 'setStyle parses #rrggbb');
  const short = new Color().setStyle('#f00');
  ok(short.r === 1 && short.g === 0 && short.b === 0, 'setStyle parses #rgb');
  const rgb = new Color().setStyle('rgb(255, 0, 0)');
  ok(rgb.r === 1 && rgb.g === 0, 'setStyle parses rgb()');
  const hsl = new Color().setHSL(0, 1, 0.5);
  ok(hsl.r > 0.9 && hsl.g < 0.01, 'setHSL red hue');
  const hslOut = new Color().setHSL(0.5, 0.75, 0.4).getHSL({ h: 0, s: 0, l: 0 });
  near(hslOut.h, 0.5, 'getHSL recovers the hue', 1e-4);
  near(new Color(0.5, 0.5, 0.5).lerp(new Color(1, 1, 1), 0.5).r, 0.75, 'Color lerp');
}

// -------------------------------------------------------------- Plane / Frustum
{
  const p = new Plane().setFromNormalAndCoplanarPoint(new Vec3(0, 1, 0), new Vec3(0, 5, 0));
  near(p.distanceToPoint(new Vec3(0, 8, 0)), 3, 'Plane distanceToPoint above');
  near(p.distanceToPoint(new Vec3(0, 1, 0)), -4, 'Plane distanceToPoint below');
  near(p.distanceToSphere(new Sphere(new Vec3(0, 8, 0), 1)), 2, 'Plane distanceToSphere');
  const unnormalized = new Plane().setComponents(0, 4, 0, -20).normalize();
  near(unnormalized.normal.y, 1, 'Plane normalize scales the normal');
  near(unnormalized.constant, -5, 'Plane normalize scales the constant');

  const camera = new Mat4().makeView(new Vec3(0, 0, 10), new Vec3(0, 0, 0), Vec3.UP);
  const proj = new Mat4().perspective(60 * DEG2RAD, 1, 1, 100);
  const viewProj = new Mat4().multiplyMatrices(proj, camera);
  const f = new Frustum().setFromProjectionMatrix(viewProj);

  let normalized = true;
  for (let i = 0; i < 6; i++) {
    if (Math.abs(f.planes[i].normal.length() - 1) > 1e-5) normalized = false;
  }
  ok(normalized, 'Frustum planes are normalized');
  ok(f.containsPoint(new Vec3(0, 0, 0)), 'Frustum contains the point it looks at');
  ok(!f.containsPoint(new Vec3(0, 0, 50)), 'Frustum rejects points behind the camera');
  ok(!f.containsPoint(new Vec3(0, 0, -95)), 'Frustum rejects points beyond the far plane');
  ok(!f.containsPoint(new Vec3(100, 0, 0)), 'Frustum rejects points outside the side planes');
  ok(f.intersectsSphere(new Sphere(new Vec3(0, 0, 0), 1)), 'Frustum intersects a sphere in view');
  ok(!f.intersectsSphere(new Sphere(new Vec3(0, 0, 1000), 1)), 'Frustum rejects a distant sphere behind');
  ok(f.intersectsSphere(new Sphere(new Vec3(0, 0, 30), 25)), 'Frustum accepts a big sphere that straddles the camera');
  ok(f.intersectsAABB(new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1))), 'Frustum intersects an AABB at the origin');
  ok(!f.intersectsAABB(new AABB(new Vec3(-1, -1, 100), new Vec3(1, 1, 102))), 'Frustum rejects an AABB behind the camera');
  ok(f.intersectsAABBMinMax(-1, -1, -1, 1, 1, 1), 'intersectsAABBMinMax accepts a visible box');
  ok(!f.intersectsAABBMinMax(-1, -1, 100, 1, 1, 102), 'intersectsAABBMinMax rejects a box behind');
  ok(f.intersectsAABBMinMax(-1000, -1000, -1000, 1000, 1000, 1000), 'intersectsAABBMinMax accepts a box containing the frustum');
  ok(f.containsAABBMinMax(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5), 'containsAABBMinMax detects a fully inside box');
  ok(!f.containsAABBMinMax(-1000, -1000, -1000, 1000, 1000, 1000), 'containsAABBMinMax rejects a partially outside box');
  ok(f.classifySphere(new Sphere(new Vec3(0, 0, 0), 0.1)) === 1, 'classifySphere reports full containment');
  ok(f.classifySphere(new Sphere(new Vec3(0, 0, 1000), 1)) === -1, 'classifySphere reports outside');
}

// --------------------------------------------------------------------- AABB
{
  const box = new AABB(new Vec3(-1, -2, -3), new Vec3(1, 2, 3));
  nearVec3(box.getCenter(new Vec3()), 0, 0, 0, 'AABB getCenter');
  nearVec3(box.getSize(new Vec3()), 2, 4, 6, 'AABB getSize');
  near(box.surfaceArea(), 2 * (2 * 4 + 4 * 6 + 6 * 2), 'AABB surfaceArea');
  ok(box.containsPoint(new Vec3(0, 0, 0)) && !box.containsPoint(new Vec3(0, 0, 4)), 'AABB containsPoint');
  ok(box.intersectsAABB(new AABB(new Vec3(0, 0, 0), new Vec3(5, 5, 5))), 'AABB intersectsAABB overlapping');
  ok(!box.intersectsAABB(new AABB(new Vec3(9, 9, 9), new Vec3(10, 10, 10))), 'AABB intersectsAABB disjoint');
  ok(box.intersectsSphere(new Sphere(new Vec3(2, 0, 0), 1.5)), 'AABB intersectsSphere');
  near(box.distanceToPoint(new Vec3(4, 0, 0)), 3, 'AABB distanceToPoint');
  nearVec3(box.clampPoint(new Vec3(10, 0, 0), new Vec3()), 1, 0, 0, 'AABB clampPoint');

  const empty = new AABB().makeEmpty();
  ok(empty.isEmpty(), 'AABB makeEmpty produces an empty box');
  empty.expandByPoint(new Vec3(1, 1, 1));
  ok(!empty.isEmpty() && empty.min.x === 1, 'AABB expandByPoint initializes the box');

  // Arvo transform: compare against the brute force 8 corner transform
  const m = new Mat4().compose(
    new Vec3(3, -2, 1),
    new Quat().setFromEuler(new Euler(0.4, 0.9, -0.2, 'XYZ')),
    new Vec3(1.5, 2, 0.5)
  );
  const arvo = box.clone().applyMat4(m);
  const brute = new AABB().makeEmpty();
  const corner = new Vec3();
  for (let i = 0; i < 8; i++) {
    box.getCorner(i, corner).applyMat4(m);
    brute.expandByPoint(corner);
  }
  ok(arvo.min.nearlyEquals(brute.min, 1e-4) && arvo.max.nearlyEquals(brute.max, 1e-4),
    'AABB applyMat4 (Arvo) matches the 8 corner transform');

  const sphereOut = box.getBoundingSphere(new Sphere());
  near(sphereOut.radius, Math.sqrt(1 + 4 + 9), 'AABB getBoundingSphere radius');

  const fromArray = new AABB().setFromArray(new Float32Array([0, 0, 0, 1, 2, 3, -1, -5, 2]));
  ok(fromArray.min.y === -5 && fromArray.max.z === 3, 'AABB setFromArray');
  ok(new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)).containsAABB(new AABB(new Vec3(0, 0, 0), new Vec3(0.5, 0.5, 0.5))),
    'AABB containsAABB');
}

// ------------------------------------------------------------------- Sphere
{
  const s = new Sphere(new Vec3(0, 0, 0), 2);
  ok(s.containsPoint(new Vec3(1, 1, 1)), 'Sphere containsPoint inside');
  ok(!s.containsPoint(new Vec3(3, 0, 0)), 'Sphere containsPoint outside');
  ok(s.intersectsSphere(new Sphere(new Vec3(3, 0, 0), 1.5)), 'Sphere intersectsSphere');
  ok(s.intersectsAABB(new AABB(new Vec3(1.5, -1, -1), new Vec3(4, 1, 1))), 'Sphere intersectsAABB');
  const scaled = s.clone().applyMat4(new Mat4().compose(new Vec3(1, 0, 0), new Quat(), new Vec3(3, 3, 3)));
  near(scaled.radius, 6, 'Sphere applyMat4 scales the radius');
  nearVec3(scaled.center, 1, 0, 0, 'Sphere applyMat4 moves the center');
  const fromBox = new Sphere().setFromAABB(new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)));
  near(fromBox.radius, Math.sqrt(3), 'Sphere setFromAABB');
  const grown = new Sphere(new Vec3(0, 0, 0), 1).expandByPoint(new Vec3(3, 0, 0));
  ok(grown.containsPoint(new Vec3(3, 0, 0)) && grown.radius >= 2, 'Sphere expandByPoint contains the new point');
}

// ---------------------------------------------------------------------- Ray
{
  const ray = new Ray(new Vec3(0, 0, 5), new Vec3(0, 0, -1));
  const box = new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
  const hit = new Vec3();
  near(ray.intersectAABB(box, hit), 4, 'Ray intersectAABB entry distance');
  nearVec3(hit, 0, 0, 1, 'Ray intersectAABB hit point');
  ok(new Ray(new Vec3(0, 0, -5), new Vec3(0, 0, -1)).intersectAABB(box) === -1, 'Ray misses a box behind it');
  ok(new Ray(new Vec3(5, 5, 5), new Vec3(0, 0, -1)).intersectAABB(box) === -1, 'Ray misses a box off axis');

  // axis aligned ray with zero direction components must not produce NaN
  const grazing = new Ray(new Vec3(1, 0, 5), new Vec3(0, 0, -1));
  ok(grazing.intersectAABB(box) === 4, 'Ray on the box border still hits (zero direction components handled)');
  const parallelOutside = new Ray(new Vec3(2, 0, 5), new Vec3(0, 0, -1));
  ok(parallelOutside.intersectAABB(box) === -1, 'Ray parallel to a slab outside the box misses');

  const inside = new Ray(new Vec3(0, 0, 0), new Vec3(0, 0, -1));
  near(inside.intersectAABB(box), 1, 'Ray starting inside returns the exit distance');

  const sphere = new Sphere(new Vec3(0, 0, 0), 1);
  near(ray.intersectSphere(sphere, hit), 4, 'Ray intersectSphere distance');
  nearVec3(hit, 0, 0, 1, 'Ray intersectSphere hit point');
  ok(new Ray(new Vec3(0, 5, 5), new Vec3(0, 0, -1)).intersectSphere(sphere) === -1, 'Ray misses the sphere');

  const plane = new Plane().setFromNormalAndCoplanarPoint(new Vec3(0, 1, 0), new Vec3(0, 0, 0));
  near(new Ray(new Vec3(0, 10, 0), new Vec3(0, -1, 0)).intersectPlane(plane), 10, 'Ray intersectPlane');
  ok(new Ray(new Vec3(0, 10, 0), new Vec3(0, 1, 0)).intersectPlane(plane) === -1, 'Ray pointing away from the plane misses');
  ok(new Ray(new Vec3(0, 10, 0), new Vec3(1, 0, 0)).intersectPlane(plane) === -1, 'Ray parallel to the plane misses');

  // Moller-Trumbore
  const a = new Vec3(-1, -1, 0);
  const b = new Vec3(1, -1, 0);
  const c = new Vec3(0, 1, 0);
  const front = new Ray(new Vec3(0, 0, 5), new Vec3(0, 0, -1));
  const res = { t: 0, u: 0, v: 0 };
  near(front.intersectTriangle(a, b, c, false, res), 5, 'Ray intersectTriangle distance');
  ok(res.u >= 0 && res.v >= 0 && res.u + res.v <= 1, 'Ray intersectTriangle writes valid barycentrics');
  near(res.u + res.v + (1 - res.u - res.v), 1, 'barycentric coordinates sum to 1');
  ok(front.intersectTriangle(a, b, c, true) !== -1, 'front facing triangle passes backface culling');
  const backRay = new Ray(new Vec3(0, 0, -5), new Vec3(0, 0, 1));
  ok(backRay.intersectTriangle(a, b, c, false) === 5, 'back facing hit works without culling');
  ok(backRay.intersectTriangle(a, b, c, true) === -1, 'back facing hit is rejected with culling');
  ok(new Ray(new Vec3(5, 5, 5), new Vec3(0, 0, -1)).intersectTriangle(a, b, c, false) === -1, 'Ray misses the triangle');

  // distance helpers and transforms
  near(new Ray(new Vec3(0, 0, 0), new Vec3(1, 0, 0)).distanceSqToPoint(new Vec3(5, 3, 0)), 9, 'Ray distanceSqToPoint');
  const moved = new Ray(new Vec3(0, 0, 0), new Vec3(0, 0, -1)).applyMat4(new Mat4().makeTranslation(1, 2, 3));
  nearVec3(moved.origin, 1, 2, 3, 'Ray applyMat4 moves the origin');
  nearVec3(moved.direction, 0, 0, -1, 'Ray applyMat4 keeps the direction under translation');
  nearVec3(new Ray(new Vec3(0, 0, 0), new Vec3(0, 0, -1)).at(3, new Vec3()), 0, 0, -3, 'Ray at(t)');
}

// ---------------------------------------------------------------- reporting
console.log('');
console.log(`math tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) {
  console.log('');
  console.log('failing assertions:');
  for (let i = 0; i < failures.length; i++) console.log(`  - ${failures[i]}`);
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
process.exit(0);
