/**
 * Greedy mesher with per-vertex ambient occlusion and smooth lighting.
 *
 * For every axis and both directions it builds a 16x16 mask of visible faces,
 * then merges runs of identical cells into the largest possible rectangle. A
 * flat plain that would naively cost 256 quads collapses into one.
 *
 * The subtlety is what "identical" means: two faces may only merge when their
 * block, texture layer, four AO corners AND four smooth light corners all match.
 * Skipping that check is the classic bug that makes greedy meshes look flat and
 * smears shadows across whole fields.
 *
 * Input is a 18x18x18 padded neighbourhood (the 16-cube section plus one block
 * of margin on every side) so face visibility, AO and light can all be resolved
 * without a single bounds check in the inner loops.
 *
 * Runs inside a worker. Imports nothing but block tables.
 */

import { AIR, IS_OPAQUE, IS_LIQUID, FACE_LAYERS, facesVisible } from './Blocks.js';

/** Padded neighbourhood edge length. */
export const PAD = 18;
const PAD_Z = PAD;
const PAD_Y = PAD * PAD;
/** Elements in a padded neighbourhood. */
export const PAD_VOLUME = PAD * PAD * PAD;

/** Section edge length. */
const N = 16;

/**
 * Padded index for section-local coordinates (which may run -1..16).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
export function padIndex(x, y, z) {
  return (x + 1) + (z + 1) * PAD_Z + (y + 1) * PAD_Y;
}

/**
 * Ambient occlusion ramp. Linear 0..3 looks harsh; this curve keeps the darkest
 * corner readable while still reading as contact shadow.
 */
const AO_RAMP = [0.40, 0.63, 0.82, 1.0];

/**
 * Axis setup. For each axis `d` we pick the in-plane axes `u` and `v` so that
 * **v is world Y on the four side faces**. That is what keeps the grass band of
 * `grass_side` pointing up instead of sideways.
 *
 * `handed` records whether (d, u, v) ended up right or left handed, so the
 * triangle winding can be corrected per axis.
 */
const AXES = [
  // d = X: u = Z, v = Y   -> Z x Y = -X, left handed
  { d: 0, u: 2, v: 1, handed: -1 },
  // d = Y: u = X, v = Z   -> X x Z = -Y, left handed
  { d: 1, u: 0, v: 2, handed: -1 },
  // d = Z: u = X, v = Y   -> X x Y = +Z, right handed
  { d: 2, u: 0, v: 1, handed: 1 },
];

/** Face index (FACE_PX..FACE_NZ) for an axis and direction. */
const FACE_OF = [
  [1, 0], // d=0: dir -1 -> -X (1), dir +1 -> +X (0)
  [3, 2], // d=1
  [5, 4], // d=2
];

/* ------------------------------------------------------------- mask buffers */

const maskId = new Int32Array(N * N);
const maskLayer = new Int32Array(N * N);
const maskAO = new Int32Array(N * N);
const maskSky = new Int32Array(N * N);
const maskBlk = new Int32Array(N * N);
const maskUsed = new Uint8Array(N * N);
/**
 * Per-face flags. Bit 0 marks "this liquid voxel is the surface layer", which
 * has to be part of the merge key: the top of a water column is lowered, and a
 * surface quad must never merge with a submerged one or the two would tear.
 */
const maskFlag = new Int32Array(N * N);

/* ----------------------------------------------------------- mesh builders */

/**
 * Growable interleaved-by-attribute vertex sink.
 * Buffers double when full, so a chunk that turns out to be dense never pays a
 * per-quad allocation.
 */
class MeshBuilder {
  constructor(initialQuads = 512) {
    this.capacityVerts = initialQuads * 4;
    this.capacityIndices = initialQuads * 6;
    this.positions = new Float32Array(this.capacityVerts * 3);
    this.normals = new Int8Array(this.capacityVerts * 3);
    this.uvs = new Float32Array(this.capacityVerts * 2);
    this.colors = new Uint8Array(this.capacityVerts * 4);
    this.indices = new Uint32Array(this.capacityIndices);
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  /** Ensures room for 4 more vertices and 6 more indices. */
  _grow() {
    if (this.vertexCount + 4 > this.capacityVerts) {
      const c = this.capacityVerts * 2;
      const p = new Float32Array(c * 3); p.set(this.positions); this.positions = p;
      const n = new Int8Array(c * 3); n.set(this.normals); this.normals = n;
      const u = new Float32Array(c * 2); u.set(this.uvs); this.uvs = u;
      const col = new Uint8Array(c * 4); col.set(this.colors); this.colors = col;
      this.capacityVerts = c;
    }
    if (this.indexCount + 6 > this.capacityIndices) {
      const c = this.capacityIndices * 2;
      const i = new Uint32Array(c); i.set(this.indices); this.indices = i;
      this.capacityIndices = c;
    }
  }

  /**
   * Appends one quad.
   * @param {Float32Array} corners 12 floats, 4 corners x xyz, in u-then-v order.
   * @param {number} nx Normal.
   * @param {number} ny
   * @param {number} nz
   * @param {number} w Quad width in blocks (u extent).
   * @param {number} h Quad height in blocks (v extent).
   * @param {number} layer Atlas layer.
   * @param {Int32Array} ao 4 corner AO levels, 0..3.
   * @param {Int32Array} sky 4 corner sky light, 0..255.
   * @param {Int32Array} blk 4 corner block light, 0..255.
   * @param {boolean} flipWinding
   * @param {boolean} flipDiagonal
   */
  addQuad(corners, nx, ny, nz, w, h, layer, ao, sky, blk, flipWinding, flipDiagonal) {
    this._grow();
    const base = this.vertexCount;
    const p3 = base * 3;
    const p2 = base * 2;
    const p4 = base * 4;

    for (let c = 0; c < 4; c++) {
      this.positions[p3 + c * 3] = corners[c * 3];
      this.positions[p3 + c * 3 + 1] = corners[c * 3 + 1];
      this.positions[p3 + c * 3 + 2] = corners[c * 3 + 2];
      // Int8 attributes are read back normalised, so +-1 has to be stored as
      // +-127 or every normal would arrive at the shader as ~0.008.
      this.normals[p3 + c * 3] = nx * 127;
      this.normals[p3 + c * 3 + 1] = ny * 127;
      this.normals[p3 + c * 3 + 2] = nz * 127;
      this.colors[p4 + c * 4] = (AO_RAMP[ao[c]] * 255) | 0;
      this.colors[p4 + c * 4 + 1] = sky[c];
      this.colors[p4 + c * 4 + 2] = blk[c];
      this.colors[p4 + c * 4 + 3] = layer;
    }

    // UV runs 0..w and 0..h so REPEAT tiles one texture per block, and V is
    // flipped because texture row 0 is the top of the block.
    this.uvs[p2] = 0; this.uvs[p2 + 1] = h;
    this.uvs[p2 + 2] = w; this.uvs[p2 + 3] = h;
    this.uvs[p2 + 4] = w; this.uvs[p2 + 5] = 0;
    this.uvs[p2 + 6] = 0; this.uvs[p2 + 7] = 0;

    const idx = this.indices;
    let o = this.indexCount;
    // Splitting along the darker diagonal removes the AO "creased corner"
    // artefact you get from always cutting 0-2.
    if (flipDiagonal) {
      if (flipWinding) {
        idx[o] = base + 1; idx[o + 1] = base + 3; idx[o + 2] = base + 2;
        idx[o + 3] = base + 1; idx[o + 4] = base; idx[o + 5] = base + 3;
      } else {
        idx[o] = base + 1; idx[o + 1] = base + 2; idx[o + 2] = base + 3;
        idx[o + 3] = base + 1; idx[o + 4] = base + 3; idx[o + 5] = base;
      }
    } else {
      if (flipWinding) {
        idx[o] = base; idx[o + 1] = base + 2; idx[o + 2] = base + 1;
        idx[o + 3] = base; idx[o + 4] = base + 3; idx[o + 5] = base + 2;
      } else {
        idx[o] = base; idx[o + 1] = base + 1; idx[o + 2] = base + 2;
        idx[o + 3] = base; idx[o + 4] = base + 2; idx[o + 5] = base + 3;
      }
    }

    this.vertexCount += 4;
    this.indexCount += 6;
  }

  /** @returns {Object|null} trimmed typed arrays, or null when empty. */
  finish() {
    if (this.indexCount === 0) return null;
    return {
      positions: this.positions.subarray(0, this.vertexCount * 3).slice(),
      normals: this.normals.subarray(0, this.vertexCount * 3).slice(),
      uvs: this.uvs.subarray(0, this.vertexCount * 2).slice(),
      colors: this.colors.subarray(0, this.vertexCount * 4).slice(),
      indices: this.indices.subarray(0, this.indexCount).slice(),
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
    };
  }
}

/* ------------------------------------------------------------ AO and light */

const _ao = new Int32Array(4);
const _sky = new Int32Array(4);
const _blk = new Int32Array(4);

/**
 * Corner offsets in (u, v) for the four quad corners, in the order the builder
 * expects: (-u,-v), (+u,-v), (+u,+v), (-u,+v).
 */
const CORNER_U = [-1, 1, 1, -1];
const CORNER_V = [-1, -1, 1, 1];

/**
 * Computes AO and smooth light for the four corners of a single-block face.
 *
 * AO is the standard three-neighbour test in the plane one step along the
 * normal. Light is the average of the four cells touching the corner in that
 * same plane, skipping opaque ones so a wall never darkens the floor beside it.
 *
 * @param {Uint16Array} blocks Padded block ids.
 * @param {Uint8Array} light Padded packed light.
 * @param {number} x Section-local voxel coords.
 * @param {number} y
 * @param {number} z
 * @param {number[]} nrm Face normal.
 * @param {number[]} uAxis Unit vector of the in-plane u axis.
 * @param {number[]} vAxis Unit vector of the in-plane v axis.
 */
function cornerData(blocks, light, x, y, z, nrm, uAxis, vAxis) {
  // Cell directly in front of the face: the lit air the face is exposed to.
  const fx = x + nrm[0];
  const fy = y + nrm[1];
  const fz = z + nrm[2];

  for (let c = 0; c < 4; c++) {
    const su = CORNER_U[c];
    const sv = CORNER_V[c];

    const s1x = fx + uAxis[0] * su, s1y = fy + uAxis[1] * su, s1z = fz + uAxis[2] * su;
    const s2x = fx + vAxis[0] * sv, s2y = fy + vAxis[1] * sv, s2z = fz + vAxis[2] * sv;
    const cxx = s1x + vAxis[0] * sv, cyy = s1y + vAxis[1] * sv, czz = s1z + vAxis[2] * sv;

    const i0 = padIndex(fx, fy, fz);
    const i1 = padIndex(s1x, s1y, s1z);
    const i2 = padIndex(s2x, s2y, s2z);
    const i3 = padIndex(cxx, cyy, czz);

    const o1 = IS_OPAQUE[blocks[i1]];
    const o2 = IS_OPAQUE[blocks[i2]];
    const o3 = IS_OPAQUE[blocks[i3]];

    _ao[c] = (o1 === 1 && o2 === 1) ? 0 : 3 - (o1 + o2 + o3);

    // Smooth light: mean over the non-opaque cells touching this corner.
    let skySum = light[i0] >> 4;
    let blkSum = light[i0] & 15;
    let count = 1;
    if (o1 === 0) { skySum += light[i1] >> 4; blkSum += light[i1] & 15; count++; }
    if (o2 === 0) { skySum += light[i2] >> 4; blkSum += light[i2] & 15; count++; }
    if (o3 === 0) { skySum += light[i3] >> 4; blkSum += light[i3] & 15; count++; }

    // 0..15 average scaled to 0..255 (15 * 17 == 255).
    _sky[c] = ((skySum / count) * 17) | 0;
    _blk[c] = ((blkSum / count) * 17) | 0;
  }
}

/* ------------------------------------------------------------------- mesher */

const _corners = new Float32Array(12);
const _p = [0, 0, 0];
const _uAxis = [0, 0, 0];
const _vAxis = [0, 0, 0];
const _nrm = [0, 0, 0];

/**
 * Meshes one 16-cube section.
 *
 * @param {Uint16Array} blocks Padded 18^3 block ids.
 * @param {Uint8Array} light Padded 18^3 packed light.
 * @returns {{opaque: Object|null, water: Object|null}}
 */
export function meshSection(blocks, light) {
  const solid = new MeshBuilder(768);
  const fluid = new MeshBuilder(128);

  for (let a = 0; a < 3; a++) {
    const axis = AXES[a];
    const d = axis.d;
    const u = axis.u;
    const v = axis.v;

    _uAxis[0] = 0; _uAxis[1] = 0; _uAxis[2] = 0; _uAxis[u] = 1;
    _vAxis[0] = 0; _vAxis[1] = 0; _vAxis[2] = 0; _vAxis[v] = 1;

    for (let dirIndex = 0; dirIndex < 2; dirIndex++) {
      const dir = dirIndex === 0 ? -1 : 1;
      const face = FACE_OF[d][dirIndex];
      _nrm[0] = 0; _nrm[1] = 0; _nrm[2] = 0; _nrm[d] = dir;

      // Winding flips when the axis frame is left handed, and again for -dir.
      const flipWinding = (axis.handed * dir) < 0;

      for (let s = 0; s < N; s++) {
        maskId.fill(0);
        maskUsed.fill(0);

        // ---- build the mask for this slice
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            _p[d] = s; _p[u] = i; _p[v] = j;
            const x = _p[0], y = _p[1], z = _p[2];

            const here = blocks[padIndex(x, y, z)];
            if (here === AIR) continue;

            const nx = x + _nrm[0], ny = y + _nrm[1], nz = z + _nrm[2];
            const there = blocks[padIndex(nx, ny, nz)];
            if (!facesVisible(here, there)) continue;

            cornerData(blocks, light, x, y, z, _nrm, _uAxis, _vAxis);

            const m = j * N + i;
            maskId[m] = here;
            maskFlag[m] = (IS_LIQUID[here] === 1 &&
              blocks[padIndex(x, y + 1, z)] !== here) ? 1 : 0;
            maskLayer[m] = FACE_LAYERS[here * 6 + face];
            maskAO[m] = _ao[0] | (_ao[1] << 2) | (_ao[2] << 4) | (_ao[3] << 6);
            maskSky[m] = _sky[0] | (_sky[1] << 8) | (_sky[2] << 16) | (_sky[3] << 24);
            maskBlk[m] = _blk[0] | (_blk[1] << 8) | (_blk[2] << 16) | (_blk[3] << 24);
          }
        }

        // ---- greedy merge
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N;) {
            const m = j * N + i;
            const id = maskId[m];
            if (id === 0 || maskUsed[m] === 1) { i++; continue; }

            const layer = maskLayer[m];
            const ao = maskAO[m];
            const sky = maskSky[m];
            const blk = maskBlk[m];
            const flag = maskFlag[m];

            // Extend along u.
            let w = 1;
            while (i + w < N) {
              const mm = m + w;
              if (maskUsed[mm] === 1 || maskId[mm] !== id || maskLayer[mm] !== layer ||
                  maskAO[mm] !== ao || maskSky[mm] !== sky || maskBlk[mm] !== blk ||
                  maskFlag[mm] !== flag) break;
              w++;
            }

            // Extend along v, whole rows only.
            let h = 1;
            outer:
            while (j + h < N) {
              const rowBase = (j + h) * N + i;
              for (let k = 0; k < w; k++) {
                const mm = rowBase + k;
                if (maskUsed[mm] === 1 || maskId[mm] !== id || maskLayer[mm] !== layer ||
                    maskAO[mm] !== ao || maskSky[mm] !== sky || maskBlk[mm] !== blk ||
                    maskFlag[mm] !== flag) break outer;
              }
              h++;
            }

            for (let dj = 0; dj < h; dj++) {
              const rowBase = (j + dj) * N + i;
              for (let di = 0; di < w; di++) maskUsed[rowBase + di] = 1;
            }

            // ---- emit
            _ao[0] = ao & 3; _ao[1] = (ao >> 2) & 3; _ao[2] = (ao >> 4) & 3; _ao[3] = (ao >> 6) & 3;
            _sky[0] = sky & 255; _sky[1] = (sky >> 8) & 255; _sky[2] = (sky >> 16) & 255; _sky[3] = (sky >>> 24) & 255;
            _blk[0] = blk & 255; _blk[1] = (blk >> 8) & 255; _blk[2] = (blk >> 16) & 255; _blk[3] = (blk >>> 24) & 255;

            // The face plane sits on the far side of the voxel for +dir.
            let planeD = dir > 0 ? s + 1 : s;

            // A surface liquid sits slightly below a full block. The drop has to
            // be applied to the top face AND to the top edge of the side faces,
            // otherwise the two disagree and leave a visible slit at the
            // shoreline. On side faces `v` is world Y and `flag` can only be set
            // on a one-block-tall quad (a voxel with water above is not a
            // surface voxel), so lowering the +v edge is always well defined.
            const drop = flag === 1 ? 0.12 : 0;
            if (d === 1 && dir > 0) planeD -= drop;
            const edgeDrop = (d !== 1) ? drop : 0;

            for (let c = 0; c < 4; c++) {
              const highV = CORNER_V[c] > 0;
              const cu = i + (CORNER_U[c] > 0 ? w : 0);
              const cv = j + (highV ? h : 0) - (highV ? edgeDrop : 0);
              _corners[c * 3 + d] = planeD;
              _corners[c * 3 + u] = cu;
              _corners[c * 3 + v] = cv;
            }

            const flipDiagonal = (_ao[0] + _ao[2]) > (_ao[1] + _ao[3]);
            const sink = IS_LIQUID[id] === 1 ? fluid : solid;
            sink.addQuad(_corners, _nrm[0], _nrm[1], _nrm[2], w, h,
              layer, _ao, _sky, _blk, flipWinding, flipDiagonal);

            i += w;
          }
        }
      }
    }
  }

  return { opaque: solid.finish(), water: fluid.finish() };
}
