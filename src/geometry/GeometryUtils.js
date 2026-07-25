/**
 * @fileoverview Geometry processing utilities: normal / tangent generation,
 * merging, indexing, bounding volumes, post-transform vertex cache optimization
 * (Tipsify) and quadric error metric decimation (Garland & Heckbert).
 *
 * Every function works directly on {@link Geometry} attribute storage and is
 * fully allocation aware: temporaries are TypedArrays sized once up front.
 */

import { Geometry } from '../render/Geometry.js';
import { AABB } from '../math/AABB.js';
import { Sphere } from '../math/Sphere.js';

const EPS = 1e-12;

/* -------------------------------------------------------------------------- */
/* Attribute access helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Number of array elements between two consecutive vertices of an attribute.
 * `stride` is expressed in bytes (GL convention) and converted here.
 * @param {object} attr
 * @returns {number}
 */
function strideElems(attr) {
  const bpe = attr.data.BYTES_PER_ELEMENT || 4;
  const strideBytes = attr.stride || 0;
  return strideBytes > 0 ? Math.floor(strideBytes / bpe) : attr.size;
}

/**
 * Element offset of the first component of an attribute.
 * @param {object} attr
 * @returns {number}
 */
function offsetElems(attr) {
  const bpe = attr.data.BYTES_PER_ELEMENT || 4;
  return Math.floor((attr.offset || 0) / bpe);
}

/**
 * Number of vertices addressed by an attribute.
 * @param {object} attr
 * @returns {number}
 */
function attrCount(attr) {
  if (typeof attr.count === 'number' && attr.count > 0) return attr.count;
  const stride = strideElems(attr);
  if (stride <= 0) return 0;
  return Math.floor((attr.data.length - offsetElems(attr)) / stride);
}

/**
 * Returns a tightly packed view of an attribute. When the attribute is already
 * packed the original array is returned unless `forceCopy` is set.
 * @param {object} attr
 * @param {boolean} [forceCopy]
 * @returns {ArrayBufferView}
 */
function packAttribute(attr, forceCopy) {
  const size = attr.size;
  const stride = strideElems(attr);
  const offset = offsetElems(attr);
  const count = attrCount(attr);
  if (!forceCopy && stride === size && offset === 0 && attr.data.length === count * size) {
    return attr.data;
  }
  const out = new attr.data.constructor(count * size);
  for (let i = 0; i < count; i++) {
    const s = offset + i * stride;
    const d = i * size;
    for (let k = 0; k < size; k++) out[d + k] = attr.data[s + k];
  }
  return out;
}

/**
 * Returns the index array of a geometry together with its element count.
 * @param {Geometry} geometry
 * @returns {{array: ArrayBufferView, count: number}|null}
 */
function getIndexInfo(geometry) {
  const index = geometry.index;
  if (!index || !index.data) return null;
  const count = typeof index.count === 'number' && index.count > 0 ? index.count : index.data.length;
  return { array: index.data, count: Math.min(count, index.data.length) };
}

/**
 * Allocates the smallest index array able to address `vertexCount` vertices.
 * @param {number} length
 * @param {number} vertexCount
 * @returns {Uint16Array|Uint32Array}
 */
function allocIndex(length, vertexCount) {
  return vertexCount <= 65535 ? new Uint16Array(length) : new Uint32Array(length);
}

/**
 * Number of vertices of a geometry, derived from `aPosition`.
 * @param {Geometry} geometry
 * @returns {number}
 */
function vertexCountOf(geometry) {
  const attr = geometry.getAttribute('aPosition');
  return attr ? attrCount(attr) : 0;
}

/* -------------------------------------------------------------------------- */
/* Normals and tangents                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Computes area weighted smooth vertex normals and stores them in `aNormal`.
 * Works for both indexed and non-indexed geometry.
 * @param {Geometry} geometry
 * @returns {Geometry} The same geometry, for chaining.
 */
export function computeNormals(geometry) {
  const posAttr = geometry.getAttribute('aPosition');
  if (!posAttr) return geometry;
  const positions = packAttribute(posAttr, false);
  const vertexCount = attrCount(posAttr);
  const normals = new Float32Array(vertexCount * 3);
  const indexInfo = getIndexInfo(geometry);
  const indices = indexInfo ? indexInfo.array : null;
  const triangleCount = indexInfo ? Math.floor(indexInfo.count / 3) : Math.floor(vertexCount / 3);

  for (let t = 0; t < triangleCount; t++) {
    const ia = indices ? indices[t * 3] : t * 3;
    const ib = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const ic = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;

    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];

    // Un-normalized cross product = 2 * area * normal (area weighting).
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }

  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const x = normals[o];
    const y = normals[o + 1];
    const z = normals[o + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-20) {
      normals[o] = x / len;
      normals[o + 1] = y / len;
      normals[o + 2] = z / len;
    } else {
      normals[o] = 0;
      normals[o + 1] = 1;
      normals[o + 2] = 0;
    }
  }

  geometry.setAttribute('aNormal', normals, 3);
  return geometry;
}

/**
 * Computes per-vertex tangents (vec4, w = handedness) from `aUV0`.
 * Requires `aPosition` and `aUV0`; `aNormal` is generated when missing.
 * @param {Geometry} geometry
 * @returns {Geometry} The same geometry, for chaining.
 */
export function computeTangents(geometry) {
  const posAttr = geometry.getAttribute('aPosition');
  const uvAttr = geometry.getAttribute('aUV0');
  if (!posAttr || !uvAttr) return geometry;
  if (!geometry.getAttribute('aNormal')) computeNormals(geometry);

  const positions = packAttribute(posAttr, false);
  const uvs = packAttribute(uvAttr, false);
  const normals = packAttribute(geometry.getAttribute('aNormal'), false);
  const vertexCount = attrCount(posAttr);

  const tan1 = new Float64Array(vertexCount * 3);
  const tan2 = new Float64Array(vertexCount * 3);
  const indexInfo = getIndexInfo(geometry);
  const indices = indexInfo ? indexInfo.array : null;
  const triangleCount = indexInfo ? Math.floor(indexInfo.count / 3) : Math.floor(vertexCount / 3);

  for (let t = 0; t < triangleCount; t++) {
    const ia = indices ? indices[t * 3] : t * 3;
    const ib = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const ic = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const a3 = ia * 3;
    const b3 = ib * 3;
    const c3 = ic * 3;
    const a2 = ia * 2;
    const b2 = ib * 2;
    const c2 = ic * 2;

    const x1 = positions[b3] - positions[a3];
    const y1 = positions[b3 + 1] - positions[a3 + 1];
    const z1 = positions[b3 + 2] - positions[a3 + 2];
    const x2 = positions[c3] - positions[a3];
    const y2 = positions[c3 + 1] - positions[a3 + 1];
    const z2 = positions[c3 + 2] - positions[a3 + 2];

    const s1 = uvs[b2] - uvs[a2];
    const t1 = uvs[b2 + 1] - uvs[a2 + 1];
    const s2 = uvs[c2] - uvs[a2];
    const t2 = uvs[c2 + 1] - uvs[a2 + 1];

    const det = s1 * t2 - s2 * t1;
    if (Math.abs(det) < 1e-20) continue;
    const r = 1 / det;

    const sdx = (t2 * x1 - t1 * x2) * r;
    const sdy = (t2 * y1 - t1 * y2) * r;
    const sdz = (t2 * z1 - t1 * z2) * r;
    const tdx = (s1 * x2 - s2 * x1) * r;
    const tdy = (s1 * y2 - s2 * y1) * r;
    const tdz = (s1 * z2 - s2 * z1) * r;

    tan1[a3] += sdx; tan1[a3 + 1] += sdy; tan1[a3 + 2] += sdz;
    tan1[b3] += sdx; tan1[b3 + 1] += sdy; tan1[b3 + 2] += sdz;
    tan1[c3] += sdx; tan1[c3 + 1] += sdy; tan1[c3 + 2] += sdz;

    tan2[a3] += tdx; tan2[a3 + 1] += tdy; tan2[a3 + 2] += tdz;
    tan2[b3] += tdx; tan2[b3 + 1] += tdy; tan2[b3 + 2] += tdz;
    tan2[c3] += tdx; tan2[c3 + 1] += tdy; tan2[c3 + 2] += tdz;
  }

  const tangents = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const o3 = i * 3;
    const o4 = i * 4;
    const nx = normals[o3];
    const ny = normals[o3 + 1];
    const nz = normals[o3 + 2];
    let tx = tan1[o3];
    let ty = tan1[o3 + 1];
    let tz = tan1[o3 + 2];

    // Gram-Schmidt orthogonalization against the normal.
    const ndt = nx * tx + ny * ty + nz * tz;
    tx -= nx * ndt;
    ty -= ny * ndt;
    tz -= nz * ndt;
    let len = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (len < 1e-12) {
      // Fallback: any vector perpendicular to the normal.
      if (Math.abs(nx) < 0.9) { tx = 1; ty = 0; tz = 0; } else { tx = 0; ty = 1; tz = 0; }
      const d = nx * tx + ny * ty + nz * tz;
      tx -= nx * d; ty -= ny * d; tz -= nz * d;
      len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    }
    tx /= len; ty /= len; tz /= len;

    // Handedness: sign of dot(cross(N, T), bitangent).
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const w = (cx * tan2[o3] + cy * tan2[o3 + 1] + cz * tan2[o3 + 2]) < 0 ? -1 : 1;

    tangents[o4] = tx;
    tangents[o4 + 1] = ty;
    tangents[o4 + 2] = tz;
    tangents[o4 + 3] = w;
  }

  geometry.setAttribute('aTangent', tangents, 4);
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Bounding volumes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Computes the axis aligned bounding box of a geometry.
 * @param {Geometry} geometry
 * @param {AABB} [out] Optional destination.
 * @returns {AABB}
 */
export function computeAABB(geometry, out) {
  const box = out || new AABB();
  box.makeEmpty();
  const attr = geometry.getAttribute('aPosition');
  if (!attr) return box;

  const data = attr.data;
  const stride = strideElems(attr);
  const offset = offsetElems(attr);
  const count = attrCount(attr);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = offset + i * stride;
    const x = data[o];
    const y = data[o + 1];
    const z = data[o + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (count === 0) return box;

  box.min.set(minX, minY, minZ);
  box.max.set(maxX, maxY, maxZ);
  return box;
}

/**
 * Computes a tight-ish bounding sphere centered on the bounding box center.
 * @param {Geometry} geometry
 * @param {Sphere} [out] Optional destination.
 * @returns {Sphere}
 */
export function computeBoundingSphere(geometry, out) {
  const sphere = out || new Sphere();
  const attr = geometry.getAttribute('aPosition');
  if (!attr) {
    sphere.center.set(0, 0, 0);
    sphere.radius = 0;
    return sphere;
  }

  const data = attr.data;
  const stride = strideElems(attr);
  const offset = offsetElems(attr);
  const count = attrCount(attr);
  if (count === 0) {
    sphere.center.set(0, 0, 0);
    sphere.radius = 0;
    return sphere;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = offset + i * stride;
    const x = data[o];
    const y = data[o + 1];
    const z = data[o + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  let maxSq = 0;
  for (let i = 0; i < count; i++) {
    const o = offset + i * stride;
    const dx = data[o] - cx;
    const dy = data[o + 1] - cy;
    const dz = data[o + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > maxSq) maxSq = d;
  }

  sphere.center.set(cx, cy, cz);
  sphere.radius = Math.sqrt(maxSq);
  return sphere;
}

/* -------------------------------------------------------------------------- */
/* Indexing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Expands an indexed geometry into a flat, non-indexed one.
 * @param {Geometry} geometry
 * @returns {Geometry} A new geometry.
 */
export function toNonIndexed(geometry) {
  const indexInfo = getIndexInfo(geometry);
  if (!indexInfo) return geometry.clone();

  const indices = indexInfo.array;
  const count = indexInfo.count;
  const out = new Geometry();

  geometry.attributes.forEach((attr, name) => {
    const size = attr.size;
    const stride = strideElems(attr);
    const offset = offsetElems(attr);
    const src = attr.data;
    const dst = new src.constructor(count * size);
    for (let i = 0; i < count; i++) {
      const s = offset + indices[i] * stride;
      const d = i * size;
      for (let k = 0; k < size; k++) dst[d + k] = src[s + k];
    }
    out.setAttribute(name, dst, size, { normalized: !!attr.normalized, divisor: attr.divisor || 0 });
  });

  out.setIndex(null);
  out.drawMode = geometry.drawMode;
  out.instanceCount = geometry.instanceCount;
  for (let i = 0, n = geometry.groups.length; i < n; i++) {
    const g = geometry.groups[i];
    out.groups.push({ start: g.start, count: g.count, materialIndex: g.materialIndex });
  }
  out.boundingBox = computeAABB(out);
  out.boundingSphere = computeBoundingSphere(out);
  return out;
}

/**
 * Welds identical vertices and builds an index buffer. Vertices are considered
 * identical when every one of their attribute components matches after
 * quantization by `tolerance`.
 * @param {Geometry} geometry
 * @param {number} [tolerance] Quantization step (1e-4 by default).
 * @returns {Geometry} A new geometry.
 */
export function toIndexed(geometry, tolerance = 1e-4) {
  const posAttr = geometry.getAttribute('aPosition');
  if (!posAttr) return geometry.clone();

  const tol = tolerance > 0 ? tolerance : 1e-4;
  const invTol = 1 / tol;
  const sourceCount = attrCount(posAttr);
  const indexInfo = getIndexInfo(geometry);
  const oldIndices = indexInfo ? indexInfo.array : null;
  const drawCount = indexInfo ? indexInfo.count : sourceCount;

  /** @type {{name: string, attr: object, size: number, stride: number, offset: number, dst: ArrayBufferView}[]} */
  const channels = [];
  geometry.attributes.forEach((attr, name) => {
    channels.push({
      name,
      attr,
      size: attr.size,
      stride: strideElems(attr),
      offset: offsetElems(attr),
      dst: new attr.data.constructor(drawCount * attr.size)
    });
  });

  const map = new Map();
  const newIndices = new Uint32Array(drawCount);
  const keyParts = [];
  let unique = 0;

  for (let i = 0; i < drawCount; i++) {
    const src = oldIndices ? oldIndices[i] : i;
    keyParts.length = 0;
    for (let c = 0, nc = channels.length; c < nc; c++) {
      const ch = channels[c];
      const o = ch.offset + src * ch.stride;
      for (let k = 0; k < ch.size; k++) {
        keyParts.push(Math.round(ch.attr.data[o + k] * invTol));
      }
    }
    const key = keyParts.join(',');
    let target = map.get(key);
    if (target === undefined) {
      target = unique++;
      map.set(key, target);
      for (let c = 0, nc = channels.length; c < nc; c++) {
        const ch = channels[c];
        const o = ch.offset + src * ch.stride;
        const d = target * ch.size;
        for (let k = 0; k < ch.size; k++) ch.dst[d + k] = ch.attr.data[o + k];
      }
    }
    newIndices[i] = target;
  }

  const out = new Geometry();
  for (let c = 0, nc = channels.length; c < nc; c++) {
    const ch = channels[c];
    out.setAttribute(ch.name, ch.dst.slice(0, unique * ch.size), ch.size, {
      normalized: !!ch.attr.normalized,
      divisor: ch.attr.divisor || 0
    });
  }

  const finalIndices = allocIndex(drawCount, unique);
  for (let i = 0; i < drawCount; i++) finalIndices[i] = newIndices[i];
  out.setIndex(finalIndices);
  out.drawMode = geometry.drawMode;
  out.instanceCount = geometry.instanceCount;
  for (let i = 0, n = geometry.groups.length; i < n; i++) {
    const g = geometry.groups[i];
    out.groups.push({ start: g.start, count: g.count, materialIndex: g.materialIndex });
  }
  out.boundingBox = computeAABB(out);
  out.boundingSphere = computeBoundingSphere(out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

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
export function mergeGeometries(geometries, useGroups = false) {
  const list = [];
  for (let i = 0, n = geometries.length; i < n; i++) {
    if (geometries[i] && geometries[i].getAttribute('aPosition')) list.push(geometries[i]);
  }
  if (list.length === 0) return new Geometry();

  const first = list[0];
  /** @type {string[]} */
  const names = [];
  first.attributes.forEach((attr, name) => {
    let ok = true;
    for (let i = 1, n = list.length; i < n; i++) {
      const other = list[i].getAttribute(name);
      if (!other || other.size !== attr.size) { ok = false; break; }
      if (other.data.constructor !== attr.data.constructor) {
        throw new Error(`mergeGeometries: attribute "${name}" has incompatible array types.`);
      }
    }
    if (ok) names.push(name);
  });

  let totalVertices = 0;
  let totalIndices = 0;
  for (let i = 0, n = list.length; i < n; i++) {
    const g = list[i];
    const vc = vertexCountOf(g);
    const info = getIndexInfo(g);
    totalVertices += vc;
    totalIndices += info ? info.count : vc;
  }

  const out = new Geometry();
  /** @type {Map<string, ArrayBufferView>} */
  const buffers = new Map();
  for (let i = 0, n = names.length; i < n; i++) {
    const attr = first.getAttribute(names[i]);
    buffers.set(names[i], new attr.data.constructor(totalVertices * attr.size));
  }

  const indices = allocIndex(totalIndices, totalVertices);
  let vertexOffset = 0;
  let indexOffset = 0;
  let materialOffset = 0;

  for (let i = 0, n = list.length; i < n; i++) {
    const g = list[i];
    const vc = vertexCountOf(g);

    for (let a = 0, na = names.length; a < na; a++) {
      const name = names[a];
      const attr = g.getAttribute(name);
      const size = attr.size;
      const stride = strideElems(attr);
      const offset = offsetElems(attr);
      const dst = buffers.get(name);
      const src = attr.data;
      let d = vertexOffset * size;
      for (let v = 0; v < vc; v++) {
        const s = offset + v * stride;
        for (let k = 0; k < size; k++) dst[d + k] = src[s + k];
        d += size;
      }
    }

    const info = getIndexInfo(g);
    const localIndexCount = info ? info.count : vc;
    if (info) {
      const src = info.array;
      for (let k = 0; k < localIndexCount; k++) indices[indexOffset + k] = src[k] + vertexOffset;
    } else {
      for (let k = 0; k < localIndexCount; k++) indices[indexOffset + k] = k + vertexOffset;
    }

    if (useGroups) {
      if (g.groups.length > 0) {
        let maxMaterial = 0;
        for (let gi = 0, gn = g.groups.length; gi < gn; gi++) {
          const grp = g.groups[gi];
          const mi = materialOffset + (grp.materialIndex || 0);
          if (mi > maxMaterial) maxMaterial = mi;
          out.groups.push({
            start: indexOffset + grp.start,
            count: grp.count,
            materialIndex: mi
          });
        }
        materialOffset = maxMaterial + 1;
      } else {
        out.groups.push({ start: indexOffset, count: localIndexCount, materialIndex: materialOffset });
        materialOffset++;
      }
    }

    vertexOffset += vc;
    indexOffset += localIndexCount;
  }

  for (let i = 0, n = names.length; i < n; i++) {
    const attr = first.getAttribute(names[i]);
    out.setAttribute(names[i], buffers.get(names[i]), attr.size, {
      normalized: !!attr.normalized,
      divisor: attr.divisor || 0
    });
  }
  out.setIndex(indices);
  out.drawMode = first.drawMode;
  out.boundingBox = computeAABB(out);
  out.boundingSphere = computeBoundingSphere(out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Post-transform vertex cache optimization (Tipsify)                          */
/* -------------------------------------------------------------------------- */

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
export function optimizeVertexCache(indices, vertexCount = 0, cacheSize = 32) {
  const indexCount = indices.length - (indices.length % 3);
  const triCount = indexCount / 3;

  let vCount = vertexCount | 0;
  if (vCount <= 0) {
    let maxIndex = -1;
    for (let i = 0; i < indexCount; i++) if (indices[i] > maxIndex) maxIndex = indices[i];
    vCount = maxIndex + 1;
  }

  const Ctor = indices.constructor === Array ? Uint32Array : indices.constructor;
  const out = new Ctor(indices.length);
  if (triCount === 0 || vCount === 0) {
    for (let i = 0, n = indices.length; i < n; i++) out[i] = indices[i];
    return out;
  }

  const k = Math.max(3, cacheSize | 0);

  // CSR adjacency: vertex -> triangles.
  const counts = new Int32Array(vCount + 1);
  for (let i = 0; i < indexCount; i++) counts[indices[i]]++;
  const offsets = new Int32Array(vCount + 1);
  let running = 0;
  let maxValence = 0;
  for (let v = 0; v < vCount; v++) {
    offsets[v] = running;
    running += counts[v];
    if (counts[v] > maxValence) maxValence = counts[v];
  }
  offsets[vCount] = running;

  const cursorPerVertex = new Int32Array(vCount);
  for (let v = 0; v < vCount; v++) cursorPerVertex[v] = offsets[v];
  const adjacency = new Int32Array(indexCount);
  for (let t = 0; t < triCount; t++) {
    adjacency[cursorPerVertex[indices[t * 3]]++] = t;
    adjacency[cursorPerVertex[indices[t * 3 + 1]]++] = t;
    adjacency[cursorPerVertex[indices[t * 3 + 2]]++] = t;
  }

  const live = new Int32Array(vCount);
  for (let v = 0; v < vCount; v++) live[v] = counts[v];

  const cacheTime = new Int32Array(vCount); // 0 == never seen
  const emitted = new Uint8Array(triCount);
  const deadEnd = new Int32Array(indexCount);
  const candidates = new Int32Array(Math.max(3, maxValence * 3));

  let timeStamp = k + 1;
  let deadEndTop = 0;
  let scanCursor = 0;
  let outPos = 0;
  let fan = 0;

  // Start from the first vertex that actually owns triangles.
  while (fan < vCount && live[fan] === 0) fan++;
  if (fan >= vCount) {
    for (let i = 0, n = indices.length; i < n; i++) out[i] = indices[i];
    return out;
  }

  while (fan >= 0) {
    let candidateCount = 0;
    const start = offsets[fan];
    const end = offsets[fan + 1];

    for (let a = start; a < end; a++) {
      const tri = adjacency[a];
      if (emitted[tri]) continue;
      emitted[tri] = 1;
      for (let j = 0; j < 3; j++) {
        const v = indices[tri * 3 + j];
        out[outPos++] = v;
        deadEnd[deadEndTop++] = v;
        candidates[candidateCount++] = v;
        live[v]--;
        if (timeStamp - cacheTime[v] > k) {
          cacheTime[v] = timeStamp;
          timeStamp++;
        }
      }
    }

    // Pick the next fanning vertex among the freshly touched ones.
    fan = -1;
    let bestPriority = -1;
    for (let i = 0; i < candidateCount; i++) {
      const v = candidates[i];
      if (live[v] <= 0) continue;
      let priority = 0;
      if (timeStamp - cacheTime[v] + 2 * live[v] <= k) priority = timeStamp - cacheTime[v];
      if (priority > bestPriority) {
        bestPriority = priority;
        fan = v;
      }
    }

    if (fan < 0) {
      // Dead end: unwind the stack, then fall back to a linear scan.
      while (deadEndTop > 0) {
        const v = deadEnd[--deadEndTop];
        if (live[v] > 0) { fan = v; break; }
      }
      if (fan < 0) {
        while (scanCursor < vCount) {
          if (live[scanCursor] > 0) { fan = scanCursor; break; }
          scanCursor++;
        }
      }
    }
  }

  // Safety net: append any triangle the traversal could not reach.
  if (outPos < indexCount) {
    for (let t = 0; t < triCount && outPos < indexCount; t++) {
      if (emitted[t]) continue;
      emitted[t] = 1;
      out[outPos++] = indices[t * 3];
      out[outPos++] = indices[t * 3 + 1];
      out[outPos++] = indices[t * 3 + 2];
    }
  }
  for (let i = indexCount, n = indices.length; i < n; i++) out[i] = indices[i];

  return out;
}

/* -------------------------------------------------------------------------- */
/* Quadric error metric simplification                                         */
/* -------------------------------------------------------------------------- */

/**
 * Binary min-heap of candidate edge collapses stored in parallel TypedArrays.
 * Entries are never removed on invalidation; stale entries are detected on pop
 * through a monotonically increasing version number.
 */
class CollapseHeap {
  /**
   * @param {number} [capacity]
   */
  constructor(capacity = 1024) {
    const c = Math.max(16, capacity | 0);
    this.cost = new Float64Array(c);
    this.va = new Int32Array(c);
    this.vb = new Int32Array(c);
    this.version = new Int32Array(c);
    this.tx = new Float64Array(c);
    this.ty = new Float64Array(c);
    this.tz = new Float64Array(c);
    this.size = 0;

    this.outCost = 0;
    this.outA = -1;
    this.outB = -1;
    this.outVersion = 0;
    this.outX = 0;
    this.outY = 0;
    this.outZ = 0;
  }

  /** Doubles the internal capacity. */
  grow() {
    const c = this.cost.length * 2;
    const cost = new Float64Array(c); cost.set(this.cost); this.cost = cost;
    const va = new Int32Array(c); va.set(this.va); this.va = va;
    const vb = new Int32Array(c); vb.set(this.vb); this.vb = vb;
    const version = new Int32Array(c); version.set(this.version); this.version = version;
    const tx = new Float64Array(c); tx.set(this.tx); this.tx = tx;
    const ty = new Float64Array(c); ty.set(this.ty); this.ty = ty;
    const tz = new Float64Array(c); tz.set(this.tz); this.tz = tz;
  }

  /**
   * Swaps two heap slots.
   * @param {number} i
   * @param {number} j
   */
  swap(i, j) {
    let f = this.cost[i]; this.cost[i] = this.cost[j]; this.cost[j] = f;
    let n = this.va[i]; this.va[i] = this.va[j]; this.va[j] = n;
    n = this.vb[i]; this.vb[i] = this.vb[j]; this.vb[j] = n;
    n = this.version[i]; this.version[i] = this.version[j]; this.version[j] = n;
    f = this.tx[i]; this.tx[i] = this.tx[j]; this.tx[j] = f;
    f = this.ty[i]; this.ty[i] = this.ty[j]; this.ty[j] = f;
    f = this.tz[i]; this.tz[i] = this.tz[j]; this.tz[j] = f;
  }

  /**
   * Inserts a candidate collapse.
   * @param {number} cost
   * @param {number} a
   * @param {number} b
   * @param {number} version
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  push(cost, a, b, version, x, y, z) {
    if (this.size >= this.cost.length) this.grow();
    let i = this.size++;
    this.cost[i] = cost;
    this.va[i] = a;
    this.vb[i] = b;
    this.version[i] = version;
    this.tx[i] = x;
    this.ty[i] = y;
    this.tz[i] = z;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  /**
   * Extracts the cheapest candidate into the `out*` fields.
   * @returns {boolean} False when the heap is empty.
   */
  pop() {
    if (this.size === 0) return false;
    this.outCost = this.cost[0];
    this.outA = this.va[0];
    this.outB = this.vb[0];
    this.outVersion = this.version[0];
    this.outX = this.tx[0];
    this.outY = this.ty[0];
    this.outZ = this.tz[0];

    this.size--;
    if (this.size > 0) {
      this.swap(0, this.size);
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.size && this.cost[l] < this.cost[smallest]) smallest = l;
        if (r < this.size && this.cost[r] < this.cost[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return true;
  }
}

const _q = new Float64Array(10);
const _target = new Float64Array(3);

/**
 * Adds `w * outer(plane, plane)` to the quadric of vertex `v`.
 * @param {Float64Array} quadrics
 * @param {number} v
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {number} w
 */
function addPlaneQuadric(quadrics, v, a, b, c, d, w) {
  const o = v * 10;
  quadrics[o] += w * a * a;
  quadrics[o + 1] += w * a * b;
  quadrics[o + 2] += w * a * c;
  quadrics[o + 3] += w * a * d;
  quadrics[o + 4] += w * b * b;
  quadrics[o + 5] += w * b * c;
  quadrics[o + 6] += w * b * d;
  quadrics[o + 7] += w * c * c;
  quadrics[o + 8] += w * c * d;
  quadrics[o + 9] += w * d * d;
}

/**
 * Evaluates v^T Q v for the quadric currently held in `_q`.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function evalQuadric(x, y, z) {
  return _q[0] * x * x + 2 * _q[1] * x * y + 2 * _q[2] * x * z + 2 * _q[3] * x +
    _q[4] * y * y + 2 * _q[5] * y * z + 2 * _q[6] * y +
    _q[7] * z * z + 2 * _q[8] * z + _q[9];
}

/**
 * Computes the optimal contraction target and its quadric error for edge (a,b).
 * The result position is written to the module scratch `_target`.
 * @param {Float64Array} quadrics
 * @param {Float64Array} positions
 * @param {Uint8Array} boundary
 * @param {number} a
 * @param {number} b
 * @returns {number} Collapse cost.
 */
function computeCollapse(quadrics, positions, boundary, a, b) {
  const oa = a * 10;
  const ob = b * 10;
  for (let i = 0; i < 10; i++) _q[i] = quadrics[oa + i] + quadrics[ob + i];

  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const by = positions[b * 3 + 1];
  const bz = positions[b * 3 + 2];

  // Border vertices are pinned so open boundaries keep their silhouette.
  const aFixed = boundary[a] === 1;
  const bFixed = boundary[b] === 1;
  if (aFixed && !bFixed) {
    _target[0] = ax; _target[1] = ay; _target[2] = az;
    return Math.max(0, evalQuadric(ax, ay, az));
  }
  if (bFixed && !aFixed) {
    _target[0] = bx; _target[1] = by; _target[2] = bz;
    return Math.max(0, evalQuadric(bx, by, bz));
  }

  const a11 = _q[0], a12 = _q[1], a13 = _q[2];
  const a22 = _q[4], a23 = _q[5], a33 = _q[7];
  const cof11 = a22 * a33 - a23 * a23;
  const cof12 = a13 * a23 - a12 * a33;
  const cof13 = a12 * a23 - a13 * a22;
  const det = a11 * cof11 + a12 * cof12 + a13 * cof13;

  const scale = Math.abs(a11) + Math.abs(a22) + Math.abs(a33) + 1e-30;
  if (Math.abs(det) > 1e-12 * scale * scale * scale) {
    const inv = 1 / det;
    const i11 = cof11 * inv;
    const i12 = cof12 * inv;
    const i13 = cof13 * inv;
    const i22 = (a11 * a33 - a13 * a13) * inv;
    const i23 = (a13 * a12 - a11 * a23) * inv;
    const i33 = (a11 * a22 - a12 * a12) * inv;

    const x = -(i11 * _q[3] + i12 * _q[6] + i13 * _q[8]);
    const y = -(i12 * _q[3] + i22 * _q[6] + i23 * _q[8]);
    const z = -(i13 * _q[3] + i23 * _q[6] + i33 * _q[8]);

    // Reject wildly extrapolated optima (numerically unstable quadrics).
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;
    const mz = (az + bz) * 0.5;
    const edgeLenSq = (ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (az - bz) * (az - bz);
    const driftSq = (x - mx) * (x - mx) + (y - my) * (y - my) + (z - mz) * (z - mz);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && driftSq <= edgeLenSq * 16 + EPS) {
      _target[0] = x; _target[1] = y; _target[2] = z;
      return Math.max(0, evalQuadric(x, y, z));
    }
  }

  // Fallback: cheapest of the two endpoints and the midpoint.
  const costA = evalQuadric(ax, ay, az);
  const costB = evalQuadric(bx, by, bz);
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;
  const mz = (az + bz) * 0.5;
  const costM = evalQuadric(mx, my, mz);

  if (costA <= costB && costA <= costM) {
    _target[0] = ax; _target[1] = ay; _target[2] = az;
    return Math.max(0, costA);
  }
  if (costB <= costM) {
    _target[0] = bx; _target[1] = by; _target[2] = bz;
    return Math.max(0, costB);
  }
  _target[0] = mx; _target[1] = my; _target[2] = mz;
  return Math.max(0, costM);
}

/**
 * Undirected edge key. Valid up to 2^26 vertices, well beyond any realistic
 * mesh handled on the CPU.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function edgeKey(a, b) {
  return a < b ? a * 67108864 + b : b * 67108864 + a;
}

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
export function simplify(geometry, targetRatio, options = {}) {
  const ratio = Math.max(1e-6, Math.min(1, targetRatio));
  const boundaryWeight = options.boundaryWeight !== undefined ? options.boundaryWeight : 1000;
  const flipThreshold = options.flipThreshold !== undefined ? options.flipThreshold : 0.2;
  const maxCost = options.maxCost !== undefined ? options.maxCost : Infinity;

  if (geometry.drawMode !== undefined && geometry.drawMode !== 'triangles') return geometry.clone();

  const source = getIndexInfo(geometry)
    ? geometry
    : toIndexed(geometry, options.weldTolerance !== undefined ? options.weldTolerance : 1e-5);

  const posAttr = source.getAttribute('aPosition');
  const indexInfo = getIndexInfo(source);
  if (!posAttr || !indexInfo) return geometry.clone();

  const vertexCount = attrCount(posAttr);
  const triCount = Math.floor(indexInfo.count / 3);
  const targetTris = Math.max(1, Math.min(triCount, Math.round(triCount * ratio)));
  if (targetTris >= triCount || triCount === 0) return source === geometry ? geometry.clone() : source;

  // --- Working copies -------------------------------------------------------
  const packedPositions = packAttribute(posAttr, false);
  const positions = new Float64Array(vertexCount * 3);
  for (let i = 0, n = vertexCount * 3; i < n; i++) positions[i] = packedPositions[i];

  const faces = new Int32Array(triCount * 3);
  for (let i = 0, n = triCount * 3; i < n; i++) faces[i] = indexInfo.array[i];

  const faceAlive = new Uint8Array(triCount).fill(1);
  const alive = new Uint8Array(vertexCount).fill(1);
  const quadrics = new Float64Array(vertexCount * 10);
  const boundary = new Uint8Array(vertexCount);

  /** @type {number[][]} */
  const vertexFaces = new Array(vertexCount);
  /** @type {Set<number>[]} */
  const neighbors = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    vertexFaces[i] = [];
    neighbors[i] = new Set();
  }

  // --- Face quadrics + adjacency -------------------------------------------
  const edgeCount = new Map();
  const edgeFace = new Map();

  for (let f = 0; f < triCount; f++) {
    const i0 = faces[f * 3];
    const i1 = faces[f * 3 + 1];
    const i2 = faces[f * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      faceAlive[f] = 0;
      continue;
    }

    vertexFaces[i0].push(f);
    vertexFaces[i1].push(f);
    vertexFaces[i2].push(f);
    neighbors[i0].add(i1); neighbors[i0].add(i2);
    neighbors[i1].add(i0); neighbors[i1].add(i2);
    neighbors[i2].add(i0); neighbors[i2].add(i1);

    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const e1x = positions[i1 * 3] - ax, e1y = positions[i1 * 3 + 1] - ay, e1z = positions[i1 * 3 + 2] - az;
    const e2x = positions[i2 * 3] - ax, e2y = positions[i2 * 3 + 1] - ay, e2z = positions[i2 * 3 + 2] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-20) {
      const area = len * 0.5;
      nx /= len; ny /= len; nz /= len;
      const d = -(nx * ax + ny * ay + nz * az);
      addPlaneQuadric(quadrics, i0, nx, ny, nz, d, area);
      addPlaneQuadric(quadrics, i1, nx, ny, nz, d, area);
      addPlaneQuadric(quadrics, i2, nx, ny, nz, d, area);
    }

    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + (e + 1) % 3];
      const key = edgeKey(va, vb);
      const prev = edgeCount.get(key);
      if (prev === undefined) {
        edgeCount.set(key, 1);
        edgeFace.set(key, f);
      } else {
        edgeCount.set(key, prev + 1);
      }
    }
  }

  // --- Boundary constraint planes ------------------------------------------
  edgeCount.forEach((count, key) => {
    if (count !== 1) return;
    const f = edgeFace.get(key);
    if (f === undefined || !faceAlive[f]) return;
    const va = Math.floor(key / 67108864);
    const vb = key - va * 67108864;
    boundary[va] = 1;
    boundary[vb] = 1;

    const i0 = faces[f * 3];
    const i1 = faces[f * 3 + 1];
    const i2 = faces[f * 3 + 2];
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const e1x = positions[i1 * 3] - ax, e1y = positions[i1 * 3 + 1] - ay, e1z = positions[i1 * 3 + 2] - az;
    const e2x = positions[i2 * 3] - ax, e2y = positions[i2 * 3 + 1] - ay, e2z = positions[i2 * 3 + 2] - az;
    let fnx = e1y * e2z - e1z * e2y;
    let fny = e1z * e2x - e1x * e2z;
    let fnz = e1x * e2y - e1y * e2x;
    const flen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
    if (flen <= 1e-20) return;
    const area = flen * 0.5;
    fnx /= flen; fny /= flen; fnz /= flen;

    const dx = positions[vb * 3] - positions[va * 3];
    const dy = positions[vb * 3 + 1] - positions[va * 3 + 1];
    const dz = positions[vb * 3 + 2] - positions[va * 3 + 2];
    // Plane containing the border edge and perpendicular to the face.
    let px = dy * fnz - dz * fny;
    let py = dz * fnx - dx * fnz;
    let pz = dx * fny - dy * fnx;
    const plen = Math.sqrt(px * px + py * py + pz * pz);
    if (plen <= 1e-20) return;
    px /= plen; py /= plen; pz /= plen;
    const pd = -(px * positions[va * 3] + py * positions[va * 3 + 1] + pz * positions[va * 3 + 2]);
    const w = boundaryWeight * area;
    addPlaneQuadric(quadrics, va, px, py, pz, pd, w);
    addPlaneQuadric(quadrics, vb, px, py, pz, pd, w);
  });

  // --- Candidate heap -------------------------------------------------------
  const heap = new CollapseHeap(edgeCount.size + 16);
  const versions = new Map();
  let versionCounter = 0;

  edgeCount.forEach((count, key) => {
    const va = Math.floor(key / 67108864);
    const vb = key - va * 67108864;
    if (!alive[va] || !alive[vb]) return;
    const cost = computeCollapse(quadrics, positions, boundary, va, vb);
    const version = ++versionCounter;
    versions.set(key, version);
    heap.push(cost, va, vb, version, _target[0], _target[1], _target[2]);
  });

  /**
   * Removes a face from the adjacency list of a vertex.
   * @param {number} v
   * @param {number} f
   */
  const removeFaceFrom = (v, f) => {
    const list = vertexFaces[v];
    for (let i = 0, n = list.length; i < n; i++) {
      if (list[i] === f) {
        list[i] = list[n - 1];
        list.pop();
        return;
      }
    }
  };

  /**
   * Detects whether moving `v` (while `other` disappears) would flip any face.
   * @param {number} v
   * @param {number} other
   * @param {number} tx
   * @param {number} ty
   * @param {number} tz
   * @returns {boolean}
   */
  const wouldFlip = (v, other, tx, ty, tz) => {
    const list = vertexFaces[v];
    for (let i = 0, n = list.length; i < n; i++) {
      const f = list[i];
      if (!faceAlive[f]) continue;
      const i0 = faces[f * 3];
      const i1 = faces[f * 3 + 1];
      const i2 = faces[f * 3 + 2];
      if (i0 === other || i1 === other || i2 === other) continue;

      const p0x = i0 === v ? tx : positions[i0 * 3];
      const p0y = i0 === v ? ty : positions[i0 * 3 + 1];
      const p0z = i0 === v ? tz : positions[i0 * 3 + 2];
      const p1x = i1 === v ? tx : positions[i1 * 3];
      const p1y = i1 === v ? ty : positions[i1 * 3 + 1];
      const p1z = i1 === v ? tz : positions[i1 * 3 + 2];
      const p2x = i2 === v ? tx : positions[i2 * 3];
      const p2y = i2 === v ? ty : positions[i2 * 3 + 1];
      const p2z = i2 === v ? tz : positions[i2 * 3 + 2];

      const nax = positions[i0 * 3], nay = positions[i0 * 3 + 1], naz = positions[i0 * 3 + 2];
      const o1x = positions[i1 * 3] - nax, o1y = positions[i1 * 3 + 1] - nay, o1z = positions[i1 * 3 + 2] - naz;
      const o2x = positions[i2 * 3] - nax, o2y = positions[i2 * 3 + 1] - nay, o2z = positions[i2 * 3 + 2] - naz;
      let onx = o1y * o2z - o1z * o2y;
      let ony = o1z * o2x - o1x * o2z;
      let onz = o1x * o2y - o1y * o2x;
      const olen = Math.sqrt(onx * onx + ony * ony + onz * onz);
      if (olen <= 1e-20) continue;
      onx /= olen; ony /= olen; onz /= olen;

      const n1x = p1x - p0x, n1y = p1y - p0y, n1z = p1z - p0z;
      const n2x = p2x - p0x, n2y = p2y - p0y, n2z = p2z - p0z;
      let nnx = n1y * n2z - n1z * n2y;
      let nny = n1z * n2x - n1x * n2z;
      let nnz = n1x * n2y - n1y * n2x;
      const nlen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
      if (nlen <= 1e-20) return true;
      nnx /= nlen; nny /= nlen; nnz /= nlen;

      if (onx * nnx + ony * nny + onz * nnz < flipThreshold) return true;
    }
    return false;
  };

  /**
   * Counts the alive faces shared by two vertices.
   * @param {number} a
   * @param {number} b
   * @returns {number}
   */
  const sharedFaceCount = (a, b) => {
    let shared = 0;
    const list = vertexFaces[a];
    for (let i = 0, n = list.length; i < n; i++) {
      const f = list[i];
      if (!faceAlive[f]) continue;
      if (faces[f * 3] === b || faces[f * 3 + 1] === b || faces[f * 3 + 2] === b) shared++;
    }
    return shared;
  };

  /**
   * Counts vertices adjacent to both `a` and `b`.
   * @param {number} a
   * @param {number} b
   * @returns {number}
   */
  const commonNeighborCount = (a, b) => {
    let common = 0;
    const sa = neighbors[a];
    const sb = neighbors[b];
    const small = sa.size <= sb.size ? sa : sb;
    const large = small === sa ? sb : sa;
    small.forEach((v) => { if (large.has(v)) common++; });
    return common;
  };

  // --- Collapse loop --------------------------------------------------------
  let currentTris = 0;
  for (let f = 0; f < triCount; f++) if (faceAlive[f]) currentTris++;

  while (currentTris > targetTris && heap.pop()) {
    const a = heap.outA;
    const b = heap.outB;
    if (!alive[a] || !alive[b]) continue;

    const key = edgeKey(a, b);
    if (versions.get(key) !== heap.outVersion) continue;
    if (heap.outCost > maxCost) break;

    const shared = sharedFaceCount(a, b);
    if (shared === 0) { versions.delete(key); continue; }
    // Link condition: a manifold collapse only merges the vertices opposite to
    // the shared faces.
    if (commonNeighborCount(a, b) !== shared) { versions.delete(key); continue; }
    // Do not pinch two distinct borders together through the interior.
    if (boundary[a] === 1 && boundary[b] === 1 && shared !== 1) { versions.delete(key); continue; }

    const tx = heap.outX;
    const ty = heap.outY;
    const tz = heap.outZ;
    if (wouldFlip(a, b, tx, ty, tz) || wouldFlip(b, a, tx, ty, tz)) {
      versions.delete(key);
      continue;
    }

    // Apply the collapse: b is merged into a.
    positions[a * 3] = tx;
    positions[a * 3 + 1] = ty;
    positions[a * 3 + 2] = tz;
    for (let i = 0; i < 10; i++) quadrics[a * 10 + i] += quadrics[b * 10 + i];
    if (boundary[b] === 1) boundary[a] = 1;
    alive[b] = 0;

    const bFaces = vertexFaces[b].slice();
    for (let i = 0, n = bFaces.length; i < n; i++) {
      const f = bFaces[i];
      if (!faceAlive[f]) continue;
      const i0 = faces[f * 3];
      const i1 = faces[f * 3 + 1];
      const i2 = faces[f * 3 + 2];
      if (i0 === a || i1 === a || i2 === a) {
        faceAlive[f] = 0;
        currentTris--;
        removeFaceFrom(i0, f);
        removeFaceFrom(i1, f);
        removeFaceFrom(i2, f);
      } else {
        if (i0 === b) faces[f * 3] = a;
        else if (i1 === b) faces[f * 3 + 1] = a;
        else faces[f * 3 + 2] = a;
        vertexFaces[a].push(f);
      }
    }
    vertexFaces[b].length = 0;

    neighbors[b].forEach((nb) => {
      neighbors[nb].delete(b);
      if (nb !== a) {
        neighbors[a].add(nb);
        neighbors[nb].add(a);
      }
    });
    neighbors[b].clear();
    neighbors[a].delete(b);
    versions.delete(key);

    // Refresh every edge touching the surviving vertex.
    neighbors[a].forEach((nb) => {
      if (!alive[nb]) return;
      const nKey = edgeKey(a, nb);
      const cost = computeCollapse(quadrics, positions, boundary, a, nb);
      const version = ++versionCounter;
      versions.set(nKey, version);
      heap.push(cost, a, nb, version, _target[0], _target[1], _target[2]);
    });
  }

  // --- Rebuild --------------------------------------------------------------
  const remap = new Int32Array(vertexCount).fill(-1);
  let outVertexCount = 0;
  let outTriCount = 0;
  for (let f = 0; f < triCount; f++) {
    if (!faceAlive[f]) continue;
    const i0 = faces[f * 3];
    const i1 = faces[f * 3 + 1];
    const i2 = faces[f * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) { faceAlive[f] = 0; continue; }
    if (remap[i0] < 0) remap[i0] = outVertexCount++;
    if (remap[i1] < 0) remap[i1] = outVertexCount++;
    if (remap[i2] < 0) remap[i2] = outVertexCount++;
    outTriCount++;
  }

  const out = new Geometry();
  source.attributes.forEach((attr, name) => {
    const size = attr.size;
    const stride = strideElems(attr);
    const offset = offsetElems(attr);
    const src = attr.data;
    const dst = new src.constructor(outVertexCount * size);
    if (name === 'aPosition') {
      for (let v = 0; v < vertexCount; v++) {
        const t = remap[v];
        if (t < 0) continue;
        dst[t * size] = positions[v * 3];
        if (size > 1) dst[t * size + 1] = positions[v * 3 + 1];
        if (size > 2) dst[t * size + 2] = positions[v * 3 + 2];
        for (let k = 3; k < size; k++) dst[t * size + k] = src[offset + v * stride + k];
      }
    } else {
      for (let v = 0; v < vertexCount; v++) {
        const t = remap[v];
        if (t < 0) continue;
        const s = offset + v * stride;
        const d = t * size;
        for (let k = 0; k < size; k++) dst[d + k] = src[s + k];
      }
    }
    out.setAttribute(name, dst, size, { normalized: !!attr.normalized, divisor: attr.divisor || 0 });
  });

  const outIndices = allocIndex(outTriCount * 3, outVertexCount);
  let w = 0;
  for (let f = 0; f < triCount; f++) {
    if (!faceAlive[f]) continue;
    outIndices[w++] = remap[faces[f * 3]];
    outIndices[w++] = remap[faces[f * 3 + 1]];
    outIndices[w++] = remap[faces[f * 3 + 2]];
  }
  out.setIndex(outIndices);
  out.drawMode = 'triangles';

  if (source.getAttribute('aNormal')) computeNormals(out);
  if (source.getAttribute('aTangent') && out.getAttribute('aUV0')) computeTangents(out);

  out.boundingBox = computeAABB(out);
  out.boundingSphere = computeBoundingSphere(out);
  return out;
}
