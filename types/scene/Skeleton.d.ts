/**
 * Bone hierarchy driving a SkinnedMesh.
 *
 * `boneMatrices[i] = bones[i].worldMatrix * boneInverses[i]` is uploaded to a
 * RGBA32F texture: 4 texels per bone. The layout is `4 * boneCount` by 1 while
 * it fits in MAX_TEXTURE_SIZE, otherwise the bones wrap into several rows
 * (`bonesPerRow` bones per row).
 */
export class Skeleton {
    /**
     * @param {import('./Node3D.js').Node3D[]} [bones=[]]
     * @param {Float32Array|Mat4[]|null} [boneInverses=null] Inverse bind matrices.
     */
    constructor(bones?: import('./Node3D.js').Node3D[], boneInverses?: Float32Array | Mat4[] | null);
    /** @type {import('./Node3D.js').Node3D[]} */
    bones: import('./Node3D.js').Node3D[];
    /** @type {Float32Array} Inverse bind matrices, 16 floats per bone. */
    boneInverses: Float32Array;
    /** @type {Float32Array} Skinning matrices, 16 floats per bone. */
    boneMatrices: Float32Array;
    /** @type {Object|null} RGBA32F texture holding `boneMatrices`. */
    boneTexture: any | null;
    boneTextureWidth: number;
    boneTextureHeight: number;
    /** Number of bones stored per texture row. */
    bonesPerRow: number;
    /** @private Texture staging buffer (aliases boneMatrices when possible). */
    private _textureData;
    /** @returns {number} Number of bones. */
    get boneCount(): number;
    /**
     * Builds the inverse bind matrices from the current bone world matrices.
     * Call it once, with the skeleton in bind pose.
     * @returns {Skeleton} this
     */
    calculateInverses(): Skeleton;
    /**
     * Recomputes every skinning matrix from the current bone world matrices.
     * Bone world matrices must already be up to date.
     * @returns {Skeleton} this
     */
    update(): Skeleton;
    /**
     * Copies the skinning matrices into the padded texture staging buffer.
     * @private
     */
    private _packTextureData;
    /**
     * Chooses the texture layout for the current bone count.
     * @private
     * @param {WebGL2RenderingContext} gl
     */
    private _computeLayout;
    /**
     * Creates the bone texture on first call and uploads the current skinning
     * matrices on every call.
     * @param {WebGL2RenderingContext} gl
     * @returns {Object|null} The bone texture, or null when the skeleton is empty.
     */
    computeBoneTexture(gl: WebGL2RenderingContext): any | null;
    /**
     * @param {string} name
     * @returns {import('./Node3D.js').Node3D|null}
     */
    getBoneByName(name: string): import('./Node3D.js').Node3D | null;
    /**
     * @param {import('./Node3D.js').Node3D} bone
     * @returns {number} Index of the bone, -1 when absent.
     */
    indexOfBone(bone: import('./Node3D.js').Node3D): number;
    /**
     * Copies the bone list and inverses into a new skeleton sharing nothing.
     * @returns {Skeleton}
     */
    clone(): Skeleton;
    /**
     * Releases the GPU texture.
     * @returns {Skeleton} this
     */
    dispose(): Skeleton;
}
import { Mat4 } from "../math/Mat4.js";
