/**
 * Resolves an internal format (name or GL enum) into a full descriptor.
 * @param {WebGL2RenderingContext} gl
 * @param {string|number} internalFormat
 * @param {number} [format] Explicit pixel format when passing a raw enum.
 * @param {number} [type] Explicit pixel type when passing a raw enum.
 * @returns {Object}
 */
export function resolveFormat(gl: WebGL2RenderingContext, internalFormat: string | number, format?: number, type?: number): any;
/**
 * Creates a 2D texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts]
 * @returns {Texture}
 */
export function createTexture2D(gl: WebGL2RenderingContext, opts?: any): Texture;
/**
 * Creates a cube map texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts] `size` may be used instead of width/height.
 * @returns {Texture}
 */
export function createTextureCube(gl: WebGL2RenderingContext, opts?: any): Texture;
/**
 * Creates a 2D array texture (cascaded shadow maps, texture atlases...).
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts] Requires `depth` (layer count).
 * @returns {Texture}
 */
export function createTextureArray(gl: WebGL2RenderingContext, opts?: any): Texture;
/**
 * Creates a 3D texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts]
 * @returns {Texture}
 */
export function createTexture3D(gl: WebGL2RenderingContext, opts?: any): Texture;
/**
 * Creates a texture straight from a typed array (lookup tables, light data...).
 * Defaults to NEAREST filtering and clamped wrapping, which is what data
 * textures almost always want.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {ArrayBufferView} typedArray
 * @param {number} width
 * @param {number} height
 * @param {string|number} [internalFormat='rgba32f']
 * @param {number} [format]
 * @param {number} [type]
 * @returns {Texture}
 */
export function createDataTexture(gl: WebGL2RenderingContext, typedArray: ArrayBufferView, width: number, height: number, internalFormat?: string | number, format?: number, type?: number): Texture;
/**
 * Convenience: 1x1 white texture used as a fallback for missing maps.
 * @param {WebGL2RenderingContext} gl
 * @returns {Texture}
 */
export function createWhiteTexture(gl: WebGL2RenderingContext): Texture;
/**
 * Logs a warning when a texture exceeds the hardware limit.
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @returns {boolean} True when the size fits.
 */
export function validateTextureSize(gl: WebGL2RenderingContext, size: number): boolean;
/**
 * GPU texture object.
 */
export class Texture {
    /** Total bytes allocated by every live Texture. @type {number} */
    static get totalBytes(): number;
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [options]
     * @param {number} [options.width=1]
     * @param {number} [options.height=1]
     * @param {number} [options.depth=1] Layers (2d-array) or slices (3d).
     * @param {string} [options.target='2d'] '2d' | 'cube' | '2d-array' | '3d'
     * @param {string|number} [options.internalFormat='rgba8']
     * @param {number} [options.format] Overrides the descriptor pixel format.
     * @param {number} [options.type] Overrides the descriptor pixel type.
     * @param {string|number} [options.minFilter]
     * @param {string|number} [options.magFilter='linear']
     * @param {string|number} [options.wrapS='repeat']
     * @param {string|number} [options.wrapT='repeat']
     * @param {string|number} [options.wrapR='clamp']
     * @param {number} [options.anisotropy=1]
     * @param {boolean} [options.generateMipmaps=false]
     * @param {boolean} [options.flipY=false]
     * @param {boolean} [options.premultiply=false]
     * @param {ArrayBufferView|Object} [options.data]
     * @param {Array} [options.images] Six faces for cube maps.
     * @param {number} [options.levels] Explicit mip level count.
     * @param {boolean} [options.compareMode=false] Enables shadow comparison.
     * @param {number} [options.compareFunc] Comparison function (default LEQUAL).
     * @param {boolean} [options.immutable=true] Use texStorage when possible.
     * @param {import('./StateCache.js').StateCache} [options.state]
     */
    constructor(gl: WebGL2RenderingContext, options?: {
        width?: number;
        height?: number;
        depth?: number;
        target?: string;
        internalFormat?: string | number;
        format?: number;
        type?: number;
        minFilter?: string | number;
        magFilter?: string | number;
        wrapS?: string | number;
        wrapT?: string | number;
        wrapR?: string | number;
        anisotropy?: number;
        generateMipmaps?: boolean;
        flipY?: boolean;
        premultiply?: boolean;
        data?: ArrayBufferView | any;
        images?: any[];
        levels?: number;
        compareMode?: boolean;
        compareFunc?: number;
        immutable?: boolean;
        state?: import('./StateCache.js').StateCache;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {number} */
    uid: number;
    /** @type {string} */
    name: string;
    /** @type {WebGLTexture|null} */
    id: WebGLTexture | null;
    /** @private */
    private _info;
    /** @private */
    private _state;
    /** @type {string} */
    targetName: string;
    /** @type {number} GL enum of the texture target. */
    target: number;
    /** @type {boolean} */
    isCube: boolean;
    /** @type {boolean} */
    isArray: boolean;
    /** @type {boolean} */
    is3D: boolean;
    /** @type {boolean} True when the target uses texStorage3D/texSubImage3D. */
    isVolume: boolean;
    /** @type {number} */
    width: number;
    /** @type {number} */
    height: number;
    /** @type {number} */
    depth: number;
    /** @type {Object} Resolved internal format descriptor. */
    descriptor: any;
    /** @type {number} */
    internalFormat: number;
    /** @type {number} */
    format: number;
    /** @type {number} */
    type: number;
    /** @type {boolean} */
    generateMipmapsEnabled: boolean;
    /** @type {number} */
    minFilter: number;
    /** @type {number} */
    magFilter: number;
    /** @type {number} */
    wrapS: number;
    /** @type {number} */
    wrapT: number;
    /** @type {number} */
    wrapR: number;
    /** @type {number} */
    anisotropy: number;
    /** @type {boolean} */
    flipY: boolean;
    /** @type {boolean} */
    premultiply: boolean;
    /** @type {boolean} */
    compareMode: boolean;
    /** @type {number} */
    compareFunc: number;
    /** @type {boolean} */
    immutable: boolean;
    /** @type {number} Mip level count. */
    levels: number;
    /** @type {boolean} Storage already allocated. */
    allocated: boolean;
    /** @type {boolean} */
    disposed: boolean;
    /** @type {number} */
    version: number;
    /**
     * Bytes counted into the global total for the CURRENT storage. Kept
     * separate from `memoryBytes` because a resize mutates the dimensions
     * before the old storage is released.
     * @type {number}
     * @private
     */
    private _allocatedBytes;
    /**
     * Full mip chain length for the current dimensions.
     * @returns {number}
     * @private
     */
    private _maxLevels;
    /**
     * Binds this texture on the scratch unit for creation/parameter work.
     * @returns {import('./StateCache.js').StateCache|null}
     * @private
     */
    private _bindSelf;
    /**
     * Configures the unpack pixel-store state for an upload.
     * The alignment must be derived from the width of the rows ACTUALLY being
     * uploaded: using the full texture width would make the driver expect padded
     * rows and shift the pixels of a narrow sub-update.
     * @param {boolean} forSource True when uploading a DOM source.
     * @param {number} [rowPixels] Row width of this upload (defaults to the texture width).
     * @private
     */
    private _setPixelStore;
    /**
     * Allocates the (immutable when possible) storage.
     * @private
     */
    private _allocate;
    /**
     * Pushes filters, wrap modes, anisotropy and compare mode to the driver.
     * @returns {Texture} this
     */
    _applyParameters(): Texture;
    /**
     * Uploads pixel data.
     *
     * For 2D-array/3D targets `face` is the layer index; pass `-1` to upload the
     * whole volume in one call. For cube maps `face` is 0..5.
     *
     * @param {ArrayBufferView|Object|null} data
     * @param {number} [level=0]
     * @param {number} [face=0]
     * @returns {Texture} this
     */
    upload(data: ArrayBufferView | any | null, level?: number, face?: number): Texture;
    /**
     * Partial 2D update.
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {ArrayBufferView|Object} data
     * @param {number} [level=0]
     * @param {number} [face=0]
     * @returns {Texture} this
     */
    updateSubImage(x: number, y: number, width: number, height: number, data: ArrayBufferView | any, level?: number, face?: number): Texture;
    /**
     * Uploads a whole layer of a 2D-array / 3D texture.
     * @param {ArrayBufferView|Object} data
     * @param {number} layer
     * @param {number} [level=0]
     * @returns {Texture} this
     */
    uploadLayer(data: ArrayBufferView | any, layer: number, level?: number): Texture;
    /**
     * Sets the texture content from an image-like source, adopting its size.
     * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} img
     * @param {number} [face=0] Cube face when applicable.
     * @returns {Texture} this
     */
    setFromImage(img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement, face?: number): Texture;
    /**
     * Recreates the GL object with the current dimensions. Required because
     * immutable storage cannot be resized.
     * @private
     */
    private _reallocate;
    /**
     * Resizes the texture, discarding its content.
     * @param {number} width
     * @param {number} height
     * @param {number} [depth]
     * @returns {Texture} this
     */
    resize(width: number, height: number, depth?: number): Texture;
    /**
     * @param {string|number} min
     * @param {string|number} mag
     * @returns {Texture} this
     */
    setFilters(min: string | number, mag: string | number): Texture;
    /**
     * @param {string|number} s
     * @param {string|number} t
     * @param {string|number} [r]
     * @returns {Texture} this
     */
    setWrap(s: string | number, t: string | number, r?: string | number): Texture;
    /**
     * @param {number} value
     * @returns {Texture} this
     */
    setAnisotropy(value: number): Texture;
    /**
     * Enables or disables hardware shadow comparison (sampler2DShadow).
     * @param {boolean} enabled
     * @param {number} [func]
     * @returns {Texture} this
     */
    setCompareMode(enabled: boolean, func?: number): Texture;
    /**
     * Generates the mip chain.
     * @returns {Texture} this
     */
    generateMipmaps(): Texture;
    /**
     * Binds the texture to a shader texture unit.
     * @param {import('./StateCache.js').StateCache} state
     * @param {number} unit
     * @returns {Texture} this
     */
    bind(state: import('./StateCache.js').StateCache, unit: number): Texture;
    /** @type {number} Approximate GPU footprint in bytes (mips included). */
    get memoryBytes(): number;
    /**
     * Deletes the GL object and updates the memory counter.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    dispose(state?: import('./StateCache.js').StateCache): void;
}
