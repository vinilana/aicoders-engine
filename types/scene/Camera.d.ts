/**
 * Base camera. Subclasses only have to implement `updateProjection()` and the
 * change detection used by `updateProjectionIfNeeded()`.
 *
 * Convention: right handed, the camera looks down its local -Z axis, +Y is up.
 * `viewMatrix` is the inverse of `worldMatrix` computed with a fast affine
 * inverse that also supports (orthogonal) non uniform scale.
 */
export class Camera extends Node3D {
    viewMatrix: Mat4;
    projectionMatrix: Mat4;
    projectionMatrixInverse: Mat4;
    viewProjectionMatrix: Mat4;
    frustum: Frustum;
    near: number;
    far: number;
    /** @private Set by subclasses when a projection parameter changed. */
    private _projectionDirty;
    /** @private worldMatrixVersion used the last time the view matrix was built. */
    private _viewVersion;
    /**
     * Rebuilds the projection matrix and its inverse. The base implementation
     * only refreshes the inverse, which is what a camera driven by a hand
     * authored projection matrix needs.
     * @returns {Camera} this
     */
    updateProjection(): Camera;
    /**
     * Rebuilds the projection matrix only when one of its parameters changed.
     * @returns {Camera} this
     */
    updateProjectionIfNeeded(): Camera;
    /**
     * Rebuilds `viewMatrix` from `worldMatrix` using a fast affine inverse.
     * @param {boolean} [force=false] Rebuild even when the world matrix did not change.
     * @returns {Camera} this
     */
    updateViewMatrix(force?: boolean): Camera;
    /**
     * Recomposes `viewProjectionMatrix` and extracts the frustum planes.
     * @returns {Camera} this
     */
    updateFrustum(): Camera;
    /**
     * Convenience: view matrix, view projection matrix and frustum in one call.
     * @returns {Camera} this
     */
    updateCamera(): Camera;
    /**
     * Projects a world space point to viewport pixels.
     * @param {Vec3} v World space point.
     * @param {number} viewportW
     * @param {number} viewportH
     * @param {Vec3} out Receives (pixelX, pixelY, ndcZ).
     * @returns {Vec3} out
     */
    worldToScreen(v: Vec3, viewportW: number, viewportH: number, out: Vec3): Vec3;
    /**
     * Unprojects a normalized device coordinate triple into world space.
     * @param {number} ndcX -1..1
     * @param {number} ndcY -1..1
     * @param {number} ndcZ -1 (near) .. 1 (far)
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    unproject(ndcX: number, ndcY: number, ndcZ: number, out: Vec3): Vec3;
    /**
     * Builds a world space ray from a viewport pixel position.
     * @param {number} x Pixel x (0 = left).
     * @param {number} y Pixel y (0 = top).
     * @param {number} viewportW
     * @param {number} viewportH
     * @param {Ray} [outRay] Reused when provided.
     * @returns {Ray}
     */
    screenPointToRay(x: number, y: number, viewportW: number, viewportH: number, outRay?: Ray): Ray;
    /**
     * Builds a world space ray from normalized device coordinates.
     * @param {number} ndcX -1..1
     * @param {number} ndcY -1..1
     * @param {Ray} [outRay]
     * @returns {Ray}
     */
    ndcToRay(ndcX: number, ndcY: number, outRay?: Ray): Ray;
}
import { Node3D } from "./Node3D.js";
import { Mat4 } from "../math/Mat4.js";
import { Frustum } from "../math/Frustum.js";
import { Vec3 } from "../math/Vec3.js";
import { Ray } from "../math/Ray.js";
