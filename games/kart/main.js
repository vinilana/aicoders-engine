/**
 * Circuito — kart racer.
 *
 * Exists to drive four parts of the engine that no other example touches:
 * render-to-texture and an orthographic camera (the minimap), positional audio
 * (a synthesised engine note pitched by RPM), analogue gamepad input, and rigid
 * body dynamics under sustained high speed contact.
 *
 * Everything is procedural. There is no asset of any kind.
 */

import { Engine } from '../../src/core/Engine.js';
import { Vec3 } from '../../src/math/Vec3.js';
import { Quat } from '../../src/math/Quat.js';
import { Color } from '../../src/math/Color.js';
import { Mesh } from '../../src/scene/Mesh.js';
import { Node3D } from '../../src/scene/Node3D.js';
import { InstancedMesh } from '../../src/scene/InstancedMesh.js';
import { DirectionalLight } from '../../src/scene/Light.js';
import { StandardMaterial } from '../../src/render/materials/StandardMaterial.js';
import { CollisionWorld } from '../../src/physics/CollisionWorld.js';
import { AudioEngine } from '../../src/audio/AudioEngine.js';
import { createCone, createCylinder, createBox } from '../../src/geometry/Primitives.js';
import { noiseTexture, noiseHeightField, normalMapFromHeight } from '../../src/geometry/ProceduralTexture.js';
import { clamp, lerp } from '../../src/math/MathUtils.js';

import { Track, ROAD_HALF_WIDTH } from './src/Track.js';
import { Vehicle } from './src/Vehicle.js';
import { KartInput } from './src/KartInput.js';
import { KartModel } from './src/KartModel.js';
import { Minimap, MINIMAP_LAYER } from './src/Minimap.js';
import { KartAudio } from './src/EngineAudio.js';
import { Race, RaceState, formatTime } from './src/Race.js';
import { Ghost } from './src/Ghost.js';

/** Everything visible carries layer 1; the minimap pass looks for layer 4. */
const WORLD_LAYER = 1;
const TRACK_LAYERS = WORLD_LAYER | MINIMAP_LAYER;

const _v = new Vec3();
const _forward = new Vec3();
const _up = new Vec3();
const _desired = new Vec3();
const _look = new Vec3();
const _wheelPos = new Vec3();
const _q = new Quat();

class KartGame {
  constructor(canvas, hud) {
    this.hud = hud;

    this.engine = new Engine({
      canvas,
      antialias: true,
      shadows: true,
      hdr: true,
      clustered: false,
      stats: false,
      maxPixelRatio: 1.5,
    });

    this.gl = this.engine.gl;
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.camera.fov = 68;
    this.camera.near = 0.25;
    this.camera.far = 900;
    this.camera.updateProjection();

    this.track = new Track();
    this.world = new CollisionWorld({
      gravity: new Vec3(0, -22, 0),
      // A kart at 30 m/s covers half a metre per frame at 60fps. Small substeps
      // are what keep the suspension stable and stop a barrier hit exploding.
      maxSubStepTime: 1 / 180,
      maxSubSteps: 8,
    });

    this._buildSky();
    this._buildTrack();
    this._buildScenery();

    this.vehicle = new Vehicle({ world: this.world, mass: 180 });
    this.model = new KartModel({
      bodyColor: new Color(0.88, 0.14, 0.11),
      layers: TRACK_LAYERS,
    });
    this.scene.add(this.model.root);

    this.ghost = new Ghost();
    this.ghostModel = new KartModel({
      bodyColor: new Color(0.25, 0.62, 0.95),
      accentColor: new Color(0.12, 0.22, 0.32),
      opacity: 0.42,
      layers: TRACK_LAYERS,
    });
    this.ghostModel.setVisible(false);
    this.scene.add(this.ghostModel.root);

    this.race = new Race({ track: this.track, totalLaps: 3 });
    this.input = new KartInput({ input: this.engine.input, canvas });

    this.minimap = new Minimap({
      renderer: this.engine.renderer,
      gl: this.gl,
      track: this.track,
    });

    // Engine does not own an AudioEngine — audio is opt in, so the game
    // creates it. Built here rather than on the first gesture because the
    // AudioContext starts suspended anyway and `resume()` is what unlocks it.
    this.audioEngine = new AudioEngine({ unlockOnGesture: true });
    this.audio = new KartAudio({ audio: this.audioEngine, node: this.model.root });
    /** @type {boolean} Audio needs a gesture; this tracks whether we have one. */
    this.audioStarted = false;

    /** @type {number} Chase camera distance, grows with speed. */
    this.cameraDistance = 7.4;
    /** @type {boolean} */
    this.showGhost = true;
    /** @type {number} Speed last frame, to detect impacts. */
    this._lastSpeed = 0;

    this._placeOnGrid();
    this._bindEvents(canvas);

    this.engine.onUpdate((dt) => this.update(dt));
    this.engine.onRender(() => this.renderOverlays());
  }

  /* ------------------------------------------------------------- world */

  /** @private */
  _buildSky() {
    this.scene.background = new Color(0.42, 0.62, 0.86);
    this.scene.ambientLight.set(0.55, 0.66, 0.85);
    this.scene.ambientIntensity = 0.42;
    this.scene.setFogExp2(new Color(0.46, 0.62, 0.82), 0.0022);
    this.scene.fog.maxOpacity = 0.9;

    this.sun = new DirectionalLight();
    this.sun.position.set(90, 130, 60);
    this.sun.target.set(0, 0, 0);
    this.sun.color.set(1.0, 0.96, 0.88);
    this.sun.intensity = 2.6;
    this.sun.castShadow = true;
    this.scene.add(this.sun);
  }

  /** @private */
  _buildTrack() {
    const gl = this.gl;

    const asphaltColor = noiseTexture(gl, 512, 4, { frequency: 9 });
    const asphaltNormal = normalMapFromHeight(gl, noiseHeightField(512, 11, 4, 6.5), 512, 1.4);

    // --- road ---------------------------------------------------------
    const roadGeometry = this.track.buildRoadGeometry();
    const roadMaterial = new StandardMaterial({
      name: 'Asphalt',
      baseColor: new Color(0.20, 0.21, 0.23),
      roughness: 0.86,
      metallic: 0.0,
    });
    roadMaterial.baseColorMap = asphaltColor;
    roadMaterial.normalMap = asphaltNormal;
    roadMaterial.normalScale = 0.55;

    const road = new Mesh(roadGeometry, roadMaterial);
    road.name = 'Road';
    road.receiveShadow = true;
    road.castShadow = false;
    road.layers = TRACK_LAYERS;
    road.matrixAutoUpdate = false;
    road.updateMatrix();
    this.scene.add(road);

    this.roadCollider = this.world.addStatic(
      { positions: roadGeometry.getAttribute('aPosition').data, indices: roadGeometry.index.data },
      { friction: 1.0 });

    // --- barriers -----------------------------------------------------
    const barrierGeometry = this.track.buildBarrierGeometry();
    const barrierMaterial = new StandardMaterial({
      name: 'Barrier',
      baseColor: new Color(0.90, 0.90, 0.92),
      roughness: 0.55,
      metallic: 0.05,
    });
    barrierMaterial.side = 'double';

    const barriers = new Mesh(barrierGeometry, barrierMaterial);
    barriers.name = 'Barriers';
    barriers.castShadow = true;
    barriers.receiveShadow = true;
    barriers.layers = TRACK_LAYERS;
    barriers.matrixAutoUpdate = false;
    barriers.updateMatrix();
    this.scene.add(barriers);

    this.world.addStatic(
      { positions: barrierGeometry.getAttribute('aPosition').data, indices: barrierGeometry.index.data },
      { friction: 0.25, restitution: 0.32 });

    // --- ground -------------------------------------------------------
    const groundGeometry = this.track.buildGroundGeometry(340, 96);
    const groundMaterial = new StandardMaterial({
      name: 'Ground',
      baseColor: new Color(0.29, 0.42, 0.22),
      roughness: 0.95,
      metallic: 0.0,
    });
    groundMaterial.baseColorMap = noiseTexture(gl, 512, 5, { frequency: 6 });

    const ground = new Mesh(groundGeometry, groundMaterial);
    ground.name = 'Ground';
    ground.receiveShadow = true;
    ground.layers = WORLD_LAYER; // never in the minimap
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    this.scene.add(ground);

    const groundCollider = this.world.addStatic(
      { positions: groundGeometry.getAttribute('aPosition').data, indices: groundGeometry.index.data },
      { friction: 0.75 });
    // The vehicle reads this to know the tyres left the racing surface.
    groundCollider.userData.offTrack = true;

    // --- start line ---------------------------------------------------
    const start = this.track.samples[0];
    const line = new Mesh(createBox(ROAD_HALF_WIDTH * 2, 0.04, 1.1), new StandardMaterial({
      name: 'StartLine',
      baseColor: new Color(0.95, 0.95, 0.97),
      roughness: 0.5,
    }));
    line.position.copy(start.position).addScaled(start.normal, 0.03);
    _q.setFromAxisAngle(new Vec3(0, 1, 0), Math.atan2(start.forward.x, start.forward.z));
    line.quaternion.copy(_q);
    line.layers = TRACK_LAYERS;
    line.matrixAutoUpdate = false;
    line.updateMatrix();
    this.scene.add(line);
  }

  /**
   * Trees and marker cones, instanced along both sides of the circuit.
   * @private
   */
  _buildScenery() {
    const samples = this.track.samples;
    const root = new Node3D('Scenery');
    this.scene.add(root);

    const treeCount = 420;
    const trunkGeometry = createCylinder(0.22, 0.3, 3.2, 7, 1, false);
    const foliageGeometry = createCone(1.9, 5.2, 8, 1, false);

    const trunks = new InstancedMesh(trunkGeometry, new StandardMaterial({
      name: 'Trunk', baseColor: new Color(0.32, 0.23, 0.15), roughness: 0.92,
    }), treeCount);
    const foliage = new InstancedMesh(foliageGeometry, new StandardMaterial({
      name: 'Foliage', baseColor: new Color(0.17, 0.36, 0.18), roughness: 0.88,
    }), treeCount);
    trunks.layers = WORLD_LAYER;
    foliage.layers = WORLD_LAYER;
    trunks.castShadow = true;
    foliage.castShadow = true;

    const position = new Vec3();
    const scale = new Vec3();
    const rotation = new Quat();
    let seed = 20260725;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < treeCount; i++) {
      const sample = samples[Math.floor(rand() * samples.length)];
      const side = rand() < 0.5 ? -1 : 1;
      const offset = ROAD_HALF_WIDTH + 6 + rand() * 26;
      position.copy(sample.position).addScaled(sample.right, offset * side);
      position.y -= 1.2;

      rotation.setFromAxisAngle(new Vec3(0, 1, 0), rand() * Math.PI * 2);
      const s = 0.75 + rand() * 0.7;

      scale.set(s, s, s);
      trunks.setTransformAt(i, position, rotation, scale);

      position.y += 3.1 * s;
      foliage.setTransformAt(i, position, rotation, scale);
    }
    trunks.setCount(treeCount);
    foliage.setCount(treeCount);
    root.add(trunks);
    root.add(foliage);

    // Marker cones just inside the barrier at every checkpoint: they read as
    // corner markers and give the minimap something to show.
    const coneCount = this.track.checkpoints.length * 2;
    const cones = new InstancedMesh(createCone(0.28, 0.72, 8, 1, false), new StandardMaterial({
      name: 'Cone', baseColor: new Color(0.94, 0.36, 0.06), roughness: 0.6,
    }), coneCount);
    cones.layers = TRACK_LAYERS;
    cones.castShadow = true;

    let c = 0;
    scale.set(1, 1, 1);
    rotation.identity();
    for (const checkpoint of this.track.checkpoints) {
      for (const side of [-1, 1]) {
        position.copy(checkpoint.position)
          .addScaled(checkpoint.right, (ROAD_HALF_WIDTH - 0.7) * side);
        position.y += 0.36;
        cones.setTransformAt(c++, position, rotation, scale);
      }
    }
    cones.setCount(coneCount);
    root.add(cones);
  }

  /* -------------------------------------------------------------- race */

  /** @private */
  _placeOnGrid() {
    const position = new Vec3();
    const heading = this.track.gridSlot(0, position);
    this.vehicle.reset(position, heading);
    this.race.reset();
    this.ghost.beginLap();
    this.ghost.restart();
  }

  /** @private */
  _bindEvents(canvas) {
    const input = this.engine.input;

    // Audio and pointer capture both need a gesture, so they share one.
    const onGesture = () => {
      if (!this.audioStarted && this.audioEngine.supported === true) {
        this.audioEngine.resume();
        this.audioStarted = this.audio.start();
      }
    };
    canvas.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture, { once: false });

    // The game owns these keys; without capture Space scrolls the page and
    // Shift can trip sticky keys.
    input.captureKeys(['Space', 'ShiftLeft', 'ShiftRight', 'KeyR', 'KeyM', 'KeyG', 'KeyC']);
    input.setCaptureMode('focus');
    canvas.setAttribute('tabindex', '0');
    canvas.focus();
    canvas.addEventListener('pointerdown', () => canvas.focus());

    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyM') {
        this.audio.setMuted(!this.audio.muted);
        this.hud.flash(this.audio.muted ? 'som desligado' : 'som ligado');
      } else if (event.code === 'KeyG') {
        this.showGhost = !this.showGhost;
        this.hud.flash(this.showGhost ? 'fantasma visivel' : 'fantasma oculto');
      } else if (event.code === 'KeyC') {
        this.minimap.rotateWithKart = !this.minimap.rotateWithKart;
        this.hud.flash(this.minimap.rotateWithKart ? 'mapa gira' : 'mapa fixo');
      } else if (event.code === 'KeyN') {
        this.minimap.setEnabled(!this.minimap.enabled);
      }
    });
  }

  /* ------------------------------------------------------------ update */

  update(dt) {
    const step = dt > 0.05 ? 0.05 : dt;

    this.input.update(step);
    if (this.input.resetPressed) this._respawn();

    const vehicle = this.vehicle;
    const body = vehicle.body;

    // The countdown holds the kart on the line: controls are ignored and the
    // brakes are on, so it does not creep forward on the banking.
    if (this.race.locked) {
      vehicle.setControls(0, 1, 0, true);
    } else {
      vehicle.setControls(this.input.throttle, this.input.brake,
        this.input.steer, this.input.handbrake);
    }

    vehicle.update(step);
    this.world.step(step);

    _forward.set(0, 0, 1).applyQuat(body.quaternion);
    _up.set(0, 1, 0).applyQuat(body.quaternion);

    this.race.update(step, body.position, _forward);

    // Ghost: record while racing, promote on a new best.
    if (this.race.state === RaceState.RACING) {
      this.ghost.record(step, body.position, body.quaternion);
      if (this.race.lapCompleted) {
        this.ghost.endLap(this.race.lastLap, this.race.newBest);
        this.ghost.restart();
        this.hud.flash(this.race.newBest
          ? 'melhor volta ' + formatTime(this.race.lastLap)
          : 'volta ' + formatTime(this.race.lastLap));
      }
    }
    this.ghost.update(step);

    this._updateModel();
    this._updateGhostModel();
    this._updateCamera(step);
    this._updateAudio(step);

    // A sharp drop in forward speed means something was hit.
    const speedDrop = this._lastSpeed - Math.abs(vehicle.speed);
    if (speedDrop > 4.5) {
      this.audio.impact(clamp(speedDrop / 14, 0, 1), body.position);
    }
    this._lastSpeed = Math.abs(vehicle.speed);

    // Fell off the world.
    if (body.position.y < -30) this._respawn();

    this.hud.update(this, step);
  }

  /** @private */
  _respawn() {
    // Back onto the centre line at the nearest point, facing the right way.
    const near = this.track.nearest(this.vehicle.body.position);
    _v.copy(near.sample.position).addScaled(near.sample.normal, 0.8);
    const heading = Math.atan2(near.sample.forward.x, near.sample.forward.z);
    this.vehicle.reset(_v, heading);
    this.hud.flash('reposicionado');
  }

  /** @private */
  _updateModel() {
    const vehicle = this.vehicle;
    this.model.setTransform(vehicle.body.position, vehicle.body.quaternion);
    for (let i = 0; i < vehicle.wheels.length; i++) {
      vehicle.getWheelPosition(i, _wheelPos);
      this.model.setWheel(i, _wheelPos, vehicle.wheels[i].spin,
        vehicle.steerAngle, vehicle.body.quaternion);
    }
  }

  /** @private */
  _updateGhostModel() {
    const visible = this.showGhost && this.ghost.playing && this.ghost.hasGhost;
    this.ghostModel.setVisible(visible);
    if (!visible) return;
    this.ghostModel.setTransform(this.ghost.position, this.ghost.quaternion);
  }

  /**
   * Chase camera.
   *
   * Two details do the work. The camera chases a point behind the kart rather
   * than being parented to it, so the kart can slide sideways under the camera
   * and the drift is visible. And the field of view opens with speed, which is
   * most of what makes fast feel fast.
   * @private
   */
  _updateCamera(dt) {
    const body = this.vehicle.body;
    const speed = Math.abs(this.vehicle.speed);

    _forward.set(0, 0, 1).applyQuat(body.quaternion);
    _up.set(0, 1, 0);

    const distance = this.cameraDistance + speed * 0.085;
    const height = 3.0 + speed * 0.045;

    _desired.copy(body.position)
      .addScaled(_forward, -distance)
      .addScaled(_up, height);

    // Exponential smoothing: frame rate independent, unlike a raw lerp factor.
    const follow = 1 - Math.exp(-7.5 * dt);
    this.camera.position.lerp(_desired, follow);

    _look.copy(body.position).addScaled(_forward, 6.5).addScaled(_up, 0.9);
    this.camera.lookAt(_look.x, _look.y, _look.z);
    this.camera.updateMatrix();
    this.camera.updateWorldMatrix(true);

    const targetFov = 68 + clamp(speed / this.vehicle.maxSpeed, 0, 1) * 14;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 3 * dt);
    this.camera.updateProjection();
  }

  /** @private */
  _updateAudio(dt) {
    if (!this.audioStarted) return;
    const audio = this.audioEngine;
    if (typeof audio.setListenerFromCamera === 'function') {
      audio.setListenerFromCamera(this.camera);
    }
    this.audio.update(this.vehicle.rpm, this.vehicle.slip, dt, this.vehicle.body.position);
  }

  /** Draws the minimap over the finished frame. */
  renderOverlays() {
    const gl = this.gl;
    this.minimap.layout(gl.drawingBufferWidth, gl.drawingBufferHeight);

    const body = this.vehicle.body;
    _forward.set(0, 0, 1).applyQuat(body.quaternion);
    const heading = Math.atan2(_forward.x, _forward.z);

    this.minimap.render(this.scene, body.position, heading);
    this.minimap.composite();
  }

  start() {
    this.engine.start();
    this.hud.hideLoading();
  }
}

/* ------------------------------------------------------------------ HUD */

class HUD {
  constructor(dom) {
    this.dom = dom;
    this._flashTimer = 0;
    this._hudTimer = 0;
  }

  flash(text) {
    this.dom.flash.textContent = text;
    this.dom.flash.classList.add('visible');
    this._flashTimer = 2.2;
  }

  hideLoading() {
    this.dom.loading.classList.add('done');
    setTimeout(() => { this.dom.loading.style.display = 'none'; }, 420);
  }

  update(game, dt) {
    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      if (this._flashTimer <= 0) this.dom.flash.classList.remove('visible');
    }

    this._hudTimer -= dt;
    if (this._hudTimer > 0) return;
    this._hudTimer = 0.06;

    const race = game.race;
    const vehicle = game.vehicle;

    this.dom.speed.textContent = String(Math.round(vehicle.speedKmh));
    this.dom.lap.textContent = Math.min(race.lap + 1, race.totalLaps) + ' / ' + race.totalLaps;
    this.dom.lapTime.textContent = formatTime(race.lapTime);
    this.dom.bestTime.textContent = formatTime(race.bestLap);
    this.dom.lastTime.textContent = formatTime(race.lastLap);

    // Rev bar.
    this.dom.rev.style.width = Math.round(vehicle.rpm * 100) + '%';
    this.dom.rev.classList.toggle('redline', vehicle.rpm > 0.88);

    this.dom.device.textContent = game.input.device;
    this.dom.grip.textContent = vehicle.groundedWheels + '/4' +
      (vehicle.offTrack ? ' · fora da pista' : '');

    this.dom.wrongWay.classList.toggle('visible',
      race.wrongWay && race.state === RaceState.RACING);

    if (race.state === RaceState.COUNTDOWN) {
      const n = Math.ceil(race.countdown);
      this.dom.countdown.textContent = n > 0 ? String(n) : 'VAI!';
      this.dom.countdown.classList.add('visible');
    } else if (race.state === RaceState.FINISHED) {
      this.dom.countdown.textContent = 'FIM · ' + formatTime(race.totalTime);
      this.dom.countdown.classList.add('visible');
    } else {
      this.dom.countdown.classList.remove('visible');
    }
  }
}

/* ----------------------------------------------------------------- boot */

function boot() {
  const canvas = document.getElementById('viewport');
  const dom = {
    speed: document.getElementById('speed'),
    rev: document.getElementById('rev'),
    lap: document.getElementById('lap'),
    lapTime: document.getElementById('lap-time'),
    bestTime: document.getElementById('best-time'),
    lastTime: document.getElementById('last-time'),
    device: document.getElementById('device'),
    grip: document.getElementById('grip'),
    countdown: document.getElementById('countdown'),
    wrongWay: document.getElementById('wrong-way'),
    flash: document.getElementById('flash'),
    loading: document.getElementById('loading'),
  };

  try {
    const hud = new HUD(dom);
    const game = new KartGame(canvas, hud);
    game.start();
    globalThis.kart = game;
  } catch (error) {
    const fatal = document.getElementById('fatal');
    fatal.style.display = 'flex';
    fatal.querySelector('p').textContent = String(error && error.message ? error.message : error);
    console.error(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
