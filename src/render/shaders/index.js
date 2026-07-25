/**
 * Registry of every complete shader program.
 *
 * Four programs are owned by this directory's core modules and are imported
 * statically, so `registerAllShaders()` is synchronous and deterministic:
 * `standard`, `unlit`, `sky` and `depth` (plus the `depthShadow` variant).
 *
 * The remaining programs - `shadow`, `post`, `ibl` and `debug` - live in sibling
 * modules that are pulled in with `import()` and are therefore optional: a missing
 * or broken module degrades to a warning instead of taking the whole engine down
 * with an unresolvable module specifier. Because that load is asynchronous, callers
 * that need every program before the first frame should await
 * `registerAllShadersAsync()` (or `shaderModulesReady()`), which is what
 * Renderer.compile() is expected to do.
 *
 * A shader module is recognised in three shapes, checked in this order:
 *   1. `export function register(shaderLib)`      - full control, preferred
 *   2. `export const vertex / fragment`           - a single program, named after
 *                                                   `export const name` or the module
 *   3. `export const shaders = { name: {vertex, fragment} }` - several programs
 */
import * as standardShader from './standard.js';
import * as unlitShader from './unlit.js';
import * as skyShader from './sky.js';
import * as depthShader from './depth.js';

/** Programs registered synchronously from this directory's own modules. */
export const CORE_SHADER_NAMES = ['standard', 'unlit', 'sky', 'depth', 'depthShadow'];

/**
 * Programs expected from the sibling modules loaded on demand.
 *
 * A name is only fetched when a loader is registered for it below, or when the
 * module is handed over directly with `registerShaderModule()`. `debug` has no
 * built in loader on purpose: the debug line and point programs are owned by
 * DebugRenderer, which registers them itself; the slot stays listed here so that
 * wiring one up later is a single `registerOptionalShaderLoader()` call.
 */
export const OPTIONAL_SHADER_NAMES = ['shadow', 'post', 'ibl', 'debug'];

/** Core modules, in registration order. */
const CORE_MODULES = [
  ['standard', standardShader],
  ['unlit', unlitShader],
  ['sky', skyShader],
  ['depth', depthShader]
];

/** @type {Map<string, Object>} optional modules already resolved or injected. */
const _loadedModules = new Map();

/** @type {Promise<string[]>|null} memoised optional module load. */
let _loadPromise = null;

/** @type {{loaded: string[], missing: string[], failed: Object}} */
const _status = { loaded: [], missing: [], failed: {} };

/**
 * Report a non fatal problem. Console access is deliberate and lazy: the module
 * scope must stay free of side effects and of any environment assumption.
 * @param {string} message
 * @param {*} [detail]
 */
function warn(message, detail) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    if (detail === undefined) console.warn(message);
    else console.warn(message, detail);
  }
}

/**
 * Register whatever programs a shader module exposes.
 *
 * @param {Object} shaderLib target ShaderLib
 * @param {string} moduleName name used when the module does not provide one
 * @param {Object|null} shaderModule
 * @returns {string[]} the names that were registered
 */
export function applyShaderModule(shaderLib, moduleName, shaderModule) {
  const registered = [];
  if (!shaderModule) return registered;

  // 1. an explicit register() hook owns the whole job.
  if (typeof shaderModule.register === 'function') {
    shaderModule.register(shaderLib);
    if (typeof shaderModule.name === 'string' && shaderModule.name.length > 0) {
      registered.push(shaderModule.name);
    } else {
      registered.push(moduleName);
    }
    return registered;
  }

  // 2. a bare (vertex, fragment) pair.
  if (typeof shaderModule.vertex === 'string' && typeof shaderModule.fragment === 'string') {
    const name = typeof shaderModule.name === 'string' && shaderModule.name.length > 0
      ? shaderModule.name
      : moduleName;
    shaderLib.register(name, {
      vertex: shaderModule.vertex,
      fragment: shaderModule.fragment,
      defines: shaderModule.defines || null
    });
    registered.push(name);
    return registered;
  }

  // 3. a table of programs.
  const table = shaderModule.shaders || shaderModule.SHADERS;
  if (table) {
    for (const key in table) {
      const entry = table[key];
      if (!entry || typeof entry.vertex !== 'string' || typeof entry.fragment !== 'string') continue;
      shaderLib.register(key, {
        vertex: entry.vertex,
        fragment: entry.fragment,
        defines: entry.defines || null
      });
      registered.push(key);
    }
    return registered;
  }

  warn('registerAllShaders: o modulo de shader "' + moduleName + '" nao expoe register(), (vertex, fragment) nem shaders{}.');
  return registered;
}

/**
 * Inject an already imported shader module, bypassing the dynamic load. Useful for
 * tests and for bundling setups that prefer static imports everywhere.
 *
 * @param {string} moduleName one of OPTIONAL_SHADER_NAMES (any name is accepted)
 * @param {Object} shaderModule
 * @param {Object} [shaderLib] register it immediately on this library
 * @returns {void}
 */
export function registerShaderModule(moduleName, shaderModule, shaderLib = null) {
  _loadedModules.set(moduleName, shaderModule);
  if (_status.loaded.indexOf(moduleName) < 0) _status.loaded.push(moduleName);
  const missingIndex = _status.missing.indexOf(moduleName);
  if (missingIndex >= 0) _status.missing.splice(missingIndex, 1);
  delete _status.failed[moduleName];
  if (shaderLib) applyShaderModule(shaderLib, moduleName, shaderModule);
}

/**
 * Loader per optional module. Every specifier is spelled out literally so the
 * module graph stays statically analysable by the import checker and by any
 * bundler the user might add later.
 * @type {Map<string, function(): Promise<Object>>}
 */
const _loaders = new Map([
  ['shadow', () => import('./shadow.js')],
  ['post', () => import('./post.js')],
  ['ibl', () => import('./ibl.js')]
]);

/**
 * Teach the registry how to fetch an optional shader module. The loader is a
 * function returning a promise, normally `() => import('./my-shaders.js')` written
 * in the module that owns those shaders, so the specifier stays local to it.
 *
 * @param {string} moduleName
 * @param {function(): Promise<Object>} loader
 * @returns {void}
 */
export function registerOptionalShaderLoader(moduleName, loader) {
  if (typeof loader !== 'function') {
    throw new Error('registerOptionalShaderLoader: "' + moduleName + '" precisa de uma funcao loader.');
  }
  _loaders.set(moduleName, loader);
  if (OPTIONAL_SHADER_NAMES.indexOf(moduleName) < 0) OPTIONAL_SHADER_NAMES.push(moduleName);
  _loadedModules.delete(moduleName);
}

/**
 * Register the four core programs. Always synchronous, never throws for a missing
 * optional module.
 *
 * @param {Object} shaderLib
 * @returns {string[]} the names that were registered
 */
export function registerCoreShaders(shaderLib) {
  if (!shaderLib || typeof shaderLib.register !== 'function') {
    throw new Error('registerAllShaders: um ShaderLib valido e obrigatorio.');
  }
  const registered = [];
  for (let i = 0, n = CORE_MODULES.length; i < n; i++) {
    const names = applyShaderModule(shaderLib, CORE_MODULES[i][0], CORE_MODULES[i][1]);
    for (let k = 0; k < names.length; k++) registered.push(names[k]);
  }
  // depth.js registers both permutations; make sure the list reflects that.
  if (shaderLib.has('depthShadow') && registered.indexOf('depthShadow') < 0) {
    registered.push('depthShadow');
  }
  return registered;
}

/**
 * Stand in for a missing `shadow` program: the depth pass already does exactly
 * what a shadow map needs (transform, alpha clip, write depth only).
 * @param {Object} shaderLib
 * @returns {boolean} true when the fallback was installed
 */
function installShadowFallback(shaderLib) {
  if (shaderLib.has('shadow')) return false;
  shaderLib.register('shadow', { vertex: depthShader.vertex, fragment: depthShader.fragment });
  return true;
}

/**
 * Load and register every optional shader module. Failures are collected, never
 * thrown; the returned promise always resolves.
 *
 * @param {Object} shaderLib
 * @returns {Promise<string[]>} names of the programs that got registered
 */
export function loadOptionalShaders(shaderLib) {
  const registered = [];
  const pending = [];

  for (let i = 0, n = OPTIONAL_SHADER_NAMES.length; i < n; i++) {
    const moduleName = OPTIONAL_SHADER_NAMES[i];
    const cached = _loadedModules.get(moduleName);
    if (cached !== undefined) {
      const names = applyShaderModule(shaderLib, moduleName, cached);
      for (let k = 0; k < names.length; k++) registered.push(names[k]);
      continue;
    }

    const loader = _loaders.get(moduleName);
    if (loader === undefined) {
      // No loader and nothing injected: an expected state, not a failure.
      if (_status.missing.indexOf(moduleName) < 0) _status.missing.push(moduleName);
      continue;
    }

    pending.push(
      Promise.resolve().then(loader).then(
        (shaderModule) => {
          _loadedModules.set(moduleName, shaderModule);
          if (_status.loaded.indexOf(moduleName) < 0) _status.loaded.push(moduleName);
          const names = applyShaderModule(shaderLib, moduleName, shaderModule);
          for (let k = 0; k < names.length; k++) registered.push(names[k]);
        },
        (error) => {
          if (_status.missing.indexOf(moduleName) < 0) _status.missing.push(moduleName);
          _status.failed[moduleName] = error && error.message ? error.message : String(error);
          warn(
            'registerAllShaders: o modulo de shader opcional "' + moduleName +
            '" nao pode ser carregado; o programa correspondente ficara indisponivel. ' +
            _status.failed[moduleName]
          );
        }
      )
    );
  }

  return Promise.all(pending).then(() => {
    // Last resort so a scene with shadows still renders something sensible.
    if (installShadowFallback(shaderLib)) registered.push('shadow');
    return registered;
  });
}

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
export function registerAllShaders(shaderLib, options = null) {
  registerCoreShaders(shaderLib);

  const wantOptional = !(options && options.optional === false);
  const wantFallbacks = !(options && options.fallbacks === false);

  if (wantOptional) {
    // Memoised so several renderers sharing a library do not race each other.
    _loadPromise = loadOptionalShaders(shaderLib);
    _loadPromise.catch(() => {});
  }

  if (wantFallbacks) installShadowFallback(shaderLib);

  return shaderLib;
}

/**
 * Register everything and wait for the optional modules to settle.
 * @param {Object} shaderLib
 * @returns {Promise<Object>} the same shader library
 */
export function registerAllShadersAsync(shaderLib) {
  registerCoreShaders(shaderLib);
  _loadPromise = loadOptionalShaders(shaderLib);
  return _loadPromise.then(() => shaderLib);
}

/**
 * Promise that settles once the optional modules have been resolved. Resolves
 * immediately when `registerAllShaders` has not started a load yet.
 * @returns {Promise<string[]>}
 */
export function shaderModulesReady() {
  return _loadPromise === null ? Promise.resolve([]) : _loadPromise;
}

/**
 * Snapshot of which optional modules loaded, which are missing and why.
 * @returns {{loaded:string[], missing:string[], failed:Object}}
 */
export function optionalShaderStatus() {
  return {
    loaded: _status.loaded.slice(),
    missing: _status.missing.slice(),
    failed: Object.assign({}, _status.failed)
  };
}

export { standardShader, unlitShader, skyShader, depthShader };
