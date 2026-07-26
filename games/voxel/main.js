/**
 * Voxel core — bootstrap.
 *
 * Wires the voxel systems onto the engine and runs the frame loop. This file is
 * intentionally the only place that knows about both worlds: everything under
 * `src/` is engine agnostic apart from the material and the chunk uploader.
 *
 * Rendering is configured deliberately flat: no HDR target, no shadow maps, no
 * clustered lighting. A voxel world bakes its own light into the mesh, so those
 * passes would cost real time and change nothing on screen.
 */

import { Engine } from '../../src/core/Engine.js';
import { DirectionalLight } from '../../src/scene/Light.js';
import { Color } from '../../src/math/Color.js';
import { DebugRenderer } from '../../src/render/DebugRenderer.js';

import { World } from './src/World.js';
import { ChunkManager } from './src/ChunkManager.js';
import { VoxelMaterial } from './src/VoxelMaterial.js';
import { buildBlockAtlas } from './src/TextureAtlas.js';
import { Player } from './src/Player.js';
import { Interaction } from './src/Interaction.js';
import { findSpawn, SEA_LEVEL, BIOME_NAMES, sampleColumn } from './src/WorldGen.js';
import { blockName } from './src/Blocks.js';

/** Length of a full day, in seconds. */
const DAY_LENGTH = 600;

/**
 * The game.
 */
class VoxelGame {
  constructor(canvas, hud) {
    this.hud = hud;

    const seed = readSeedFromURL();

    this.engine = new Engine({
      canvas,
      antialias: true,
      // Flat forward rendering: the voxel material does its own lighting.
      hdr: false,
      shadows: false,
      clustered: false,
      stats: false,
      maxPixelRatio: 1.5,
    });

    this.gl = this.engine.gl;
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.camera.fov = 75;
    this.camera.near = 0.1;
    this.camera.far = 640;
    this.camera.updateProjection();

    // --- world
    this.world = new World({ seed });

    const atlas = buildBlockAtlas(this.gl);
    this.atlas = atlas.texture;

    this.material = new VoxelMaterial({ atlas: this.atlas });
    this.waterMaterial = new VoxelMaterial({ atlas: this.atlas, water: true });

    this.chunks = new ChunkManager({
      world: this.world,
      scene: this.scene,
      material: this.material,
      waterMaterial: this.waterMaterial,
      gl: this.gl,
      renderDistance: readIntFromURL('distance', 8),
    });

    // --- sky and sun
    this.sun = new DirectionalLight();
    this.sun.intensity = 1.0;
    this.sun.castShadow = false;
    this.scene.add(this.sun);

    this.scene.ambientLight.set(0.62, 0.70, 0.86);
    this.scene.ambientIntensity = 0.34;

    this.skyColor = new Color(0.52, 0.72, 1.0);
    this.scene.background = this.skyColor;
    this.scene.setFogExp2(new Color(0.52, 0.72, 1.0), 0.0055);
    this.scene.fog.maxOpacity = 0.94;

    // --- player
    const spawn = findSpawn(seed);
    this.player = new Player({
      world: this.world,
      camera: this.camera,
      input: this.engine.input,
    });
    this.player.setPosition(spawn.x, spawn.y, spawn.z);
    this.player.yaw = 0.6;
    this.player.pitch = -0.12;

    this.debug = new DebugRenderer(this.gl, this.engine.renderer);

    this.interaction = new Interaction({
      world: this.world,
      player: this.player,
      camera: this.camera,
      input: this.engine.input,
      debug: this.debug,
    });

    /** @type {number} World time in seconds; starts mid morning. */
    this.timeOfDay = DAY_LENGTH * 0.32;
    /** @type {boolean} */
    this.dayCycleRunning = true;
    /** @type {boolean} */
    this.showDebug = true;
    /** @type {boolean} */
    this.paused = false;

    this._hudTimer = 0;
    this._spawnSettled = false;

    this._bindEvents(canvas);

    this.engine.onUpdate((dt) => this.update(dt));
    this.engine.onRender(() => this.debug.render(this.camera));
  }

  /** @private */
  _bindEvents(canvas) {
    const input = this.engine.input;

    // While the pointer is locked the game owns the keyboard, so Ctrl+W does not
    // close the tab mid-dig and Ctrl+D does not open a bookmark dialog. The
    // Keyboard Lock API only grants this from a user gesture, which is why it
    // rides along with the click that starts play rather than running at boot.
    input.captureMode = 'pointerlock';
    input.captureAllShortcuts = true;

    canvas.addEventListener('mousedown', () => {
      if (!input.pointerLocked) {
        input.requestPointerLock();
        input.enterGameMode(canvas);
      }
    });

    // Right click must not open the browser menu while playing.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || e.code === 'Backquote') {
        this.showDebug = !this.showDebug;
        this.hud.debugPanel.style.display = this.showDebug ? '' : 'none';
        e.preventDefault();
      } else if (e.code === 'KeyP') {
        this.paused = !this.paused;
      } else if (e.code === 'KeyN') {
        this.dayCycleRunning = !this.dayCycleRunning;
      } else if (e.code === 'KeyH') {
        this.hud.root.classList.toggle('hidden');
      } else if (e.code === 'BracketLeft') {
        this.chunks.setRenderDistance(this.chunks.renderDistance - 1);
      } else if (e.code === 'BracketRight') {
        this.chunks.setRenderDistance(this.chunks.renderDistance + 1);
      }
    });
  }

  /**
   * One simulation step.
   * @param {number} dt
   */
  update(dt) {
    if (this.paused) return;

    // Clamp: a long tab switch must not teleport the player through the floor.
    const step = dt > 0.1 ? 0.1 : dt;

    if (this.dayCycleRunning) {
      this.timeOfDay = (this.timeOfDay + step) % DAY_LENGTH;
    }
    this._updateSky();

    // Hold the player still until the ground beneath them exists, otherwise
    // they fall through the world while the first chunks are still generating.
    if (this.player.suspended) {
      if (this.world.getChunkAt(Math.floor(this.player.body.x), Math.floor(this.player.body.z)) !== null) {
        this._spawnSettled = this.player.settle();
      }
    }

    this.player.update(step);
    this.chunks.update(this.player.body.x, this.player.body.z, step);
    this.interaction.update(step);

    // Underwater tint follows the camera, not the feet.
    const underwater = this.player.headInLiquid ? 1 : 0;
    this.material.setUnderwater(underwater);
    this.waterMaterial.setUnderwater(underwater);

    this._hudTimer -= step;
    if (this._hudTimer <= 0) {
      this._hudTimer = 0.12;
      this._updateHUD();
    }
  }

  /**
   * Drives the sun, sky colour and fog from the time of day.
   * @private
   */
  _updateSky() {
    const t = this.timeOfDay / DAY_LENGTH;
    const angle = t * Math.PI * 2 - Math.PI * 0.5;

    const sunY = Math.sin(angle);
    const sunX = Math.cos(angle) * 0.6;
    const sunZ = Math.cos(angle) * 0.8;

    this.sun.position.set(sunX * 200, sunY * 200, sunZ * 200);
    if (this.sun.target !== undefined && this.sun.target.set !== undefined) {
      this.sun.target.set(0, 0, 0);
    }
    this.sun.updateMatrix();

    // Daylight ramps through dawn and dusk instead of switching.
    const daylight = clamp01((sunY + 0.18) / 0.42);
    const dusk = daylight * (1 - daylight) * 4; // peaks at the horizon

    this.material.setDaylight(daylight);
    this.waterMaterial.setDaylight(daylight);

    // Sun colour: warm at the horizon, neutral at noon.
    this.sun.color.set(
      1.0,
      0.72 + daylight * 0.28,
      0.52 + daylight * 0.48,
    );
    this.sun.intensity = 0.35 + daylight * 0.85;

    // Sky and fog share a colour so the horizon dissolves cleanly.
    const nightR = 0.035, nightG = 0.05, nightB = 0.09;
    const dayR = 0.48, dayG = 0.68, dayB = 0.98;
    const r = lerp(nightR, dayR, daylight) + dusk * 0.30;
    const g = lerp(nightG, dayG, daylight) + dusk * 0.10;
    const b = lerp(nightB, dayB, daylight) - dusk * 0.02;

    this.skyColor.set(r, g, b);
    if (this.scene.fog !== null) this.scene.fog.color.set(r, g, b);

    this.scene.ambientIntensity = 0.10 + daylight * 0.26;

    this.timeLabel = formatClock(t);
    this.daylight = daylight;
  }

  /** @private */
  _updateHUD() {
    if (!this.showDebug) return;

    const info = this.engine.renderer.info;
    const stats = this.chunks.stats;
    const body = this.player.body;
    const hit = this.interaction.hit;

    const bx = Math.floor(body.x);
    const bz = Math.floor(body.z);
    const column = sampleColumn(bx, bz, this.world.seed);

    const rows = [
      ['fps', Math.round(this.engine.time.fps)],
      ['frame', this.engine.time.smoothDelta !== undefined
        ? (this.engine.time.smoothDelta * 1000).toFixed(1) + ' ms'
        : '-'],
      ['draw calls', info.calls],
      ['triangulos', formatNumber(info.triangles)],
      ['posicao', body.x.toFixed(1) + ' / ' + body.y.toFixed(1) + ' / ' + body.z.toFixed(1)],
      ['chunk', (bx >> 4) + ', ' + (bz >> 4)],
      ['bioma', BIOME_NAMES[column.biome] || '?'],
      ['luz (ceu/bloco)', this.world.getSkyLight(bx, Math.floor(body.y + 1), bz) + ' / ' +
        this.world.getBlockLight(bx, Math.floor(body.y + 1), bz)],
      ['chunks', stats.chunksLoaded + ' carregados, ' + stats.pendingGenerate + ' na fila'],
      ['secoes', stats.sectionsDrawn + ' malhas'],
      ['workers', stats.generating + ' gerando, ' + stats.meshing + ' meshing'],
      ['fila de luz', formatNumber(stats.lightQueue)],
      ['agua', stats.fluidQueue > 0
        ? formatNumber(stats.fluidQueue) + ' na fila, ' + stats.fluidChanged + ' movendo'
        : 'parada'],
      ['triangulos residentes', formatNumber(Math.round(stats.trianglesResident))],
      ['alvo', hit.hit ? blockName(hit.block) + ' @ ' + hit.x + ',' + hit.y + ',' + hit.z : '-'],
      ['selecionado', this.interaction.selectedName],
      ['modo', this.player.flying ? 'voo' : (this.player.inLiquid ? 'nadando' : 'caminhando')],
      ['hora', this.timeLabel + (this.dayCycleRunning ? '' : ' (pausado)')],
      ['distancia', this.chunks.renderDistance + ' chunks'],
      ['seed', this.world.seed],
    ];

    let html = '';
    for (let i = 0; i < rows.length; i++) {
      html += '<div class="row"><span>' + rows[i][0] + '</span><b>' + rows[i][1] + '</b></div>';
    }
    this.hud.debugPanel.innerHTML = html;

    this.hud.blockLabel.textContent = this.interaction.selectedName;
  }

  /** Starts the loop and hides the loading screen once the ground is ready. */
  start() {
    this.engine.start();

    const waitForGround = () => {
      if (this.chunks.stats.sectionsDrawn > 0 && this._spawnSettled) {
        this.hud.loading.classList.add('done');
        setTimeout(() => { this.hud.loading.style.display = 'none'; }, 420);
        return;
      }
      const pending = this.chunks.stats.pendingGenerate;
      const total = Math.max(1, this.chunks._initialTarget);
      const progress = Math.round((1 - pending / total) * 100);
      this.hud.loadingBar.style.width = Math.max(4, Math.min(100, progress)) + '%';
      requestAnimationFrame(waitForGround);
    };
    waitForGround();
  }
}

/* --------------------------------------------------------------- helpers */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

function formatNumber(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatClock(t) {
  const totalMinutes = Math.floor(t * 24 * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function readSeedFromURL() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('seed');
  if (raw === null) return 1337;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber | 0;
  // Hash a text seed so "minecraft" is a valid world name.
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function readIntFromURL(name, fallback) {
  const params = new URLSearchParams(location.search);
  const raw = params.get(name);
  if (raw === null) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------ boot */

function boot() {
  const canvas = document.getElementById('viewport');
  const hud = {
    root: document.getElementById('hud'),
    debugPanel: document.getElementById('debug'),
    loading: document.getElementById('loading'),
    loadingBar: document.getElementById('loading-bar'),
    blockLabel: document.getElementById('block-label'),
  };

  try {
    const game = new VoxelGame(canvas, hud);
    game.start();
    // Handy for poking at the world from the console.
    window.game = game;
  } catch (error) {
    const fatal = document.getElementById('fatal');
    fatal.style.display = 'flex';
    fatal.querySelector('p').textContent = String(error && error.message ? error.message : error);
    // Still log it: the message alone rarely explains a WebGL failure.
    console.error(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
