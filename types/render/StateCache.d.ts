/**
 * Returns the StateCache registered for a GL context, if any.
 * @param {WebGL2RenderingContext} gl
 * @returns {StateCache|null}
 */
export function getStateCache(gl: WebGL2RenderingContext): StateCache | null;
/**
 * Shadowed WebGL2 state with per-call redundancy elimination and draw statistics.
 */
export class StateCache {
    /**
     * @param {WebGL2RenderingContext} gl
     */
    constructor(gl: WebGL2RenderingContext);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {number} */
    maxTextureUnits: number;
    /** @type {number} Highest unit, reserved for resource creation binds. */
    scratchTextureUnit: number;
    /** @type {number} */
    maxUBOBindings: number;
    /** @type {WebGLProgram|null} */
    _program: WebGLProgram | null;
    /** @type {WebGLVertexArrayObject|null|number} */
    _vao: WebGLVertexArrayObject | null | number;
    /** @type {Array<WebGLBuffer|null|number>} Indexed by `_bufferIndex`. */
    _buffers: Array<WebGLBuffer | null | number>;
    /** @type {Array<WebGLTexture|null|number>} unit * 4 + targetIndex. */
    _textures: Array<WebGLTexture | null | number>;
    /** @type {Array<WebGLBuffer|null|number>} Indexed by UBO binding point. */
    _uboBindings: Array<WebGLBuffer | null | number>;
    /** @type {number} */
    _activeTexture: number;
    /** @type {WebGLFramebuffer|null|number} */
    _drawFramebuffer: WebGLFramebuffer | null | number;
    /** @type {WebGLFramebuffer|null|number} */
    _readFramebuffer: WebGLFramebuffer | null | number;
    /** @type {WebGLRenderbuffer|null|number} */
    _renderbuffer: WebGLRenderbuffer | null | number;
    _viewportX: number;
    _viewportY: number;
    _viewportW: number;
    _viewportH: number;
    _scissorX: number;
    _scissorY: number;
    _scissorW: number;
    _scissorH: number;
    /** @type {boolean|number} */
    _scissorTest: boolean | number;
    /** @type {boolean|number} */
    _depthTest: boolean | number;
    /** @type {boolean|number} */
    _depthWrite: boolean | number;
    /** @type {number} */
    _depthFunc: number;
    _depthRangeNear: number;
    _depthRangeFar: number;
    /** @type {string|number} 'none' | 'back' | 'front' | 'both' */
    _cullMode: string | number;
    /** @type {boolean|number} */
    _cullEnabled: boolean | number;
    /** @type {boolean|number} */
    _frontFaceCCW: boolean | number;
    /** @type {string|number} */
    _blendMode: string | number;
    /** @type {boolean|number} */
    _blendEnabled: boolean | number;
    _blendSrcRGB: number;
    _blendDstRGB: number;
    _blendSrcAlpha: number;
    _blendDstAlpha: number;
    _blendEquationRGB: number;
    _blendEquationAlpha: number;
    /** @type {boolean|number} */
    _colorMaskR: boolean | number;
    _colorMaskG: number;
    _colorMaskB: number;
    _colorMaskA: number;
    /** @type {boolean|number} */
    _polygonOffsetEnabled: boolean | number;
    _polygonOffsetFactor: number;
    _polygonOffsetUnits: number;
    _clearR: number;
    _clearG: number;
    _clearB: number;
    _clearA: number;
    _clearDepth: number;
    _clearStencil: number;
    _lineWidth: number;
    /** @type {boolean|number} */
    _stencilTest: boolean | number;
    _stencilFunc: number;
    _stencilRef: number;
    _stencilFuncMask: number;
    _stencilFail: number;
    _stencilZFail: number;
    _stencilZPass: number;
    _stencilWriteMask: number;
    /** @type {boolean|number} */
    _rasterizerDiscard: boolean | number;
    _unpackFlipY: number;
    _unpackPremultiply: number;
    _unpackAlignment: number;
    _unpackColorspace: number;
    /**
     * Per-frame statistics. Reset by the renderer each frame via `resetStats()`.
     * @type {{calls:number, drawCalls:number, triangles:number, points:number,
     *         lines:number, programSwitches:number, vaoSwitches:number,
     *         textureBinds:number, bufferBinds:number, fboBinds:number,
     *         stateChanges:number}}
     */
    stats: {
        calls: number;
        drawCalls: number;
        triangles: number;
        points: number;
        lines: number;
        programSwitches: number;
        vaoSwitches: number;
        textureBinds: number;
        bufferBinds: number;
        fboBinds: number;
        stateChanges: number;
    };
    /**
     * Binds a shader program.
     * @param {WebGLProgram|null} program
     * @returns {boolean} True when the driver was actually touched.
     */
    useProgram(program: WebGLProgram | null): boolean;
    /**
     * Binds a vertex array object.
     * Also invalidates the ELEMENT_ARRAY_BUFFER shadow because the index buffer
     * binding is part of the VAO state and changes implicitly here.
     * @param {WebGLVertexArrayObject|null} vao
     * @returns {boolean}
     */
    bindVAO(vao: WebGLVertexArrayObject | null): boolean;
    /**
     * Currently bound VAO (null when none). Lets resources check whether they are
     * bound without reaching into the private shadow state.
     * @returns {WebGLVertexArrayObject|null}
     */
    getBoundVAO(): WebGLVertexArrayObject | null;
    /**
     * Currently bound program (null when none).
     * @returns {WebGLProgram|null}
     */
    getBoundProgram(): WebGLProgram | null;
    /**
     * Maps a GL buffer target to a dense cache slot.
     * @param {number} target
     * @returns {number} slot index or -1 when untracked
     * @private
     */
    private _bufferIndex;
    /**
     * Binds a buffer to a target.
     * @param {number} target GL enum.
     * @param {WebGLBuffer|null} buffer
     * @returns {boolean}
     */
    bindBuffer(target: number, buffer: WebGLBuffer | null): boolean;
    /**
     * Marks a buffer target as unknown (call after external code touched it).
     * @param {number} target
     */
    invalidateBuffer(target: number): void;
    /**
     * Binds a whole buffer to an indexed uniform block binding point.
     * @param {number} bindingPoint
     * @param {WebGLBuffer|null} buffer
     * @returns {boolean}
     */
    bindUBO(bindingPoint: number, buffer: WebGLBuffer | null): boolean;
    /**
     * Binds a sub range of a buffer to a uniform block binding point.
     * Offsets must respect `Capabilities.uboOffsetAlignment`.
     * @param {number} bindingPoint
     * @param {WebGLBuffer|null} buffer
     * @param {number} offset Byte offset.
     * @param {number} size Byte size.
     */
    bindUBORange(bindingPoint: number, buffer: WebGLBuffer | null, offset: number, size: number): void;
    /**
     * Maps a texture target to a dense per-unit slot.
     * @param {number} target
     * @returns {number}
     * @private
     */
    private _textureIndex;
    /**
     * Selects the active texture unit.
     * @param {number} unit
     * @returns {boolean}
     */
    activeTexture(unit: number): boolean;
    /**
     * Binds a texture to a unit, avoiding both redundant binds and redundant
     * `activeTexture` switches.
     * @param {number} unit
     * @param {number} target GL enum.
     * @param {WebGLTexture|null} texture
     * @returns {boolean}
     */
    bindTexture(unit: number, target: number, texture: WebGLTexture | null): boolean;
    /**
     * Drops every cached binding of a texture object (call before deleting it,
     * otherwise a recycled GL name could be considered "already bound").
     * @param {WebGLTexture} texture
     */
    invalidateTexture(texture: WebGLTexture): void;
    /**
     * Marks every target of a texture unit as unknown.
     * @param {number} unit
     */
    invalidateTextureUnit(unit: number): void;
    /**
     * Binds a texture on the reserved scratch unit for creation/parameter work,
     * so that the units used by materials (0..15) are never disturbed.
     *
     * Unlike `bindTexture`, this always selects the scratch unit first, even when
     * the binding itself is already cached. `texStorage*`, `texImage*`,
     * `texSubImage*`, `texParameter*` and `generateMipmap` all act on the texture
     * bound to the ACTIVE unit, so a cached bind without an `activeTexture` would
     * send the update to whatever texture the current active unit happens to hold
     * (INVALID_OPERATION when the formats differ, silent corruption when they
     * match).
     * @param {number} target
     * @param {WebGLTexture|null} texture
     * @returns {number} The unit used.
     */
    bindTextureForUpdate(target: number, texture: WebGLTexture | null): number;
    /**
     * Binds a framebuffer.
     * @param {number} target GL_FRAMEBUFFER, GL_DRAW_FRAMEBUFFER or GL_READ_FRAMEBUFFER.
     * @param {WebGLFramebuffer|null} fbo
     * @returns {boolean}
     */
    bindFramebuffer(target: number, fbo: WebGLFramebuffer | null): boolean;
    /**
     * Drops every cached binding of a framebuffer (call before deleting it).
     * @param {WebGLFramebuffer} fbo
     */
    invalidateFramebuffer(fbo: WebGLFramebuffer): void;
    /**
     * Binds a renderbuffer.
     * @param {WebGLRenderbuffer|null} rb
     * @returns {boolean}
     */
    bindRenderbuffer(rb: WebGLRenderbuffer | null): boolean;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {boolean}
     */
    viewport(x: number, y: number, width: number, height: number): boolean;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {boolean}
     */
    scissor(x: number, y: number, width: number, height: number): boolean;
    /**
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setScissorTest(enabled: boolean): boolean;
    /**
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setDepthTest(enabled: boolean): boolean;
    /**
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setDepthWrite(enabled: boolean): boolean;
    /**
     * @param {string|number} func Name ('less', 'lequal', ...) or GL enum.
     * @returns {boolean}
     */
    setDepthFunc(func: string | number): boolean;
    /**
     * @param {number} near
     * @param {number} far
     * @returns {boolean}
     */
    setDepthRange(near: number, far: number): boolean;
    /**
     * @param {string} mode 'none' | 'back' | 'front' | 'both'
     * @returns {boolean}
     */
    setCullFace(mode: string): boolean;
    /**
     * @param {boolean} ccw True for counter-clockwise front faces (engine default).
     * @returns {boolean}
     */
    setFrontFace(ccw: boolean): boolean;
    /**
     * @param {boolean} enabled
     * @param {number} [factor=1]
     * @param {number} [units=1]
     * @returns {boolean}
     */
    setPolygonOffset(enabled: boolean, factor?: number, units?: number): boolean;
    /**
     * WebGL2 only guarantees a line width of 1; kept for completeness.
     * @param {number} width
     * @returns {boolean}
     */
    setLineWidth(width: number): boolean;
    /**
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setRasterizerDiscard(enabled: boolean): boolean;
    /**
     * Applies one of the engine blend presets.
     * @param {string} mode 'none' | 'normal' | 'additive' | 'multiply' | 'premultiplied'
     * @returns {boolean}
     */
    setBlending(mode: string): boolean;
    /**
     * Applies a fully custom separate blend function; switches the cached mode to
     * 'custom' so a later preset re-applies correctly.
     * @param {number} srcRGB
     * @param {number} dstRGB
     * @param {number} srcAlpha
     * @param {number} dstAlpha
     * @param {number} [equationRGB=0x8006]
     * @param {number} [equationAlpha=0x8006]
     */
    setBlendFuncSeparate(srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number, equationRGB?: number, equationAlpha?: number): void;
    /**
     * @private
     */
    private _applyBlendFunc;
    /**
     * @param {boolean} r
     * @param {boolean} g
     * @param {boolean} b
     * @param {boolean} a
     * @returns {boolean}
     */
    setColorMask(r: boolean, g: boolean, b: boolean, a: boolean): boolean;
    /**
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setStencilTest(enabled: boolean): boolean;
    /**
     * @param {string|number} func
     * @param {number} ref
     * @param {number} mask
     * @returns {boolean}
     */
    setStencilFunc(func: string | number, ref: number, mask: number): boolean;
    /**
     * @param {string|number} fail
     * @param {string|number} zfail
     * @param {string|number} zpass
     * @returns {boolean}
     */
    setStencilOp(fail: string | number, zfail: string | number, zpass: string | number): boolean;
    /**
     * @param {number} mask
     * @returns {boolean}
     */
    setStencilMask(mask: number): boolean;
    /**
     * @param {boolean} flipY
     * @param {boolean} premultiply
     * @param {number} alignment 1, 2, 4 or 8.
     */
    setPixelStore(flipY: boolean, premultiply: boolean, alignment: number): void;
    /**
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     * @returns {boolean}
     */
    setClearColor(r: number, g: number, b: number, a: number): boolean;
    /**
     * @param {number} depth
     * @returns {boolean}
     */
    setClearDepth(depth: number): boolean;
    /**
     * @param {number} value
     * @returns {boolean}
     */
    setClearStencil(value: number): boolean;
    /**
     * Clears the bound framebuffer. Automatically re-enables the write masks that
     * a clear requires (a disabled depth mask silently discards a depth clear).
     * @param {boolean} [color=true]
     * @param {boolean} [depth=true]
     * @param {boolean} [stencil=false]
     */
    clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
    /**
     * Applies the render state block of a Material in one shot.
     * @param {Object} material
     */
    applyMaterialState(material: any): void;
    /**
     * Counts primitives for the statistics block.
     * @param {number} mode GL primitive mode.
     * @param {number} count Vertex/index count.
     * @param {number} instances
     * @private
     */
    private _countPrimitives;
    /**
     * @param {number} mode
     * @param {number} first
     * @param {number} count
     */
    drawArrays(mode: number, first: number, count: number): void;
    /**
     * @param {number} mode
     * @param {number} count
     * @param {number} type
     * @param {number} byteOffset
     */
    drawElements(mode: number, count: number, type: number, byteOffset: number): void;
    /**
     * @param {number} mode
     * @param {number} first
     * @param {number} count
     * @param {number} instanceCount
     */
    drawArraysInstanced(mode: number, first: number, count: number, instanceCount: number): void;
    /**
     * @param {number} mode
     * @param {number} count
     * @param {number} type
     * @param {number} byteOffset
     * @param {number} instanceCount
     */
    drawElementsInstanced(mode: number, count: number, type: number, byteOffset: number, instanceCount: number): void;
    /** Zeroes the per-frame statistics. */
    resetStats(): void;
    /**
     * Invalidates the whole shadow state and pushes a known default state to the
     * driver. Call this whenever foreign code (a devtools overlay, another
     * library, a context restore) may have touched the GL state machine.
     */
    reset(): void;
    /** Releases the registry entry. The GL context itself is not destroyed here. */
    dispose(): void;
}
