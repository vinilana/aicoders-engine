/**
 * Format a defines object into GLSL `#define` lines, sorted for determinism.
 * `false`, `null` and `undefined` values are skipped; `true` becomes `1`.
 * @param {Object|null} defines
 * @returns {string[]} one entry per line, without trailing newlines
 */
export function formatDefines(defines: any | null): string[];
/**
 * Build a stable, deterministic key for a defines object.
 * @param {Object|null} defines
 * @returns {string}
 */
export function definesKey(defines: any | null): string;
export class ShaderPreprocessor {
    /** @type {Map<string,string>} chunk name -> GLSL source */
    chunks: Map<string, string>;
    /** Statistics, handy when profiling shader compilation. */
    stats: {
        resolves: number;
        includes: number;
        cacheHits: number;
    };
    /** @type {Map<string,{names:string[],lines:number[]}>} resolved source -> line map */
    _maps: Map<string, {
        names: string[];
        lines: number[];
    }>;
    /** @type {Array<{names:string[],lines:number[]}>} line map of the last resolve */
    lastLineMap: {
        names: string[];
        lines: number[];
    }[];
    /**
     * Register a chunk under the name used by `#include <name>`.
     * @param {string} name
     * @param {string} source
     * @returns {ShaderPreprocessor} this
     */
    registerChunk(name: string, source: string): ShaderPreprocessor;
    /**
     * Remove a chunk from the registry.
     * @param {string} name
     * @returns {boolean} true when a chunk was removed
     */
    unregisterChunk(name: string): boolean;
    /**
     * @param {string} name
     * @returns {boolean}
     */
    hasChunk(name: string): boolean;
    /**
     * @param {string} name
     * @returns {string|null}
     */
    getChunk(name: string): string | null;
    /** @returns {number} number of registered chunks */
    get chunkCount(): number;
    /**
     * Resolve a shader source: expand includes and inject defines.
     *
     * @param {string} source raw shader source, usually starting with `#version 300 es`
     * @param {Object|null} defines map of macro name -> value
     * @param {{stage?:string, extraDefines?:Object, name?:string}} [options]
     *        `stage` may be 'vertex' or 'fragment'; it injects VERTEX_SHADER /
     *        FRAGMENT_SHADER so chunks can guard stage specific built-ins.
     * @returns {string} the fully resolved source
     */
    resolve(source: string, defines?: any | null, options?: {
        stage?: string;
        extraDefines?: any;
        name?: string;
    }): string;
    /**
     * Index of the first line that introduces a declaration, skipping blank lines,
     * line comments and the directives that must stay in front of every declaration.
     * @private
     * @returns {number}
     */
    private _findDeclarationStart;
    /**
     * Expand a block of lines into the output, resolving nested includes.
     * @private
     * @param {number} [endLine] exclusive upper bound, defaults to the whole array
     */
    private _expand;
    /**
     * Resolve one `#include <name>` directive.
     * @private
     */
    private _include;
    /**
     * Append one line to the output, collapsing consecutive blank lines.
     * @private
     */
    private _emit;
    /**
     * Remember the line map of a resolved source, evicting the oldest entry once the
     * budget is exhausted.
     * @private
     */
    private _trackMap;
    /**
     * Translate a line of a resolved source back to the chunk it came from.
     * @param {string} resolvedSource
     * @param {number} lineNumber 1 based line in the resolved source
     * @returns {{file:string, line:number}|null}
     */
    getOrigin(resolvedSource: string, lineNumber: number): {
        file: string;
        line: number;
    } | null;
    /**
     * Turn a driver info log into a readable report with the offending lines, three
     * lines of context on each side and the originating chunk.
     *
     * @param {string} infoLog raw log from getShaderInfoLog / getProgramInfoLog
     * @param {string} resolvedSource the source that was compiled
     * @param {string} [label] optional heading, e.g. 'standard.vertex'
     * @returns {string}
     */
    formatError(infoLog: string, resolvedSource: string, label?: string): string;
    /**
     * Number the lines of a source, for dumping a shader during debugging.
     * @param {string} source
     * @returns {string}
     */
    numberLines(source: string): string;
    /** Drop every tracked line map. Chunks stay registered. */
    clear(): void;
    /** Drop chunks and line maps. */
    dispose(): void;
}
