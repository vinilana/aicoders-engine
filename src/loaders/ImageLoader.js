/**
 * Image decoding helpers.
 *
 * `createImageBitmap` is preferred everywhere it exists: it decodes off the main
 * thread and it is the only API that lets the caller pin down the two things that
 * silently corrupt textures otherwise - the vertical orientation and whether the
 * alpha channel comes back premultiplied. When it is missing (or when the option
 * bag it accepts is an older revision of the spec) the loader degrades, in order,
 * to a plain `createImageBitmap(blob)` and finally to an `HTMLImageElement`.
 *
 * Orientation contract used by the whole engine (and required by glTF): the first
 * row of the decoded image is the row sampled at `v = 0`, i.e. NO flip. Callers
 * that want the OpenGL convention pass `flipY: true` and the flip is baked into
 * the bitmap (never left to `UNPACK_FLIP_Y_WEBGL`, which several drivers ignore
 * for `ImageBitmap` sources).
 */

import { Texture } from '../render/Texture.js';
import { Logger } from '../core/Logger.js';

/** File extension -> MIME type, used when decoding raw bytes. */
const EXTENSION_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ktx2: 'image/ktx2',
  svg: 'image/svg+xml'
};

/** Fallback MIME type when the extension tells us nothing. */
const DEFAULT_MIME = 'image/png';

/**
 * Orientation keyword accepted by this browser, resolved once.
 * `null` = unknown, `''` = the option bag is not supported at all.
 * @type {string|null}
 */
let _orientationKeyword = null;

/**
 * Extracts the lowercase extension of a URL, ignoring the query and the hash.
 * @param {string} url
 * @returns {string} Extension without the dot, or an empty string.
 */
export function extensionOf(url) {
  if (typeof url !== 'string') return '';
  let end = url.length;
  const q = url.indexOf('?');
  if (q >= 0 && q < end) end = q;
  const h = url.indexOf('#');
  if (h >= 0 && h < end) end = h;
  const slash = url.lastIndexOf('/', end - 1);
  const dot = url.lastIndexOf('.', end - 1);
  if (dot < 0 || dot < slash) return '';
  return url.slice(dot + 1, end).toLowerCase();
}

/**
 * Guesses the MIME type of an image from its URL.
 * @param {string} url
 * @returns {string} A MIME type (never empty).
 */
export function mimeTypeFromURL(url) {
  const mime = EXTENSION_MIME[extensionOf(url)];
  return mime === undefined ? DEFAULT_MIME : mime;
}

/**
 * True when the runtime exposes `createImageBitmap`.
 * @returns {boolean}
 */
export function isImageBitmapSupported() {
  return typeof globalThis.createImageBitmap === 'function';
}

/**
 * Pixel width of any image-like source.
 * @param {Object} image
 * @returns {number}
 */
export function imageWidth(image) {
  if (!image) return 0;
  return (image.naturalWidth || image.videoWidth || image.width || 0) | 0;
}

/**
 * Pixel height of any image-like source.
 * @param {Object} image
 * @returns {number}
 */
export function imageHeight(image) {
  if (!image) return 0;
  return (image.naturalHeight || image.videoHeight || image.height || 0) | 0;
}

/**
 * Releases an `ImageBitmap` (a no-op for every other source). Bitmaps keep their
 * decoded pixels alive until closed, so this matters for big models.
 * @param {Object} image
 */
export function disposeImage(image) {
  if (image && typeof image.close === 'function') {
    try {
      image.close();
    } catch (err) {
      // A bitmap that was already transferred/closed throws; nothing to do.
    }
  }
}

/**
 * Builds the option bag handed to `createImageBitmap` for a given orientation
 * keyword.
 * @param {string} orientation `'from-image'` | `'none'` | `'flipY'`
 * @param {boolean} flipY
 * @param {boolean} premultiplyAlpha
 * @returns {Object}
 */
function bitmapOptions(orientation, flipY, premultiplyAlpha) {
  return {
    imageOrientation: flipY ? 'flipY' : orientation,
    premultiplyAlpha: premultiplyAlpha ? 'premultiply' : 'none',
    colorSpaceConversion: 'none'
  };
}

/**
 * Decodes a Blob into an `ImageBitmap`, negotiating the option bag revision the
 * browser understands. The successful keyword is memoized so the negotiation
 * happens at most once per session.
 *
 * @param {Blob} blob
 * @param {Object} [options]
 * @param {boolean} [options.flipY=false] Bake a vertical flip into the bitmap.
 * @param {boolean} [options.premultiplyAlpha=false] Premultiply the alpha channel.
 * @param {string} [options.label] Name used in error messages.
 * @returns {Promise<ImageBitmap>}
 */
export async function decodeBlobToBitmap(blob, options = {}) {
  const create = globalThis.createImageBitmap;
  const label = options.label || 'imagem';
  if (typeof create !== 'function') {
    throw new Error('ImageLoader: createImageBitmap indisponivel neste ambiente (' + label + ').');
  }

  const flipY = options.flipY === true;
  const premultiply = options.premultiplyAlpha === true;

  if (_orientationKeyword !== null) {
    if (_orientationKeyword === '') return create(blob);
    return create(blob, bitmapOptions(_orientationKeyword, flipY, premultiply));
  }

  // First call of the session: probe the accepted spellings, newest first.
  const candidates = ['from-image', 'none'];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const bitmap = await create(blob, bitmapOptions(candidates[i], flipY, premultiply));
      _orientationKeyword = candidates[i];
      return bitmap;
    } catch (err) {
      // Fall through and try the next spelling.
    }
  }

  try {
    const bitmap = await create(blob);
    _orientationKeyword = '';
    if (flipY) {
      Logger.warnOnce(
        'ImageLoader.noOrientation',
        'ImageLoader: este navegador ignora imageOrientation; flipY nao pode ser aplicado no decode.'
      );
    }
    return bitmap;
  } catch (err) {
    throw new Error(
      'ImageLoader: falha ao decodificar "' + label + '": ' + (err && err.message ? err.message : String(err))
    );
  }
}

/**
 * Wraps raw bytes into a Blob.
 * @param {ArrayBuffer|ArrayBufferView|Blob} source
 * @param {string} mimeType
 * @returns {Blob}
 */
export function toBlob(source, mimeType) {
  if (typeof globalThis.Blob !== 'function') {
    throw new Error('ImageLoader: Blob indisponivel neste ambiente.');
  }
  if (source instanceof globalThis.Blob) return source;
  const type = mimeType || DEFAULT_MIME;
  if (ArrayBuffer.isView(source)) {
    // Slice so the Blob never keeps a whole multi-megabyte glTF buffer alive.
    return new globalThis.Blob(
      [source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)],
      { type }
    );
  }
  return new globalThis.Blob([source], { type });
}

/**
 * Loads a URL as an `ImageBitmap`.
 *
 * @param {string} url Absolute or already resolved URL (data: URIs work too).
 * @param {Object} [options]
 * @param {boolean} [options.flipY=false]
 * @param {boolean} [options.premultiplyAlpha=false]
 * @param {string} [options.credentials='same-origin'] Fetch credentials mode.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<ImageBitmap>}
 */
export async function loadImageBitmap(url, options = {}) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('ImageLoader: fetch indisponivel; nao foi possivel baixar "' + url + '".');
  }
  let response;
  try {
    response = await globalThis.fetch(url, {
      credentials: options.credentials || 'same-origin',
      signal: options.signal
    });
  } catch (err) {
    throw new Error(
      'ImageLoader: falha de rede ao baixar a imagem "' + url + '": ' +
      (err && err.message ? err.message : String(err))
    );
  }
  if (!response.ok) {
    throw new Error(
      'ImageLoader: erro HTTP ' + response.status + ' (' + response.statusText + ') ao baixar a imagem "' + url + '".'
    );
  }
  const blob = await response.blob();
  return decodeBlobToBitmap(blob, {
    flipY: options.flipY,
    premultiplyAlpha: options.premultiplyAlpha,
    label: url
  });
}

/**
 * Loads a URL into an `HTMLImageElement`. Used as the fallback path and for
 * cross-origin images that an `<img>` tag can reach but `fetch` cannot.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string|null} [options.crossOrigin='anonymous'] `null` disables the attribute.
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ImageCtor = globalThis.Image;
    if (typeof ImageCtor !== 'function') {
      reject(new Error('ImageLoader: HTMLImageElement indisponivel; nao foi possivel carregar "' + url + '".'));
      return;
    }

    const image = new ImageCtor();
    const inlineSource = url.lastIndexOf('data:', 0) === 0 || url.lastIndexOf('blob:', 0) === 0;
    if (!inlineSource && options.crossOrigin !== null) {
      image.crossOrigin = options.crossOrigin === undefined ? 'anonymous' : options.crossOrigin;
    }

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };

    image.onload = () => {
      cleanup();
      // `decode()` guarantees the pixels are ready before the first texture
      // upload, which removes a main-thread hitch on the frame after the load.
      if (typeof image.decode === 'function') {
        image.decode().then(() => resolve(image), () => resolve(image));
      } else {
        resolve(image);
      }
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('ImageLoader: falha ao carregar a imagem "' + url + '" (arquivo ausente, CORS ou formato invalido).'));
    };

    image.src = url;
  });
}

/**
 * Loads an image and reports which decoder produced it.
 *
 * The `flipped` flag matters to the caller: the bitmap path bakes `flipY` into
 * the pixels, while the `HTMLImageElement` path cannot, and the texture upload
 * has to compensate with `UNPACK_FLIP_Y_WEBGL`.
 *
 * @param {string} url
 * @param {Object} [options] See {@link loadImageBitmap} and {@link loadImage}.
 * @returns {Promise<{image: Object, isBitmap: boolean, flipped: boolean, url: string}>}
 */
export async function loadImageSource(url, options = {}) {
  const wantsFlip = options.flipY === true;

  if (options.preferImageBitmap !== false && isImageBitmapSupported()) {
    try {
      const bitmap = await loadImageBitmap(url, options);
      return { image: bitmap, isBitmap: true, flipped: wantsFlip && _orientationKeyword !== '', url };
    } catch (err) {
      Logger.debug('ImageLoader: createImageBitmap falhou para "' + url + '", usando <img>. ' + err.message);
    }
  }

  const image = await loadImage(url, options);
  return { image, isBitmap: false, flipped: false, url };
}

/**
 * Decodes raw bytes (a bufferView of a .glb, a data: URI payload, ...) into an
 * image source, without ever touching the network.
 *
 * @param {ArrayBuffer|ArrayBufferView|Blob} source
 * @param {Object} [options]
 * @param {string} [options.mimeType='image/png']
 * @param {boolean} [options.flipY=false]
 * @param {boolean} [options.premultiplyAlpha=false]
 * @param {string} [options.label] Name used in error messages.
 * @returns {Promise<{image: Object, isBitmap: boolean, flipped: boolean, url: string}>}
 */
export async function decodeImageSource(source, options = {}) {
  const label = options.label || 'imagem embutida';
  const blob = toBlob(source, options.mimeType);
  const wantsFlip = options.flipY === true;

  if (options.preferImageBitmap !== false && isImageBitmapSupported()) {
    try {
      const bitmap = await decodeBlobToBitmap(blob, {
        flipY: wantsFlip,
        premultiplyAlpha: options.premultiplyAlpha,
        label
      });
      return { image: bitmap, isBitmap: true, flipped: wantsFlip && _orientationKeyword !== '', url: label };
    } catch (err) {
      Logger.debug('ImageLoader: decode direto falhou para "' + label + '", usando <img>. ' + err.message);
    }
  }

  const objectURL = globalThis.URL && typeof globalThis.URL.createObjectURL === 'function'
    ? globalThis.URL.createObjectURL(blob)
    : null;
  if (objectURL === null) {
    throw new Error('ImageLoader: nao foi possivel decodificar "' + label + '" (sem createImageBitmap nem URL.createObjectURL).');
  }
  try {
    const image = await loadImage(objectURL, { crossOrigin: null });
    return { image, isBitmap: false, flipped: false, url: label };
  } finally {
    globalThis.URL.revokeObjectURL(objectURL);
  }
}

/**
 * Creates a GPU texture from an already decoded image source.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Object} image `ImageBitmap`, `HTMLImageElement`, canvas or video.
 * @param {Object} [options]
 * @param {boolean} [options.srgb=false] Upload as SRGB8_ALPHA8 (colour maps).
 * @param {boolean} [options.generateMipmaps=true]
 * @param {number|string} [options.minFilter]
 * @param {number|string} [options.magFilter]
 * @param {number|string} [options.wrapS]
 * @param {number|string} [options.wrapT]
 * @param {number} [options.anisotropy=1]
 * @param {boolean} [options.flipY=false] Requested orientation.
 * @param {boolean} [options.alreadyFlipped=false] The pixels are already flipped.
 * @param {boolean} [options.premultiplyAlpha=false]
 * @param {string} [options.name]
 * @param {Object} [options.state] StateCache instance.
 * @returns {Texture}
 */
export function createTextureFromImage(gl, image, options = {}) {
  const width = imageWidth(image);
  const height = imageHeight(image);
  if (width <= 0 || height <= 0) {
    throw new Error('ImageLoader: imagem "' + (options.name || 'sem nome') + '" tem dimensoes invalidas (' + width + 'x' + height + ').');
  }

  const generateMipmaps = options.generateMipmaps !== false;
  const texture = new Texture(gl, {
    target: '2d',
    width,
    height,
    internalFormat: options.srgb === true ? 'srgb8_alpha8' : 'rgba8',
    minFilter: options.minFilter,
    magFilter: options.magFilter,
    wrapS: options.wrapS,
    wrapT: options.wrapT,
    anisotropy: options.anisotropy,
    generateMipmaps,
    // The bitmap path bakes the flip in; only the <img> path needs UNPACK_FLIP_Y.
    flipY: options.flipY === true && options.alreadyFlipped !== true,
    premultiply: options.premultiplyAlpha === true,
    data: image,
    state: options.state
  });
  if (options.name) texture.name = options.name;
  return texture;
}

/**
 * Loads a URL straight into a GPU texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} url
 * @param {Object} [options] Union of {@link loadImageSource} and {@link createTextureFromImage}.
 * @returns {Promise<Texture>}
 */
export async function loadTexture(gl, url, options = {}) {
  const source = await loadImageSource(url, options);
  try {
    const texture = createTextureFromImage(gl, source.image, {
      srgb: options.srgb,
      generateMipmaps: options.generateMipmaps,
      minFilter: options.minFilter,
      magFilter: options.magFilter,
      wrapS: options.wrapS,
      wrapT: options.wrapT,
      anisotropy: options.anisotropy,
      flipY: options.flipY,
      alreadyFlipped: source.flipped,
      premultiplyAlpha: options.premultiplyAlpha,
      name: options.name || url,
      state: options.state
    });
    return texture;
  } finally {
    if (options.keepImage !== true) disposeImage(source.image);
  }
}
