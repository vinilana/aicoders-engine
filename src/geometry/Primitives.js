/**
 * @fileoverview Procedural primitive geometry factories.
 *
 * Every factory returns a fully populated {@link Geometry} instance carrying the
 * standard attribute set (`aPosition`, `aNormal`, `aUV0`) plus an index buffer,
 * with `boundingBox` and `boundingSphere` already computed.
 *
 * Conventions:
 *  - Right handed coordinate system, +Y up, camera looks down -Z.
 *  - Front faces are counter clockwise (CCW) when seen from outside the solid.
 *  - UVs use the OpenGL convention with V growing upwards on the surface.
 */

import { Geometry } from '../render/Geometry.js';
import { computeAABB, computeBoundingSphere } from './GeometryUtils.js';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const EPS = 1e-10;

/**
 * Converts an sRGB encoded channel (0..1) to linear space.
 * @param {number} c
 * @returns {number}
 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Decodes an 0xRRGGBB sRGB hexadecimal value into a linear RGB triple.
 * @param {number} hex
 * @param {Float32Array} out Destination of at least 3 elements.
 * @param {number} offset
 */
function hexToLinear(hex, out, offset) {
  const h = Math.floor(hex);
  out[offset] = srgbToLinear(((h >> 16) & 255) / 255);
  out[offset + 1] = srgbToLinear(((h >> 8) & 255) / 255);
  out[offset + 2] = srgbToLinear((h & 255) / 255);
}

/**
 * Growable triangle mesh accumulator used by every primitive builder.
 * Data is stored directly in TypedArrays; capacity doubles on demand so that no
 * intermediate JavaScript arrays or per-vertex objects are ever created.
 */
class MeshBuilder {
  /**
   * @param {number} [vertexCapacity] Initial vertex capacity.
   * @param {number} [indexCapacity] Initial index capacity.
   */
  constructor(vertexCapacity = 64, indexCapacity = 128) {
    const vc = Math.max(4, vertexCapacity | 0);
    const ic = Math.max(6, indexCapacity | 0);
    /** @type {Float32Array} */
    this.positions = new Float32Array(vc * 3);
    /** @type {Float32Array} */
    this.normals = new Float32Array(vc * 3);
    /** @type {Float32Array} */
    this.uvs = new Float32Array(vc * 2);
    /** @type {Uint32Array} */
    this.indices = new Uint32Array(ic);
    /** @type {number} */
    this.vertexCount = 0;
    /** @type {number} */
    this.indexCount = 0;
  }

  /**
   * Ensures room for `extra` additional vertices.
   * @param {number} extra
   */
  reserveVertices(extra) {
    const needed = this.vertexCount + extra;
    let cap = this.positions.length / 3;
    if (needed <= cap) return;
    while (cap < needed) cap *= 2;
    const p = new Float32Array(cap * 3);
    p.set(this.positions);
    this.positions = p;
    const n = new Float32Array(cap * 3);
    n.set(this.normals);
    this.normals = n;
    const t = new Float32Array(cap * 2);
    t.set(this.uvs);
    this.uvs = t;
  }

  /**
   * Ensures room for `extra` additional indices.
   * @param {number} extra
   */
  reserveIndices(extra) {
    const needed = this.indexCount + extra;
    let cap = this.indices.length;
    if (needed <= cap) return;
    while (cap < needed) cap *= 2;
    const a = new Uint32Array(cap);
    a.set(this.indices);
    this.indices = a;
  }

  /**
   * Appends one vertex.
   * @param {number} px
   * @param {number} py
   * @param {number} pz
   * @param {number} nx
   * @param {number} ny
   * @param {number} nz
   * @param {number} u
   * @param {number} v
   * @returns {number} Index of the newly created vertex.
   */
  vertex(px, py, pz, nx, ny, nz, u, v) {
    this.reserveVertices(1);
    const i = this.vertexCount++;
    const i3 = i * 3;
    const i2 = i * 2;
    this.positions[i3] = px;
    this.positions[i3 + 1] = py;
    this.positions[i3 + 2] = pz;
    this.normals[i3] = nx;
    this.normals[i3 + 1] = ny;
    this.normals[i3 + 2] = nz;
    this.uvs[i2] = u;
    this.uvs[i2 + 1] = v;
    return i;
  }

  /**
   * Appends one triangle.
   * @param {number} a
   * @param {number} b
   * @param {number} c
   */
  triangle(a, b, c) {
    this.reserveIndices(3);
    const i = this.indexCount;
    this.indices[i] = a;
    this.indices[i + 1] = b;
    this.indices[i + 2] = c;
    this.indexCount = i + 3;
  }

  /**
   * Appends a quad as two triangles (a, b, d) and (b, c, d).
   * @param {number} a
   * @param {number} b
   * @param {number} c
   * @param {number} d
   */
  quad(a, b, c, d) {
    this.reserveIndices(6);
    const i = this.indexCount;
    const idx = this.indices;
    idx[i] = a; idx[i + 1] = b; idx[i + 2] = d;
    idx[i + 3] = b; idx[i + 4] = c; idx[i + 5] = d;
    this.indexCount = i + 6;
  }

  /**
   * Materializes the accumulated data into a {@link Geometry}.
   * @returns {Geometry}
   */
  build() {
    const vc = this.vertexCount;
    const geometry = new Geometry();
    geometry.setAttribute('aPosition', this.positions.slice(0, vc * 3), 3);
    geometry.setAttribute('aNormal', this.normals.slice(0, vc * 3), 3);
    geometry.setAttribute('aUV0', this.uvs.slice(0, vc * 2), 2);
    geometry.setIndex(packIndices(this.indices, this.indexCount, vc));
    geometry.drawMode = 'triangles';
    return finalize(geometry);
  }
}

/**
 * Narrows an index buffer to 16 bits when the vertex count allows it.
 * @param {Uint32Array} source
 * @param {number} count
 * @param {number} vertexCount
 * @returns {Uint16Array|Uint32Array}
 */
function packIndices(source, count, vertexCount) {
  if (vertexCount <= 65535) {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = source[i];
    return out;
  }
  return source.slice(0, count);
}

/**
 * Computes and assigns the bounding volumes of a geometry.
 * @param {Geometry} geometry
 * @returns {Geometry} The same geometry, for chaining.
 */
function finalize(geometry) {
  geometry.boundingBox = computeAABB(geometry);
  geometry.boundingSphere = computeBoundingSphere(geometry);
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Box                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds one segmented face of a box directly into the builder.
 * @param {MeshBuilder} b
 * @param {number} u Axis index (0,1,2) mapped to the face's horizontal axis.
 * @param {number} v Axis index mapped to the face's vertical axis.
 * @param {number} w Axis index of the face normal.
 * @param {number} udir Direction of the horizontal axis (+1/-1).
 * @param {number} vdir Direction of the vertical axis (+1/-1).
 * @param {number} width Face width along `u`.
 * @param {number} height Face height along `v`.
 * @param {number} depth Signed extent along `w` (sign selects the face side).
 * @param {number} gridX Segments along `u`.
 * @param {number} gridY Segments along `v`.
 */
function buildBoxFace(b, u, v, w, udir, vdir, width, height, depth, gridX, gridY) {
  const segWidth = width / gridX;
  const segHeight = height / gridY;
  const widthHalf = width * 0.5;
  const heightHalf = height * 0.5;
  const depthHalf = depth * 0.5;
  const gridX1 = gridX + 1;
  const gridY1 = gridY + 1;
  const start = b.vertexCount;
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  n[w] = depth > 0 ? 1 : -1;

  b.reserveVertices(gridX1 * gridY1);
  for (let iy = 0; iy < gridY1; iy++) {
    const y = iy * segHeight - heightHalf;
    for (let ix = 0; ix < gridX1; ix++) {
      const x = ix * segWidth - widthHalf;
      p[u] = x * udir;
      p[v] = y * vdir;
      p[w] = depthHalf;
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], ix / gridX, 1 - iy / gridY);
    }
  }
  for (let iy = 0; iy < gridY; iy++) {
    for (let ix = 0; ix < gridX; ix++) {
      const a = start + ix + gridX1 * iy;
      const bb = start + ix + gridX1 * (iy + 1);
      const c = start + (ix + 1) + gridX1 * (iy + 1);
      const d = start + (ix + 1) + gridX1 * iy;
      b.quad(a, bb, c, d);
    }
  }
}

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
export function createBox(width = 1, height = 1, depth = 1, widthSegments = 1, heightSegments = 1, depthSegments = 1) {
  const ws = Math.max(1, Math.floor(widthSegments));
  const hs = Math.max(1, Math.floor(heightSegments));
  const ds = Math.max(1, Math.floor(depthSegments));
  const vertexEstimate = 2 * ((ws + 1) * (hs + 1) + (ws + 1) * (ds + 1) + (ds + 1) * (hs + 1));
  const b = new MeshBuilder(vertexEstimate, vertexEstimate * 3);

  buildBoxFace(b, 2, 1, 0, -1, -1, depth, height, width, ds, hs);   // +X
  buildBoxFace(b, 2, 1, 0, 1, -1, depth, height, -width, ds, hs);   // -X
  buildBoxFace(b, 0, 2, 1, 1, 1, width, depth, height, ws, ds);     // +Y
  buildBoxFace(b, 0, 2, 1, 1, -1, width, depth, -height, ws, ds);   // -Y
  buildBoxFace(b, 0, 1, 2, 1, -1, width, height, depth, ws, hs);    // +Z
  buildBoxFace(b, 0, 1, 2, -1, -1, width, height, -depth, ws, hs);  // -Z

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Sphere                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Creates a UV sphere. Pole rings are collapsed to degenerate-free triangle
 * fans and their U coordinate is shifted by half a segment so that the texture
 * does not pinch asymmetrically at the poles.
 * @param {number} [radius]
 * @param {number} [widthSegments] Segments around the equator (>= 3).
 * @param {number} [heightSegments] Segments from pole to pole (>= 2).
 * @returns {Geometry}
 */
export function createSphere(radius = 0.5, widthSegments = 32, heightSegments = 16) {
  const wSeg = Math.max(3, Math.floor(widthSegments));
  const hSeg = Math.max(2, Math.floor(heightSegments));
  const b = new MeshBuilder((wSeg + 1) * (hSeg + 1), wSeg * hSeg * 6);
  const grid = new Int32Array((wSeg + 1) * (hSeg + 1));
  const invR = radius !== 0 ? 1 / radius : 0;

  for (let iy = 0; iy <= hSeg; iy++) {
    const v = iy / hSeg;
    let uOffset = 0;
    if (iy === 0) uOffset = 0.5 / wSeg;
    else if (iy === hSeg) uOffset = -0.5 / wSeg;
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let ix = 0; ix <= wSeg; ix++) {
      const u = ix / wSeg;
      const theta = u * TWO_PI;
      const px = -radius * Math.cos(theta) * sinPhi;
      const py = radius * cosPhi;
      const pz = radius * Math.sin(theta) * sinPhi;
      grid[iy * (wSeg + 1) + ix] = b.vertex(
        px, py, pz,
        px * invR, py * invR, pz * invR,
        u + uOffset, 1 - v
      );
    }
  }

  for (let iy = 0; iy < hSeg; iy++) {
    for (let ix = 0; ix < wSeg; ix++) {
      const a = grid[iy * (wSeg + 1) + ix + 1];
      const bb = grid[iy * (wSeg + 1) + ix];
      const c = grid[(iy + 1) * (wSeg + 1) + ix];
      const d = grid[(iy + 1) * (wSeg + 1) + ix + 1];
      if (iy !== 0) b.triangle(a, bb, d);
      if (iy !== hSeg - 1) b.triangle(bb, c, d);
    }
  }

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Plane                                                                       */
/* -------------------------------------------------------------------------- */

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
export function createDisc(radius = 1, segments = 32, rings = 8) {
  const seg = Math.max(3, Math.floor(segments));
  const ring = Math.max(1, Math.floor(rings));

  const vertexCount = 1 + seg * ring;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  // Centre vertex.
  positions[0] = 0; positions[1] = 0; positions[2] = 0;
  normals[0] = 0; normals[1] = 1; normals[2] = 0;
  uvs[0] = 0.5; uvs[1] = 0.5;

  let v = 1;
  for (let r = 1; r <= ring; r++) {
    // Square root spacing keeps the ring areas equal, so triangles stay a
    // similar size instead of bunching up at the centre.
    const t = Math.sqrt(r / ring);
    const rr = t * radius;
    for (let s = 0; s < seg; s++) {
      const angle = (s / seg) * Math.PI * 2;
      const x = Math.cos(angle) * rr;
      const z = Math.sin(angle) * rr;
      positions[v * 3] = x;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = z;
      normals[v * 3] = 0;
      normals[v * 3 + 1] = 1;
      normals[v * 3 + 2] = 0;
      uvs[v * 2] = (x / radius) * 0.5 + 0.5;
      uvs[v * 2 + 1] = (z / radius) * 0.5 + 0.5;
      v++;
    }
  }

  const triangleCount = seg + seg * (ring - 1) * 2;
  const indices = new Uint32Array(triangleCount * 3);
  let i = 0;

  // Inner fan around the centre.
  for (let s = 0; s < seg; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % seg);
    indices[i++] = 0; indices[i++] = b; indices[i++] = a;
  }

  // Quads between successive rings.
  for (let r = 0; r < ring - 1; r++) {
    const inner = 1 + r * seg;
    const outer = inner + seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      const a = inner + s;
      const b = inner + s1;
      const c = outer + s;
      const d = outer + s1;
      indices[i++] = a; indices[i++] = d; indices[i++] = c;
      indices[i++] = a; indices[i++] = b; indices[i++] = d;
    }
  }

  const geometry = new Geometry();
  geometry.setAttribute('aPosition', positions, 3);
  geometry.setAttribute('aNormal', normals, 3);
  geometry.setAttribute('aUV0', uvs, 2);
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Creates a subdivided plane on the XY axes facing +Z.
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [widthSegments]
 * @param {number} [heightSegments]
 * @returns {Geometry}
 */
export function createPlane(width = 1, height = 1, widthSegments = 1, heightSegments = 1) {
  const gridX = Math.max(1, Math.floor(widthSegments));
  const gridY = Math.max(1, Math.floor(heightSegments));
  const gridX1 = gridX + 1;
  const gridY1 = gridY + 1;
  const widthHalf = width * 0.5;
  const heightHalf = height * 0.5;
  const segWidth = width / gridX;
  const segHeight = height / gridY;
  const b = new MeshBuilder(gridX1 * gridY1, gridX * gridY * 6);

  for (let iy = 0; iy < gridY1; iy++) {
    const y = iy * segHeight - heightHalf;
    for (let ix = 0; ix < gridX1; ix++) {
      const x = ix * segWidth - widthHalf;
      b.vertex(x, -y, 0, 0, 0, 1, ix / gridX, 1 - iy / gridY);
    }
  }
  for (let iy = 0; iy < gridY; iy++) {
    for (let ix = 0; ix < gridX; ix++) {
      const a = ix + gridX1 * iy;
      const bb = ix + gridX1 * (iy + 1);
      const c = (ix + 1) + gridX1 * (iy + 1);
      const d = (ix + 1) + gridX1 * iy;
      b.quad(a, bb, c, d);
    }
  }
  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Cylinder / Cone                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generates one cap disc of a cylinder.
 * @param {MeshBuilder} b
 * @param {boolean} top
 * @param {number} radius
 * @param {number} halfHeight
 * @param {number} radialSeg
 */
function buildCylinderCap(b, top, radius, halfHeight, radialSeg) {
  if (radius <= 0) return;
  const sign = top ? 1 : -1;
  const centerStart = b.vertexCount;
  for (let x = 0; x < radialSeg; x++) {
    b.vertex(0, halfHeight * sign, 0, 0, sign, 0, 0.5, 0.5);
  }
  const ringStart = b.vertexCount;
  for (let x = 0; x <= radialSeg; x++) {
    const u = x / radialSeg;
    const theta = u * TWO_PI;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    b.vertex(
      radius * sinTheta, halfHeight * sign, radius * cosTheta,
      0, sign, 0,
      cosTheta * 0.5 + 0.5, sinTheta * 0.5 * sign + 0.5
    );
  }
  for (let x = 0; x < radialSeg; x++) {
    const c = centerStart + x;
    const i = ringStart + x;
    if (top) b.triangle(i, i + 1, c);
    else b.triangle(i + 1, i, c);
  }
}

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
export function createCylinder(radiusTop = 0.5, radiusBottom = 0.5, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false) {
  const radialSeg = Math.max(3, Math.floor(radialSegments));
  const heightSeg = Math.max(1, Math.floor(heightSegments));
  const halfHeight = height * 0.5;
  const slope = (radiusBottom - radiusTop) / height;
  const b = new MeshBuilder((radialSeg + 1) * (heightSeg + 1) + radialSeg * 4, radialSeg * heightSeg * 6 + radialSeg * 6);
  const grid = new Int32Array((radialSeg + 1) * (heightSeg + 1));

  for (let y = 0; y <= heightSeg; y++) {
    const v = y / heightSeg;
    const radius = v * (radiusBottom - radiusTop) + radiusTop;
    for (let x = 0; x <= radialSeg; x++) {
      const u = x / radialSeg;
      const theta = u * TWO_PI;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      let nx = sinTheta;
      let ny = slope;
      let nz = cosTheta;
      const len = Math.hypot(nx, ny, nz);
      if (len > EPS) { nx /= len; ny /= len; nz /= len; }
      grid[y * (radialSeg + 1) + x] = b.vertex(
        radius * sinTheta, -v * height + halfHeight, radius * cosTheta,
        nx, ny, nz,
        u, 1 - v
      );
    }
  }

  for (let x = 0; x < radialSeg; x++) {
    for (let y = 0; y < heightSeg; y++) {
      const a = grid[y * (radialSeg + 1) + x];
      const bb = grid[(y + 1) * (radialSeg + 1) + x];
      const c = grid[(y + 1) * (radialSeg + 1) + x + 1];
      const d = grid[y * (radialSeg + 1) + x + 1];
      if (radiusTop > 0 || y !== 0) b.triangle(a, bb, d);
      if (radiusBottom > 0 || y !== heightSeg - 1) b.triangle(bb, c, d);
    }
  }

  if (!openEnded) {
    buildCylinderCap(b, true, radiusTop, halfHeight, radialSeg);
    buildCylinderCap(b, false, radiusBottom, halfHeight, radialSeg);
  }

  return b.build();
}

/**
 * Creates a cone aligned with the Y axis (apex at +Y).
 * @param {number} [radius]
 * @param {number} [height]
 * @param {number} [radialSegments]
 * @param {number} [heightSegments]
 * @param {boolean} [openEnded]
 * @returns {Geometry}
 */
export function createCone(radius = 0.5, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false) {
  return createCylinder(0, radius, height, radialSegments, heightSegments, openEnded);
}

/* -------------------------------------------------------------------------- */
/* Capsule                                                                     */
/* -------------------------------------------------------------------------- */

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
export function createCapsule(radius = 0.5, height = 1, capSegments = 8, radialSegments = 16, heightSegments = 1) {
  const capSeg = Math.max(1, Math.floor(capSegments));
  const radialSeg = Math.max(3, Math.floor(radialSegments));
  const heightSeg = Math.max(1, Math.floor(heightSegments));
  const halfLen = height * 0.5;

  const rowCount = (capSeg + 1) + (heightSeg - 1) + (capSeg + 1);
  const rowY = new Float64Array(rowCount);
  const rowR = new Float64Array(rowCount);
  const rowNY = new Float64Array(rowCount);
  const rowNR = new Float64Array(rowCount);
  const rowV = new Float64Array(rowCount);

  const capArc = HALF_PI * radius;
  const total = 2 * capArc + height;
  const invTotal = total > EPS ? 1 / total : 0;
  let row = 0;

  // Top hemisphere: phi 0 (pole) .. PI/2 (equator).
  for (let i = 0; i <= capSeg; i++) {
    const phi = (i / capSeg) * HALF_PI;
    const ny = Math.cos(phi);
    const nr = Math.sin(phi);
    rowNY[row] = ny;
    rowNR[row] = nr;
    rowY[row] = halfLen + radius * ny;
    rowR[row] = radius * nr;
    rowV[row] = 1 - (i / capSeg) * capArc * invTotal;
    row++;
  }
  // Cylindrical body (interior rings only, the equator rings are shared).
  for (let i = 1; i < heightSeg; i++) {
    const t = i / heightSeg;
    rowNY[row] = 0;
    rowNR[row] = 1;
    rowY[row] = halfLen - t * height;
    rowR[row] = radius;
    rowV[row] = 1 - (capArc + t * height) * invTotal;
    row++;
  }
  // Bottom hemisphere: phi PI/2 (equator) .. PI (pole).
  for (let i = 0; i <= capSeg; i++) {
    const phi = HALF_PI + (i / capSeg) * HALF_PI;
    const ny = Math.cos(phi);
    const nr = Math.sin(phi);
    rowNY[row] = ny;
    rowNR[row] = nr;
    rowY[row] = -halfLen + radius * ny;
    rowR[row] = radius * nr;
    rowV[row] = 1 - (capArc + height + (i / capSeg) * capArc) * invTotal;
    row++;
  }

  const cols = radialSeg + 1;
  const b = new MeshBuilder(rowCount * cols, rowCount * radialSeg * 6);
  const grid = new Int32Array(rowCount * cols);

  for (let r = 0; r < rowCount; r++) {
    const y = rowY[r];
    const rad = rowR[r];
    const ny = rowNY[r];
    const nr = rowNR[r];
    const v = rowV[r];
    for (let c = 0; c < cols; c++) {
      const u = c / radialSeg;
      const theta = u * TWO_PI;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      grid[r * cols + c] = b.vertex(
        -rad * cosT, y, rad * sinT,
        -nr * cosT, ny, nr * sinT,
        u, v
      );
    }
  }

  for (let r = 0; r < rowCount - 1; r++) {
    const topDegenerate = rowR[r] < EPS;
    const bottomDegenerate = rowR[r + 1] < EPS;
    for (let c = 0; c < radialSeg; c++) {
      const a = grid[r * cols + c + 1];
      const bb = grid[r * cols + c];
      const cc = grid[(r + 1) * cols + c];
      const d = grid[(r + 1) * cols + c + 1];
      if (!topDegenerate) b.triangle(a, bb, d);
      if (!bottomDegenerate) b.triangle(bb, cc, d);
    }
  }

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Torus                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates a torus lying on the XY plane.
 * @param {number} [radius] Distance from the center to the tube center.
 * @param {number} [tube] Tube radius.
 * @param {number} [radialSegments] Segments around the tube.
 * @param {number} [tubularSegments] Segments around the ring.
 * @returns {Geometry}
 */
export function createTorus(radius = 0.5, tube = 0.2, radialSegments = 16, tubularSegments = 48) {
  const radialSeg = Math.max(3, Math.floor(radialSegments));
  const tubularSeg = Math.max(3, Math.floor(tubularSegments));
  const b = new MeshBuilder((radialSeg + 1) * (tubularSeg + 1), radialSeg * tubularSeg * 6);
  const invTube = tube !== 0 ? 1 / tube : 0;

  for (let j = 0; j <= radialSeg; j++) {
    const v = (j / radialSeg) * TWO_PI;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    for (let i = 0; i <= tubularSeg; i++) {
      const u = (i / tubularSeg) * TWO_PI;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const px = (radius + tube * cosV) * cosU;
      const py = (radius + tube * cosV) * sinU;
      const pz = tube * sinV;
      b.vertex(
        px, py, pz,
        (px - radius * cosU) * invTube, (py - radius * sinU) * invTube, pz * invTube,
        i / tubularSeg, j / radialSeg
      );
    }
  }

  for (let j = 1; j <= radialSeg; j++) {
    for (let i = 1; i <= tubularSeg; i++) {
      const a = (tubularSeg + 1) * j + i - 1;
      const bb = (tubularSeg + 1) * (j - 1) + i - 1;
      const c = (tubularSeg + 1) * (j - 1) + i;
      const d = (tubularSeg + 1) * j + i;
      b.quad(a, bb, c, d);
    }
  }

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Torus knot                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Evaluates the (p,q) torus knot curve and its first two derivatives.
 * @param {number} u Curve parameter.
 * @param {number} p
 * @param {number} q
 * @param {number} radius
 * @param {Float64Array} out 9 elements: position, first derivative, second derivative.
 */
function torusKnotCurve(u, p, q, radius, out) {
  const k = q / p;
  const ku = k * u;
  const R = radius * 0.5;
  const A = 2 + Math.cos(ku);
  const dA = -k * Math.sin(ku);
  const ddA = -k * k * Math.cos(ku);
  const cu = Math.cos(u);
  const su = Math.sin(u);

  out[0] = R * A * cu;
  out[1] = R * A * su;
  out[2] = R * Math.sin(ku);

  out[3] = R * (dA * cu - A * su);
  out[4] = R * (dA * su + A * cu);
  out[5] = R * k * Math.cos(ku);

  out[6] = R * (ddA * cu - 2 * dA * su - A * cu);
  out[7] = R * (ddA * su + 2 * dA * cu - A * su);
  out[8] = -R * k * k * Math.sin(ku);
}

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
export function createTorusKnot(radius = 0.5, tube = 0.15, tubularSegments = 128, radialSegments = 12, p = 2, q = 3) {
  const tubularSeg = Math.max(3, Math.floor(tubularSegments));
  const radialSeg = Math.max(3, Math.floor(radialSegments));
  const pp = Math.max(1, Math.floor(p));
  const qq = Math.max(1, Math.floor(q));
  const b = new MeshBuilder((tubularSeg + 1) * (radialSeg + 1), tubularSeg * radialSeg * 6);
  const curve = new Float64Array(9);
  const invTube = tube !== 0 ? 1 / tube : 0;

  for (let i = 0; i <= tubularSeg; i++) {
    const u = (i / tubularSeg) * pp * TWO_PI;
    torusKnotCurve(u, pp, qq, radius, curve);

    const px = curve[0];
    const py = curve[1];
    const pz = curve[2];

    let tx = curve[3];
    let ty = curve[4];
    let tz = curve[5];
    let len = Math.hypot(tx, ty, tz);
    if (len > EPS) { tx /= len; ty /= len; tz /= len; } else { tx = 1; ty = 0; tz = 0; }

    // Binormal from the osculating plane: B = normalize(P' x P'').
    let bx = curve[4] * curve[8] - curve[5] * curve[7];
    let by = curve[5] * curve[6] - curve[3] * curve[8];
    let bz = curve[3] * curve[7] - curve[4] * curve[6];
    len = Math.hypot(bx, by, bz);
    if (len > EPS) {
      bx /= len; by /= len; bz /= len;
    } else {
      // Degenerate (zero curvature): pick any vector perpendicular to T.
      if (Math.abs(tx) < 0.9) { bx = 1; by = 0; bz = 0; } else { bx = 0; by = 1; bz = 0; }
      const dot = bx * tx + by * ty + bz * tz;
      bx -= tx * dot; by -= ty * dot; bz -= tz * dot;
      len = Math.hypot(bx, by, bz);
      bx /= len; by /= len; bz /= len;
    }

    // N = B x T keeps (T, N, B) right handed.
    const nx = by * tz - bz * ty;
    const ny = bz * tx - bx * tz;
    const nz = bx * ty - by * tx;

    for (let j = 0; j <= radialSeg; j++) {
      const v = (j / radialSeg) * TWO_PI;
      const cx = -tube * Math.cos(v);
      const cy = tube * Math.sin(v);
      const vx = px + cx * nx + cy * bx;
      const vy = py + cx * ny + cy * by;
      const vz = pz + cx * nz + cy * bz;
      b.vertex(
        vx, vy, vz,
        (vx - px) * invTube, (vy - py) * invTube, (vz - pz) * invTube,
        i / tubularSeg, j / radialSeg
      );
    }
  }

  for (let j = 1; j <= tubularSeg; j++) {
    for (let i = 1; i <= radialSeg; i++) {
      const a = (radialSeg + 1) * (j - 1) + (i - 1);
      const bb = (radialSeg + 1) * j + (i - 1);
      const c = (radialSeg + 1) * j + i;
      const d = (radialSeg + 1) * (j - 1) + i;
      b.quad(a, bb, c, d);
    }
  }

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Icosphere                                                                   */
/* -------------------------------------------------------------------------- */

const ICO_T = (1 + Math.sqrt(5)) * 0.5;

const ICO_POSITIONS = [
  -1, ICO_T, 0, 1, ICO_T, 0, -1, -ICO_T, 0, 1, -ICO_T, 0,
  0, -1, ICO_T, 0, 1, ICO_T, 0, -1, -ICO_T, 0, 1, -ICO_T,
  ICO_T, 0, -1, ICO_T, 0, 1, -ICO_T, 0, -1, -ICO_T, 0, 1
];

const ICO_FACES = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1
];

/**
 * Creates a geodesic sphere by recursively subdividing an icosahedron.
 * Edge midpoints are cached so shared edges never duplicate vertices; the UV
 * seam and the poles are fixed afterwards by duplicating only the vertices that
 * actually need a different U coordinate.
 * @param {number} [radius]
 * @param {number} [subdivisions] 0..6 recommended (4^n growth).
 * @returns {Geometry}
 */
export function createIcosphere(radius = 0.5, subdivisions = 2) {
  const levels = Math.max(0, Math.min(7, Math.floor(subdivisions)));

  // Unit direction vectors of the base icosahedron.
  let vertexCount = 12;
  let capacity = 12;
  let dirs = new Float64Array(capacity * 3);
  for (let i = 0; i < 12; i++) {
    const x = ICO_POSITIONS[i * 3];
    const y = ICO_POSITIONS[i * 3 + 1];
    const z = ICO_POSITIONS[i * 3 + 2];
    const inv = 1 / Math.hypot(x, y, z);
    dirs[i * 3] = x * inv;
    dirs[i * 3 + 1] = y * inv;
    dirs[i * 3 + 2] = z * inv;
  }

  let faces = new Uint32Array(ICO_FACES.length);
  faces.set(ICO_FACES);

  const midCache = new Map();

  const pushVertex = (x, y, z) => {
    if (vertexCount >= capacity) {
      capacity *= 2;
      const next = new Float64Array(capacity * 3);
      next.set(dirs);
      dirs = next;
    }
    const i = vertexCount++;
    dirs[i * 3] = x;
    dirs[i * 3 + 1] = y;
    dirs[i * 3 + 2] = z;
    return i;
  };

  const midpoint = (a, b) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * 8388608 + hi;
    const cached = midCache.get(key);
    if (cached !== undefined) return cached;
    const x = (dirs[a * 3] + dirs[b * 3]) * 0.5;
    const y = (dirs[a * 3 + 1] + dirs[b * 3 + 1]) * 0.5;
    const z = (dirs[a * 3 + 2] + dirs[b * 3 + 2]) * 0.5;
    const inv = 1 / Math.hypot(x, y, z);
    const idx = pushVertex(x * inv, y * inv, z * inv);
    midCache.set(key, idx);
    return idx;
  };

  for (let level = 0; level < levels; level++) {
    const faceCount = faces.length / 3;
    const next = new Uint32Array(faceCount * 12);
    let w = 0;
    for (let f = 0; f < faceCount; f++) {
      const a = faces[f * 3];
      const b = faces[f * 3 + 1];
      const c = faces[f * 3 + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next[w++] = a; next[w++] = ab; next[w++] = ca;
      next[w++] = b; next[w++] = bc; next[w++] = ab;
      next[w++] = c; next[w++] = ca; next[w++] = bc;
      next[w++] = ab; next[w++] = bc; next[w++] = ca;
    }
    faces = next;
    midCache.clear();
  }

  // Spherical UVs matching createSphere: u from atan2(z, -x), v from acos(y).
  const baseU = new Float64Array(vertexCount);
  const baseV = new Float64Array(vertexCount);
  const isPole = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const x = dirs[i * 3];
    const y = dirs[i * 3 + 1];
    const z = dirs[i * 3 + 2];
    let u = Math.atan2(z, -x) / TWO_PI;
    if (u < 0) u += 1;
    baseU[i] = u;
    baseV[i] = 1 - Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI;
    isPole[i] = Math.abs(y) > 1 - 1e-9 ? 1 : 0;
  }

  const faceCount = faces.length / 3;
  const b = new MeshBuilder(vertexCount + faceCount, faceCount * 3);
  const emitted = new Map();
  const fu = [0, 0, 0];
  const tri = [0, 0, 0];

  const emitVertex = (index, u) => {
    // U stays within [0, 2] after the seam fix, so 18 bits of fraction are
    // enough and the key never collides across vertex indices.
    const quantized = Math.round(u * 65536);
    const key = index * 262144 + quantized;
    const cached = emitted.get(key);
    if (cached !== undefined) return cached;
    const x = dirs[index * 3];
    const y = dirs[index * 3 + 1];
    const z = dirs[index * 3 + 2];
    const created = b.vertex(x * radius, y * radius, z * radius, x, y, z, u, baseV[index]);
    emitted.set(key, created);
    return created;
  };

  for (let f = 0; f < faceCount; f++) {
    tri[0] = faces[f * 3];
    tri[1] = faces[f * 3 + 1];
    tri[2] = faces[f * 3 + 2];
    fu[0] = baseU[tri[0]];
    fu[1] = baseU[tri[1]];
    fu[2] = baseU[tri[2]];

    // Wrap correction using only the non pole corners (poles have no meaningful U).
    let minU = Infinity;
    let maxU = -Infinity;
    for (let k = 0; k < 3; k++) {
      if (isPole[tri[k]]) continue;
      if (fu[k] < minU) minU = fu[k];
      if (fu[k] > maxU) maxU = fu[k];
    }
    if (minU !== Infinity && maxU - minU > 0.5) {
      for (let k = 0; k < 3; k++) {
        if (!isPole[tri[k]] && fu[k] < 0.5) fu[k] += 1;
      }
    }
    // Poles inherit the average U of the opposite edge so the texture converges.
    for (let k = 0; k < 3; k++) {
      if (!isPole[tri[k]]) continue;
      const k1 = (k + 1) % 3;
      const k2 = (k + 2) % 3;
      fu[k] = (fu[k1] + fu[k2]) * 0.5;
    }

    b.triangle(emitVertex(tri[0], fu[0]), emitVertex(tri[1], fu[1]), emitVertex(tri[2], fu[2]));
  }

  return b.build();
}

/* -------------------------------------------------------------------------- */
/* Grid lines                                                                  */
/* -------------------------------------------------------------------------- */

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
export function createGridLines(size = 10, divisions = 10, centerColor = 0x888888, gridColor = 0x444444) {
  const div = Math.max(1, Math.floor(divisions));
  const half = size * 0.5;
  const step = size / div;
  const lineCount = (div + 1) * 2;
  const vertexCount = lineCount * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const indices = vertexCount <= 65535 ? new Uint16Array(vertexCount) : new Uint32Array(vertexCount);

  const centerLinear = new Float32Array(3);
  const gridLinear = new Float32Array(3);
  hexToLinear(centerColor, centerLinear, 0);
  hexToLinear(gridColor, gridLinear, 0);

  const center = div % 2 === 0 ? div / 2 : -1;
  let v = 0;

  for (let i = 0; i <= div; i++) {
    const k = -half + i * step;
    const c = i === center ? centerLinear : gridLinear;
    const t = i / div;

    // Line parallel to Z.
    for (let e = 0; e < 2; e++) {
      const z = e === 0 ? -half : half;
      positions[v * 3] = k;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = z;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = t;
      uvs[v * 2 + 1] = e;
      colors[v * 4] = c[0];
      colors[v * 4 + 1] = c[1];
      colors[v * 4 + 2] = c[2];
      colors[v * 4 + 3] = 1;
      indices[v] = v;
      v++;
    }
    // Line parallel to X.
    for (let e = 0; e < 2; e++) {
      const x = e === 0 ? -half : half;
      positions[v * 3] = x;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = k;
      normals[v * 3 + 1] = 1;
      uvs[v * 2] = e;
      uvs[v * 2 + 1] = t;
      colors[v * 4] = c[0];
      colors[v * 4 + 1] = c[1];
      colors[v * 4 + 2] = c[2];
      colors[v * 4 + 3] = 1;
      indices[v] = v;
      v++;
    }
  }

  const geometry = new Geometry();
  geometry.setAttribute('aPosition', positions, 3);
  geometry.setAttribute('aNormal', normals, 3);
  geometry.setAttribute('aUV0', uvs, 2);
  geometry.setAttribute('aColor', colors, 4);
  geometry.setIndex(indices);
  geometry.drawMode = 'lines';
  return finalize(geometry);
}

/* -------------------------------------------------------------------------- */
/* Screen space helpers                                                        */
/* -------------------------------------------------------------------------- */

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
export function createQuadFullscreen() {
  const positions = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
  const uvs = new Float32Array([0, 0, 2, 0, 0, 2]);
  const indices = new Uint16Array([0, 1, 2]);

  const geometry = new Geometry();
  geometry.setAttribute('aPosition', positions, 3);
  geometry.setAttribute('aUV0', uvs, 2);
  geometry.setIndex(indices);
  geometry.drawMode = 'triangles';
  return finalize(geometry);
}

/**
 * Creates a unit cube with inward facing winding and normals, meant to be
 * rendered from the inside as a skybox. `aPosition` doubles as the cubemap
 * sampling direction.
 * @param {number} [size] Edge length of the cube.
 * @returns {Geometry}
 */
export function createSkyboxCube(size = 1) {
  const box = createBox(size, size, size, 1, 1, 1);
  const index = box.index;
  const idx = index.data;
  for (let i = 0, n = index.count !== undefined ? index.count : idx.length; i < n; i += 3) {
    const tmp = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = tmp;
  }
  const normals = box.getAttribute('aNormal').data;
  for (let i = 0, n = normals.length; i < n; i++) normals[i] = -normals[i];
  box.markAttributeDirty('aNormal');
  index.needsUpdate = true;
  return box;
}

/* -------------------------------------------------------------------------- */
/* Terrain                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Flat height function used when the caller does not provide one.
 * @returns {number}
 */
function flatHeight() {
  return 0;
}

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
export function createTerrain(size = 100, segments = 64, heightFn = null, uvScale = 1) {
  const seg = Math.max(1, Math.floor(segments));
  const n = seg + 1;
  const half = size * 0.5;
  const step = size / seg;
  const fn = typeof heightFn === 'function' ? heightFn : flatHeight;

  // Padded sample grid (one extra ring on each side) for central differences.
  const gw = n + 2;
  const h = new Float64Array(gw * gw);
  for (let j = 0; j < gw; j++) {
    const z = -half + (j - 1) * step;
    for (let i = 0; i < gw; i++) {
      const x = -half + (i - 1) * step;
      const value = fn(x, z);
      h[j * gw + i] = Number.isFinite(value) ? value : 0;
    }
  }

  const vertexCount = n * n;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indexCount = seg * seg * 6;
  const indices = vertexCount <= 65535 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  const twoStep = 2 * step;

  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) {
      const x = -half + i * step;
      const gi = (j + 1) * gw + (i + 1);
      const v = j * n + i;
      const v3 = v * 3;
      const v2 = v * 2;

      positions[v3] = x;
      positions[v3 + 1] = h[gi];
      positions[v3 + 2] = z;

      const nx = h[gi - 1] - h[gi + 1];
      const nz = h[gi - gw] - h[gi + gw];
      const len = Math.hypot(nx, twoStep, nz);
      normals[v3] = nx / len;
      normals[v3 + 1] = twoStep / len;
      normals[v3 + 2] = nz / len;

      uvs[v2] = (i / seg) * uvScale;
      uvs[v2 + 1] = (j / seg) * uvScale;
    }
  }

  let w = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = (j + 1) * n + i;
      const c = (j + 1) * n + i + 1;
      const d = j * n + i + 1;
      indices[w++] = a; indices[w++] = b; indices[w++] = d;
      indices[w++] = b; indices[w++] = c; indices[w++] = d;
    }
  }

  const geometry = new Geometry();
  geometry.setAttribute('aPosition', positions, 3);
  geometry.setAttribute('aNormal', normals, 3);
  geometry.setAttribute('aUV0', uvs, 2);
  geometry.setIndex(indices);
  geometry.drawMode = 'triangles';
  return finalize(geometry);
}
