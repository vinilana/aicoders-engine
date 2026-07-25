/**
 * Resolves a friendly buffer target name to its GL enum.
 * @param {string|number} name
 * @returns {number}
 */
export function bufferTargetToGL(name: string | number): number;
/**
 * Resolves a friendly usage name to its GL enum.
 * @param {string|number} name
 * @returns {number}
 */
export function bufferUsageToGL(name: string | number): number;
/**
 * GPU buffer object with byte accounting and partial upload support.
 */
export class GLBuffer {
    /**
     * Total bytes currently allocated by every live GLBuffer.
     * @type {number}
     */
    static get totalBytes(): number;
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {string|number} [target='array'] Friendly name or GL enum.
     * @param {string|number} [usage='static'] Friendly name or GL enum.
     */
    constructor(gl: WebGL2RenderingContext, target?: string | number, usage?: string | number);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {number} Engine-side unique id (sorting / debugging). */
    uid: number;
    /** @type {number} GL enum of the default binding target. */
    target: number;
    /** @type {number} GL enum of the usage hint. */
    usage: number;
    /** @type {WebGLBuffer|null} */
    id: WebGLBuffer | null;
    /** @type {number} Allocated size in bytes. */
    byteLength: number;
    /** @type {number} Bumped on every data upload (useful for invalidation). */
    version: number;
    /** @type {boolean} */
    disposed: boolean;
    /**
     * Binds the buffer to its target.
     * For index buffers this first unbinds the VAO, because binding an element
     * array buffer would otherwise be recorded into the bound VAO.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    bind(state?: import('./StateCache.js').StateCache): void;
    /**
     * Binds without protecting the current VAO. Only VertexArray should use this,
     * while it is recording the index buffer into a VAO on purpose.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    bindInVAO(state?: import('./StateCache.js').StateCache): void;
    /**
     * Uploads a full data store, (re)allocating it.
     * @param {ArrayBufferView|ArrayBuffer} data
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {GLBuffer} this
     */
    setData(data: ArrayBufferView | ArrayBuffer, state?: import('./StateCache.js').StateCache): GLBuffer;
    /**
     * Allocates (or reallocates) an uninitialized data store.
     * @param {number} byteLength
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {GLBuffer} this
     */
    allocate(byteLength: number, state?: import('./StateCache.js').StateCache): GLBuffer;
    /**
     * Uploads a sub range without reallocating.
     * @param {ArrayBufferView} data Source typed array.
     * @param {number} [dstByteOffset=0] Destination offset in bytes.
     * @param {number} [srcOffset=0] Source offset in ELEMENTS of `data`.
     * @param {number} [srcLength] Element count to copy (defaults to the rest).
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {GLBuffer} this
     */
    setSubData(data: ArrayBufferView, dstByteOffset?: number, srcOffset?: number, srcLength?: number, state?: import('./StateCache.js').StateCache): GLBuffer;
    /**
     * Orphans the current data store (same size, fresh storage). Used by streaming
     * buffers to avoid pipeline stalls when the GPU is still reading the old data.
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {GLBuffer} this
     */
    orphan(state?: import('./StateCache.js').StateCache): GLBuffer;
    /**
     * Reads GPU data back into a typed array (slow, debug only).
     * @param {ArrayBufferView} out
     * @param {number} [srcByteOffset=0]
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {ArrayBufferView} out
     */
    read(out: ArrayBufferView, srcByteOffset?: number, state?: import('./StateCache.js').StateCache): ArrayBufferView;
    /**
     * Bytes this buffer occupies on the GPU.
     * @type {number}
     */
    get memoryBytes(): number;
    /**
     * Deletes the GL object and updates the global byte counter.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    dispose(state?: import('./StateCache.js').StateCache): void;
}
