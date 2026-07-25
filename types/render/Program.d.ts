export namespace UBO_BINDINGS {
    const Camera: number;
    const Lights: number;
    const Shadows: number;
    const Fog: number;
}
export namespace DEFAULT_ATTRIB_LOCATIONS {
    const aPosition: number;
    const aNormal: number;
    const aUV0: number;
    const aTangent: number;
    const aColor: number;
    const aUV1: number;
    const aJoints: number;
    const aWeights: number;
    const aInstanceMatrix: number;
    const aInstanceColor: number;
    const aInstanceData: number;
}
export class Program {
    /**
     * Deterministic 16 bit FNV-1a hash, used for the program component of a sort key.
     * @param {string} text
     * @returns {number}
     */
    static hashKey(text: string): number;
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {string} vertexSource
     * @param {string} fragmentSource
     * @param {Object|null} [defines] macros injected into both stages
     * @param {string} [name] label used in error messages
     * @param {{preprocessor?:Object, async?:boolean, key?:string}} [options]
     *        When `preprocessor` is given the sources go through it (includes +
     *        defines); otherwise only the defines are injected.
     */
    constructor(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, defines?: any | null, name?: string, options?: {
        preprocessor?: any;
        async?: boolean;
        key?: string;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** Unique id, useful as a draw call sort key component. */
    id: number;
    /** @type {string} */
    name: string;
    /** @type {Object|null} */
    defines: any | null;
    /** Cache key assigned by ShaderLib, empty for standalone programs. */
    key: string;
    /** @type {WebGLProgram|null} */
    program: WebGLProgram | null;
    /** True once the program is linked and reflected. */
    ready: boolean;
    /** True when compilation or linking failed. */
    failed: boolean;
    /** @type {string} last error report, empty when the program is healthy */
    error: string;
    /** @type {Map<string,{location:WebGLUniformLocation,type:number,size:number,isArray:boolean,setter:Function}>} */
    uniforms: Map<string, {
        location: WebGLUniformLocation;
        type: number;
        size: number;
        isArray: boolean;
        setter: Function;
    }>;
    /** @type {Map<string,number>} attribute name -> location */
    attributes: Map<string, number>;
    /** @type {Map<string,{index:number,binding:number,size:number}>} */
    uniformBlocks: Map<string, {
        index: number;
        binding: number;
        size: number;
    }>;
    /** @type {number} 16 bit hash of the cache key, folded into Material.sortKey */
    hash: number;
    _preprocessor: any;
    _vertexShader: WebGLShader;
    _fragmentShader: WebGLShader;
    _parallelExt: any;
    _async: boolean;
    _boundTextureUnits: Map<any, any>;
    vertexSource: any;
    fragmentSource: any;
    /**
     * Compile both stages and start linking.
     * @private
     */
    private _link;
    /**
     * @private
     * @returns {WebGLShader|null}
     */
    private _compile;
    /**
     * Query link status, report errors and reflect the interface.
     * @private
     */
    private _finalize;
    /**
     * Collect compile and link logs into one readable report.
     * @private
     * @returns {string}
     */
    private _buildErrorReport;
    /** @private */
    private _deleteShaders;
    /** @private */
    private _reflectAttributes;
    /** @private */
    private _reflectUniformBlocks;
    /** @private */
    private _reflectUniforms;
    /**
     * Build a uniform record together with its specialised setter.
     * @private
     */
    private _createRecord;
    /**
     * Specialised setter per uniform type. Scalars and vectors compare against the
     * last uploaded value so redundant driver calls are skipped; matrices and arrays
     * always upload because comparing them costs more than the call itself.
     * @private
     * @returns {Function}
     */
    private _createSetter;
    /**
     * Poll the driver for asynchronous link completion.
     * @returns {boolean} true when the program is finished (linked or failed)
     */
    checkAsync(): boolean;
    /**
     * Force the link to complete (blocking) and report success.
     * @returns {boolean}
     */
    isLinked(): boolean;
    /**
     * Bind this program through the state cache.
     * @param {Object} state StateCache instance
     * @returns {boolean} false when the program is not usable
     */
    use(state: any): boolean;
    /**
     * @param {string} name
     * @returns {boolean}
     */
    hasUniform(name: string): boolean;
    /**
     * Set one uniform. Unknown names are ignored, which keeps a shader permutation
     * that optimised a uniform away from breaking the caller.
     * @param {string} name
     * @param {*} value
     * @returns {boolean} true when the uniform exists and was written
     */
    setUniform(name: string, value: any): boolean;
    /**
     * Set many uniforms at once.
     * @param {Object|Map} values
     * @returns {number} how many uniforms were written
     */
    setUniforms(values: any | Map<any, any>): number;
    /**
     * Bind a texture to a unit and point the sampler uniform at it.
     * @param {string} name sampler uniform name
     * @param {Object|null} texture engine Texture (or null to only set the unit)
     * @param {number} unit texture unit index
     * @param {Object} state StateCache instance
     * @returns {boolean}
     */
    setTexture(name: string, texture: any | null, unit: number, state: any): boolean;
    /**
     * Rebind a uniform block to an explicit binding point.
     * @param {string} name
     * @param {number} bindingPoint
     * @returns {boolean}
     */
    bindUniformBlock(name: string, bindingPoint: number): boolean;
    /**
     * Invalidate every cached uniform value. Call it when the program is rebound
     * outside of the engine, or after a context restore.
     */
    resetUniformCache(): void;
    /** Release the GL program. The instance must not be used afterwards. */
    dispose(): void;
}
