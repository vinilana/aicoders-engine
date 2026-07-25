/**
 * Minimap: a second camera rendering the circuit into a texture.
 *
 * This is the engine's render-to-texture path driven by game code rather than
 * by an internal pass, and an orthographic camera doing what orthographic
 * cameras are for. The scene is rendered a second time from directly above into
 * a RenderTarget, then that texture is composited into the corner of the screen
 * by a tiny overlay scene — a quad, an unlit material and a second orthographic
 * camera in pixel space.
 *
 * Rendering the world twice is the honest cost of a live minimap. It is kept
 * affordable by a layer mask: only the track, the barriers and the karts are
 * drawn, so the scenery and the thousands of props never reach it.
 */

import { Vec3 } from '../../../src/math/Vec3.js';
import { Quat } from '../../../src/math/Quat.js';
import { Color } from '../../../src/math/Color.js';
import { Scene } from '../../../src/scene/Scene.js';
import { Mesh } from '../../../src/scene/Mesh.js';
import { OrthographicCamera } from '../../../src/scene/OrthographicCamera.js';
import { RenderTarget } from '../../../src/render/RenderTarget.js';
import { UnlitMaterial } from '../../../src/render/materials/UnlitMaterial.js';
import { createPlane } from '../../../src/geometry/Primitives.js';

/**
 * Layer bit for objects that appear in the minimap. Anything without it is
 * skipped by the minimap camera, which is the whole reason the second pass is
 * cheap.
 */
export const MINIMAP_LAYER = 1 << 2;

const _yawQuat = new Quat();
const _pitchQuat = new Quat();
const _axisY = new Vec3(0, 1, 0);
const _axisX = new Vec3(1, 0, 0);

/**
 * Top down minimap rendered to a texture and composited on screen.
 */
export class Minimap {
  /**
   * @param {Object} options
   * @param {import('../../../src/render/Renderer.js').Renderer} options.renderer
   * @param {WebGL2RenderingContext} options.gl
   * @param {import('./Track.js').Track} options.track
   * @param {number} [options.size=256] Texture resolution, square.
   * @param {number} [options.screenSize=190] On screen size in CSS pixels.
   * @param {number} [options.margin=18]
   */
  constructor(options) {
    this.renderer = options.renderer;
    this.gl = options.gl;
    this.track = options.track;

    /** @type {number} */
    this.size = options.size !== undefined ? options.size : 256;
    /** @type {number} */
    this.screenSize = options.screenSize !== undefined ? options.screenSize : 190;
    /** @type {number} */
    this.margin = options.margin !== undefined ? options.margin : 18;
    /** @type {boolean} */
    this.enabled = true;
    /** @type {Color} Backdrop used only inside the minimap pass. */
    this.background = new Color(0.055, 0.075, 0.10);
    /**
     * @type {boolean} When true the map turns with the kart; when false north
     * stays up. Rotating is easier to read while driving, fixed is easier to
     * learn the circuit from, so both exist.
     */
    this.rotateWithKart = true;

    /** @type {RenderTarget} */
    this.target = new RenderTarget(this.gl, this.size, this.size, {
      colorFormat: 'rgba8',
      depth: true,
      filter: 'linear',
      wrap: 'clamp',
    });

    // How much of the world fits in the map. Sized from the circuit itself so
    // it frames any track this class is handed.
    const extent = this._trackExtent();
    /** @type {number} */
    this.viewRadius = extent * 0.62;

    /** @type {OrthographicCamera} */
    this.camera = new OrthographicCamera(
      -this.viewRadius, this.viewRadius, this.viewRadius, -this.viewRadius, 1, 600);
    // Only what carries the minimap layer is drawn.
    this.camera.layers = MINIMAP_LAYER;

    /* ---- overlay: the quad that shows the texture on screen ------------ */

    /** @type {Scene} */
    this.overlayScene = new Scene();
    this.overlayScene.background = null;

    /** @type {OrthographicCamera} Pixel space: 1 unit = 1 CSS pixel. */
    this.overlayCamera = new OrthographicCamera(0, 1, 0, 1, -1, 1);

    this.quadMaterial = new UnlitMaterial({
      name: 'MinimapQuad',
      baseColor: new Color(1, 1, 1),
      transparent: true,
      opacity: 0.92,
    });
    this.quadMaterial.baseColorMap = this.target.textures[0];
    this.quadMaterial.depthTest = false;
    this.quadMaterial.depthWrite = false;
    // Double sided, and not out of carelessness. The overlay camera uses
    // top = 0 with bottom = height so that Y grows downwards like CSS, which
    // makes the projection a mirror: its determinant is negative and every
    // triangle's winding flips. With front face culling the quad is submitted,
    // rasterised and thrown away — a draw call that draws nothing.
    this.quadMaterial.side = 'double';
    // O render target guarda cor JA tonemapeada e codificada em sRGB. O passe
    // de composicao desenha direto para a tela, onde o proprio shader aplica
    // tonemap e sRGB de novo — codificar duas vezes lava a imagem inteira.
    // Decodificar na amostragem desfaz exatamente a primeira das duas.
    this.quadMaterial.srgbDecode = true;

    /** @type {Mesh} */
    this.quad = new Mesh(createPlane(1, 1, 1, 1), this.quadMaterial);
    this.quad.frustumCulled = false;
    this.overlayScene.add(this.quad);

    this._layoutWidth = 0;
    this._layoutHeight = 0;
  }

  /**
   * Widest span of the circuit on the ground plane.
   * @private
   * @returns {number}
   */
  _trackExtent() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const sample of this.track.samples) {
      const p = sample.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return Math.max(maxX - minX, maxZ - minZ);
  }

  /**
   * Places the overlay quad for the current canvas size.
   * @param {number} width Drawing buffer width in pixels.
   * @param {number} height
   */
  layout(width, height) {
    if (width === this._layoutWidth && height === this._layoutHeight) return;
    this._layoutWidth = width;
    this._layoutHeight = height;

    // Pixel space with the origin at the top left, matching CSS.
    this.overlayCamera.left = 0;
    this.overlayCamera.right = width;
    this.overlayCamera.top = 0;
    this.overlayCamera.bottom = height;
    this.overlayCamera.updateProjection();
    this.overlayCamera.updateMatrix();
    this.overlayCamera.updateWorldMatrix(true);

    const s = this.screenSize;
    this.quad.scale.set(s, s, 1);
    // Top right corner. Z is pushed in front of the camera: the overlay camera
    // sits at the origin looking down -Z, so a quad left at z = 0 would be
    // exactly at the eye and never rasterise.
    this.quad.position.set(width - this.margin - s * 0.5, this.margin + s * 0.5, -0.5);
    this.quad.updateMatrix();
    this.quad.updateWorldMatrix(true);
  }

  /**
   * Renders the map from above the kart.
   *
   * @param {import('../../../src/scene/Scene.js').Scene} scene World scene.
   * @param {Vec3} focus Position to centre on.
   * @param {number} heading Kart heading in radians, used when rotating.
   */
  render(scene, focus, heading) {
    if (this.enabled === false) return;

    const camera = this.camera;
    // Straight down from well above, so nothing on the circuit clips the near
    // plane even on the highest part of the track.
    camera.position.set(focus.x, focus.y + 220, focus.z);

    // The orientation is composed explicitly instead of via lookAt, because
    // Node3D.lookAt always uses world up — pointing a camera straight down is
    // exactly the degenerate case it cannot express, and there would be no way
    // to say which direction should end up at the top of the map.
    //
    // Rx(-90) tips the camera's -Z (its view direction) down to -Y; Ry(yaw)
    // then spins the map about the vertical.
    const yaw = this.rotateWithKart ? heading : 0;
    _yawQuat.setFromAxisAngle(_axisY, yaw);
    _pitchQuat.setFromAxisAngle(_axisX, -Math.PI * 0.5);
    camera.quaternion.copy(_yawQuat).multiply(_pitchQuat);

    camera.updateMatrix();
    camera.updateWorldMatrix(true);

    // Fundo proprio durante o passe: o ceu da cena e claro e a pista some nele.
    // Trocado e restaurado em volta do render para nao afetar o mundo.
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    scene.background = this.background;
    scene.fog = null; // nevoa num mapa de 230 m de lado so apaga a pista
    this.renderer.renderToTarget(scene, camera, this.target);
    scene.background = previousBackground;
    scene.fog = previousFog;
  }

  /**
   * Draws the map texture over the frame. Call after the main render, with
   * `autoClear` off so the world underneath survives.
   */
  composite() {
    if (this.enabled === false) return;
    const renderer = this.renderer;

    // HDR is switched off for this pass, not as an optimisation but because it
    // is the only way to draw over a finished frame. With HDR on, a render goes
    // scene -> HDR target -> post -> screen, and that final blit covers the
    // whole screen: compositing an overlay through it would erase the world
    // underneath. With it off the pass writes to the default framebuffer
    // directly, and `autoClear = false` keeps what is already there.
    const previousClear = renderer.autoClear;
    const previousHdr = renderer.hdrEnabled;
    renderer.autoClear = false;
    renderer.hdrEnabled = false;

    renderer.render(this.overlayScene, this.overlayCamera);

    renderer.hdrEnabled = previousHdr;
    renderer.autoClear = previousClear;
  }

  /** @param {boolean} value */
  setEnabled(value) {
    this.enabled = value === true;
  }

  /** Frees the render target. */
  dispose() {
    this.target.dispose();
    this.quad.geometry.dispose(this.gl);
  }
}
