/**
 * Extracts the lowercase extension of a URL, ignoring the query and the hash.
 * @param {string} url
 * @returns {string} Extension without the dot, or an empty string.
 */
export function extensionOf(url: string): string;
/**
 * Guesses the MIME type of an image from its URL.
 * @param {string} url
 * @returns {string} A MIME type (never empty).
 */
export function mimeTypeFromURL(url: string): string;
/**
 * True when the runtime exposes `createImageBitmap`.
 * @returns {boolean}
 */
export function isImageBitmapSupported(): boolean;
/**
 * Pixel width of any image-like source.
 * @param {Object} image
 * @returns {number}
 */
export function imageWidth(image: any): number;
/**
 * Pixel height of any image-like source.
 * @param {Object} image
 * @returns {number}
 */
export function imageHeight(image: any): number;
/**
 * Releases an `ImageBitmap` (a no-op for every other source). Bitmaps keep their
 * decoded pixels alive until closed, so this matters for big models.
 * @param {Object} image
 */
export function disposeImage(image: any): void;
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
export function decodeBlobToBitmap(blob: Blob, options?: {
    flipY?: boolean;
    premultiplyAlpha?: boolean;
    label?: string;
}): Promise<ImageBitmap>;
/**
 * Wraps raw bytes into a Blob.
 * @param {ArrayBuffer|ArrayBufferView|Blob} source
 * @param {string} mimeType
 * @returns {Blob}
 */
export function toBlob(source: ArrayBuffer | ArrayBufferView | Blob, mimeType: string): Blob;
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
export function loadImageBitmap(url: string, options?: {
    flipY?: boolean;
    premultiplyAlpha?: boolean;
    credentials?: string;
    signal?: AbortSignal;
}): Promise<ImageBitmap>;
/**
 * Loads a URL into an `HTMLImageElement`. Used as the fallback path and for
 * cross-origin images that an `<img>` tag can reach but `fetch` cannot.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string|null} [options.crossOrigin='anonymous'] `null` disables the attribute.
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(url: string, options?: {
    crossOrigin?: string | null;
}): Promise<HTMLImageElement>;
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
export function loadImageSource(url: string, options?: any): Promise<{
    image: any;
    isBitmap: boolean;
    flipped: boolean;
    url: string;
}>;
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
export function decodeImageSource(source: ArrayBuffer | ArrayBufferView | Blob, options?: {
    mimeType?: string;
    flipY?: boolean;
    premultiplyAlpha?: boolean;
    label?: string;
}): Promise<{
    image: any;
    isBitmap: boolean;
    flipped: boolean;
    url: string;
}>;
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
export function createTextureFromImage(gl: WebGL2RenderingContext, image: any, options?: {
    srgb?: boolean;
    generateMipmaps?: boolean;
    minFilter?: number | string;
    magFilter?: number | string;
    wrapS?: number | string;
    wrapT?: number | string;
    anisotropy?: number;
    flipY?: boolean;
    alreadyFlipped?: boolean;
    premultiplyAlpha?: boolean;
    name?: string;
    state?: any;
}): Texture;
/**
 * Loads a URL straight into a GPU texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} url
 * @param {Object} [options] Union of {@link loadImageSource} and {@link createTextureFromImage}.
 * @returns {Promise<Texture>}
 */
export function loadTexture(gl: WebGL2RenderingContext, url: string, options?: any): Promise<Texture>;
import { Texture } from "../render/Texture.js";
