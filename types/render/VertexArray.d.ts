/**
 * Wraps a WebGLVertexArrayObject and records attribute layouts into it.
 */
export class VertexArray {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {import('./StateCache.js').StateCache} [state] Optional explicit cache.
     */
    constructor(gl: WebGL2RenderingContext, state?: import('./StateCache.js').StateCache);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {number} */
    uid: number;
    /** @type {WebGLVertexArrayObject|null} */
    id: WebGLVertexArrayObject | null;
    /** @type {import('./StateCache.js').StateCache|null} */
    state: import('./StateCache.js').StateCache | null;
    /** @type {number} Bitmask of enabled attribute locations. */
    enabledMask: number;
    /** @type {import('./Buffer.js').GLBuffer|null} */
    indexBuffer: import('./Buffer.js').GLBuffer | null;
    /** @type {boolean} */
    disposed: boolean;
    /**
     * Resolves the state cache to use for internal binds.
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {import('./StateCache.js').StateCache|null}
     * @private
     */
    private _cache;
    /**
     * Makes this VAO current.
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {VertexArray} this
     */
    bind(state?: import('./StateCache.js').StateCache): VertexArray;
    /**
     * Records one vertex attribute into the VAO.
     *
     * Integer typed attributes are recorded with `vertexAttribIPointer` only when
     * `integer` is true; otherwise integer data is converted to float by the GPU
     * (which is what the engine wants for e.g. `aJoints`, declared as `vec4`).
     *
     * @param {number} location layout(location = N)
     * @param {import('./Buffer.js').GLBuffer} buffer Vertex buffer holding the data.
     * @param {number} size Components per vertex (1..4).
     * @param {number} [type=0x1406] GL component type (FLOAT by default).
     * @param {boolean} [normalized=false]
     * @param {number} [stride=0] Byte stride (0 = tightly packed).
     * @param {number} [offset=0] Byte offset into the buffer.
     * @param {number} [divisor=0] Instancing divisor.
     * @param {boolean} [integer=false] Use vertexAttribIPointer.
     * @returns {VertexArray} this
     */
    setAttribute(location: number, buffer: import('./Buffer.js').GLBuffer, size: number, type?: number, normalized?: boolean, stride?: number, offset?: number, divisor?: number, integer?: boolean): VertexArray;
    /**
     * Records a mat4 attribute occupying four consecutive locations
     * (used for `aInstanceMatrix` at locations 8..11).
     * @param {number} baseLocation First location.
     * @param {import('./Buffer.js').GLBuffer} buffer
     * @param {number} [stride=64] Byte stride between matrices.
     * @param {number} [offset=0] Byte offset of the first matrix.
     * @param {number} [divisor=1]
     * @returns {VertexArray} this
     */
    setMatrixAttribute(baseLocation: number, buffer: import('./Buffer.js').GLBuffer, stride?: number, offset?: number, divisor?: number): VertexArray;
    /**
     * Disables an attribute location in this VAO.
     * @param {number} location
     * @returns {VertexArray} this
     */
    disableAttribute(location: number): VertexArray;
    /**
     * Records the index buffer into the VAO.
     * @param {import('./Buffer.js').GLBuffer|null} buffer
     * @returns {VertexArray} this
     */
    setIndexBuffer(buffer: import('./Buffer.js').GLBuffer | null): VertexArray;
    /**
     * Deletes the GL object.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    dispose(state?: import('./StateCache.js').StateCache): void;
}
