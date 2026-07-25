export class ShaderLib {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {ShaderPreprocessor} [preprocessor] shared preprocessor; a new one with
     *        every built in chunk registered is created when omitted
     */
    constructor(gl: WebGL2RenderingContext, preprocessor?: ShaderPreprocessor);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {ShaderPreprocessor} */
    preprocessor: ShaderPreprocessor;
    /** @type {Map<string,{vertex:string, fragment:string, defaultDefines:Object|null}>} */
    sources: Map<string, {
        vertex: string;
        fragment: string;
        defaultDefines: any | null;
    }>;
    /** @type {Map<string,Program>} permutation key -> program */
    cache: Map<string, Program>;
    /** @type {Program[]} programs still linking asynchronously */
    pending: Program[];
    /** Compilation statistics. */
    stats: {
        compiled: number;
        cacheHits: number;
        failed: number;
    };
    /**
     * Register (or replace) a shader source pair.
     * @param {string} name
     * @param {{vertex:string, fragment:string, defines?:Object}} sources
     * @returns {ShaderLib} this
     */
    register(name: string, sources: {
        vertex: string;
        fragment: string;
        defines?: any;
    }): ShaderLib;
    /**
     * @param {string} name
     * @returns {boolean}
     */
    has(name: string): boolean;
    /**
     * @param {string} name
     * @returns {{vertex:string, fragment:string, defaultDefines:Object|null}|null}
     */
    getSource(name: string): {
        vertex: string;
        fragment: string;
        defaultDefines: any | null;
    } | null;
    /** @returns {string[]} every registered shader name */
    get shaderNames(): string[];
    /** @returns {number} number of compiled permutations currently cached */
    get programCount(): number;
    /**
     * Deterministic cache key for a (name, defines) pair.
     * @param {string} name
     * @param {Object|null} defines
     * @returns {string}
     */
    getKey(name: string, defines: any | null): string;
    /**
     * Fetch, compiling on demand, the program for one permutation.
     * @param {string} name registered shader name
     * @param {Object|null} [defines]
     * @returns {Program}
     */
    get(name: string, defines?: any | null): Program;
    /**
     * Merge the shader default defines with the per call ones.
     * @private
     * @returns {Object|null}
     */
    private _mergeDefines;
    /**
     * Warm up a set of permutations ahead of time so no frame pays for the compile.
     * @param {string} name
     * @param {Array<Object>} definesList
     * @returns {Program[]}
     */
    precompile(name: string, definesList: Array<any>): Program[];
    /**
     * Block until every pending program has finished linking. Used by
     * Renderer.compile() before the first frame is drawn.
     * @returns {number} number of programs that failed
     */
    finishAll(): number;
    /**
     * Poll the asynchronously linking programs. Cheap enough to call once per frame.
     * @returns {number} how many are still pending
     */
    poll(): number;
    /**
     * Drop every compiled permutation of one shader.
     * @param {string} name
     * @returns {number} how many programs were released
     */
    invalidate(name: string): number;
    /** Release every compiled program. Sources stay registered. */
    clearCache(): void;
    /** Release programs and forget every registered source. */
    dispose(): void;
}
import { ShaderPreprocessor } from "./ShaderPreprocessor.js";
import { Program } from "./Program.js";
