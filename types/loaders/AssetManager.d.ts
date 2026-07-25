/**
 * @param {string} url
 * @returns {boolean} True for `data:` URIs.
 */
export function isDataURI(url: string): boolean;
/**
 * @param {string} url
 * @returns {boolean} True for URLs that need no base path.
 */
export function isAbsoluteURL(url: string): boolean;
/**
 * Appends a trailing slash when the string is a non-empty directory path.
 * @param {string} path
 * @returns {string}
 */
export function ensureTrailingSlash(path: string): string;
/**
 * Directory part of a URL, slash included. `''` when the URL has no directory.
 * @param {string} url
 * @returns {string}
 */
export function extractBasePath(url: string): string;
/**
 * Resolves a possibly relative URL against a base path.
 *
 * `data:`, `blob:`, absolute and root relative URLs are returned untouched;
 * everything else is concatenated with `basePath` and normalized.
 *
 * @param {string} url
 * @param {string} [basePath='']
 * @returns {string}
 */
export function resolveURL(url: string, basePath?: string): string;
/**
 * Decodes a base64 string into bytes. Uses `atob` when the runtime has it and
 * falls back to a self contained decoder otherwise (zero dependencies).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(text: string): Uint8Array;
/**
 * Encodes a string into UTF-8 bytes without depending on `TextEncoder`.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function textToUint8Array(text: string): Uint8Array;
/**
 * Decodes UTF-8 bytes into a string without depending on `TextDecoder`.
 * @param {ArrayBufferView} bytes
 * @returns {string}
 */
export function uint8ArrayToText(bytes: ArrayBufferView): string;
/**
 * Splits a `data:` URI into its MIME type and its decoded payload.
 * @param {string} uri
 * @returns {{mimeType: string, isBase64: boolean, data: Uint8Array, text: string|null}}
 */
export function parseDataURI(uri: string): {
    mimeType: string;
    isBase64: boolean;
    data: Uint8Array;
    text: string | null;
};
/**
 * Maps a file extension to the asset type the manager should use.
 * @param {string} url
 * @returns {string}
 */
export function guessAssetType(url: string): string;
/**
 * Fetches a URL as bytes, streaming byte level progress when the runtime allows
 * it. Data URIs short-circuit the network entirely.
 *
 * @param {string} url Already resolved URL.
 * @param {Object} [options]
 * @param {string} [options.credentials='same-origin']
 * @param {AbortSignal} [options.signal]
 * @param {(loaded: number, total: number) => void} [options.onBytes]
 * @param {string} [options.label] Name used in error messages.
 * @returns {Promise<Uint8Array>}
 */
export function fetchBytes(url: string, options?: {
    credentials?: string;
    signal?: AbortSignal;
    onBytes?: (loaded: number, total: number) => void;
    label?: string;
}): Promise<Uint8Array>;
/**
 * Fetches a URL as text.
 * @param {string} url
 * @param {Object} [options] See {@link fetchBytes}.
 * @returns {Promise<string>}
 */
export function fetchText(url: string, options?: any): Promise<string>;
/**
 * Fetches a URL and parses it as JSON.
 * @param {string} url
 * @param {Object} [options] See {@link fetchBytes}.
 * @returns {Promise<Object>}
 */
export function fetchJSON(url: string, options?: any): Promise<any>;
/**
 * One cached asset plus its owners.
 * @typedef {Object} AssetEntry
 * @property {string} key
 * @property {string} url
 * @property {string} type
 * @property {*} asset
 * @property {number} refCount
 * @property {number} bytes
 */
export class AssetManager {
    /**
     * @param {WebGL2RenderingContext|null} [gl] Required by the `texture` type.
     * @param {Object} [options]
     * @param {string} [options.basePath=''] Prefix for every relative URL.
     * @param {string} [options.credentials='same-origin']
     * @param {string|null} [options.crossOrigin='anonymous']
     * @param {number} [options.anisotropy=1] Default anisotropy of loaded textures.
     * @param {Object} [options.state] StateCache used when creating textures.
     */
    constructor(gl?: WebGL2RenderingContext | null, options?: {
        basePath?: string;
        credentials?: string;
        crossOrigin?: string | null;
        anisotropy?: number;
        state?: any;
    });
    /** @type {WebGL2RenderingContext|null} */
    gl: WebGL2RenderingContext | null;
    /** @type {string} Prefix applied to every relative URL. */
    basePath: string;
    /** @type {string} */
    credentials: string;
    /** @type {string|null} */
    crossOrigin: string | null;
    /** @type {number} */
    anisotropy: number;
    /** @type {Object|null} */
    state: any | null;
    /** @type {Map<string, AssetEntry>} Cache key -> entry. */
    cache: Map<string, AssetEntry>;
    /** @type {Map<string, {promise: Promise<*>, refs: number}>} Requests in flight. */
    inflight: Map<string, {
        promise: Promise<any>;
        refs: number;
    }>;
    /** @type {Map<string, Function>} Asset type -> handler. */
    loaders: Map<string, Function>;
    /** @type {Array<Function>} Progress listeners. */
    progressCallbacks: Array<Function>;
    /**
     * Aggregated counters. `bytesTotal` only accounts for downloads whose server
     * sent a Content-Length, so treat `progress` as the authoritative number.
     */
    stats: {
        requested: number;
        completed: number;
        failed: number;
        bytesLoaded: number;
        bytesTotal: number;
    };
    /** @type {boolean} */
    disposed: boolean;
    /**
     * Sets the prefix used to resolve relative URLs.
     * @param {string} basePath
     * @returns {AssetManager} this
     */
    setBasePath(basePath: string): AssetManager;
    /**
     * Registers (or replaces) a handler for an asset type.
     * @param {string} type
     * @param {(url: string, options: Object, manager: AssetManager) => Promise<*>} handler
     * @returns {AssetManager} this
     */
    registerType(type: string, handler: (url: string, options: any, manager: AssetManager) => Promise<any>): AssetManager;
    /**
     * Installs the built in handlers. The glTF and OBJ parsers are imported lazily
     * so a project that never touches them never pays for the code.
     * @private
     */
    private _registerDefaultLoaders;
    /**
     * Network options shared by every built in handler.
     * @param {string} url
     * @param {Object|null} options
     * @returns {Object}
     * @private
     */
    private _netOptions;
    /**
     * @param {Object|null} options
     * @returns {Object}
     * @private
     */
    private _imageOptions;
    /**
     * @param {Object|null} options
     * @returns {Object}
     * @private
     */
    private _textureOptions;
    /**
     * Builds the cache key of a request.
     * @param {string} resolvedURL
     * @param {string} type
     * @param {Object|null} options
     * @returns {string}
     * @private
     */
    private _cacheKey;
    /**
     * Resolves the effective type of a request.
     * @param {string} resolvedURL
     * @param {string|null|undefined} type
     * @returns {string}
     * @private
     */
    private _resolveType;
    /**
     * Loads an asset, reusing the cache and coalescing concurrent requests.
     *
     * Every successful call adds one reference; balance it with {@link unload}.
     *
     * @param {string} url Absolute or relative to `basePath`.
     * @param {string} [type] Forces the asset type; guessed from the extension otherwise.
     * @param {Object} [options] Forwarded to the type handler.
     * @returns {Promise<*>}
     */
    load(url: string, type?: string, options?: any): Promise<any>;
    /**
     * Wraps the caller options with the byte progress hook used by the aggregate
     * counters.
     * @param {string} url
     * @param {Object|null} options
     * @returns {Object}
     * @private
     */
    private _withByteProgress;
    /**
     * Loads several assets at once.
     *
     * @param {Array<string|{url: string, type?: string, options?: Object, name?: string}>|Object} urls
     *   An array of URLs / descriptors, or a plain object mapping names to URLs.
     * @param {Object} [options] Default options for every entry.
     * @returns {Promise<Map<string, *>>} Keyed by name when given, by URL otherwise.
     */
    loadMany(urls: Array<string | {
        url: string;
        type?: string;
        options?: any;
        name?: string;
    }> | any, options?: any): Promise<Map<string, any>>;
    /**
     * Returns a cached asset without touching the reference count.
     * @param {string} url
     * @param {string} [type]
     * @param {Object} [options] Only `cacheKey` is read.
     * @returns {*} The asset, or `null`.
     */
    get(url: string, type?: string, options?: any): any;
    /**
     * @param {string} url
     * @param {string} [type]
     * @param {Object} [options]
     * @returns {boolean} True when the asset is already cached.
     */
    has(url: string, type?: string, options?: any): boolean;
    /**
     * Number of live references to an asset.
     * @param {string} url
     * @param {string} [type]
     * @param {Object} [options]
     * @returns {number} 0 when the asset is not cached.
     */
    refCount(url: string, type?: string, options?: any): number;
    /**
     * Releases one reference. The asset is disposed and evicted when the count
     * reaches zero.
     *
     * @param {string} url
     * @param {string} [type]
     * @param {Object} [options] `{ force: true }` evicts regardless of the count.
     * @returns {boolean} True when the asset was evicted.
     */
    unload(url: string, type?: string, options?: any): boolean;
    /**
     * Disposes an asset if it knows how.
     * @param {*} asset
     * @private
     */
    private _disposeAsset;
    /**
     * Registers a progress listener.
     *
     * The callback receives `{ url, type, phase, loaded, total, progress,
     * bytesLoaded, bytesTotal, failed }` where `phase` is `'start'`, `'bytes'`,
     * `'load'` or `'error'`.
     *
     * @param {(info: Object) => void} fn
     * @returns {() => void} Unsubscribe function.
     */
    onProgress(fn: (info: any) => void): () => void;
    /**
     * Removes a progress listener.
     * @param {Function} fn
     * @returns {AssetManager} this
     */
    offProgress(fn: Function): AssetManager;
    /**
     * Fraction of the requested assets already resolved (0..1).
     * @returns {number}
     */
    get progress(): number;
    /** @returns {number} Requests still running. */
    get pending(): number;
    /** @returns {number} Assets currently cached. */
    get size(): number;
    /**
     * @param {string} url
     * @param {string|null} type
     * @param {string} phase
     * @private
     */
    private _emitProgress;
    /** Zeroes the aggregated counters (useful between loading screens). */
    resetStats(): AssetManager;
    /**
     * Disposes every cached asset and refuses further loads.
     * @returns {AssetManager} this
     */
    dispose(): AssetManager;
}
/**
 * One cached asset plus its owners.
 */
export type AssetEntry = {
    key: string;
    url: string;
    type: string;
    asset: any;
    refCount: number;
    bytes: number;
};
