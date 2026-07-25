import { Mat4 } from '../math/Mat4.js';
import { createDataTexture } from '../render/Texture.js';

const _m1 = new Mat4();
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Multiplies two column major 4x4 matrices stored in flat arrays.
 * `dst = a * b`. No allocation, fully unrolled.
 * @param {Float32Array} dst
 * @param {number} dstOff
 * @param {Float32Array} a
 * @param {number} aOff
 * @param {Float32Array} b
 * @param {number} bOff
 */
function multiplyFlat(dst, dstOff, a, aOff, b, bOff) {
  const a00 = a[aOff], a01 = a[aOff + 1], a02 = a[aOff + 2], a03 = a[aOff + 3];
  const a10 = a[aOff + 4], a11 = a[aOff + 5], a12 = a[aOff + 6], a13 = a[aOff + 7];
  const a20 = a[aOff + 8], a21 = a[aOff + 9], a22 = a[aOff + 10], a23 = a[aOff + 11];
  const a30 = a[aOff + 12], a31 = a[aOff + 13], a32 = a[aOff + 14], a33 = a[aOff + 15];

  let b0 = b[bOff], b1 = b[bOff + 1], b2 = b[bOff + 2], b3 = b[bOff + 3];
  dst[dstOff] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
  dst[dstOff + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
  dst[dstOff + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
  dst[dstOff + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;

  b0 = b[bOff + 4]; b1 = b[bOff + 5]; b2 = b[bOff + 6]; b3 = b[bOff + 7];
  dst[dstOff + 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
  dst[dstOff + 5] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
  dst[dstOff + 6] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
  dst[dstOff + 7] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;

  b0 = b[bOff + 8]; b1 = b[bOff + 9]; b2 = b[bOff + 10]; b3 = b[bOff + 11];
  dst[dstOff + 8] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
  dst[dstOff + 9] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
  dst[dstOff + 10] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
  dst[dstOff + 11] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;

  b0 = b[bOff + 12]; b1 = b[bOff + 13]; b2 = b[bOff + 14]; b3 = b[bOff + 15];
  dst[dstOff + 12] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
  dst[dstOff + 13] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
  dst[dstOff + 14] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
  dst[dstOff + 15] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
}

/**
 * Bone hierarchy driving a SkinnedMesh.
 *
 * `boneMatrices[i] = bones[i].worldMatrix * boneInverses[i]` is uploaded to a
 * RGBA32F texture: 4 texels per bone. The layout is `4 * boneCount` by 1 while
 * it fits in MAX_TEXTURE_SIZE, otherwise the bones wrap into several rows
 * (`bonesPerRow` bones per row).
 */
export class Skeleton {
  /** @type {import('./Node3D.js').Node3D[]} */
  bones = [];
  /** @type {Float32Array} Inverse bind matrices, 16 floats per bone. */
  boneInverses = null;
  /** @type {Float32Array} Skinning matrices, 16 floats per bone. */
  boneMatrices = null;
  /** @type {Object|null} RGBA32F texture holding `boneMatrices`. */
  boneTexture = null;

  boneTextureWidth = 0;
  boneTextureHeight = 0;
  /** Number of bones stored per texture row. */
  bonesPerRow = 0;

  /** @private Texture staging buffer (aliases boneMatrices when possible). */
  _textureData = null;

  /**
   * @param {import('./Node3D.js').Node3D[]} [bones=[]]
   * @param {Float32Array|Mat4[]|null} [boneInverses=null] Inverse bind matrices.
   */
  constructor(bones = [], boneInverses = null) {
    this.bones = bones.slice();
    const n = this.bones.length;
    this.boneMatrices = new Float32Array(n * 16);
    this.boneInverses = new Float32Array(n * 16);
    if (boneInverses === null || boneInverses === undefined) {
      this.calculateInverses();
    } else if (boneInverses instanceof Float32Array) {
      this.boneInverses.set(boneInverses.subarray(0, Math.min(boneInverses.length, n * 16)));
    } else {
      for (let i = 0; i < n && i < boneInverses.length; i++) {
        const m = boneInverses[i];
        if (m === null || m === undefined) continue;
        if (m.elements !== undefined) this.boneInverses.set(m.elements, i * 16);
        else this.boneInverses.set(m, i * 16);
      }
    }
    for (let i = 0; i < n; i++) this.boneMatrices.set(IDENTITY, i * 16);
  }

  /** @returns {number} Number of bones. */
  get boneCount() {
    return this.bones.length;
  }

  /**
   * Builds the inverse bind matrices from the current bone world matrices.
   * Call it once, with the skeleton in bind pose.
   * @returns {Skeleton} this
   */
  calculateInverses() {
    const bones = this.bones;
    for (let i = 0, n = bones.length; i < n; i++) {
      const bone = bones[i];
      if (bone === null || bone === undefined) {
        this.boneInverses.set(IDENTITY, i * 16);
        continue;
      }
      _m1.copy(bone.worldMatrix).invert();
      this.boneInverses.set(_m1.elements, i * 16);
    }
    return this;
  }

  /**
   * Recomputes every skinning matrix from the current bone world matrices.
   * Bone world matrices must already be up to date.
   * @returns {Skeleton} this
   */
  update() {
    const bones = this.bones;
    const boneMatrices = this.boneMatrices;
    const boneInverses = this.boneInverses;
    for (let i = 0, n = bones.length; i < n; i++) {
      const bone = bones[i];
      const src = bone !== null && bone !== undefined ? bone.worldMatrix.elements : IDENTITY;
      multiplyFlat(boneMatrices, i * 16, src, 0, boneInverses, i * 16);
    }
    if (this._textureData !== null && this._textureData !== boneMatrices) this._packTextureData();
    return this;
  }

  /**
   * Copies the skinning matrices into the padded texture staging buffer.
   * @private
   */
  _packTextureData() {
    const data = this._textureData;
    const src = this.boneMatrices;
    const perRow = this.bonesPerRow;
    const rowFloats = this.boneTextureWidth * 4;
    for (let i = 0, n = this.bones.length; i < n; i++) {
      const row = (i / perRow) | 0;
      const col = i - row * perRow;
      let d = row * rowFloats + col * 16;
      let s = i * 16;
      for (let k = 0; k < 16; k++) data[d++] = src[s++];
    }
  }

  /**
   * Chooses the texture layout for the current bone count.
   * @private
   * @param {WebGL2RenderingContext} gl
   */
  _computeLayout(gl) {
    const n = this.bones.length > 0 ? this.bones.length : 1;
    let maxSize = 4096;
    const queried = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof queried === 'number' && queried > 0) maxSize = queried;
    if (n * 4 <= maxSize) {
      this.bonesPerRow = n;
      this.boneTextureWidth = n * 4;
      this.boneTextureHeight = 1;
      this._textureData = this.boneMatrices;
    } else {
      const perRow = Math.max(1, Math.floor(maxSize / 4));
      this.bonesPerRow = perRow;
      this.boneTextureWidth = perRow * 4;
      this.boneTextureHeight = Math.ceil(n / perRow);
      this._textureData = new Float32Array(this.boneTextureWidth * this.boneTextureHeight * 4);
      this._packTextureData();
    }
  }

  /**
   * Creates the bone texture on first call and uploads the current skinning
   * matrices on every call.
   * @param {WebGL2RenderingContext} gl
   * @returns {Object|null} The bone texture, or null when the skeleton is empty.
   */
  computeBoneTexture(gl) {
    if (this.bones.length === 0) return null;
    if (this.boneTexture === null) {
      this._computeLayout(gl);
      this.boneTexture = createDataTexture(
        gl,
        this._textureData,
        this.boneTextureWidth,
        this.boneTextureHeight,
        gl.RGBA32F,
        gl.RGBA,
        gl.FLOAT
      );
      return this.boneTexture;
    }
    if (this._textureData !== this.boneMatrices) this._packTextureData();
    this.boneTexture.upload(this._textureData, 0, 0);
    return this.boneTexture;
  }

  /**
   * @param {string} name
   * @returns {import('./Node3D.js').Node3D|null}
   */
  getBoneByName(name) {
    const bones = this.bones;
    for (let i = 0, n = bones.length; i < n; i++) {
      const bone = bones[i];
      if (bone !== null && bone !== undefined && bone.name === name) return bone;
    }
    return null;
  }

  /**
   * @param {import('./Node3D.js').Node3D} bone
   * @returns {number} Index of the bone, -1 when absent.
   */
  indexOfBone(bone) {
    return this.bones.indexOf(bone);
  }

  /**
   * Copies the bone list and inverses into a new skeleton sharing nothing.
   * @returns {Skeleton}
   */
  clone() {
    return new Skeleton(this.bones, this.boneInverses);
  }

  /**
   * Releases the GPU texture.
   * @returns {Skeleton} this
   */
  dispose() {
    if (this.boneTexture !== null && typeof this.boneTexture.dispose === 'function') {
      this.boneTexture.dispose();
    }
    this.boneTexture = null;
    this._textureData = null;
    return this;
  }
}
