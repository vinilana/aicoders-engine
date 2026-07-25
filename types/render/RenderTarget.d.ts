/**
 * Off-screen render destination.
 */
export class RenderTarget {
    /** Total bytes held by renderbuffers across every RenderTarget. @type {number} */
    static get totalRenderbufferBytes(): number;
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {number} width
     * @param {number} height
     * @param {Object} [options]
     * @param {number} [options.colorAttachments=1] 0..4 color textures (0 = depth only).
     * @param {string|string[]} [options.colorFormat='rgba8'] One format, or one per attachment.
     * @param {boolean} [options.depth=true] Attach a depth buffer.
     * @param {boolean} [options.depthTexture=false] Depth as a sampleable texture.
     * @param {string} [options.depthFormat='depth24']
     * @param {number} [options.samples=0] MSAA sample count (0 = disabled).
     * @param {string} [options.wrap='clamp']
     * @param {string} [options.filter='linear']
     * @param {number} [options.layers=1] Layer count (creates 2D-array attachments).
     * @param {boolean} [options.isCube=false] Cube map attachments.
     * @param {boolean} [options.generateMipmaps=false]
     * @param {boolean} [options.compareMode=false] Shadow comparison on the depth texture.
     * @param {import('./StateCache.js').StateCache} [options.state]
     */
    constructor(gl: WebGL2RenderingContext, width: number, height: number, options?: {
        colorAttachments?: number;
        colorFormat?: string | string[];
        depth?: boolean;
        depthTexture?: boolean;
        depthFormat?: string;
        samples?: number;
        wrap?: string;
        filter?: string;
        layers?: number;
        isCube?: boolean;
        generateMipmaps?: boolean;
        compareMode?: boolean;
        state?: import('./StateCache.js').StateCache;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {number} */
    uid: number;
    /** @type {string} */
    name: string;
    /** @type {number} */
    width: number;
    /** @type {number} */
    height: number;
    /** @private */
    private _stateRef;
    /** @type {number} */
    layers: number;
    /** @type {boolean} */
    isCube: boolean;
    /** @type {boolean} */
    isLayered: boolean;
    /** @type {number} */
    colorAttachmentCount: number;
    /** @type {string|string[]} */
    colorFormat: string | string[];
    /** @type {boolean} */
    hasDepth: boolean;
    /** @type {boolean} */
    useDepthTexture: boolean;
    /** @type {string} */
    depthFormat: string;
    /** @type {string} */
    wrap: string;
    /** @type {string} */
    filter: string;
    /** @type {boolean} */
    generateMipmaps: boolean;
    /** @type {boolean} */
    compareMode: boolean;
    /** @type {number} */
    samples: number;
    /** @type {Texture[]} Resolved color textures. */
    textures: Texture[];
    /** @type {Texture|null} */
    depthTexture: Texture | null;
    /** @type {WebGLFramebuffer|null} Texture-backed FBO. */
    resolveFramebuffer: WebGLFramebuffer | null;
    /** @type {WebGLFramebuffer|null} FBO actually rendered into. */
    framebuffer: WebGLFramebuffer | null;
    /** @type {WebGLRenderbuffer|null} */
    depthRenderbuffer: WebGLRenderbuffer | null;
    /** @type {WebGLRenderbuffer[]} */
    colorRenderbuffers: WebGLRenderbuffer[];
    /** @type {number} Currently bound layer/face. */
    currentLayer: number;
    /** @type {boolean} */
    disposed: boolean;
    /** @private */
    private _needsResolve;
    /** @private */
    private _drawBuffers;
    /**
     * Alias kept for contract compatibility: the FBO the renderer binds.
     * @type {WebGLFramebuffer|null}
     */
    get id(): WebGLFramebuffer;
    /** First color texture (the common case). @type {Texture|null} */
    get texture(): Texture;
    /**
     * Resolves the state cache used for internal binds.
     * @returns {import('./StateCache.js').StateCache|null}
     * @private
     */
    private _state;
    /**
     * Binds a framebuffer through the cache when available.
     * @param {number} target
     * @param {WebGLFramebuffer|null} fbo
     * @private
     */
    private _bindFBO;
    /**
     * Color format for attachment i.
     * @param {number} i
     * @returns {string}
     * @private
     */
    private _formatFor;
    /**
     * Creates every GL resource.
     * @private
     */
    private _build;
    /**
     * Creates a (possibly multisampled) renderbuffer and accounts its memory.
     * @param {number} internalFormat
     * @param {number} samples
     * @returns {WebGLRenderbuffer}
     * @private
     */
    private _createRenderbuffer;
    /**
     * Attaches a color texture (layer/face aware).
     * @private
     */
    private _attachColor;
    /**
     * Attaches a texture to an attachment point.
     * @param {number} attachment
     * @param {Texture} tex
     * @param {number} layer
     * @param {number} level
     * @private
     */
    private _attachTexture;
    /**
     * Declares the draw buffers of the currently bound FBO.
     * @private
     */
    private _setupDrawBuffers;
    /**
     * Restricts rendering to a subset of the color attachments.
     * @param {number[]|null} indices Attachment indices, or null to restore all.
     * @returns {RenderTarget} this
     */
    setDrawBuffers(indices: number[] | null): RenderTarget;
    /**
     * Validates the currently bound framebuffer.
     * @param {string} which Label used in the error message.
     * @private
     */
    private _checkStatus;
    /**
     * Makes this target current and sets the viewport to its full size.
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {RenderTarget} this
     */
    bind(state?: import('./StateCache.js').StateCache): RenderTarget;
    /**
     * Attaches a specific layer (2D-array) or face (cube) to every layered
     * attachment and binds the target. Used once per cascade by the shadow mapper.
     * @param {number} layerIndex
     * @param {number} [level=0]
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {RenderTarget} this
     */
    bindLayer(layerIndex: number, level?: number, state?: import('./StateCache.js').StateCache): RenderTarget;
    /**
     * Alias of `bindLayer` for cube map targets.
     * @param {number} face 0..5
     * @param {number} [level=0]
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {RenderTarget} this
     */
    bindFace(face: number, level?: number, state?: import('./StateCache.js').StateCache): RenderTarget;
    /**
     * Resolves MSAA (when needed) and unbinds to the default framebuffer.
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {RenderTarget} this
     */
    unbind(state?: import('./StateCache.js').StateCache): RenderTarget;
    /**
     * Blits the multisampled attachments into the texture-backed FBO.
     * Each color attachment is resolved individually because `blitFramebuffer`
     * only ever reads from the current read buffer.
     * @returns {RenderTarget} this
     */
    resolve(): RenderTarget;
    /**
     * Blits this target into another one (or into the default framebuffer).
     * @param {RenderTarget|null} target Destination, null = screen.
     * @param {number} [mask=GL_COLOR_BUFFER_BIT] Buffer bits to copy.
     * @param {number} [filter] GL_NEAREST or GL_LINEAR (forced to NEAREST for depth).
     * @returns {RenderTarget} this
     */
    blitTo(target: RenderTarget | null, mask?: number, filter?: number): RenderTarget;
    /**
     * Resizes the target, discarding its contents.
     * @param {number} width
     * @param {number} height
     * @returns {RenderTarget} this
     */
    resize(width: number, height: number): RenderTarget;
    /**
     * Regenerates the mip chains of the color textures (bloom/reflection chains).
     * Only textures created with `generateMipmaps: true` have a chain to fill;
     * the others are skipped instead of being reallocated, which would discard
     * whatever was just rendered into them.
     * @returns {RenderTarget} this
     */
    generateMipmapsForTextures(): RenderTarget;
    /** @type {number} Approximate GPU footprint of this target. */
    get memoryBytes(): number;
    /**
     * Deletes every GL resource but keeps the instance reusable (used by resize).
     * @private
     */
    private _releaseResources;
    /**
     * Releases everything. The instance must not be used afterwards.
     * @param {import('./StateCache.js').StateCache} [state]
     */
    dispose(state?: import('./StateCache.js').StateCache): void;
}
import { Texture } from "./Texture.js";
