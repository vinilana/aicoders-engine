/**
 * Computes area weighted smooth vertex normals and stores them in `aNormal`.
 * Works for both indexed and non-indexed geometry.
 * @param {Geometry} geometry
 * @returns {Geometry} The same geometry, for chaining.
 */
export function computeNormals(geometry: Geometry): Geometry;
/**
 * Computes per-vertex tangents (vec4, w = handedness) from `aUV0`.
 * Requires `aPosition` and `aUV0`; `aNormal` is generated when missing.
 * @param {Geometry} geometry
 * @returns {Geometry} The same geometry, for chaining.
 */
export function computeTangents(geometry: Geometry): Geometry;
/**
 * Computes the axis aligned bounding box of a geometry.
 * @param {Geometry} geometry
 * @param {AABB} [out] Optional destination.
 * @returns {AABB}
 */
export function computeAABB(geometry: Geometry, out?: AABB): AABB;
/**
 * Computes a tight-ish bounding sphere centered on the bounding box center.
 * @param {Geometry} geometry
 * @param {Sphere} [out] Optional destination.
 * @returns {Sphere}
 */
export function computeBoundingSphere(geometry: Geometry, out?: Sphere): Sphere;
/**
 * Expands an indexed geometry into a flat, non-indexed one.
 * @param {Geometry} geometry
 * @returns {Geometry} A new geometry.
 */
export function toNonIndexed(geometry: Geometry): Geometry;
/**
 * Welds identical vertices and builds an index buffer. Vertices are considered
 * identical when every one of their attribute components matches after
 * quantization by `tolerance`.
 * @param {Geometry} geometry
 * @param {number} [tolerance] Quantization step (1e-4 by default).
 * @returns {Geometry} A new geometry.
 */
export function toIndexed(geometry: Geometry, tolerance?: number): Geometry;
/**
 * Merges several geometries into a single one.
 *
 * All inputs must share the same draw mode and expose compatible attributes
 * (same item size and same backing array type). Only attributes present in
 * every input are kept. When `useGroups` is true the result carries one draw
 * group per input geometry (or per input group, offsetting material indices),
 * so it can be rendered with a material array.
 * @param {Geometry[]} geometries
 * @param {boolean} [useGroups]
 * @returns {Geometry} A new geometry.
 */
export function mergeGeometries(geometries: Geometry[], useGroups?: boolean): Geometry;
/**
 * Reorders triangles to maximize the post-transform vertex cache hit rate using
 * the Tipsify algorithm (Sander, Nehab & Barczak, 2007).
 *
 * The returned array has the same type and length as the input and contains a
 * permutation of the original triangles (vertex indices are untouched, so no
 * other attribute needs to be remapped).
 * @param {Uint16Array|Uint32Array|Array<number>} indices
 * @param {number} [vertexCount] Defaults to max(index) + 1.
 * @param {number} [cacheSize] Simulated FIFO cache size (32 by default).
 * @returns {Uint16Array|Uint32Array} Reordered indices.
 */
export function optimizeVertexCache(indices: Uint16Array | Uint32Array | Array<number>, vertexCount?: number, cacheSize?: number): Uint16Array | Uint32Array;
/**
 * Decimates a triangle mesh using quadric error metrics (Garland & Heckbert).
 *
 * Features: area weighted face quadrics, virtual boundary planes so open
 * borders keep their shape, link-condition test to preserve manifoldness,
 * normal flip rejection and a lazily invalidated binary heap of candidate
 * collapses.
 *
 * Vertex attributes other than the position are inherited from the surviving
 * vertex of each collapse; normals (and tangents, when present) are recomputed
 * on the result.
 * @param {Geometry} geometry
 * @param {number} targetRatio Fraction of triangles to keep, in (0, 1].
 * @param {object} [options]
 * @param {number} [options.boundaryWeight] Penalty applied to border planes (1000).
 * @param {number} [options.flipThreshold] Minimum cos() between the old and new face normals (0.2).
 * @param {number} [options.maxCost] Hard error ceiling; collapses above it stop the process (Infinity).
 * @param {number} [options.weldTolerance] Welding tolerance used when the input is non-indexed (1e-5).
 * @returns {Geometry} A new, simplified geometry.
 */
export function simplify(geometry: Geometry, targetRatio: number, options?: {
    boundaryWeight?: number;
    flipThreshold?: number;
    maxCost?: number;
    weldTolerance?: number;
}): Geometry;
import { Geometry } from "../render/Geometry.js";
import { AABB } from "../math/AABB.js";
import { Sphere } from "../math/Sphere.js";
