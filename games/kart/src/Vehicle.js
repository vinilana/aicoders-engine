/**
 * Kart physics: raycast suspension on a rigid body chassis.
 *
 * This is the standard technique, and the reason it is standard is worth
 * stating. The chassis is one rigid body. Each wheel is not a body at all — it
 * is a ray cast downwards from a mounting point. Where the ray hits, a spring
 * pushes the chassis up and a tyre model pushes it along. Because both forces
 * are applied *at the contact point* rather than at the centre of mass, weight
 * transfer, body roll in corners and squat under acceleration all fall out of
 * the maths for free instead of being animated.
 *
 * The tyre model is the other half. A wheel resists sideways motion far more
 * than forward motion, and that asymmetry is the whole difference between a
 * car and a hovering brick. Grip is capped by a friction circle, so a tyre
 * asked for both maximum braking and maximum cornering gives less of each —
 * which is what makes trail braking and power slides emerge rather than being
 * scripted.
 */

import { Vec3 } from '../../../src/math/Vec3.js';
import { Quat } from '../../../src/math/Quat.js';
import { RigidBody, BodyShape } from '../../../src/physics/RigidBody.js';
import { createSweepHit } from '../../../src/physics/CollisionWorld.js';
import { clamp } from '../../../src/math/MathUtils.js';

/** Module scratch: the update runs every substep and must not allocate. */
const _anchor = new Vec3();
const _down = new Vec3();
const _forward = new Vec3();
const _right = new Vec3();
const _up = new Vec3();
const _pointVel = new Vec3();
const _force = new Vec3();
const _wheelForward = new Vec3();
const _wheelRight = new Vec3();
const _tmp = new Vec3();
const _hit = createSweepHit();
const _q = new Quat();

/** Wheel layout: front left, front right, rear left, rear right. */
const WHEELS = [
  { x: -0.62, z: 0.86, steers: true, drives: false },
  { x: 0.62, z: 0.86, steers: true, drives: false },
  { x: -0.66, z: -0.92, steers: false, drives: true },
  { x: 0.66, z: -0.92, steers: false, drives: true },
];

/**
 * Per wheel state, exposed so the renderer can place the wheel meshes and the
 * HUD can show what the tyres are doing.
 */
class Wheel {
  constructor(config, index) {
    /** @type {number} */
    this.index = index;
    /** @type {Vec3} Mount point in chassis space. */
    this.anchor = new Vec3(config.x, 0.02, config.z);
    /** @type {boolean} */
    this.steers = config.steers;
    /** @type {boolean} */
    this.drives = config.drives;

    /** @type {boolean} True while the ray found ground. */
    this.grounded = false;
    /** @type {number} 0 = fully extended, 1 = bottomed out. */
    this.compression = 0;
    /** @type {Vec3} World contact point. */
    this.contact = new Vec3();
    /** @type {Vec3} World contact normal. */
    this.normal = new Vec3(0, 1, 0);
    /** @type {number} Wheel spin angle, for the visual. */
    this.spin = 0;
    /** @type {number} How much the tyre is sliding sideways, 0..1. */
    this.slip = 0;
    /** @type {number} Suspension length right now. */
    this.length = 0;
  }
}

/**
 * A drivable kart.
 */
export class Vehicle {
  /**
   * @param {Object} options
   * @param {import('../../../src/physics/CollisionWorld.js').CollisionWorld} options.world
   * @param {number} [options.mass=180]
   */
  constructor(options) {
    /** @type {import('../../../src/physics/CollisionWorld.js').CollisionWorld} */
    this.world = options.world;

    /* ---- tuning ------------------------------------------------------- */

    /** @type {number} Distance from mount to wheel centre when unloaded. */
    this.suspensionRest = 0.42;
    /** @type {number} */
    this.wheelRadius = 0.34;
    /** @type {number} Spring rate, in newtons per metre of compression. */
    this.suspensionStiffness = 26000;
    /** @type {number} Damper rate. Under damped karts pogo; over damped skate. */
    this.suspensionDamping = 2700;
    /** @type {number} Hard limit on the spring force, to survive a bad landing. */
    this.suspensionMaxForce = 26000;

    /** @type {number} Peak drive force per driven wheel, in newtons. */
    this.engineForce = 2100;
    /** @type {number} Brake force per wheel. */
    this.brakeForce = 3200;
    /** @type {number} Top speed in m/s (~95 km/h). */
    this.maxSpeed = 26;
    /**
     * @type {number} Aerodynamic drag, in N per (m/s)^2.
     *
     * Not decoration: without it the only thing holding the top speed is the
     * engine force fading out, and a kart pointed downhill accelerates forever.
     */
    this.dragCoefficient = 1.15;
    /** @type {number} Rolling resistance, N per m/s. */
    this.rollingResistance = 14;
    /** @type {number} Steering angle at rest, in radians. */
    this.maxSteer = 0.56;
    /**
     * @type {number} How much the steering shrinks with speed. Without this a
     * flick of the wheel at top speed spins the kart instantly.
     */
    this.steerSpeedFalloff = 0.72;
    // Aderencia e expressa por unidade de carga, entao ela acompanha a
    // gravidade: baixar a gravidade sem recompor isto deixa o kart escorregando.
    /** @type {number} Lateral grip coefficient of a loaded tyre. */
    this.lateralGrip = 4.6;
    /** @type {number} Longitudinal grip, used to cap drive and brake force. */
    this.longitudinalGrip = 3.3;
    /** @type {number} Grip multiplier when off the racing surface. */
    this.offTrackGrip = 0.45;
    /** @type {number} Extra yaw damping, keeps the kart from spinning forever. */
    this.yawDamping = 5.2;
    /**
     * @type {number} Aderencia lateral extra da traseira.
     *
     * As rodas de tracao gastam parte do circulo de atrito acelerando, e o que
     * sobra para segurar de lado e menos do que a dianteira tem. Isso e
     * fisicamente correto e, sem compensacao, torna o kart um piao: medido,
     * mantendo esterco por 6 s ele rodava 179 graus. Dar mais aderencia a
     * traseira e o que todo jogo de corrida faz para que o carro empurre em vez
     * de rodar quando o piloto exagera.
     */
    this.rearGripBias = 1.45;
    /** @type {number} Downforce coefficient; grows with the square of speed. */
    this.downforce = 2.2;

    /* ---- state -------------------------------------------------------- */

    /** @type {Wheel[]} */
    this.wheels = WHEELS.map((c, i) => new Wheel(c, i));

    /** @type {number} -1..1 */
    this.throttle = 0;
    /** @type {number} 0..1 */
    this.brake = 0;
    /** @type {number} -1..1 */
    this.steer = 0;
    /** @type {boolean} */
    this.handbrake = false;

    /** @type {number} Current steering angle, smoothed towards the input. */
    this.steerAngle = 0;
    /** @type {number} Signed forward speed in m/s. */
    this.speed = 0;
    /** @type {number} Engine revolutions, 0..1, drives the audio. */
    this.rpm = 0;
    /** @type {number} How many wheels found ground last update. */
    this.groundedWheels = 0;
    /** @type {number} Mean tyre slip, 0..1: the skid signal. */
    this.slip = 0;
    /** @type {boolean} True when most of the kart is off the racing surface. */
    this.offTrack = false;

    /** @type {RigidBody} */
    this.body = new RigidBody({
      name: 'kart',
      shape: BodyShape.BOX,
      mass: options.mass !== undefined ? options.mass : 180,
      restitution: 0.18,
      friction: 0.22,
      linearDamping: 0.02,
      angularDamping: 0.35,
      allowSleep: false,
    });
    this.body.setShape(BodyShape.BOX, { halfExtents: new Vec3(0.72, 0.34, 1.18) });
    this.body.position.set(0, 2, 0);

    this.world.addDynamic(this.body);
  }

  /**
   * Places the kart at a position and heading, at rest.
   * @param {Vec3} position
   * @param {number} heading Radians about Y.
   */
  reset(position, heading) {
    this.body.position.copy(position);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    _q.setFromAxisAngle(new Vec3(0, 1, 0), heading);
    this.body.quaternion.copy(_q);
    this.body.wake();
    this.steerAngle = 0;
    this.speed = 0;
    this.rpm = 0;
  }

  /**
   * Applies the driver's intent. Called once per frame from the input layer.
   * @param {number} throttle -1..1 (negative reverses)
   * @param {number} brake 0..1
   * @param {number} steer -1..1
   * @param {boolean} handbrake
   */
  setControls(throttle, brake, steer, handbrake) {
    this.throttle = clamp(throttle, -1, 1);
    this.brake = clamp(brake, 0, 1);
    this.steer = clamp(steer, -1, 1);
    this.handbrake = handbrake === true;
  }

  /**
   * Advances the vehicle. Call before `world.step`, so the forces this writes
   * are integrated in the same step.
   * @param {number} dt
   */
  update(dt) {
    const body = this.body;

    // Referencial do chassi.
    //
    // A direita e derivada, nao assumida. Num sistema destro com Y para cima e
    // forward = +Z, a direita real e forward x up = -X. Usar +X como "direita"
    // — o que parece obvio — inverte a direcao inteira: o jogador vira para um
    // lado e o kart vai para o outro.
    _forward.set(0, 0, 1).applyQuat(body.quaternion);
    _up.set(0, 1, 0).applyQuat(body.quaternion);
    _right.crossVectors(_forward, _up).normalize();
    _down.copy(_up).negate();

    this.speed = body.velocity.dot(_forward);
    const speedAbs = Math.abs(this.speed);

    // Steering falls off with speed, and the wheel returns to centre faster
    // than it turns, which is what makes the kart feel planted rather than
    // twitchy.
    const falloff = 1 / (1 + speedAbs * this.steerSpeedFalloff * 0.06);
    const targetSteer = this.steer * this.maxSteer * falloff;
    const rate = Math.abs(targetSteer) > Math.abs(this.steerAngle) ? 7.5 : 12.0;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, rate * dt);

    // Downforce: pressing the kart onto the road as speed rises. Applied along
    // the chassis up axis so it also helps when landing at an angle.
    if (this.downforce > 0) {
      const push = this.downforce * this.speed * this.speed * 0.5;
      _force.copy(_down).multiplyScalar(push);
      body.applyForce(_force);
    }

    // Arrasto do ar e resistencia ao rolamento, opostos a velocidade. Sao o que
    // fixa a velocidade maxima de verdade, e valem no ar tambem — um kart que
    // decola nao deveria continuar ganhando velocidade.
    const v = body.velocity;
    const vLen = v.length();
    if (vLen > 0.05) {
      const resist = this.dragCoefficient * vLen * vLen +
        (this.groundedWheels > 0 ? this.rollingResistance : 0);
      _force.copy(v).multiplyScalar(-resist / vLen);
      body.applyForce(_force);
    }

    let grounded = 0;
    let slipSum = 0;
    let offTrackCount = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];

      // Mount point in world space.
      _anchor.copy(wheel.anchor).applyQuat(body.quaternion).add(body.position);

      const maxLength = this.suspensionRest + this.wheelRadius;
      const found = this.world.raycast(_anchor, _down, maxLength, _hit);

      if (!found || _hit.hit !== true) {
        wheel.grounded = false;
        wheel.compression = 0;
        wheel.length = this.suspensionRest;
        wheel.slip = 0;
        // A wheel in the air still spins down towards the road speed.
        wheel.spin += this.speed / this.wheelRadius * dt;
        continue;
      }

      grounded++;
      wheel.grounded = true;
      wheel.contact.copy(_hit.point);
      wheel.normal.copy(_hit.normal);
      wheel.length = Math.max(0, _hit.distance - this.wheelRadius);
      wheel.compression = clamp(
        (this.suspensionRest - wheel.length) / this.suspensionRest, 0, 1);

      if (_hit.collider !== null && _hit.collider.userData &&
          _hit.collider.userData.offTrack === true) {
        offTrackCount++;
      }

      // ---- suspension -------------------------------------------------
      body.getPointVelocity(wheel.contact, _pointVel);
      const alongSuspension = _pointVel.dot(_up);

      let springForce = this.suspensionStiffness * wheel.compression * this.suspensionRest;
      const damperForce = -this.suspensionDamping * alongSuspension;
      let total = springForce + damperForce;
      if (total < 0) total = 0;
      if (total > this.suspensionMaxForce) total = this.suspensionMaxForce;

      _force.copy(_up).multiplyScalar(total);
      body.applyForce(_force, wheel.contact);

      // ---- tyre --------------------------------------------------------
      // The wheel's own frame: steering rotates the front pair about the
      // chassis up axis.
      if (wheel.steers && this.steerAngle !== 0) {
        const c = Math.cos(this.steerAngle);
        const s = Math.sin(this.steerAngle);
        _wheelForward.copy(_forward).multiplyScalar(c).addScaled(_right, s).normalize();
      } else {
        _wheelForward.copy(_forward);
      }
      // Mesma convencao do chassi: forward x up.
      _wheelRight.crossVectors(_wheelForward, _up).normalize();

      // Project the wheel frame onto the contact plane, so a banked corner
      // pushes the kart along the road and not into it.
      _tmp.copy(wheel.normal);
      _wheelForward.addScaled(_tmp, -_wheelForward.dot(_tmp)).normalize();
      _wheelRight.addScaled(_tmp, -_wheelRight.dot(_tmp)).normalize();

      const vForward = _pointVel.dot(_wheelForward);
      const vLateral = _pointVel.dot(_wheelRight);

      // The load on this tyre is what it can trade for grip.
      const load = total;
      const gripScale = offTrackCount > 0 ? this.offTrackGrip : 1;

      // Lateral: cancel the sideways velocity over one step, capped by grip.
      const wheelMass = body.mass / this.wheels.length;
      const gripBias = wheel.steers ? 1 : this.rearGripBias;
      let lateralForce = -vLateral * wheelMass * this.lateralGrip * gripBias;
      const lateralMax = load * this.lateralGrip * gripBias * 0.25 * gripScale *
        (this.handbrake && !wheel.steers ? 0.35 : 1);
      lateralForce = clamp(lateralForce, -lateralMax, lateralMax);

      // Longitudinal: drive and brake.
      let longitudinalForce = 0;
      if (wheel.drives && this.brake <= 0.01) {
        // A curva de tracao tem que CHEGAR a zero no teto. Um piso residual
        // (era 0.25) significa que o kart nunca para de acelerar: medido, ele
        // passava de 280 km/h numa pista com descidas.
        const ratio = clamp(speedAbs / this.maxSpeed, 0, 1);
        const limit = 1 - ratio * ratio;
        const pushing = Math.sign(this.throttle) === Math.sign(vForward) || speedAbs < 0.5;
        longitudinalForce = this.throttle * this.engineForce * (pushing ? limit : 1);
      }
      if (this.brake > 0.01) {
        // Brake opposes motion; it must never drive the kart backwards.
        const stopping = -Math.sign(vForward) * this.brake * this.brakeForce;
        longitudinalForce += Math.abs(vForward) > 0.4 ? stopping : -vForward * wheelMass * 8;
      }
      if (this.handbrake && !wheel.steers) {
        longitudinalForce += -Math.sign(vForward) * this.brakeForce * 0.9;
      }

      const longitudinalMax = load * this.longitudinalGrip * 0.35 * gripScale;
      longitudinalForce = clamp(longitudinalForce, -longitudinalMax, longitudinalMax);

      // Friction circle: a tyre has one budget, spent on turning or on driving.
      const combined = Math.hypot(lateralForce, longitudinalForce);
      const budget = load * this.longitudinalGrip * 0.4 * gripScale * gripBias;
      if (combined > budget && combined > 1e-3) {
        const scale = budget / combined;
        lateralForce *= scale;
        longitudinalForce *= scale;
      }

      _force.copy(_wheelRight).multiplyScalar(lateralForce)
        .addScaled(_wheelForward, longitudinalForce);
      body.applyForce(_force, wheel.contact);

      // Slip signal for skid marks, audio and the HUD.
      wheel.slip = clamp(Math.abs(vLateral) / 9, 0, 1);
      slipSum += wheel.slip;

      // Visual spin follows the ground speed under the wheel.
      wheel.spin += vForward / this.wheelRadius * dt;
    }

    this.groundedWheels = grounded;
    this.slip = grounded > 0 ? slipSum / grounded : 0;
    this.offTrack = offTrackCount >= 3;

    // Yaw damping. Real tyre scrub kills rotation; the wheel model above only
    // approximates it, and without this the kart keeps rotating after a spin.
    if (grounded > 0 && this.yawDamping > 0) {
      const yaw = body.angularVelocity.dot(_up);
      _force.copy(_up).multiplyScalar(-yaw * this.yawDamping * body.mass * 0.06);
      body.applyTorque(_force);
    }

    // In the air, damp rotation hard so a jump does not end in a barrel roll.
    if (grounded === 0) {
      body.angularVelocity.multiplyScalar(Math.pow(0.25, dt));
    }

    // Engine note: mostly speed, plus a kick from wheelspin so flooring it from
    // a standstill sounds like effort rather than silence.
    const speedPart = clamp(speedAbs / this.maxSpeed, 0, 1);
    const effortPart = clamp(Math.abs(this.throttle) * (1 - speedPart) * 0.6, 0, 1);
    const target = clamp(speedPart + effortPart * 0.5 + this.slip * 0.15, 0, 1);
    this.rpm += (target - this.rpm) * Math.min(1, 6 * dt);
  }

  /** @returns {number} speed in km/h, always positive. */
  get speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }

  /**
   * Wheel centre in chassis space, which is what the visual actually needs.
   *
   * Cheaper than the world space version and, more importantly, independent of
   * whether any world matrix has been refreshed yet this frame.
   *
   * @param {number} index
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getWheelLocalPosition(index, out) {
    const wheel = this.wheels[index];
    const drop = wheel.grounded ? wheel.length : this.suspensionRest;
    out.set(wheel.anchor.x, wheel.anchor.y - drop, wheel.anchor.z);
    return out;
  }

  /**
   * World position of a wheel's centre, for placing the visual.
   * @param {number} index
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getWheelPosition(index, out) {
    const wheel = this.wheels[index];
    out.copy(wheel.anchor).applyQuat(this.body.quaternion).add(this.body.position);
    _tmp.set(0, -1, 0).applyQuat(this.body.quaternion);
    out.addScaled(_tmp, wheel.grounded ? wheel.length : this.suspensionRest);
    return out;
  }
}
