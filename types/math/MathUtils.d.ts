/**
 * Clamps a value into the inclusive range [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(v: number, min: number, max: number): number;
/**
 * Linear interpolation between a and b.
 * @param {number} a
 * @param {number} b
 * @param {number} t Interpolation factor (not clamped).
 * @returns {number}
 */
export function lerp(a: number, b: number, t: number): number;
/**
 * Inverse of {@link lerp}: returns the t that produces v between a and b.
 * Returns 0 when a === b.
 * @param {number} a
 * @param {number} b
 * @param {number} v
 * @returns {number}
 */
export function inverseLerp(a: number, b: number, v: number): number;
/**
 * Hermite smoothstep between two edges.
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smoothstep(e0: number, e1: number, x: number): number;
/**
 * Quintic smootherstep (zero 1st and 2nd derivatives at the edges).
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smootherstep(e0: number, e1: number, x: number): number;
/**
 * Framerate independent exponential smoothing towards b.
 * @param {number} a Current value.
 * @param {number} b Target value.
 * @param {number} lambda Smoothing rate (higher = faster).
 * @param {number} dt Delta time in seconds.
 * @returns {number}
 */
export function damp(a: number, b: number, lambda: number, dt: number): number;
/**
 * Moves a towards b by at most maxDelta.
 * @param {number} a
 * @param {number} b
 * @param {number} maxDelta
 * @returns {number}
 */
export function moveTowards(a: number, b: number, maxDelta: number): number;
/**
 * Smallest power of two greater than or equal to v.
 * @param {number} v
 * @returns {number}
 */
export function nextPowerOfTwo(v: number): number;
/**
 * Largest power of two less than or equal to v.
 * @param {number} v
 * @returns {number}
 */
export function floorPowerOfTwo(v: number): number;
/**
 * True when v is an exact power of two (v > 0).
 * @param {number} v
 * @returns {boolean}
 */
export function isPowerOfTwo(v: number): boolean;
/**
 * Random float in [min, max).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randFloat(min: number, max: number): number;
/**
 * Random integer in [min, max] (both inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(min: number, max: number): number;
/**
 * Creates a deterministic pseudo random generator (mulberry32).
 * @param {number} [seed=0]
 * @returns {function(): number} Generator producing floats in [0, 1).
 */
export function seededRandom(seed?: number): () => number;
/**
 * Integer avalanche hash (lowbias32). Returns an unsigned 32 bit integer.
 * @param {number} i
 * @returns {number}
 */
export function hash32(i: number): number;
/**
 * Deterministic float in [0, 1) derived from an integer.
 * @param {number} i
 * @returns {number}
 */
export function hashFloat(i: number): number;
/**
 * Degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
export function degToRad(deg: number): number;
/**
 * Radians to degrees.
 * @param {number} rad
 * @returns {number}
 */
export function radToDeg(rad: number): number;
/**
 * Modulo that always returns a value with the sign of m.
 * @param {number} n
 * @param {number} m
 * @returns {number}
 */
export function euclideanModulo(n: number, m: number): number;
/**
 * Triangle wave: ping-pongs t in the range [0, length].
 * @param {number} t
 * @param {number} [length=1]
 * @returns {number}
 */
export function pingPong(t: number, length?: number): number;
/**
 * Wraps an angle (radians) into (-PI, PI].
 * @param {number} a
 * @returns {number}
 */
export function wrapAngle(a: number): number;
/**
 * Shortest signed angular delta from a to b (radians).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function deltaAngle(a: number, b: number): number;
/**
 * True when both values differ by less than eps.
 * @param {number} a
 * @param {number} b
 * @param {number} [eps=EPSILON]
 * @returns {boolean}
 */
export function nearlyEqual(a: number, b: number, eps?: number): boolean;
/**
 * Scalar math helpers and constants shared by the whole engine.
 * Pure functions only - no allocations, no side effects, no globals.
 */
/** Generic tolerance used across the math library. */
export const EPSILON: 0.000001;
/** Degrees to radians factor. */
export const DEG2RAD: number;
/** Radians to degrees factor. */
export const RAD2DEG: number;
/** Two times PI. */
export const PI2: number;
/** Half PI. */
export const PI_HALF: number;
