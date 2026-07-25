/**
 * Kart visual, assembled from primitives.
 *
 * Deliberately a handful of boxes and cylinders rather than a loaded model:
 * this example exists to exercise the render-to-texture, audio and gamepad
 * paths, and a mesh file would only add a dependency it does not test. The one
 * thing the visual must get right is that the wheels are separate nodes, so the
 * physics can place them at whatever height the suspension worked out and the
 * body can lean above them.
 */

import { Vec3 } from '../../../src/math/Vec3.js';
import { Quat } from '../../../src/math/Quat.js';
import { Color } from '../../../src/math/Color.js';
import { Node3D } from '../../../src/scene/Node3D.js';
import { Mesh } from '../../../src/scene/Mesh.js';
import { StandardMaterial } from '../../../src/render/materials/StandardMaterial.js';
import { createBox, createCylinder, createSphere } from '../../../src/geometry/Primitives.js';

const _axisX = new Vec3(1, 0, 0);
const _axisY = new Vec3(0, 1, 0);
const _spin = new Quat();
const _steer = new Quat();

/**
 * A kart's meshes, with the wheels reachable for the physics to drive.
 */
export class KartModel {
  /**
   * @param {Object} [options]
   * @param {Color} [options.bodyColor]
   * @param {Color} [options.accentColor]
   * @param {number} [options.opacity=1] Below 1 makes the ghost translucent.
   * @param {number} [options.layers] Layer mask for the whole kart.
   */
  constructor(options = {}) {
    const bodyColor = options.bodyColor || new Color(0.85, 0.16, 0.13);
    const accentColor = options.accentColor || new Color(0.10, 0.11, 0.14);
    const opacity = options.opacity !== undefined ? options.opacity : 1;
    const transparent = opacity < 1;

    /** @type {Node3D} Root; the physics writes its transform. */
    this.root = new Node3D('Kart');

    const bodyMaterial = new StandardMaterial({
      name: 'KartBody',
      baseColor: bodyColor,
      roughness: 0.34,
      metallic: 0.25,
      opacity,
      transparent,
    });
    const darkMaterial = new StandardMaterial({
      name: 'KartTrim',
      baseColor: accentColor,
      roughness: 0.62,
      metallic: 0.1,
      opacity,
      transparent,
    });
    const tyreMaterial = new StandardMaterial({
      name: 'KartTyre',
      baseColor: new Color(0.045, 0.045, 0.05),
      roughness: 0.88,
      metallic: 0.0,
      opacity,
      transparent,
    });

    /** @type {StandardMaterial[]} Kept so the colour can be changed later. */
    this.materials = [bodyMaterial, darkMaterial, tyreMaterial];

    // --- chassis -----------------------------------------------------------
    const floor = new Mesh(createBox(1.28, 0.16, 2.15), darkMaterial);
    floor.position.set(0, 0.0, 0);
    this.root.add(floor);

    const nose = new Mesh(createBox(1.05, 0.22, 0.72), bodyMaterial);
    nose.position.set(0, 0.13, 1.02);
    this.root.add(nose);

    const sidepodL = new Mesh(createBox(0.26, 0.30, 1.15), bodyMaterial);
    sidepodL.position.set(-0.72, 0.16, -0.05);
    this.root.add(sidepodL);

    const sidepodR = new Mesh(createBox(0.26, 0.30, 1.15), bodyMaterial);
    sidepodR.position.set(0.72, 0.16, -0.05);
    this.root.add(sidepodR);

    const seat = new Mesh(createBox(0.62, 0.46, 0.62), darkMaterial);
    seat.position.set(0, 0.30, -0.42);
    this.root.add(seat);

    const engineBlock = new Mesh(createBox(0.52, 0.40, 0.52), darkMaterial);
    engineBlock.position.set(0, 0.26, -1.02);
    this.root.add(engineBlock);

    const wing = new Mesh(createBox(1.15, 0.06, 0.30), bodyMaterial);
    wing.position.set(0, 0.60, -1.16);
    this.root.add(wing);

    // --- driver ------------------------------------------------------------
    const torso = new Mesh(createBox(0.44, 0.50, 0.34), bodyMaterial);
    torso.position.set(0, 0.52, -0.34);
    this.root.add(torso);

    const helmet = new Mesh(createSphere(0.23, 20, 14), new StandardMaterial({
      name: 'Helmet',
      baseColor: new Color(0.93, 0.93, 0.95),
      roughness: 0.18,
      metallic: 0.05,
      opacity,
      transparent,
    }));
    helmet.position.set(0, 0.92, -0.30);
    this.root.add(helmet);
    this.materials.push(helmet.material);

    const visor = new Mesh(createBox(0.30, 0.10, 0.06), new StandardMaterial({
      name: 'Visor',
      baseColor: new Color(0.06, 0.09, 0.14),
      roughness: 0.08,
      metallic: 0.4,
      opacity,
      transparent,
    }));
    visor.position.set(0, 0.94, -0.12);
    this.root.add(visor);
    this.materials.push(visor.material);

    // --- wheels ------------------------------------------------------------
    // Separate nodes under the root, positioned every frame from the
    // suspension result rather than parented at a fixed offset.
    const tyreGeometry = createCylinder(0.34, 0.34, 0.26, 18, 1, false);

    /** @type {Node3D[]} Front left, front right, rear left, rear right. */
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const pivot = new Node3D('Wheel' + i);
      const tyre = new Mesh(tyreGeometry, tyreMaterial);
      // The cylinder stands on Y; lay it on its side so it rolls about X.
      tyre.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.5);
      pivot.add(tyre);
      this.root.add(pivot);
      this.wheels.push(pivot);
    }

    if (options.layers !== undefined) this.setLayers(options.layers);
    this.setShadows(opacity >= 1);
  }

  /**
   * @param {number} mask
   */
  setLayers(mask) {
    this.root.traverse((node) => { node.layers = mask; });
  }

  /**
   * @param {boolean} enabled
   */
  setShadows(enabled) {
    this.root.traverse((node) => {
      if (node.isMesh !== true) return;
      node.castShadow = enabled;
      node.receiveShadow = enabled;
    });
  }

  /**
   * Places a wheel and applies its roll and steering.
   * @param {number} index
   * @param {Vec3} worldPosition
   * @param {number} spin Roll angle in radians.
   * @param {number} steerAngle Steering angle; ignored on the rear pair.
   * @param {Quat} chassisRotation
   */
  setWheel(index, worldPosition, spin, steerAngle, chassisRotation) {
    const pivot = this.wheels[index];
    // The wheels hang off the root, so their transform is expressed in the
    // root's space; converting here keeps the caller in world space.
    pivot.position.copy(worldPosition);
    this.root.worldToLocal(pivot.position);

    _spin.setFromAxisAngle(_axisX, spin);
    if (index < 2 && steerAngle !== 0) {
      _steer.setFromAxisAngle(_axisY, steerAngle);
      pivot.quaternion.copy(_steer).multiply(_spin);
    } else {
      pivot.quaternion.copy(_spin);
    }
  }

  /**
   * @param {Vec3} position
   * @param {Quat} quaternion
   */
  setTransform(position, quaternion) {
    this.root.position.copy(position);
    this.root.quaternion.copy(quaternion);
    this.root.updateMatrix();
    this.root.updateWorldMatrix(true);
  }

  /** @param {boolean} value */
  setVisible(value) {
    this.root.visible = value === true;
  }
}
