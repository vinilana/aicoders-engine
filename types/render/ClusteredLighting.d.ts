/**
 * Fixed texture units used by the clustered path. Mirrors the table in
 * Material.js and the sampler declarations of the GLSL chunks.
 * @type {{lightIndices: number, clusterGrid: number, lightData: number}}
 */
export const CLUSTER_TEXTURE_UNITS: {
    lightIndices: number;
    clusterGrid: number;
    lightData: number;
};
/** RGBA32F texels occupied by one light in `uLightData`. */
export const TEXELS_PER_LIGHT: 4;
/** Floats occupied by one light in `uLightData`. */
export const FLOATS_PER_LIGHT: number;
/**
 * Clustered light assignment and its GPU resources.
 */
export class ClusteredLighting {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [options]
     * @param {number} [options.clusterX=16] Tiles on X.
     * @param {number} [options.clusterY=9] Tiles on Y.
     * @param {number} [options.clusterZ=24] Exponential depth slices.
     * @param {number} [options.maxLights=1024] Punctual lights uploaded per frame.
     * @param {number} [options.maxLightsPerCluster=64] Importance cut per froxel.
     * @param {number} [options.lightDataWidth=256] Width of uLightData, in texels.
     * @param {number} [options.indexTextureWidth=1024] Width of uLightIndices, in texels.
     * @param {number} [options.initialIndexCapacity=16384] Initial index list size.
     * @param {number} [options.maxIndexCapacity] Hard cap of the index list.
     * @param {import('./StateCache.js').StateCache} [options.state]
     */
    constructor(gl: WebGL2RenderingContext, options?: {
        clusterX?: number;
        clusterY?: number;
        clusterZ?: number;
        maxLights?: number;
        maxLightsPerCluster?: number;
        lightDataWidth?: number;
        indexTextureWidth?: number;
        initialIndexCapacity?: number;
        maxIndexCapacity?: number;
        state?: import('./StateCache.js').StateCache;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @private @type {import('./StateCache.js').StateCache|null} */
    private _state;
    /** @type {number} */
    clusterX: number;
    /** @type {number} */
    clusterY: number;
    /** @type {number} */
    clusterZ: number;
    /** @type {number} Total froxel count. */
    clusterCount: number;
    /** @type {number} */
    maxLights: number;
    /** @type {number} */
    maxLightsPerCluster: number;
    /** @private */
    private _lightDataWidth;
    /** @private */
    private _indexWidth;
    /** @type {number} Upper bound of the packed index list. */
    maxIndexCapacity: number;
    /** @private Packed froxel cells, x fastest then y then z. */
    private _gridData;
    /** @private Per froxel light count of the frame being built. */
    private _counts;
    /** @private Per froxel bucket of light indices, before compaction. */
    private _buckets;
    /** @private Compacted light index list. */
    private _indexData;
    /** @private RGBA32F light records. */
    private _lightData;
    /** @private Height of the light data texture, in texels. */
    private _lightDataHeight;
    /** @private View space light centres, xyz per light (z is positive depth). */
    private _viewPos;
    /** @private View space spot axis, xyz per light (z mirrored to match _viewPos). */
    private _viewDir;
    /** @private Effective influence radius per light. */
    private _radius;
    /** @private Cosine / sine of the outer cone half angle, 2 floats per light. */
    private _cone;
    /** @private 1 for spot lights, 0 for point lights. */
    private _isSpot;
    /** @private Depth of every slice boundary, clusterZ + 1 entries. */
    private _sliceDepths;
    /** @private View space x / depth ratio of every tile boundary. */
    private _tanX;
    /** @private View space y / depth ratio of every tile boundary. */
    private _tanY;
    /** @private Cached projection parameters used to rebuild the tile ratios. */
    private _cachedScaleX;
    _cachedScaleY: number;
    _cachedOffsetX: number;
    _cachedOffsetY: number;
    /** @private Cached depth range used to rebuild the slice depths. */
    private _cachedNear;
    _cachedFar: number;
    /** @type {import('./Texture.js').Texture} usampler3D R32UI froxel grid. */
    gridTexture: import('./Texture.js').Texture;
    /** @type {import('./Texture.js').Texture} sampler2D RGBA32F light records. */
    lightDataTexture: import('./Texture.js').Texture;
    /** @type {import('./Texture.js').Texture} usampler2D R32UI packed index list. */
    indexTexture: import('./Texture.js').Texture;
    /** @type {boolean} True when the grid built this frame is usable. */
    active: boolean;
    /** @type {number} Punctual lights uploaded this frame. */
    lightCount: number;
    /** @type {number} Render target width recorded by the last `update()`. */
    screenWidth: number;
    /** @type {number} Render target height recorded by the last `update()`. */
    screenHeight: number;
    /** @private Index entries written by the last `update()`. */
    private _indexCount;
    /** @type {number} Exponential slice scale published as uClusterParams.x. */
    sliceScale: number;
    /** @type {number} Exponential slice bias published as uClusterParams.y. */
    sliceBias: number;
    /** @private uClusterParams: sliceScale, sliceBias, near, far. */
    private _clusterParams;
    /** @private uClusterSize: clusterX, clusterY, clusterZ, maxLightsPerCluster. */
    private _clusterSize;
    /** @private Frame-local wall clock, resolved without touching module scope. */
    private _now;
    /** @private Warned once about an exhausted index list. */
    private _warnedOverflow;
    /**
     * Assignment statistics of the last `update()`.
     * @type {{lights: number, assignments: number, activeClusters: number,
     *         maxClusterLights: number, droppedAssignments: number,
     *         droppedClusters: number, indexCapacity: number, cpuTimeMs: number}}
     */
    stats: {
        lights: number;
        assignments: number;
        activeClusters: number;
        maxClusterLights: number;
        droppedAssignments: number;
        droppedClusters: number;
        indexCapacity: number;
        cpuTimeMs: number;
    };
    /**
     * Shader defines this instance requires. Feed them into the material /
     * ShaderLib permutation key so the GLSL constants match the CPU grid.
     * @param {Object} [out] Optional object to write into.
     * @returns {Object}
     */
    getDefines(out?: any): any;
    /**
     * Changes the per froxel importance cut. Reallocates the bucket storage, so
     * call it outside of the render loop.
     * @param {number} value
     * @returns {ClusteredLighting} this
     */
    setMaxLightsPerCluster(value: number): ClusteredLighting;
    /**
     * Recomputes the exponential Z distribution when the depth range changes.
     * @param {number} near
     * @param {number} far
     * @private
     */
    private _updateClusterParams;
    /**
     * Recomputes the view space slope of every tile boundary.
     * @param {number} scaleX
     * @param {number} scaleY
     * @param {number} offsetX
     * @param {number} offsetY
     * @private
     */
    private _updateTileSlopes;
    /**
     * Rebuilds the froxel assignment for this frame and uploads the used range of
     * every texture.
     *
     * `lights` must already be culled and sorted by importance (see LightManager):
     * the assignment walks it in order, so a froxel that overflows keeps the most
     * important lights and drops the rest.
     *
     * @param {import('../scene/Camera.js').Camera} camera Perspective camera.
     * @param {import('../scene/Light.js').Light[]} lights Point and spot lights.
     * @param {number} width Render target width in pixels (statistics only).
     * @param {number} height Render target height in pixels (statistics only).
     * @returns {boolean} True when the clustered path can be used this frame.
     */
    update(camera: import('../scene/Camera.js').Camera, lights: import('../scene/Light.js').Light[], width: number, height: number): boolean;
    /**
     * Fills `_lightData` plus the view space scratch arrays.
     * @param {import('../scene/Camera.js').Camera} camera
     * @param {import('../scene/Light.js').Light[]} lights
     * @returns {number} Number of lights actually packed.
     * @private
     */
    private _packLights;
    /**
     * Assigns one light to every froxel it can reach.
     * @param {number} index Light index.
     * @param {number} scaleX Projection scale on X.
     * @param {number} scaleY Projection scale on Y.
     * @param {number} offsetX NDC offset on X.
     * @param {number} offsetY NDC offset on Y.
     * @param {number} near
     * @param {number} far
     * @returns {number} Number of froxels the light was written into.
     * @private
     */
    private _assignLight;
    /**
     * Packs the per froxel buckets into the linear index list and builds the grid.
     * @param {number} assignments Total number of bucket entries.
     * @private
     */
    private _compact;
    /**
     * Grows the index list and its texture to hold at least `needed` entries.
     * @param {number} needed
     * @returns {boolean} True when the capacity is now sufficient.
     * @private
     */
    private _ensureIndexCapacity;
    /**
     * Uploads the whole froxel grid (a few kilobytes).
     * @private
     */
    private _uploadGrid;
    /**
     * Uploads only the rows of `uLightData` that hold live lights.
     * @param {number} count
     * @private
     */
    private _uploadLightData;
    /**
     * Uploads only the rows of `uLightIndices` that hold live entries.
     * @private
     */
    private _uploadIndices;
    /**
     * Binds the three textures to their fixed units and points the samplers of
     * `program` at them. The grid and index textures are bound even when the
     * clustered path is inactive: leaving an integer sampler on a unit that holds
     * a float texture is an INVALID_OPERATION at draw time.
     *
     * @param {import('./StateCache.js').StateCache} state
     * @param {import('./Program.js').Program} program
     * @returns {boolean} False when there is nothing to bind.
     */
    bind(state: import('./StateCache.js').StateCache, program: import('./Program.js').Program): boolean;
    /**
     * Froxel index of a screen pixel and a positive view depth. Mirrors
     * `getClusterCoord` in the GLSL chunk (fragment coordinates, origin bottom
     * left).
     * @param {number} fragX
     * @param {number} fragY
     * @param {number} viewDepth Positive distance along the view direction.
     * @returns {number} Linear cluster index, or -1 when the screen size is unknown.
     */
    getClusterIndex(fragX: number, fragY: number, viewDepth: number): number;
    /**
     * Number of lights assigned to a froxel by the last `update()`.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    getClusterLightCount(x: number, y: number, z: number): number;
    /**
     * Light index stored at slot `slot` of a froxel.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} slot
     * @returns {number} Light index, or -1 when the slot is empty.
     */
    getClusterLight(x: number, y: number, z: number, slot: number): number;
    /** @type {number} Index entries written by the last `update()`. */
    get indexCount(): number;
    /** @type {number} Approximate GPU footprint of the clustered resources. */
    get memoryBytes(): number;
    /** Releases every GPU resource. The instance must not be used afterwards. */
    dispose(): void;
}
