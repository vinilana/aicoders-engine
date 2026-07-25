export namespace SIDE_CODE {
    const front: number;
    const back: number;
    const double: number;
}
export namespace TEXTURE_UNITS {
    const uBaseColorMap: number;
    const uNormalMap: number;
    const uMetallicRoughnessMap: number;
    const uOcclusionMap: number;
    const uEmissiveMap: number;
    const uClearcoatMap: number;
    const uBoneTexture: number;
    const uLightIndices: number;
    const uShadowMap: number;
    const uClusterGrid: number;
    const uLightData: number;
    const uIrradianceMap: number;
    const uPrefilteredMap: number;
    const uBRDFLUT: number;
}
export class Material {
    /**
     * @param {Object} [options] any public field of the class may be passed here
     */
    constructor(options?: any);
    /** Unique id, stable for the lifetime of the material. */
    id: number;
    /** @type {string} */
    name: string;
    /** Key into the ShaderLib. @type {string} */
    shaderName: any;
    /** Uniform name -> value, uploaded verbatim by the renderer. @type {Object} */
    uniforms: {};
    /** Extra permutation defines, merged on top of the derived ones. @type {Object} */
    defines: {};
    /** @type {boolean} */
    transparent: boolean;
    /** @type {number} */
    opacity: number;
    /** @type {number} discard threshold used when alphaMode is 'mask' */
    alphaTest: number;
    /** @type {string} 'opaque' | 'mask' | 'blend' */
    alphaMode: string;
    /** @type {boolean} */
    depthTest: boolean;
    /** @type {boolean} */
    depthWrite: boolean;
    /** @type {string} 'never'|'less'|'equal'|'lequal'|'greater'|'notequal'|'gequal'|'always' */
    depthFunc: string;
    /** @type {string} 'front' | 'back' | 'double' */
    side: string;
    /** @type {string} 'none'|'normal'|'additive'|'multiply'|'premultiplied' */
    blending: string;
    /** @type {boolean} */
    polygonOffset: boolean;
    /** @type {number} */
    polygonOffsetFactor: number;
    /** @type {number} */
    polygonOffsetUnits: number;
    /** @type {boolean} */
    wireframe: boolean;
    /** @type {boolean} this material writes into the shadow map */
    castShadow: boolean;
    /** @type {boolean} this material samples the shadow map */
    receiveShadow: boolean;
    /** @type {boolean} this material samples the environment probes */
    receiveIBL: boolean;
    /** @type {number} ties are broken by this before depth */
    renderOrder: number;
    /** Bumped every time `needsUpdate` is raised. @type {number} */
    version: number;
    /** Precomputed uint32 draw call sort key. @type {number} */
    sortKey: number;
    /** @private @type {Map<number,Object>} defines signature -> defines object */
    private _definesCache;
    /** @private @type {Object|null} last resolved program */
    private _program;
    /** @private @type {number} 16 bit hash of the last resolved program key */
    private _programHash;
    /** @private */
    private _needsUpdate;
    set needsUpdate(arg: boolean);
    /**
     * Raising this flag invalidates the cached defines, the resolved program and the
     * sort key. The renderer never has to look at it: everything downstream keys off
     * `version`.
     * @returns {boolean}
     */
    get needsUpdate(): boolean;
    /**
     * Recompute the uint32 sort key.
     * Layout: transparent << 31 | renderOrder << 24 | programHash << 8 | side.
     * `renderOrder` is biased by +64 so negative orders keep sorting before zero.
     * @protected
     */
    protected _computeSortKey(): number;
    /**
     * Numeric signature of the permutation inputs, used as the defines cache key.
     * @protected
     * @param {Object|null} geometry
     * @param {Object|null} ctx render context
     * @returns {number}
     */
    protected _definesSignature(geometry: any | null, ctx: any | null): number;
    /**
     * Derive the permutation defines for a geometry and a render context.
     * The result is cached; callers must treat it as read only.
     *
     * @param {Object|null} geometry
     * @param {Object|null} [renderContext] `{ shadows, shadowCascades, clustered,
     *        clusterX, clusterY, clusterZ, ibl, fog, toneMapping, motionVectors,
     *        depthOnly, instancing, skinning, maxDirLights, maxPunctualLights }`
     * @returns {Object}
     */
    getDefines(geometry: any | null, renderContext?: any | null): any;
    /**
     * Hook for subclasses: add the defines that depend on the material's own state
     * (which maps are bound, which features are enabled). Called before the explicit
     * `defines` object is merged, so the user always wins.
     *
     * @param {Object} defines mutable defines object
     * @param {Object|null} geometry
     * @param {Object|null} renderContext
     */
    applyOwnDefines(defines: any, geometry: any | null, renderContext: any | null): void;
    /**
     * Resolve (and cache) the program for a set of defines.
     * @param {Object} shaderLib
     * @param {Object|null} defines
     * @returns {Object} Program
     */
    getProgram(shaderLib: any, defines: any | null): any;
    /** @returns {Object|null} the program resolved by the last getProgram() call */
    get program(): any;
    /**
     * Set one uniform value.
     * @param {string} name
     * @param {*} value
     * @returns {Material} this
     */
    setUniform(name: string, value: any): Material;
    /**
     * @param {string} name
     * @returns {*}
     */
    getUniform(name: string): any;
    /**
     * Set many uniforms at once.
     * @param {Object} values
     * @returns {Material} this
     */
    setUniforms(values: any): Material;
    /**
     * Add or replace permutation defines. A value of `false` is an explicit opt out:
     * it is remembered and removes the define even when the geometry or the render
     * context would have derived it.
     * @param {Object} defines
     * @returns {Material} this
     */
    setDefines(defines: any): Material;
    /**
     * Toggle a single define.
     * @param {string} name
     * @param {*} value `false` disables the define even if it would be derived,
     *        `null` / `undefined` drops the override and restores the derived value
     * @returns {Material} this
     */
    setDefine(name: string, value: any): Material;
    /**
     * Upload every uniform of this material to a program, binding texture valued
     * uniforms to their fixed unit. Values that the permutation compiled away are
     * silently skipped.
     *
     * @param {Object} program
     * @param {Object} state StateCache
     * @returns {number} how many uniforms were written
     */
    applyUniforms(program: any, state: any): number;
    /**
     * Copy every property of another material of the same class.
     * @param {Material} source
     * @returns {Material} this
     */
    copy(source: Material): Material;
    /**
     * @returns {Material} a new material of the same concrete class
     */
    clone(): Material;
    /**
     * Release the cached state. Textures are owned by whoever created them and are
     * deliberately not disposed here.
     */
    dispose(): void;
}
