/**
 * Mesh deformed on the GPU by a `Skeleton`.
 *
 * Shader side the skinning matrix is
 * `bindMatrixInverse * boneMatrix[j] * bindMatrix`, with `boneMatrix` coming
 * from the skeleton bone texture.
 */
export class SkinnedMesh extends Mesh {
    /** @type {import('./Skeleton.js').Skeleton|null} */
    skeleton: import('./Skeleton.js').Skeleton | null;
    bindMatrix: Mat4;
    bindMatrixInverse: Mat4;
    /** 'attached' follows the mesh world matrix, 'detached' stays on the bind pose. */
    bindMode: string;
    /** Extra world units added to the bounds to compensate for deformation. */
    boundsPadding: number;
    /** @type {number} Index inside `Scene.skinnedMeshes`. */
    _skinIndex: number;
    /**
     * Attaches a skeleton. When `bindMatrix` is omitted the current world matrix
     * is used, which is what a freshly loaded model expects.
     * @param {import('./Skeleton.js').Skeleton} skeleton
     * @param {Mat4} [bindMatrix]
     * @returns {SkinnedMesh} this
     */
    bind(skeleton: import('./Skeleton.js').Skeleton, bindMatrix?: Mat4): SkinnedMesh;
    /**
     * Refreshes the skinning matrices. Called by `Scene.updateMatrices()` once
     * every bone world matrix is up to date.
     * @returns {SkinnedMesh} this
     */
    updateSkeleton(): SkinnedMesh;
    /**
     * Transforms the bind pose bounds into world space and inflates them by
     * `boundsPadding` so animation does not pop out of the culling volume.
     * @param {boolean} [force=false]
     * @returns {SkinnedMesh} this
     */
    updateWorldBounds(force?: boolean): SkinnedMesh;
    /**
     * Rescales the `aWeights` attribute so every vertex sums to one.
     * @returns {SkinnedMesh} this
     */
    normalizeSkinWeights(): SkinnedMesh;
}
import { Mesh } from "./Mesh.js";
import { Mat4 } from "../math/Mat4.js";
