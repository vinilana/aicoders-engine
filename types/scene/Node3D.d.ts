/**
 * Base node of the scene graph.
 *
 * Transform model: `position`, `quaternion` and `scale` are the source of truth
 * and may be mutated freely. `Scene.updateMatrices()` (or `updateWorldMatrix()`)
 * recomposes `localMatrix` when the transform actually changed and multiplies it
 * by the parent world matrix, iteratively, once per frame. Nodes flagged with
 * `matrixAutoUpdate = false` are treated as static and are skipped until
 * `updateMatrix()` is called manually.
 */
export class Node3D {
    /** @type {number} Monotonic id source. */
    static _nextId: number;
    /**
     * @param {string} [name] Optional node name.
     */
    constructor(name?: string);
    id: number;
    name: string;
    /** @type {Node3D|null} */
    parent: Node3D | null;
    /** @type {Node3D[]} */
    children: Node3D[];
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
    localMatrix: Mat4;
    worldMatrix: Mat4;
    visible: boolean;
    /** @type {number} 32 bit layer mask. */
    layers: number;
    castShadow: boolean;
    receiveShadow: boolean;
    frustumCulled: boolean;
    renderOrder: number;
    matrixAutoUpdate: boolean;
    matrixWorldNeedsUpdate: boolean;
    /**
     * Incremented every time `worldMatrix` is recomputed. Consumers (bounds,
     * broadphase proxies, skinning) compare it against their own cached value to
     * know whether they must refresh.
     * @type {number}
     */
    worldMatrixVersion: number;
    isMesh: boolean;
    isLight: boolean;
    isCamera: boolean;
    isSkinnedMesh: boolean;
    isInstancedMesh: boolean;
    isScene: boolean;
    isLOD: boolean;
    /** @type {Object} Free-form user storage. */
    userData: any;
    /** @type {Function|null} Called by the renderer right before drawing. */
    onBeforeRender: Function | null;
    /** @type {Function|null} Called by the renderer right after drawing. */
    onAfterRender: Function | null;
    /** @private Index inside the owning Scene flat list (meshes or lights). */
    private _listIndex;
    /** @private Cached local transform used for change detection. */
    private _lpx;
    _lpy: number;
    _lpz: number;
    _lqx: number;
    _lqy: number;
    _lqz: number;
    _lqw: number;
    _lsx: number;
    _lsy: number;
    _lsz: number;
    /**
     * Adds one or more children, detaching them from their previous parent.
     * @param {...Node3D} children
     * @returns {Node3D} this
     */
    add(...children: Node3D[]): Node3D;
    /**
     * Removes a direct child.
     * @param {Node3D} child
     * @returns {Node3D} this
     */
    remove(child: Node3D): Node3D;
    /**
     * Detaches this node from its parent, if any.
     * @returns {Node3D} this
     */
    removeFromParent(): Node3D;
    /**
     * Removes every direct child.
     * @returns {Node3D} this
     */
    clear(): Node3D;
    /**
     * Walks up the parent chain looking for the owning Scene.
     * @private
     * @returns {Node3D|null}
     */
    private _findScene;
    /**
     * Iterative depth first traversal (this node included).
     * @param {(node: Node3D) => void} cb
     * @returns {Node3D} this
     */
    traverse(cb: (node: Node3D) => void): Node3D;
    /**
     * Iterative traversal that prunes invisible sub trees.
     * @param {(node: Node3D) => void} cb
     * @returns {Node3D} this
     */
    traverseVisible(cb: (node: Node3D) => void): Node3D;
    /**
     * Iterative traversal of every ancestor, closest first.
     * @param {(node: Node3D) => void} cb
     * @returns {Node3D} this
     */
    traverseAncestors(cb: (node: Node3D) => void): Node3D;
    /**
     * Recomposes `localMatrix` from position/quaternion/scale and flags the
     * world matrix (and the whole sub tree) as dirty. Call it manually after
     * moving a node whose `matrixAutoUpdate` is false.
     * @returns {Node3D} this
     */
    updateMatrix(): Node3D;
    /**
     * Recomposes `localMatrix` only when the transform actually changed.
     * @private
     * @returns {boolean} True when the local matrix was rebuilt.
     */
    private _syncLocalMatrix;
    /**
     * Single node transform step shared by `updateWorldMatrix` and
     * `Scene.updateMatrices`.
     * @private
     * @param {number} parentChanged 1 when the parent world matrix was rebuilt.
     * @returns {number} 1 when this world matrix was rebuilt, 0 otherwise.
     */
    private _updateTransformStep;
    /**
     * Iteratively updates the world matrices of this node and its sub tree.
     * @param {boolean} [force=false] Force a rebuild even when nothing is dirty.
     * @returns {Node3D} this
     */
    updateWorldMatrix(force?: boolean): Node3D;
    /**
     * Marks this node and its whole sub tree as needing a world matrix rebuild.
     * @returns {Node3D} this
     */
    invalidateWorldMatrix(): Node3D;
    /**
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getWorldPosition(out: Vec3): Vec3;
    /**
     * @param {Quat} out
     * @returns {Quat} out
     */
    getWorldQuaternion(out: Quat): Quat;
    /**
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getWorldScale(out: Vec3): Vec3;
    /**
     * World space forward vector (-Z, engine convention).
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getWorldDirection(out: Vec3): Vec3;
    /**
     * Transforms a point from local space into world space, in place.
     * @param {Vec3} v
     * @returns {Vec3} v
     */
    localToWorld(v: Vec3): Vec3;
    /**
     * Transforms a point from world space into local space, in place.
     * @param {Vec3} v
     * @returns {Vec3} v
     */
    worldToLocal(v: Vec3): Vec3;
    /**
     * Orients the node so its -Z axis points at the given world space target.
     * @param {number|Vec3} x
     * @param {number} [y]
     * @param {number} [z]
     * @returns {Node3D} this
     */
    lookAt(x: number | Vec3, y?: number, z?: number): Node3D;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Node3D} this
     */
    setPosition(x: number, y: number, z: number): Node3D;
    /**
     * @param {number} x
     * @param {number} [y=x]
     * @param {number} [z=x]
     * @returns {Node3D} this
     */
    setScale(x: number, y?: number, z?: number): Node3D;
    /**
     * @param {import('../math/Euler.js').Euler} e
     * @returns {Node3D} this
     */
    setRotationFromEuler(e: import('../math/Euler.js').Euler): Node3D;
    /**
     * @param {Vec3} axis Normalized axis in local space.
     * @param {number} angle Radians.
     * @returns {Node3D} this
     */
    setRotationFromAxisAngle(axis: Vec3, angle: number): Node3D;
    /**
     * Rotates around an axis expressed in local space.
     * @param {Vec3} axis Normalized axis.
     * @param {number} angle Radians.
     * @returns {Node3D} this
     */
    rotateOnAxis(axis: Vec3, angle: number): Node3D;
    /**
     * Rotates around an axis expressed in world space.
     * @param {Vec3} axis Normalized axis.
     * @param {number} angle Radians.
     * @returns {Node3D} this
     */
    rotateOnWorldAxis(axis: Vec3, angle: number): Node3D;
    /** @param {number} angle Radians. @returns {Node3D} this */
    rotateX(angle: number): Node3D;
    /** @param {number} angle Radians. @returns {Node3D} this */
    rotateY(angle: number): Node3D;
    /** @param {number} angle Radians. @returns {Node3D} this */
    rotateZ(angle: number): Node3D;
    /**
     * Moves along an axis expressed in local space.
     * @param {Vec3} axis Normalized axis.
     * @param {number} distance
     * @returns {Node3D} this
     */
    translateOnAxis(axis: Vec3, distance: number): Node3D;
    /** @param {number} d @returns {Node3D} this */
    translateX(d: number): Node3D;
    /** @param {number} d @returns {Node3D} this */
    translateY(d: number): Node3D;
    /** @param {number} d @returns {Node3D} this */
    translateZ(d: number): Node3D;
    /**
     * Puts the node exclusively on one layer.
     * @param {number} index 0..31
     * @returns {Node3D} this
     */
    setLayer(index: number): Node3D;
    /** @param {number} index 0..31 @returns {Node3D} this */
    enableLayer(index: number): Node3D;
    /** @param {number} index 0..31 @returns {Node3D} this */
    disableLayer(index: number): Node3D;
    /**
     * @param {number} mask
     * @returns {boolean} True when the node shares at least one layer bit.
     */
    testLayers(mask: number): boolean;
    /**
     * @param {string} name
     * @returns {Node3D|null}
     */
    getObjectByName(name: string): Node3D | null;
    /**
     * @param {number} id
     * @returns {Node3D|null}
     */
    getObjectById(id: number): Node3D | null;
    /**
     * Subclass hook: releases resources owned by this single node.
     * @protected
     */
    protected _disposeSelf(): void;
    /**
     * Detaches the node and releases the whole sub tree, iteratively.
     * @returns {Node3D} this
     */
    dispose(): Node3D;
}
import { Vec3 } from "../math/Vec3.js";
import { Quat } from "../math/Quat.js";
import { Mat4 } from "../math/Mat4.js";
