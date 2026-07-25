/**
 * Carregadores de assets — barril da area.
 *
 * GERADO por tools/gen-barrels.mjs. Nao edite a mao: rode o gerador.
 * Existe para o subpath export do pacote, por exemplo
 *   import { AssetManager } from 'aicoders-engine/loaders';
 */

export { AssetManager, base64ToUint8Array, ensureTrailingSlash, extractBasePath, fetchBytes, fetchJSON, fetchText, guessAssetType, isAbsoluteURL, isDataURI, parseDataURI, resolveURL, textToUint8Array, uint8ArrayToText } from './AssetManager.js';
export { GLTFLoader, GLTFParser } from './GLTFLoader.js';
export { createTextureFromImage, decodeBlobToBitmap, decodeImageSource, disposeImage, extensionOf, imageHeight, imageWidth, isImageBitmapSupported, loadImage, loadImageBitmap, loadImageSource, loadTexture, mimeTypeFromURL, toBlob } from './ImageLoader.js';
export { OBJLoader, parseMTL, parseMTLMapStatement } from './OBJLoader.js';
