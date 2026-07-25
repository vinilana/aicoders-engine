/**
 * Asset cache and download orchestrator.
 *
 * Three properties make this class worth having over a bare `fetch`:
 *
 *  - **Reference counted cache.** Two systems can ask for the same texture and
 *    each release it independently; the GPU resource dies exactly once, when the
 *    last owner lets go.
 *  - **In-flight de-duplication.** Ten meshes asking for the same normal map
 *    during the same frame produce one network request and ten handles to the
 *    same promise.
 *  - **Aggregated progress.** Every download reports item and byte progress
 *    through a single callback, which is what a loading screen actually needs.
 *
 * The URL helpers exported alongside it (`resolveURL`, `extractBasePath`,
 * `parseDataURI`, ...) are the ones the glTF and OBJ loaders use, so relative
 * paths resolve identically no matter which entry point started the load.
 */

import { Logger } from '../core/Logger.js';
import { loadImageSource, loadTexture, extensionOf, disposeImage } from './ImageLoader.js';

/** Matches `scheme://` and protocol relative `//host/...`. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** Base64 alphabet, used by the dependency free decoder fallback. */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup table for {@link base64ToUint8Array}, built on first use. */
let _base64Lookup = null;

/* ------------------------------------------------------------------------ */
/* URL utilities                                                             */
/* ------------------------------------------------------------------------ */

/**
 * @param {string} url
 * @returns {boolean} True for `data:` URIs.
 */
export function isDataURI(url) {
  return typeof url === 'string' && url.lastIndexOf('data:', 0) === 0;
}

/**
 * @param {string} url
 * @returns {boolean} True for URLs that need no base path.
 */
export function isAbsoluteURL(url) {
  if (typeof url !== 'string' || url === '') return false;
  if (isDataURI(url)) return true;
  if (url.lastIndexOf('blob:', 0) === 0) return true;
  return ABSOLUTE_URL.test(url);
}

/**
 * Collapses `.` and `..` segments while preserving the `scheme://authority`
 * prefix and any query/hash suffix.
 * @param {string} path
 * @returns {string}
 */
function normalizePath(path) {
  let suffix = '';
  const cut = path.search(/[?#]/);
  if (cut >= 0) {
    suffix = path.slice(cut);
    path = path.slice(0, cut);
  }

  let prefix = '';
  const schemeEnd = path.indexOf('://');
  if (schemeEnd >= 0) {
    const authorityEnd = path.indexOf('/', schemeEnd + 3);
    if (authorityEnd < 0) return path + suffix;
    prefix = path.slice(0, authorityEnd + 1);
    path = path.slice(authorityEnd + 1);
  } else if (path.charCodeAt(0) === 47) {
    prefix = '/';
    path = path.slice(1);
  }

  const parts = path.split('/');
  const out = [];
  let lastWasDots = false;
  for (let i = 0, n = parts.length; i < n; i++) {
    const part = parts[i];
    if (part === '.') {
      lastWasDots = true;
      continue;
    }
    if (part === '..') {
      lastWasDots = true;
      const top = out.length > 0 ? out[out.length - 1] : null;
      if (top !== null && top !== '..' && top !== '') out.pop();
      else out.push('..');
      continue;
    }
    lastWasDots = false;
    out.push(part);
  }
  // `a/b/..` must keep behaving like a directory.
  if (lastWasDots && (out.length === 0 || out[out.length - 1] !== '')) out.push('');

  return prefix + out.join('/') + suffix;
}

/**
 * Appends a trailing slash when the string is a non-empty directory path.
 * @param {string} path
 * @returns {string}
 */
export function ensureTrailingSlash(path) {
  if (typeof path !== 'string' || path === '') return '';
  return path.charAt(path.length - 1) === '/' ? path : path + '/';
}

/**
 * Directory part of a URL, slash included. `''` when the URL has no directory.
 * @param {string} url
 * @returns {string}
 */
export function extractBasePath(url) {
  if (typeof url !== 'string' || url === '') return '';
  let end = url.length;
  const cut = url.search(/[?#]/);
  if (cut >= 0) end = cut;
  const slash = url.lastIndexOf('/', end - 1);
  if (slash < 0) return '';
  return url.slice(0, slash + 1);
}

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
export function resolveURL(url, basePath = '') {
  if (typeof url !== 'string' || url === '') return '';
  if (isAbsoluteURL(url)) return url;
  if (url.charCodeAt(0) === 47) return url; // '/absolute/path'
  if (!basePath) return normalizePath(url);
  return normalizePath(ensureTrailingSlash(basePath) + url);
}

/**
 * Decodes a base64 string into bytes. Uses `atob` when the runtime has it and
 * falls back to a self contained decoder otherwise (zero dependencies).
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(text) {
  const clean = text.replace(/[\r\n\t ]/g, '');
  const decode = globalThis.atob;
  if (typeof decode === 'function') {
    const binary = decode(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0, n = binary.length; i < n; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  if (_base64Lookup === null) {
    _base64Lookup = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) _base64Lookup[BASE64_CHARS.charCodeAt(i)] = i;
    _base64Lookup[61] = -2; // '='
  }
  const lookup = _base64Lookup;

  let padding = 0;
  if (clean.charCodeAt(clean.length - 1) === 61) padding++;
  if (clean.charCodeAt(clean.length - 2) === 61) padding++;
  const out = new Uint8Array(((clean.length * 3) >> 2) - padding);

  let acc = 0;
  let bits = 0;
  let w = 0;
  for (let i = 0, n = clean.length; i < n; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? lookup[code] : -1;
    if (value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (w < out.length) out[w++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Encodes a string into UTF-8 bytes without depending on `TextEncoder`.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function textToUint8Array(text) {
  const Encoder = globalThis.TextEncoder;
  if (typeof Encoder === 'function') return new Encoder().encode(text);

  const out = new Uint8Array(text.length * 4);
  let w = 0;
  for (let i = 0, n = text.length; i < n; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out[w++] = code;
    } else if (code < 0x800) {
      out[w++] = 0xc0 | (code >> 6);
      out[w++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[w++] = 0xe0 | (code >> 12);
      out[w++] = 0x80 | ((code >> 6) & 0x3f);
      out[w++] = 0x80 | (code & 0x3f);
    } else {
      out[w++] = 0xf0 | (code >> 18);
      out[w++] = 0x80 | ((code >> 12) & 0x3f);
      out[w++] = 0x80 | ((code >> 6) & 0x3f);
      out[w++] = 0x80 | (code & 0x3f);
    }
  }
  return out.subarray(0, w);
}

/**
 * Decodes UTF-8 bytes into a string without depending on `TextDecoder`.
 * @param {ArrayBufferView} bytes
 * @returns {string}
 */
export function uint8ArrayToText(bytes) {
  const Decoder = globalThis.TextDecoder;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof Decoder === 'function') return new Decoder('utf-8').decode(view);

  // Manual UTF-8 decode, chunked so a large buffer never blows the argument limit.
  let result = '';
  const chunk = [];
  for (let i = 0, n = view.length; i < n;) {
    const b0 = view[i++];
    let code;
    if (b0 < 0x80) {
      code = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = ((b0 & 0x1f) << 6) | (view[i++] & 0x3f);
    } else if ((b0 & 0xf0) === 0xe0) {
      code = ((b0 & 0x0f) << 12) | ((view[i++] & 0x3f) << 6) | (view[i++] & 0x3f);
    } else {
      code = ((b0 & 0x07) << 18) | ((view[i++] & 0x3f) << 12) | ((view[i++] & 0x3f) << 6) | (view[i++] & 0x3f);
    }
    if (code > 0xffff) {
      code -= 0x10000;
      chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      chunk.push(code);
    }
    if (chunk.length >= 8192) {
      result += String.fromCharCode.apply(null, chunk);
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) result += String.fromCharCode.apply(null, chunk);
  return result;
}

/**
 * Splits a `data:` URI into its MIME type and its decoded payload.
 * @param {string} uri
 * @returns {{mimeType: string, isBase64: boolean, data: Uint8Array, text: string|null}}
 */
export function parseDataURI(uri) {
  if (!isDataURI(uri)) {
    throw new Error('AssetManager: "' + String(uri).slice(0, 48) + '" nao e uma data URI.');
  }
  const comma = uri.indexOf(',');
  if (comma < 0) {
    throw new Error('AssetManager: data URI malformada (virgula separadora ausente).');
  }
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = /(^|;)base64($|;)/i.test(header);
  const semi = header.indexOf(';');
  const mimeType = (semi < 0 ? header : header.slice(0, semi)) || 'text/plain';

  if (isBase64) {
    return { mimeType, isBase64: true, data: base64ToUint8Array(payload), text: null };
  }
  let text;
  try {
    text = decodeURIComponent(payload);
  } catch (err) {
    text = payload;
  }
  return { mimeType, isBase64: false, data: textToUint8Array(text), text };
}

/**
 * Maps a file extension to the asset type the manager should use.
 * @param {string} url
 * @returns {string}
 */
export function guessAssetType(url) {
  switch (extensionOf(url)) {
    case 'gltf':
    case 'glb':
      return 'gltf';
    case 'obj':
      return 'obj';
    case 'mtl':
    case 'txt':
    case 'glsl':
    case 'vert':
    case 'frag':
    case 'csv':
      return 'text';
    case 'json':
      return 'json';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'jpe':
    case 'webp':
    case 'gif':
    case 'bmp':
    case 'avif':
      return 'texture';
    default:
      return 'arraybuffer';
  }
}

/* ------------------------------------------------------------------------ */
/* Networking                                                                */
/* ------------------------------------------------------------------------ */

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
export async function fetchBytes(url, options = {}) {
  const label = options.label || url;
  if (isDataURI(url)) return parseDataURI(url).data;

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('AssetManager: fetch indisponivel neste ambiente; nao foi possivel baixar "' + label + '".');
  }

  let response;
  try {
    response = await globalThis.fetch(url, {
      credentials: options.credentials || 'same-origin',
      signal: options.signal
    });
  } catch (err) {
    throw new Error(
      'AssetManager: falha de rede ao baixar "' + label + '": ' + (err && err.message ? err.message : String(err))
    );
  }
  if (!response.ok) {
    throw new Error(
      'AssetManager: erro HTTP ' + response.status + ' (' + (response.statusText || 'sem descricao') +
      ') ao baixar "' + label + '".'
    );
  }

  const header = response.headers && response.headers.get ? response.headers.get('content-length') : null;
  const total = header ? parseInt(header, 10) : 0;

  const onBytes = options.onBytes;
  if (typeof onBytes !== 'function' || !response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (typeof onBytes === 'function') onBytes(buffer.byteLength, total || buffer.byteLength);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    chunks.push(chunk);
    loaded += chunk.byteLength;
    onBytes(loaded, total || 0);
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (let i = 0, n = chunks.length; i < n; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

/**
 * Fetches a URL as text.
 * @param {string} url
 * @param {Object} [options] See {@link fetchBytes}.
 * @returns {Promise<string>}
 */
export async function fetchText(url, options = {}) {
  if (isDataURI(url)) {
    const parsed = parseDataURI(url);
    return parsed.text !== null ? parsed.text : uint8ArrayToText(parsed.data);
  }
  const bytes = await fetchBytes(url, options);
  return uint8ArrayToText(bytes);
}

/**
 * Fetches a URL and parses it as JSON.
 * @param {string} url
 * @param {Object} [options] See {@link fetchBytes}.
 * @returns {Promise<Object>}
 */
export async function fetchJSON(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      'AssetManager: "' + (options.label || url) + '" nao contem JSON valido: ' +
      (err && err.message ? err.message : String(err))
    );
  }
}

/* ------------------------------------------------------------------------ */
/* AssetManager                                                              */
/* ------------------------------------------------------------------------ */

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
  constructor(gl = null, options = {}) {
    /** @type {WebGL2RenderingContext|null} */
    this.gl = gl || null;
    /** @type {string} Prefix applied to every relative URL. */
    this.basePath = options.basePath ? ensureTrailingSlash(options.basePath) : '';
    /** @type {string} */
    this.credentials = options.credentials || 'same-origin';
    /** @type {string|null} */
    this.crossOrigin = options.crossOrigin !== undefined ? options.crossOrigin : 'anonymous';
    /** @type {number} */
    this.anisotropy = options.anisotropy !== undefined ? options.anisotropy : 1;
    /** @type {Object|null} */
    this.state = options.state || null;

    /** @type {Map<string, AssetEntry>} Cache key -> entry. */
    this.cache = new Map();
    /** @type {Map<string, {promise: Promise<*>, refs: number}>} Requests in flight. */
    this.inflight = new Map();
    /** @type {Map<string, Function>} Asset type -> handler. */
    this.loaders = new Map();
    /** @type {Array<Function>} Progress listeners. */
    this.progressCallbacks = [];

    /**
     * Aggregated counters. `bytesTotal` only accounts for downloads whose server
     * sent a Content-Length, so treat `progress` as the authoritative number.
     */
    this.stats = {
      requested: 0,
      completed: 0,
      failed: 0,
      bytesLoaded: 0,
      bytesTotal: 0
    };

    /** @type {boolean} */
    this.disposed = false;

    this._registerDefaultLoaders();
  }

  /* --------------------------------------------------------------- config */

  /**
   * Sets the prefix used to resolve relative URLs.
   * @param {string} basePath
   * @returns {AssetManager} this
   */
  setBasePath(basePath) {
    this.basePath = basePath ? ensureTrailingSlash(basePath) : '';
    return this;
  }

  /**
   * Registers (or replaces) a handler for an asset type.
   * @param {string} type
   * @param {(url: string, options: Object, manager: AssetManager) => Promise<*>} handler
   * @returns {AssetManager} this
   */
  registerType(type, handler) {
    if (typeof handler !== 'function') {
      throw new Error('AssetManager.registerType: handler de "' + type + '" precisa ser uma funcao.');
    }
    this.loaders.set(type, handler);
    return this;
  }

  /**
   * Installs the built in handlers. The glTF and OBJ parsers are imported lazily
   * so a project that never touches them never pays for the code.
   * @private
   */
  _registerDefaultLoaders() {
    this.registerType('arraybuffer', (url, options, manager) =>
      fetchBytes(url, manager._netOptions(url, options)).then((bytes) => bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength
      )));

    this.registerType('bytes', (url, options, manager) => fetchBytes(url, manager._netOptions(url, options)));
    this.registerType('binary', (url, options, manager) => fetchBytes(url, manager._netOptions(url, options)));
    this.registerType('text', (url, options, manager) => fetchText(url, manager._netOptions(url, options)));
    this.registerType('json', (url, options, manager) => fetchJSON(url, manager._netOptions(url, options)));

    this.registerType('image', (url, options, manager) =>
      loadImageSource(url, manager._imageOptions(options)).then((source) => source.image));

    this.registerType('texture', (url, options, manager) => {
      if (manager.gl === null) {
        return Promise.reject(new Error(
          'AssetManager: nao e possivel criar a textura "' + url + '" sem um contexto WebGL2 ' +
          '(passe o gl no construtor ou use o tipo "image").'
        ));
      }
      return loadTexture(manager.gl, url, manager._textureOptions(options));
    });

    this.registerType('gltf', async (url, options, manager) => {
      const module = await import('./GLTFLoader.js');
      const loader = new module.GLTFLoader(manager.gl, Object.assign({ manager }, options));
      return loader.load(url);
    });

    this.registerType('obj', async (url, options, manager) => {
      const module = await import('./OBJLoader.js');
      const loader = new module.OBJLoader(manager.gl, Object.assign({ manager }, options));
      return loader.load(url);
    });
  }

  /**
   * Network options shared by every built in handler.
   * @param {string} url
   * @param {Object|null} options
   * @returns {Object}
   * @private
   */
  _netOptions(url, options) {
    const merged = {
      credentials: (options && options.credentials) || this.credentials,
      signal: options ? options.signal : undefined,
      label: url
    };
    if (options && typeof options.onBytes === 'function') merged.onBytes = options.onBytes;
    return merged;
  }

  /**
   * @param {Object|null} options
   * @returns {Object}
   * @private
   */
  _imageOptions(options) {
    const merged = Object.assign({}, options || {});
    if (merged.credentials === undefined) merged.credentials = this.credentials;
    if (merged.crossOrigin === undefined) merged.crossOrigin = this.crossOrigin;
    return merged;
  }

  /**
   * @param {Object|null} options
   * @returns {Object}
   * @private
   */
  _textureOptions(options) {
    const merged = this._imageOptions(options);
    if (merged.anisotropy === undefined) merged.anisotropy = this.anisotropy;
    if (merged.state === undefined && this.state !== null) merged.state = this.state;
    return merged;
  }

  /* ---------------------------------------------------------------- cache */

  /**
   * Builds the cache key of a request.
   * @param {string} resolvedURL
   * @param {string} type
   * @param {Object|null} options
   * @returns {string}
   * @private
   */
  _cacheKey(resolvedURL, type, options) {
    const suffix = options && options.cacheKey ? '|' + options.cacheKey : '';
    return type + '|' + resolvedURL + suffix;
  }

  /**
   * Resolves the effective type of a request.
   * @param {string} resolvedURL
   * @param {string|null|undefined} type
   * @returns {string}
   * @private
   */
  _resolveType(resolvedURL, type) {
    let kind = type || guessAssetType(resolvedURL);
    if (kind === 'texture' && this.gl === null) kind = 'image';
    return kind;
  }

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
  load(url, type, options) {
    if (this.disposed) {
      return Promise.reject(new Error('AssetManager: o gerenciador ja foi descartado (dispose).'));
    }
    if (typeof url !== 'string' || url === '') {
      return Promise.reject(new Error('AssetManager.load: url invalida (' + String(url) + ').'));
    }

    const resolved = resolveURL(url, this.basePath);
    const kind = this._resolveType(resolved, type);
    const key = this._cacheKey(resolved, kind, options);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      cached.refCount++;
      return Promise.resolve(cached.asset);
    }

    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      pending.refs++;
      return pending.promise;
    }

    const handler = this.loaders.get(kind);
    if (handler === undefined) {
      return Promise.reject(new Error(
        'AssetManager: tipo de asset desconhecido "' + kind + '" para "' + resolved + '". ' +
        'Registre-o com registerType() antes de carregar.'
      ));
    }

    const record = { promise: null, refs: 1 };
    this.inflight.set(key, record);
    this.stats.requested++;
    this._emitProgress(resolved, kind, 'start');

    const handlerOptions = this._withByteProgress(resolved, options);

    record.promise = Promise.resolve()
      .then(() => handler(resolved, handlerOptions, this))
      .then((asset) => {
        this.inflight.delete(key);
        if (this.disposed) {
          this._disposeAsset(asset);
          throw new Error('AssetManager: gerenciador descartado durante o carregamento de "' + resolved + '".');
        }
        const entry = {
          key,
          url: resolved,
          type: kind,
          asset,
          refCount: record.refs,
          bytes: handlerOptions._bytes | 0
        };
        this.cache.set(key, entry);
        this.stats.completed++;
        this._emitProgress(resolved, kind, 'load');
        return asset;
      })
      .catch((err) => {
        this.inflight.delete(key);
        this.stats.failed++;
        this._emitProgress(resolved, kind, 'error');
        const message = err && err.message ? err.message : String(err);
        const wrapped = message.lastIndexOf('AssetManager:', 0) === 0 ||
          message.indexOf('Loader:') >= 0
          ? err
          : new Error('AssetManager: falha ao carregar "' + resolved + '" (' + kind + '): ' + message);
        throw wrapped;
      });

    return record.promise;
  }

  /**
   * Wraps the caller options with the byte progress hook used by the aggregate
   * counters.
   * @param {string} url
   * @param {Object|null} options
   * @returns {Object}
   * @private
   */
  _withByteProgress(url, options) {
    const merged = Object.assign({}, options || {});
    const userHook = typeof merged.onBytes === 'function' ? merged.onBytes : null;
    merged._bytes = 0;
    let lastLoaded = 0;
    let countedTotal = 0;
    merged.onBytes = (loaded, total) => {
      this.stats.bytesLoaded += loaded - lastLoaded;
      lastLoaded = loaded;
      merged._bytes = loaded;
      if (total > 0 && total !== countedTotal) {
        this.stats.bytesTotal += total - countedTotal;
        countedTotal = total;
      }
      this._emitProgress(url, null, 'bytes');
      if (userHook !== null) userHook(loaded, total);
    };
    return merged;
  }

  /**
   * Loads several assets at once.
   *
   * @param {Array<string|{url: string, type?: string, options?: Object, name?: string}>|Object} urls
   *   An array of URLs / descriptors, or a plain object mapping names to URLs.
   * @param {Object} [options] Default options for every entry.
   * @returns {Promise<Map<string, *>>} Keyed by name when given, by URL otherwise.
   */
  loadMany(urls, options) {
    const names = [];
    const jobs = [];

    if (Array.isArray(urls)) {
      for (let i = 0, n = urls.length; i < n; i++) {
        const item = urls[i];
        if (typeof item === 'string') {
          names.push(item);
          jobs.push(this.load(item, undefined, options));
        } else if (item && typeof item.url === 'string') {
          names.push(item.name || item.url);
          jobs.push(this.load(item.url, item.type, item.options || options));
        }
      }
    } else if (urls && typeof urls === 'object') {
      for (const name in urls) {
        const item = urls[name];
        names.push(name);
        if (typeof item === 'string') {
          jobs.push(this.load(item, undefined, options));
        } else if (item && typeof item.url === 'string') {
          jobs.push(this.load(item.url, item.type, item.options || options));
        } else {
          jobs.push(Promise.reject(new Error('AssetManager.loadMany: entrada "' + name + '" invalida.')));
        }
      }
    } else {
      return Promise.reject(new Error('AssetManager.loadMany: esperava um array ou um objeto de URLs.'));
    }

    return Promise.all(jobs).then((assets) => {
      const out = new Map();
      for (let i = 0, n = names.length; i < n; i++) out.set(names[i], assets[i]);
      return out;
    });
  }

  /**
   * Returns a cached asset without touching the reference count.
   * @param {string} url
   * @param {string} [type]
   * @param {Object} [options] Only `cacheKey` is read.
   * @returns {*} The asset, or `null`.
   */
  get(url, type, options) {
    const resolved = resolveURL(url, this.basePath);
    const entry = this.cache.get(this._cacheKey(resolved, this._resolveType(resolved, type), options));
    return entry === undefined ? null : entry.asset;
  }

  /**
   * @param {string} url
   * @param {string} [type]
   * @param {Object} [options]
   * @returns {boolean} True when the asset is already cached.
   */
  has(url, type, options) {
    const resolved = resolveURL(url, this.basePath);
    return this.cache.has(this._cacheKey(resolved, this._resolveType(resolved, type), options));
  }

  /**
   * Number of live references to an asset.
   * @param {string} url
   * @param {string} [type]
   * @param {Object} [options]
   * @returns {number} 0 when the asset is not cached.
   */
  refCount(url, type, options) {
    const resolved = resolveURL(url, this.basePath);
    const entry = this.cache.get(this._cacheKey(resolved, this._resolveType(resolved, type), options));
    return entry === undefined ? 0 : entry.refCount;
  }

  /**
   * Releases one reference. The asset is disposed and evicted when the count
   * reaches zero.
   *
   * @param {string} url
   * @param {string} [type]
   * @param {Object} [options] `{ force: true }` evicts regardless of the count.
   * @returns {boolean} True when the asset was evicted.
   */
  unload(url, type, options) {
    const resolved = resolveURL(url, this.basePath);
    const key = this._cacheKey(resolved, this._resolveType(resolved, type), options);
    const entry = this.cache.get(key);
    if (entry === undefined) return false;

    if (options && options.force === true) entry.refCount = 0;
    else entry.refCount--;

    if (entry.refCount > 0) return false;

    this.cache.delete(key);
    this._disposeAsset(entry.asset);
    return true;
  }

  /**
   * Disposes an asset if it knows how.
   * @param {*} asset
   * @private
   */
  _disposeAsset(asset) {
    if (asset === null || asset === undefined) return;
    if (typeof asset.dispose === 'function') {
      try {
        asset.dispose();
      } catch (err) {
        Logger.warn('AssetManager: dispose() do asset falhou: ' + (err && err.message ? err.message : err));
      }
      return;
    }
    if (typeof asset.close === 'function') disposeImage(asset);
  }

  /* ------------------------------------------------------------- progress */

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
  onProgress(fn) {
    if (typeof fn !== 'function') {
      throw new Error('AssetManager.onProgress: esperava uma funcao.');
    }
    this.progressCallbacks.push(fn);
    return () => this.offProgress(fn);
  }

  /**
   * Removes a progress listener.
   * @param {Function} fn
   * @returns {AssetManager} this
   */
  offProgress(fn) {
    const index = this.progressCallbacks.indexOf(fn);
    if (index >= 0) this.progressCallbacks.splice(index, 1);
    return this;
  }

  /**
   * Fraction of the requested assets already resolved (0..1).
   * @returns {number}
   */
  get progress() {
    const done = this.stats.completed + this.stats.failed;
    return this.stats.requested === 0 ? 1 : done / this.stats.requested;
  }

  /** @returns {number} Requests still running. */
  get pending() {
    return this.inflight.size;
  }

  /** @returns {number} Assets currently cached. */
  get size() {
    return this.cache.size;
  }

  /**
   * @param {string} url
   * @param {string|null} type
   * @param {string} phase
   * @private
   */
  _emitProgress(url, type, phase) {
    const listeners = this.progressCallbacks;
    if (listeners.length === 0) return;
    const stats = this.stats;
    const info = {
      url,
      type,
      phase,
      loaded: stats.completed,
      failed: stats.failed,
      total: stats.requested,
      progress: this.progress,
      bytesLoaded: stats.bytesLoaded,
      bytesTotal: stats.bytesTotal
    };
    for (let i = 0, n = listeners.length; i < n; i++) {
      try {
        listeners[i](info);
      } catch (err) {
        Logger.warn('AssetManager: callback de progresso lancou: ' + (err && err.message ? err.message : err));
      }
    }
  }

  /** Zeroes the aggregated counters (useful between loading screens). */
  resetStats() {
    this.stats.requested = this.inflight.size;
    this.stats.completed = 0;
    this.stats.failed = 0;
    this.stats.bytesLoaded = 0;
    this.stats.bytesTotal = 0;
    return this;
  }

  /* -------------------------------------------------------------- teardown */

  /**
   * Disposes every cached asset and refuses further loads.
   * @returns {AssetManager} this
   */
  dispose() {
    this.disposed = true;
    const it = this.cache.values();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      this._disposeAsset(entry.value.asset);
    }
    this.cache.clear();
    this.inflight.clear();
    this.progressCallbacks.length = 0;
    return this;
  }
}
