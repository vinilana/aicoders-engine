/**
 * Register whatever programs a shader module exposes.
 *
 * @param {Object} shaderLib target ShaderLib
 * @param {string} moduleName name used when the module does not provide one
 * @param {Object|null} shaderModule
 * @returns {string[]} the names that were registered
 */
export function applyShaderModule(shaderLib: any, moduleName: string, shaderModule: any | null): string[];
/**
 * Inject an already imported shader module, bypassing the dynamic load. Useful for
 * tests and for bundling setups that prefer static imports everywhere.
 *
 * @param {string} moduleName one of OPTIONAL_SHADER_NAMES (any name is accepted)
 * @param {Object} shaderModule
 * @param {Object} [shaderLib] register it immediately on this library
 * @returns {void}
 */
export function registerShaderModule(moduleName: string, shaderModule: any, shaderLib?: any): void;
/**
 * Teach the registry how to fetch an optional shader module. The loader is a
 * function returning a promise, normally `() => import('./my-shaders.js')` written
 * in the module that owns those shaders, so the specifier stays local to it.
 *
 * @param {string} moduleName
 * @param {function(): Promise<Object>} loader
 * @returns {void}
 */
export function registerOptionalShaderLoader(moduleName: string, loader: () => Promise<any>): void;
/**
 * Register the four core programs. Always synchronous, never throws for a missing
 * optional module.
 *
 * @param {Object} shaderLib
 * @returns {string[]} the names that were registered
 */
export function registerCoreShaders(shaderLib: any): string[];
/**
 * Load and register every optional shader module. Failures are collected, never
 * thrown; the returned promise always resolves.
 *
 * @param {Object} shaderLib
 * @returns {Promise<string[]>} names of the programs that got registered
 */
export function loadOptionalShaders(shaderLib: any): Promise<string[]>;
/**
 * Register every shader program known to the engine.
 *
 * The core programs are live as soon as this returns. The optional modules are
 * fetched in the background unless `options.optional` is false; await
 * `shaderModulesReady()` when their availability matters.
 *
 * A synchronous `shadow` fallback backed by the depth pass is installed straight
 * away so nothing downstream can fail on a missing program; the real `shadow`
 * module replaces it as soon as it lands.
 *
 * @param {Object} shaderLib
 * @param {{optional?:boolean, fallbacks?:boolean}} [options]
 * @returns {Object} the same shader library
 */
export function registerAllShaders(shaderLib: any, options?: {
    optional?: boolean;
    fallbacks?: boolean;
}): any;
/**
 * Register everything and wait for the optional modules to settle.
 * @param {Object} shaderLib
 * @returns {Promise<Object>} the same shader library
 */
export function registerAllShadersAsync(shaderLib: any): Promise<any>;
/**
 * Promise that settles once the optional modules have been resolved. Resolves
 * immediately when `registerAllShaders` has not started a load yet.
 * @returns {Promise<string[]>}
 */
export function shaderModulesReady(): Promise<string[]>;
/**
 * Snapshot of which optional modules loaded, which are missing and why.
 * @returns {{loaded:string[], missing:string[], failed:Object}}
 */
export function optionalShaderStatus(): {
    loaded: string[];
    missing: string[];
    failed: any;
};
/** Programs registered synchronously from this directory's own modules. */
export const CORE_SHADER_NAMES: string[];
/**
 * Programs expected from the sibling modules loaded on demand.
 *
 * A name is only fetched when a loader is registered for it below, or when the
 * module is handed over directly with `registerShaderModule()`. `debug` has no
 * built in loader on purpose: the debug line and point programs are owned by
 * DebugRenderer, which registers them itself; the slot stays listed here so that
 * wiring one up later is a single `registerOptionalShaderLoader()` call.
 */
export const OPTIONAL_SHADER_NAMES: string[];
import * as standardShader from "./standard.js";
import * as unlitShader from "./unlit.js";
import * as skyShader from "./sky.js";
import * as depthShader from "./depth.js";
export { standardShader, unlitShader, skyShader, depthShader };
