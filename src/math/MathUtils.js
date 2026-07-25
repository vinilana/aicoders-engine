/**
 * Scalar math helpers and constants shared by the whole engine.
 * Pure functions only - no allocations, no side effects, no globals.
 */

/** Generic tolerance used across the math library. */
export const EPSILON = 1e-6;
/** Degrees to radians factor. */
export const DEG2RAD = Math.PI / 180;
/** Radians to degrees factor. */
export const RAD2DEG = 180 / Math.PI;
/** Two times PI. */
export const PI2 = Math.PI * 2;
/** Half PI. */
export const PI_HALF = Math.PI * 0.5;

/**
 * Clamps a value into the inclusive range [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Linear interpolation between a and b.
 * @param {number} a
 * @param {number} b
 * @param {number} t Interpolation factor (not clamped).
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Inverse of {@link lerp}: returns the t that produces v between a and b.
 * Returns 0 when a === b.
 * @param {number} a
 * @param {number} b
 * @param {number} v
 * @returns {number}
 */
export function inverseLerp(a, b, v) {
  const d = b - a;
  if (d === 0) return 0;
  return (v - a) / d;
}

/**
 * Hermite smoothstep between two edges.
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smoothstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}

/**
 * Quintic smootherstep (zero 1st and 2nd derivatives at the edges).
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smootherstep(e0, e1, x) {
  if (e0 === e1) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Framerate independent exponential smoothing towards b.
 * @param {number} a Current value.
 * @param {number} b Target value.
 * @param {number} lambda Smoothing rate (higher = faster).
 * @param {number} dt Delta time in seconds.
 * @returns {number}
 */
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/**
 * Moves a towards b by at most maxDelta.
 * @param {number} a
 * @param {number} b
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveTowards(a, b, maxDelta) {
  const d = b - a;
  if (d > maxDelta) return a + maxDelta;
  if (d < -maxDelta) return a - maxDelta;
  return b;
}

/**
 * Smallest power of two greater than or equal to v.
 * @param {number} v
 * @returns {number}
 */
export function nextPowerOfTwo(v) {
  if (v <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(v)));
}

/**
 * Largest power of two less than or equal to v.
 * @param {number} v
 * @returns {number}
 */
export function floorPowerOfTwo(v) {
  if (v < 1) return 0;
  return Math.pow(2, Math.floor(Math.log2(v)));
}

/**
 * True when v is an exact power of two (v > 0).
 * @param {number} v
 * @returns {boolean}
 */
export function isPowerOfTwo(v) {
  return v > 0 && (v & (v - 1)) === 0;
}

/**
 * Random float in [min, max).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Random integer in [min, max] (both inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Creates a deterministic pseudo random generator (mulberry32).
 * @param {number} [seed=0]
 * @returns {function(): number} Generator producing floats in [0, 1).
 */
export function seededRandom(seed = 0) {
  let s = seed >>> 0;
  return function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Integer avalanche hash (lowbias32). Returns an unsigned 32 bit integer.
 * @param {number} i
 * @returns {number}
 */
export function hash32(i) {
  let x = i >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Deterministic float in [0, 1) derived from an integer.
 * @param {number} i
 * @returns {number}
 */
export function hashFloat(i) {
  return hash32(i) / 4294967296;
}

/**
 * Degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
export function degToRad(deg) {
  return deg * DEG2RAD;
}

/**
 * Radians to degrees.
 * @param {number} rad
 * @returns {number}
 */
export function radToDeg(rad) {
  return rad * RAD2DEG;
}

/**
 * Modulo that always returns a value with the sign of m.
 * @param {number} n
 * @param {number} m
 * @returns {number}
 */
export function euclideanModulo(n, m) {
  return ((n % m) + m) % m;
}

/**
 * Triangle wave: ping-pongs t in the range [0, length].
 * @param {number} t
 * @param {number} [length=1]
 * @returns {number}
 */
export function pingPong(t, length = 1) {
  return length - Math.abs(euclideanModulo(t, length * 2) - length);
}

/**
 * Wraps an angle (radians) into (-PI, PI].
 * @param {number} a
 * @returns {number}
 */
export function wrapAngle(a) {
  return euclideanModulo(a + Math.PI, PI2) - Math.PI;
}

/**
 * Shortest signed angular delta from a to b (radians).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function deltaAngle(a, b) {
  return wrapAngle(b - a);
}

/**
 * True when both values differ by less than eps.
 * @param {number} a
 * @param {number} b
 * @param {number} [eps=EPSILON]
 * @returns {boolean}
 */
export function nearlyEqual(a, b, eps = EPSILON) {
  return Math.abs(a - b) <= eps;
}
