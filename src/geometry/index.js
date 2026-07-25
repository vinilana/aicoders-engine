/**
 * Geometria e texturas procedurais — barril da area.
 *
 * GERADO por tools/gen-barrels.mjs. Nao edite a mao: rode o gerador.
 * Existe para o subpath export do pacote, por exemplo
 *   import { computeAABB } from 'aicoders-engine/geometry';
 */

export { computeAABB, computeBoundingSphere, computeNormals, computeTangents, mergeGeometries, optimizeVertexCache, simplify, toIndexed, toNonIndexed } from './GeometryUtils.js';
export { createBox, createCapsule, createCone, createCylinder, createDisc, createGridLines, createIcosphere, createPlane, createQuadFullscreen, createSkyboxCube, createSphere, createTerrain, createTorus, createTorusKnot } from './Primitives.js';
export { brdfLUTTexture, checkerTexture, fbm, fbmPeriodic, gradientTexture, noiseHeightField, noiseTexture, normalMapFromHeight, perlin3, perlin3Periodic, ridgedFbm, simplex3, solidColorTexture, uvGridTexture } from './ProceduralTexture.js';
