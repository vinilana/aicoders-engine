/**
 * Creates a WebGL2 rendering context with the engine defaults and probes
 * every optional extension the renderer can take advantage of.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|string} canvas Canvas element or CSS selector.
 * @param {Object} [options] Context attributes plus `onContextLost` / `onContextRestored` hooks.
 * @returns {{gl: WebGL2RenderingContext, caps: Capabilities, canvas: Object,
 *            attributes: Object, isWebGL2: boolean, lose: Function, restore: Function,
 *            dispose: Function}}
 */
export function createGLContext(canvas: HTMLCanvasElement | OffscreenCanvas | string, options?: any): {
    gl: WebGL2RenderingContext;
    caps: Capabilities;
    canvas: any;
    attributes: any;
    isWebGL2: boolean;
    lose: Function;
    restore: Function;
    dispose: Function;
};
/**
 * Immutable snapshot of everything the renderer needs to know about the GPU.
 * Queried once at startup; every value is a plain number/boolean/string so it
 * can be serialized into the stats overlay without extra work.
 */
export class Capabilities {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object<string,Object>} extensions Map of extension name -> object (null when absent).
     */
    constructor(gl: WebGL2RenderingContext, extensions: {
        [x: string]: any;
    });
    /** @type {Object<string,Object>} */
    extensions: {
        [x: string]: any;
    };
    /** @type {number} */
    maxTextureSize: number;
    /** @type {number} */
    maxCubeMapSize: number;
    /** @type {number} */
    max3DTextureSize: number;
    /** @type {number} Texture units addressable from a single fragment shader. */
    maxTextureUnits: number;
    /** @type {number} Texture units addressable across the whole pipeline. */
    maxCombinedTextureUnits: number;
    /** @type {number} */
    maxVertexTextureUnits: number;
    /** @type {number} */
    maxArrayTextureLayers: number;
    /** @type {Object|null} */
    anisotropic: any | null;
    /** @type {number} Always >= 1, even if the driver reports a bogus value. */
    maxAnisotropy: number;
    /** @type {number} */
    maxSamples: number;
    /** @type {number} */
    maxColorAttachments: number;
    /** @type {number} */
    maxDrawBuffers: number;
    /** @type {number} */
    maxRenderbufferSize: number;
    /** @type {number} */
    maxUBOSize: number;
    /** @type {number} */
    maxUBOBindings: number;
    /** @type {number} Required alignment (bytes) for bindBufferRange offsets. */
    uboOffsetAlignment: number;
    /** @type {number} */
    maxVertexUniformBlocks: number;
    /** @type {number} */
    maxFragmentUniformBlocks: number;
    /** @type {number} */
    maxVertexAttribs: number;
    /** @type {number} */
    maxVaryingComponents: number;
    /** @type {number} */
    maxVertexUniformVectors: number;
    /** @type {number} */
    maxFragmentUniformVectors: number;
    /** @type {Int32Array|Array<number>} */
    maxViewportDims: Int32Array | Array<number>;
    /** @type {boolean} Float/half-float color attachments (HDR pipeline). */
    colorBufferFloat: boolean;
    /** @type {boolean} */
    colorBufferHalfFloat: boolean;
    /** @type {boolean} Linear filtering of 32F textures. */
    textureFloatLinear: boolean;
    /** @type {boolean} Half float linear filtering is core in WebGL2. */
    textureHalfFloatLinear: boolean;
    /** @type {Object|null} */
    timerQuery: any | null;
    /** @type {Object|null} */
    parallelShaderCompile: any | null;
    /** @type {boolean} Blending onto 32F render targets. */
    floatBlend: boolean;
    /** @type {Object|null} */
    multiDraw: any | null;
    /** @type {Object|null} */
    loseContext: any | null;
    /** @type {number[]} */
    compressedFormats: number[];
    /** @type {string[]} */
    compressedFormatNames: string[];
    /** @type {boolean} */
    s3tc: boolean;
    /** @type {boolean} */
    etc: boolean;
    /** @type {boolean} */
    astc: boolean;
    /** @type {boolean} */
    bptc: boolean;
    /** @type {boolean} True when the fragment stage really supports highp. */
    highpFragment: boolean;
    /** @type {string} 'highp' or 'mediump' - what shaders should declare. */
    precision: string;
    /** @type {string} */
    vendor: string;
    /** @type {string} */
    renderer: string;
    /** @type {string} */
    version: string;
    /** @type {string} */
    glslVersion: string;
    /** @type {boolean} Heuristic: integrated/mobile GPUs get cheaper defaults. */
    isMobile: boolean;
    /**
     * Tells whether a probed extension is present.
     * @param {string} name
     * @returns {boolean}
     */
    hasExtension(name: string): boolean;
    /**
     * Returns a probed extension object or null.
     * @param {string} name
     * @returns {Object|null}
     */
    getExtension(name: string): any | null;
    /**
     * Clamps a requested anisotropy level to what the GPU supports.
     * @param {number} value
     * @returns {number}
     */
    clampAnisotropy(value: number): number;
    /**
     * Clamps a requested MSAA sample count.
     * @param {number} samples
     * @returns {number}
     */
    clampSamples(samples: number): number;
    /**
     * Human readable multi-line summary, used by Stats and the console banner.
     * @returns {string}
     */
    toString(): string;
}
