export class Renderer {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object|null} [caps] Capabilities from `createGLContext`.
     * @param {Object} [options]
     * @param {boolean} [options.shadows=true]
     * @param {boolean} [options.clustered=true]
     * @param {boolean} [options.hdr=true]
     * @param {boolean} [options.postprocessing=true]
     * @param {number}  [options.msaa=0] Sample count of the HDR target.
     * @param {string}  [options.toneMapping='aces']
     * @param {number}  [options.exposure=1]
     * @param {number}  [options.shadowMapSize=2048]
     * @param {number}  [options.cascades=4]
     * @param {number}  [options.maxLights=1024]
     * @param {number}  [options.pixelRatio=1]
     * @param {boolean} [options.depthPrepass=false]
     * @param {boolean} [options.sortObjects=true]
     * @param {boolean} [options.autoClear=true]
     * @param {Object}  [options.shaders] Extra shader sources, or a registration function.
     */
    constructor(gl: WebGL2RenderingContext, caps?: any | null, options?: {
        shadows?: boolean;
        clustered?: boolean;
        hdr?: boolean;
        postprocessing?: boolean;
        msaa?: number;
        toneMapping?: string;
        exposure?: number;
        shadowMapSize?: number;
        cascades?: number;
        maxLights?: number;
        pixelRatio?: number;
        depthPrepass?: boolean;
        sortObjects?: boolean;
        autoClear?: boolean;
        shaders?: any;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object|null} */
    caps: any | null;
    /** @type {Object} Frozen copy of the construction options. */
    options: any;
    /** @type {StateCache} Every GL state change funnels through this. */
    state: StateCache;
    /** @type {ShaderLib} */
    shaderLib: ShaderLib;
    /** @type {UniformBuffers} */
    ubo: UniformBuffers;
    /** @type {RenderList} */
    renderList: RenderList;
    /** @type {boolean} */
    shadowsEnabled: boolean;
    /** @type {boolean} */
    clusteredEnabled: boolean;
    /** @type {boolean} */
    hdrEnabled: boolean;
    /** @type {boolean} */
    postEnabled: boolean;
    /** @type {number} */
    msaa: number;
    /** @type {string} */
    toneMapping: string;
    /** @type {number} */
    exposure: number;
    /** @type {number} */
    shadowMapSize: number;
    /** @type {number} */
    cascades: number;
    /** @type {number} */
    maxLights: number;
    /** @type {boolean} Depth prepass, worth it on heavy overdraw scenes. */
    depthPrepass: boolean;
    /** @type {boolean} */
    sortObjects: boolean;
    /** @type {boolean} */
    autoClear: boolean;
    /** @type {number} Cluster grid dimensions. */
    clusterX: number;
    clusterY: number;
    clusterZ: number;
    /** @type {number} CSS width. */
    width: number;
    /** @type {number} CSS height. */
    height: number;
    /** @type {number} */
    pixelRatio: number;
    /** @type {number} Drawing buffer width in device pixels. */
    drawingBufferWidth: number;
    /** @type {number} */
    drawingBufferHeight: number;
    /** @private Clear colour, linear. */
    private _clearR;
    _clearG: number;
    _clearB: number;
    _clearA: number;
    /** @private Numeric tone mapping code pushed to the object shaders. */
    private _toneMappingCode;
    /**
     * Per frame statistics. Read by Stats and by the demo overlay.
     * `textures` counts the texture binds issued this frame and `geometries` the
     * draw items queued: the engine has no live registry of either resource, and
     * a per frame number is the useful one for a profiler anyway.
     */
    info: {
        frame: number;
        calls: number;
        drawCalls: number;
        triangles: number;
        points: number;
        lines: number;
        programs: number;
        textures: number;
        geometries: number;
        gpuTimeMs: number;
        cullTimeMs: number;
        cpuTimeMs: number;
        visibleMeshes: number;
        culledMeshes: number;
        shadowDrawCalls: number;
        memoryBytes: number;
        memory: {
            buffers: number;
            textures: number;
        };
    };
    /** @type {Object|null} */
    lightManager: any | null;
    /** @type {Object|null} */
    shadowMapper: any | null;
    /** @type {Object|null} */
    clustered: any | null;
    /** @type {Object|null} */
    post: any | null;
    /** @type {Object|null} Environment probe used when the scene has none. */
    ibl: any | null;
    /** @private @type {Object[]} Meshes surviving the broadphase. */
    private _visible;
    /** @private @type {Object[]} Cached LOD nodes of the current scene. */
    private _lodNodes;
    /** @private */
    private _lodScene;
    /** @private */
    private _lodMeshCount;
    /** @private @type {Object|null} */
    private _activeIBL;
    /** @private @type {Object|null} */
    private _shadowTexture;
    /** @private @type {boolean} Clustered permutation compiled in / textures bound. */
    private _clusterActive;
    /**
     * @private @type {boolean} Whether the froxel grid built this frame is usable.
     * `ClusteredLighting.update()` returns false when it cannot build the grid
     * (non perspective camera): the grid is zeroed and the shader is expected to
     * fall back to the flat punctual loop, which only happens when the
     * `clusterEnabled` flag of the Lights block is 0.
     */
    private _clusterReady;
    /** @private Program whose renderer owned samplers are already bound. */
    private _globalsProgram;
    /** @private */
    private _lastMaterial;
    /** @private */
    private _lastMaterialProgram;
    /** @private */
    private _lastMaterialVersion;
    /** @private Geometry of the previous draw, used to skip a redundant upload. */
    private _lastGeometry;
    /** @private VAO handle that goes with `_lastGeometry`. */
    private _lastVAO;
    /** @private Depth function forced by the depth prepass, null when free. */
    private _depthFuncOverride;
    /** @private */
    private _depthWriteOverride;
    /** @private @type {RenderTarget|null} */
    private _hdrTarget;
    /** @private @type {RenderTarget|null} Target the frame is being drawn into. */
    private _currentTarget;
    /** @private @type {Map<number, Object>} geometry id -> wireframe VAO record */
    private _wireframeCache;
    /** @private @type {Map<Object, number>} skeleton -> frame of its last upload */
    private _boneUploadFrame;
    /** @private @type {Object|null} lazily built skybox geometry */
    private _skyGeometry;
    /** @private @type {Material|null} lazily built material for a cube background */
    private _skyMaterial;
    /** @private Model matrix of the skybox draw, rebuilt in place every frame. */
    private _skyMatrix;
    /** @private Callback reused by every LOD rescan (never created per frame). */
    private _collectLOD;
    /** @private @type {Set<string>} shader names already reported as missing */
    private _missingShaders;
    /**
     * Defines object -> Program, for the material's own shader.
     * `Material.getDefines` returns a cached object whose identity is stable for
     * a given (material, permutation) pair, which makes it a perfect key: it
     * turns the per draw program lookup into one WeakMap hit and keeps
     * `ShaderLib.get` - which builds a key string - out of the frame loop.
     * @private @type {WeakMap<Object, Object>}
     */
    private _programCache;
    /**
     * shaderName -> (defines object -> Program), for the depth and shadow passes
     * which reuse the material defines under a different shader name.
     * @private @type {Map<string, WeakMap<Object, Object>>}
     */
    private _namedProgramCaches;
    /** @private */
    private _fallbackDirLights;
    /** @private */
    private _fallbackPunctualLights;
    /** @private */
    private _fallbackLights;
    /**
     * Shared permutation context handed to `Material.getDefines`. It is mutated
     * once per frame and read many times, never copied.
     * @private
     */
    private _ctx;
    /** @private Permutation context of the depth only passes. */
    private _depthCtx;
    /** @private */
    private _timerExt;
    /** @private @type {Array<Object|null>} */
    private _timerQueries;
    /** @private @type {boolean[]} slot has an un-read result */
    private _timerPending;
    /** @private */
    private _timerSlot;
    /** @private */
    private _timerActive;
    /**
     * Builds an optional subsystem, degrading to `null` when it throws. The
     * constructors of these classes touch the driver (targets, textures), which is
     * exactly the kind of thing a limited or software context refuses.
     * @param {string} label
     * @param {Function} factory
     * @returns {Object|null}
     * @private
     */
    private _build;
    /**
     * Registers every shader exported by `src/render/shaders/index.js`.
     *
     * The barrel shape is discovered at runtime so the shader author is free to
     * expose `registerAllShaders(shaderLib)`, a `SHADERS` map, or one
     * `{vertex, fragment}` object per shader.
     * @private
     */
    private _registerBuiltinShaders;
    /**
     * Adds shader sources to the library.
     * @param {Object|Function} sources A registration function, a `{name: {vertex,
     *        fragment}}` map, or a module namespace exporting either of those.
     * @returns {number} how many shaders are registered afterwards
     */
    registerShaders(sources: any | Function): number;
    /**
     * Registers every `{vertex, fragment}` pair reachable from an object: the
     * entries of a `SHADERS` table first, then the module level exports, whose
     * names are normalised (`standardShader` -> `standard`). Names already known to
     * the library are left alone.
     * @param {Object} sources
     * @returns {number} how many shaders are registered afterwards
     * @private
     */
    private _registerShaderPairs;
    /**
     * Sets the CSS size and the device pixel ratio, resizing every owned target.
     * @param {number} width CSS pixels.
     * @param {number} height CSS pixels.
     * @param {number} [pixelRatio]
     * @returns {Renderer} this
     */
    setSize(width: number, height: number, pixelRatio?: number): Renderer;
    /**
     * Sets the device pixel ratio, keeping the CSS size.
     * @param {number} value
     * @returns {Renderer} this
     */
    setPixelRatio(value: number): Renderer;
    /**
     * Overrides the viewport (device pixels).
     * @param {number} x @param {number} y @param {number} width @param {number} height
     * @returns {Renderer} this
     */
    setViewport(x: number, y: number, width: number, height: number): Renderer;
    /**
     * Enables and sets the scissor rectangle (device pixels).
     * @param {number} x @param {number} y @param {number} width @param {number} height
     * @returns {Renderer} this
     */
    setScissor(x: number, y: number, width: number, height: number): Renderer;
    /**
     * @param {boolean} enabled
     * @returns {Renderer} this
     */
    setScissorTest(enabled: boolean): Renderer;
    /**
     * Sets the clear colour. Values are linear, exactly like every Color in the engine.
     * @param {Object|number} color Color instance, `{r,g,b}` or a 0xRRGGBB integer.
     * @param {number} [alpha=1]
     * @returns {Renderer} this
     */
    setClearColor(color: any | number, alpha?: number): Renderer;
    /**
     * Sets the tone mapping operator applied by the last pass of the frame.
     * @param {string} mode 'none'|'linear'|'reinhard'|'aces'|'aces-fit'|'uncharted2'|'agx'
     * @param {number} [exposure]
     * @returns {Renderer} this
     */
    setToneMapping(mode: string, exposure?: number): Renderer;
    /**
     * Renders a scene through a camera into the default framebuffer.
     * @param {Object} scene
     * @param {Object} camera
     * @returns {Renderer} this
     */
    render(scene: any, camera: any): Renderer;
    /**
     * Renders a scene through a camera into an off-screen target.
     * Post processing is skipped: the caller owns the contents of the target.
     * @param {Object} scene
     * @param {Object} camera
     * @param {RenderTarget} renderTarget
     * @returns {Renderer} this
     */
    renderToTarget(scene: any, camera: any, renderTarget: RenderTarget): Renderer;
    /**
     * The whole pipeline.
     * @param {Object} scene
     * @param {Object} camera
     * @param {RenderTarget|null} target
     * @returns {Renderer} this
     * @private
     */
    private _renderFrame;
    /**
     * Makes sure the camera world matrix is fresh.
     *
     * `scene.updateMatrices()` only walks the scene graph, and a camera very often
     * lives outside of it (or under a rig that does). Walking up to the root and
     * refreshing that sub tree covers both cases and costs nothing when the camera
     * is already a scene child - the root is then the scene itself, which was just
     * updated.
     *
     * @param {Object} scene
     * @param {Object} camera
     * @private
     */
    private _updateCameraTransform;
    /**
     * Reads a time-ish value out of the scene for the Camera uniform block.
     * @param {Object} scene
     * @returns {Object|number|null}
     * @private
     */
    private _sceneTime;
    /**
     * Refreshes the cached list of LOD nodes and lets every one of them pick its
     * level. The cache is rebuilt when the scene changes identity or when the mesh
     * count moves, which is what adding or removing an LOD always does.
     * @param {Object} scene
     * @param {Object} camera
     * @private
     */
    private _updateLODs;
    /**
     * Fills `_visible` with the meshes that survive the broadphase, the layer mask
     * and the visibility flags.
     * @param {Object} scene
     * @param {Object} camera
     * @returns {number} number of visible meshes
     * @private
     */
    private _cull;
    /**
     * Runs the light manager, falling back to an internal split when it is
     * unavailable or returns an unusable shape.
     * @param {Object} scene
     * @param {Object} camera
     * @returns {{dirLights: Object[], punctualLights: Object[]}}
     * @private
     */
    private _collectLights;
    /**
     * Picks the environment probe for this frame.
     * @param {Object} scene
     * @returns {Object|null}
     * @private
     */
    private _resolveEnvironment;
    /**
     * Turns the visible mesh list into pooled draw items, resolving each program
     * once so both the sort key and the draw path can use it.
     * @param {Object} camera
     * @private
     */
    private _buildRenderList;
    /**
     * Resolves (and caches on the material) the program for the current frame
     * context. Returns null - never throws - when the shader is not registered.
     * @param {Object} material
     * @param {Object} geometry
     * @param {Object} [context] Permutation context, defaults to the frame one.
     * @returns {Object|null}
     * @private
     */
    private _resolveProgram;
    /**
     * Colour masked depth only pass over the opaque list, so the shading pass runs
     * with depthFunc EQUAL and shades every pixel exactly once.
     * @param {Object} camera
     * @private
     */
    private _renderDepthPrepass;
    /**
     * Resolves a program for an explicit shader name (depth prepass, shadow pass),
     * reusing the material defines so alpha masking, skinning and instancing keep
     * working in the depth only permutation.
     * @param {string} shaderName
     * @param {Object} material
     * @param {Object} geometry
     * @param {Object} context
     * @returns {Object|null}
     * @private
     */
    private _resolveNamedProgram;
    /**
     * Draws a whole list of pooled items.
     * @param {Array} list
     * @param {Object} camera
     * @private
     */
    private _renderItems;
    /**
     * Renders the shadow maps and captures the resulting texture.
     * @param {Object} scene
     * @param {Object} camera
     * @param {Object} lights
     * @param {Object} shadowLight
     * @private
     */
    private _renderShadows;
    /**
     * Draws `scene.background`: a Color is handled by the clear, a Material (a
     * SkyMaterial for instance) or a cube texture is drawn as a camera centred box
     * with depthFunc LEQUAL, between the opaque and the transparent passes.
     * @param {Object} scene
     * @param {Object} camera
     * @private
     */
    private _renderBackground;
    /** @returns {Object} the lazily created skybox geometry @private */
    private _getSkyGeometry;
    /**
     * Material used to draw a cube texture background.
     * @param {Object} texture
     * @returns {Material}
     * @private
     */
    private _getSkyMaterial;
    /**
     * Public single draw entry point: resolves the program itself and draws the
     * whole geometry. Used by tools (DebugRenderer, ShadowMapper) that submit one
     * object at a time; the frame pipeline uses the pooled item variant instead.
     *
     * @param {Object} mesh
     * @param {Object} geometry
     * @param {Object} material
     * @param {Object} camera
     * @returns {boolean} true when a draw call was issued
     */
    renderMesh(mesh: any, geometry: any, material: any, camera: any): boolean;
    /**
     * Low level draw: the program and the group are already resolved.
     * Allocation free.
     *
     * @param {Object} mesh
     * @param {Object} geometry
     * @param {Object} material
     * @param {Object} program
     * @param {Object|null} group `{start, count}` or null for the whole geometry.
     * @param {Object} [camera]
     * @param {boolean} [depthOnly=false] Skip the material uniforms / global maps.
     * @returns {boolean}
     */
    drawMesh(mesh: any, geometry: any, material: any, program: any, group: any | null, camera?: any, depthOnly?: boolean): boolean;
    /**
     * Draws one pooled render item.
     * @param {Object} item
     * @param {Object} program
     * @param {Object} camera
     * @param {boolean} depthOnly
     * @returns {boolean}
     * @private
     */
    private _drawItem;
    /**
     * Binds the samplers and uniforms the renderer owns (shadow atlas, cluster
     * textures, IBL probes, exposure). Because those never change inside a frame
     * and sampler values are per program, doing it once per program switch is
     * enough - and free for the long runs of draws that share a program.
     * @param {Object} program
     * @private
     */
    private _bindGlobalUniforms;
    /**
     * Uploads and binds the bone texture of a skinned mesh, at most once per frame
     * per skeleton even when the mesh is drawn in several passes.
     * @param {Object} mesh
     * @param {Object} program
     * @private
     */
    private _bindSkeleton;
    /**
     * Builds (and caches) a line-list VAO for a triangle geometry, so
     * `material.wireframe` draws real edges instead of an approximation. The cache
     * is owned by the renderer, never by the shared geometry.
     *
     * @param {Object} geometry
     * @returns {{vao: VertexArray, count: number, type: number}|null}
     * @private
     */
    private _getWireframe;
    /**
     * Builds the deduplicated edge index list of a triangle geometry.
     * Runs once per geometry, never inside the frame loop.
     * @param {Object} geometry
     * @returns {Uint16Array|Uint32Array|null}
     * @private
     */
    private _buildWireframeIndices;
    /**
     * Returns the off-screen target the frame should be drawn into, creating it on
     * demand. Returns null when the frame goes straight to the default framebuffer.
     * @returns {RenderTarget|null}
     * @private
     */
    private _acquireFrameTarget;
    /**
     * Copies the driver counters into `info`.
     * @private
     */
    private _collectStats;
    /**
     * Starts the GPU timer query of this frame, when the extension is available.
     * @private
     */
    private _beginGPUTimer;
    /**
     * Ends the GPU timer query of this frame.
     * @private
     */
    private _endGPUTimer;
    /**
     * Compiles every program the scene needs, so the first frame does not hitch.
     * @param {Object} scene
     * @param {Object} camera
     * @returns {number} number of programs in the library afterwards
     */
    compile(scene: any, camera: any): number;
    /**
     * Compiles the shading, depth and shadow permutations of one material.
     * @param {Object} mesh
     * @param {Object} geometry
     * @param {Object} material
     * @private
     */
    private _compileOne;
    /**
     * Drops every cached GPU-side object after a context loss/restore cycle.
     * The GL objects themselves are already gone, so nothing is deleted here: the
     * caches are simply forgotten and rebuilt lazily.
     * @returns {Renderer} this
     */
    onContextRestored(): Renderer;
    /**
     * Creates (and keeps) an environment probe generator bound to this renderer.
     * @returns {Object|null}
     */
    createIBL(): any | null;
    /**
     * Releases every GPU resource the renderer owns. Scene resources (geometries,
     * textures, materials) belong to the application and are left untouched.
     */
    dispose(): void;
}
import { StateCache } from "./StateCache.js";
import { ShaderLib } from "./ShaderLib.js";
import { UniformBuffers } from "./UniformBuffers.js";
import { RenderList } from "./RenderList.js";
import { RenderTarget } from "./RenderTarget.js";
