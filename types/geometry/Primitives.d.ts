/**
 * Creates an axis aligned box centered on the origin with per-face UVs.
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [depth]
 * @param {number} [widthSegments]
 * @param {number} [heightSegments]
 * @param {number} [depthSegments]
 * @returns {Geometry}
 */
export function createBox(width?: number, height?: number, depth?: number, widthSegments?: number, heightSegments?: number, depthSegments?: number): Geometry;
/**
 * Creates a UV sphere. Pole rings are collapsed to degenerate-free triangle
 * fans and their U coordinate is shifted by half a segment so that the texture
 * does not pinch asymmetrically at the poles.
 * @param {number} [radius]
 * @param {number} [widthSegments] Segments around the equator (>= 3).
 * @param {number} [heightSegments] Segments from pole to pole (>= 2).
 * @returns {Geometry}
 */
export function createSphere(radius?: number, widthSegments?: number, heightSegments?: number): Geometry;
/**
 * Creates a horizontal disc on the XZ plane facing +Y, subdivided into rings.
 *
 * Not the same thing as a cylinder cap. A cap is a triangle fan — one vertex in
 * the middle, the rest on the rim — which is fine for flat shading and useless
 * the moment anything displaces it: waves on a fan become a radial star. The
 * rings here give the interior the vertices a displacement needs, and keep the
 * triangles roughly even in size from centre to edge.
 *
 * @param {number} [radius=1]
 * @param {number} [segments=32] Subdivisions around the circumference.
 * @param {number} [rings=8] Subdivisions from the centre to the rim.
 * @returns {Geometry}
 */
export function createDisc(radius?: number, segments?: number, rings?: number): Geometry;
/**
 * Creates a subdivided plane on the XY axes facing +Z.
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [widthSegments]
 * @param {number} [heightSegments]
 * @returns {Geometry}
 */
export function createPlane(width?: number, height?: number, widthSegments?: number, heightSegments?: number): Geometry;
/**
 * Creates a (possibly truncated) cone / cylinder aligned with the Y axis.
 * @param {number} [radiusTop]
 * @param {number} [radiusBottom]
 * @param {number} [height]
 * @param {number} [radialSegments]
 * @param {number} [heightSegments]
 * @param {boolean} [openEnded]
 * @returns {Geometry}
 */
export function createCylinder(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number, heightSegments?: number, openEnded?: boolean): Geometry;
/**
 * Creates a cone aligned with the Y axis (apex at +Y).
 * @param {number} [radius]
 * @param {number} [height]
 * @param {number} [radialSegments]
 * @param {number} [heightSegments]
 * @param {boolean} [openEnded]
 * @returns {Geometry}
 */
export function createCone(radius?: number, height?: number, radialSegments?: number, heightSegments?: number, openEnded?: boolean): Geometry;
/**
 * Creates a capsule aligned with the Y axis. The two hemispherical caps and the
 * cylindrical body share their ring vertices, so the surface has no seam other
 * than the (unavoidable) UV wrap column.
 *
 * The total height of the solid is `height + 2 * radius`; `height` is the length
 * of the cylindrical section only.
 * @param {number} [radius]
 * @param {number} [height] Length of the cylindrical section.
 * @param {number} [capSegments] Rings per hemisphere.
 * @param {number} [radialSegments] Segments around the axis.
 * @param {number} [heightSegments] Rings along the cylindrical section.
 * @returns {Geometry}
 */
export function createCapsule(radius?: number, height?: number, capSegments?: number, radialSegments?: number, heightSegments?: number): Geometry;
/**
 * Creates a torus lying on the XY plane.
 * @param {number} [radius] Distance from the center to the tube center.
 * @param {number} [tube] Tube radius.
 * @param {number} [radialSegments] Segments around the tube.
 * @param {number} [tubularSegments] Segments around the ring.
 * @returns {Geometry}
 */
export function createTorus(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number): Geometry;
/**
 * Creates a (p,q) torus knot swept with an exact Frenet frame
 * (T = P' / |P'|, B = (P' x P'') / |P' x P''|, N = B x T).
 * @param {number} [radius]
 * @param {number} [tube]
 * @param {number} [tubularSegments] Segments along the curve.
 * @param {number} [radialSegments] Segments around the tube.
 * @param {number} [p] Windings around the axis of rotational symmetry.
 * @param {number} [q] Windings around the torus interior.
 * @returns {Geometry}
 */
export function createTorusKnot(radius?: number, tube?: number, tubularSegments?: number, radialSegments?: number, p?: number, q?: number): Geometry;
/**
 * Creates a geodesic sphere by recursively subdividing an icosahedron.
 * Edge midpoints are cached so shared edges never duplicate vertices; the UV
 * seam and the poles are fixed afterwards by duplicating only the vertices that
 * actually need a different U coordinate.
 * @param {number} [radius]
 * @param {number} [subdivisions] 0..6 recommended (4^n growth).
 * @returns {Geometry}
 */
export function createIcosphere(radius?: number, subdivisions?: number): Geometry;
/**
 * Creates a wireframe ground grid on the XZ plane.
 *
 * The returned geometry uses `drawMode = 'lines'` and carries `aPosition`,
 * `aNormal` (constant +Y so it stays compatible with lit shaders) and `aColor`
 * (linear RGBA). `aUV0` is emitted as the normalized grid coordinate.
 * @param {number} [size] Total extent of the grid.
 * @param {number} [divisions] Number of cells per axis.
 * @param {number} [centerColor] sRGB hex color of the two center axes.
 * @param {number} [gridColor] sRGB hex color of the remaining lines.
 * @returns {Geometry}
 */
export function createGridLines(size?: number, divisions?: number, centerColor?: number, gridColor?: number): Geometry;
/**
 * Creates a single oversized triangle that covers the whole clip space volume.
 *
 * One triangle is cheaper than two (no shared diagonal edge, perfect quad
 * rasterization coherence). Positions are already in clip space
 * (-1,-1), (3,-1), (-1,3) with z = 0, so the fullscreen vertex shader can pass
 * `aPosition` straight to `gl_Position` without any matrix.
 *
 * `aUV0` is provided as a convenience (0,0), (2,0), (0,2); a shader that does
 * not declare it simply ignores the attribute. Equivalent UVs can also be
 * derived in the shader with `aPosition.xy * 0.5 + 0.5`.
 * @returns {Geometry}
 */
export function createQuadFullscreen(): Geometry;
/**
 * Creates a unit cube with inward facing winding and normals, meant to be
 * rendered from the inside as a skybox. `aPosition` doubles as the cubemap
 * sampling direction.
 * @param {number} [size] Edge length of the cube.
 * @returns {Geometry}
 */
export function createSkyboxCube(size?: number): Geometry;
/**
 * Creates a heightmapped terrain patch on the XZ plane centered on the origin.
 *
 * `heightFn(x, z)` is sampled on a grid extended by one cell on every side, so
 * the normals can be obtained analytically through central differences without
 * paying four extra evaluations per vertex.
 * @param {number} [size] Total extent along X and Z.
 * @param {number} [segments] Cells per axis.
 * @param {function(number, number): number} [heightFn] Height sampler.
 * @param {number} [uvScale] Number of UV tiles across the patch.
 * @returns {Geometry}
 */
export function createTerrain(size?: number, segments?: number, heightFn?: (arg0: number, arg1: number) => number, uvScale?: number): Geometry;
import { Geometry } from "../render/Geometry.js";
