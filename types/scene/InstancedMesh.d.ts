/**
 * Mesh drawn `count` times in a single draw call.
 *
 * Per instance streams live in plain Float32Arrays owned by this node and are
 * uploaded incrementally: every setter widens a dirty range and `upload()` only
 * pushes that range through `gl.bufferSubData`. The arrays are also published as
 * geometry attributes (`aInstanceMatrix`, `aInstanceColor`, `aInstanceData`) so
 * a renderer that simply calls `geometry.upload()` still gets correct data.
 *
 * Note: the geometry of an InstancedMesh is not shareable with another
 * InstancedMesh, since the instance attributes are stored on it.
 */
export class InstancedMesh extends Mesh {
    /**
     * @param {import('../render/Geometry.js').Geometry|null} geometry
     * @param {Object|Object[]|null} material
     * @param {number} [capacity=1] Number of instance slots to allocate.
     * @param {{useColor?: boolean, useData?: boolean, count?: number}} [options={}]
     */
    constructor(geometry: import('../render/Geometry.js').Geometry | null, material: any | any[] | null, capacity?: number, options?: {
        useColor?: boolean;
        useData?: boolean;
        count?: number;
    });
    /** @type {number} Number of instances actually drawn. */
    count: number;
    /** @type {number} Allocated instance slots. */
    capacity: number;
    /** @type {Float32Array} Column major 4x4 matrix per instance. */
    instanceMatrix: Float32Array;
    /** @type {Float32Array|null} RGBA per instance. */
    instanceColor: Float32Array | null;
    /** @type {Float32Array|null} Free-form vec4 per instance. */
    instanceData: Float32Array | null;
    /** Local space bounds of every instance, in mesh space. */
    instanceBoundingBox: AABB;
    /** Local space bounding sphere of every instance, in mesh space. */
    instanceBoundingSphere: Sphere;
    /** @private Dirty ranges expressed in instance indices. */
    private _matrixDirtyMin;
    /** @private */
    private _matrixDirtyMax;
    /** @private */
    private _colorDirtyMin;
    /** @private */
    private _colorDirtyMax;
    /** @private */
    private _dataDirtyMin;
    /** @private */
    private _dataDirtyMax;
    /** @private Buffers must be recreated (capacity changed). */
    private _reallocate;
    /** @private Instance bounds need a rebuild. */
    private _boundsDirty;
    /**
     * @param {boolean} value
     */
    set needsUpdate(arg: boolean);
    /**
     * True while any instance stream still has to be uploaded.
     * Setting it to true marks every stream fully dirty.
     * @returns {boolean}
     */
    get needsUpdate(): boolean;
    /**
     * Flags the matching geometry attribute so a renderer that only calls
     * `geometry.upload()` still refreshes the data. Called once per frame at
     * most, when a dirty range opens.
     * @private
     * @param {string} name
     */
    private _flagAttribute;
    /**
     * @private
     * @param {number} index
     */
    private _markMatrixDirty;
    /**
     * @private
     * @param {number} index
     */
    private _markColorDirty;
    /**
     * @private
     * @param {number} index
     */
    private _markDataDirty;
    /**
     * @param {number} index
     * @param {Mat4} matrix
     * @returns {InstancedMesh} this
     */
    setMatrixAt(index: number, matrix: Mat4): InstancedMesh;
    /**
     * @param {number} index
     * @param {Mat4} matrix Receives the instance transform.
     * @returns {Mat4} matrix
     */
    getMatrixAt(index: number, matrix: Mat4): Mat4;
    /**
     * Composes position / rotation / scale straight into the instance buffer,
     * without going through a temporary matrix.
     * @param {number} index
     * @param {import('../math/Vec3.js').Vec3} position
     * @param {import('../math/Quat.js').Quat} quaternion
     * @param {import('../math/Vec3.js').Vec3} scale
     * @returns {InstancedMesh} this
     */
    setTransformAt(index: number, position: import('../math/Vec3.js').Vec3, quaternion: import('../math/Quat.js').Quat, scale: import('../math/Vec3.js').Vec3): InstancedMesh;
    /**
     * @param {number} index
     * @param {import('../math/Color.js').Color} color
     * @param {number} [alpha=1]
     * @returns {InstancedMesh} this
     */
    setColorAt(index: number, color: import('../math/Color.js').Color, alpha?: number): InstancedMesh;
    /**
     * @param {number} index
     * @param {import('../math/Color.js').Color} out Receives the instance color.
     * @returns {import('../math/Color.js').Color} out
     */
    getColorAt(index: number, out: import('../math/Color.js').Color): import('../math/Color.js').Color;
    /**
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} w
     * @returns {InstancedMesh} this
     */
    setDataAt(index: number, x: number, y: number, z: number, w: number): InstancedMesh;
    /**
     * Allocates the per instance color stream.
     * @returns {InstancedMesh} this
     */
    enableInstanceColor(): InstancedMesh;
    /**
     * Allocates the free-form per instance vec4 stream.
     * @returns {InstancedMesh} this
     */
    enableInstanceData(): InstancedMesh;
    /**
     * Sets how many instances are drawn, growing the storage when needed.
     * @param {number} n
     * @returns {InstancedMesh} this
     */
    setCount(n: number): InstancedMesh;
    /**
     * Grows the instance storage, preserving existing data. The capacity at least
     * doubles so repeated growth stays amortized.
     * @param {number} newCapacity
     * @returns {InstancedMesh} this
     */
    grow(newCapacity: number): InstancedMesh;
    /**
     * Rebuilds the union of every instance bounding box, in mesh local space.
     * @returns {InstancedMesh} this
     */
    computeBounds(): InstancedMesh;
    /**
     * Transforms the instance bounds into world space.
     * @param {boolean} [force=false]
     * @returns {InstancedMesh} this
     */
    updateWorldBounds(force?: boolean): InstancedMesh;
    /**
     * Publishes the instance streams as geometry attributes with divisor 1.
     * @private
     */
    private _ensureAttributes;
    /**
     * Uploads only the dirty instance ranges.
     * @private
     * @param {string} name Attribute name.
     * @param {Float32Array} array
     * @param {number} components Float32 components per instance.
     * @param {number} min First dirty instance.
     * @param {number} max Last dirty instance.
     */
    private _uploadRange;
    /**
     * Pushes the dirty instance ranges to the GPU. Safe to call every frame: it
     * is a no-op when nothing changed.
     * @param {WebGL2RenderingContext} gl
     * @param {Object} state StateCache.
     * @returns {InstancedMesh} this
     */
    upload(gl: WebGL2RenderingContext, state: any): InstancedMesh;
}
import { Mesh } from "./Mesh.js";
import { AABB } from "../math/AABB.js";
import { Sphere } from "../math/Sphere.js";
import { Mat4 } from "../math/Mat4.js";
