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
const _applyAt = new Vec3();
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
    /** @type {number} Carga apurada na fase de forcas, usada pelo atrito. */
    this.load = 0;
    /** @type {number} Multiplicador de aderencia da superficie. */
    this.gripScale = 1;
    /** @type {Vec3} Eixo longitudinal da roda, no plano de contato. */
    this.wheelForward = new Vec3();
    /** @type {Vec3} Eixo lateral da roda, no plano de contato. */
    this.wheelRight = new Vec3();
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
    /**
     * @type {number} Coeficiente de atrito do pneu (mu).
     *
     * Um numero so, do jeito que Coulomb funciona: a forca maxima que um pneu
     * entrega e mu vezes a carga sobre ele, gastavel em qualquer direcao. Pneu
     * de competicao fica entre 1,2 e 1,9. Aqui e 1,25: acima disso o kart cola
     * na pista (medido: 0 a 50 km/h em 0,94 s e frenagem a 2,6 g) e o esterco
     * total deixa de quebrar aderencia, o que faz o carro parecer sobre trilhos.
     * Continua uma ordem de grandeza acima de tan(15 graus) = 0,27, entao o
     * atrito estatico na rampa nao corre risco.
     */
    this.tyreFriction = 1.25;
    /**
     * @type {number} Teto da carga usada para aderencia, em pesos estaticos.
     *
     * A carga instantanea da suspensao dispara num solavanco — pode bater no
     * limite da mola, 26 kN — e usar isso cru multiplicaria a aderencia por
     * cinquenta num unico passo, arremessando o kart. Transferencia de peso
     * real raramente passa de umas 2,5 vezes a carga estatica de uma roda.
     */
    this.maxLoadFactor = 1.5;
    /**
     * @type {number} Fracao do deslizamento cancelada por passo, 0..1.
     *
     * Pedir 100% realimenta: a forca entra no ponto de contato, vira torque,
     * muda a velocidade angular e volta como deslizamento no passo seguinte.
     * Com o atrito aplicado como FORCA, pedir 100% realimentava pela rotacao e
     * o rumo invertia 120 vezes por segundo. Com impulso a malha e estavel, e
     * 100% e o que zera a fluencia: qualquer valor menor deixa uma fracao da
     * gravidade acumular a cada frame, e o kart desce a rampa devagarinho para
     * sempre.
     */
    this.slipRelaxation = 1.0;
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
    /**
     * @type {number} Altura do ponto de aplicacao do atrito, 0 = chao,
     * 1 = centro de massa.
     *
     * Aplicar o impulso lateral inteiro no ponto de contato gera um torque de
     * rolagem grande demais e o kart capota em curva. Subir o ponto de
     * aplicacao e o equivalente a um centro de rolagem alto.
     */
    this.rollCentre = 0.75;
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
    /** @private @type {Function|null} */
    this._onSubstep = null;
    /** @private @type {Function|null} */
    this._onConstraint = null;

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

    // As rodas rodam na taxa do solver, nao na do frame. Aplicado uma vez por
    // frame, o atrito nunca alcanca a gravidade — que e integrada a cada
    // substep — e o kart escorrega ladeira abaixo para sempre.
    // Forcas antes da integracao, atrito depois dela. E a ordem que um solver
    // usa, e a unica em que o pneu ve a gravidade que precisa anular.
    this._onSubstep = (h) => this.applyForces(h);
    this._onConstraint = (h) => this.applyTyreFriction(h);
    if (typeof this.world.onSubstep === 'function') this.world.onSubstep(this._onSubstep);
    if (typeof this.world.onVelocityConstraint === 'function') {
      this.world.onVelocityConstraint(this._onConstraint);
    }
  }

  /** Desregistra do mundo. */
  dispose() {
    if (this._onSubstep !== null && typeof this.world.offSubstep === 'function') {
      this.world.offSubstep(this._onSubstep);
      this._onSubstep = null;
    }
    if (this._onConstraint !== null && typeof this.world.offVelocityConstraint === 'function') {
      this.world.offVelocityConstraint(this._onConstraint);
      this._onConstraint = null;
    }
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
   * Estado que muda por FRAME: suavizacao da direcao e rotacao do motor.
   * A fisica das rodas nao vive aqui — ela roda por substep, em `simulate`.
   * @param {number} dt
   */
  update(dt) {
    const speedAbs = Math.abs(this.speed);

    // A direcao volta ao centro mais rapido do que sai dele, que e o que faz o
    // kart parecer plantado em vez de nervoso.
    const falloff = 1 / (1 + speedAbs * this.steerSpeedFalloff * 0.06);
    const targetSteer = this.steer * this.maxSteer * falloff;
    const rate = Math.abs(targetSteer) > Math.abs(this.steerAngle) ? 7.5 : 12.0;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, rate * dt);

    // Nota do motor: sobretudo velocidade, mais um empurrao do patinar para que
    // sair da inercia soe como esforco e nao como silencio.
    const speedPart = clamp(speedAbs / this.maxSpeed, 0, 1);
    const effortPart = clamp(Math.abs(this.throttle) * (1 - speedPart) * 0.6, 0, 1);
    const target = clamp(speedPart + effortPart * 0.5 + this.slip * 0.15, 0, 1);
    this.rpm += (target - this.rpm) * Math.min(1, 6 * dt);
  }

  /**
   * Suspensao, downforce e arrasto. Roda ANTES da integracao, porque sao forcas
   * e o integrador precisa ve-las no acumulador.
   * @param {number} dt Duracao do substep.
   */
  applyForces(dt) {
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

    // Carga estatica por roda, para limitar os picos da suspensao.
    const gravityMag = this.world !== null && this.world.gravity !== undefined
      ? this.world.gravity.length() : 9.81;
    const staticLoad = body.mass * gravityMag / this.wheels.length;
    const loadCeiling = staticLoad * this.maxLoadFactor;

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

      // A carga sobre este pneu e o que ele tem para trocar por aderencia,
      // limitada para que um solavanco na suspensao nao vire aderencia infinita.
      const load = Math.min(total, loadCeiling);
      const gripScale = offTrackCount > 0 ? this.offTrackGrip : 1;
      const wheelMass = body.mass / this.wheels.length;
      const gripBias = wheel.steers ? 1 : this.rearGripBias;

      // O atrito nao acontece aqui: ele e uma restricao de velocidade e roda
      // depois da integracao. O que fica guardado e o que ele vai precisar.
      wheel.load = load;
      wheel.gripScale = gripScale;
      wheel.wheelForward.copy(_wheelForward);
      wheel.wheelRight.copy(_wheelRight);

      // Sinal de derrapagem para marca de pneu, audio e HUD.
      wheel.slip = clamp(Math.abs(vLateral) / 9, 0, 1);
      slipSum += wheel.slip;

      // O giro visual acompanha a velocidade do chao sob a roda.
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

  }

  /**
   * Atrito dos pneus, como restricao de velocidade.
   *
   * Roda DEPOIS que a gravidade entrou na velocidade, que e o que permite
   * anula-la de verdade. Aplicado como impulso, porque o acumulador de forca ja
   * foi zerado e porque atrito e uma restricao, nao uma forca.
   *
   * @param {number} dt Duracao do substep.
   */
  applyTyreFriction(dt) {
    const body = this.body;
    const wheels = this.wheels;

    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i];
      if (wheel.grounded === false) continue;

      body.getPointVelocity(wheel.contact, _pointVel);
      const vForward = _pointVel.dot(wheel.wheelForward);
      const vLateral = _pointVel.dot(wheel.wheelRight);
      const wheelMass = body.mass / wheels.length;
      const gripBias = wheel.steers ? 1 : this.rearGripBias;
      const speedAbs = Math.abs(this.speed);

      // Limite de Coulomb: mu * N, convertido em impulso deste passo.
      const limit = wheel.load * this.tyreFriction * wheel.gripScale * gripBias;
      const impulseLimit = limit * dt;

      let lateralImpulse = -vLateral * wheelMass * this.slipRelaxation;
      const lateralCap = impulseLimit * (this.handbrake && !wheel.steers ? 0.35 : 1);
      lateralImpulse = clamp(lateralImpulse, -lateralCap, lateralCap);

      let longitudinalImpulse = 0;
      if (wheel.drives && this.brake <= 0.01) {
        const ratio = clamp(speedAbs / this.maxSpeed, 0, 1);
        const fade = 1 - ratio * ratio;
        const pushing = Math.sign(this.throttle) === Math.sign(vForward) || speedAbs < 0.5;
        longitudinalImpulse = this.throttle * this.engineForce * (pushing ? fade : 1) * dt;
      }
      if (this.brake > 0.01) {
        longitudinalImpulse += -vForward * wheelMass * this.brake * this.slipRelaxation;
      }
      if (this.handbrake && !wheel.steers) {
        longitudinalImpulse += -vForward * wheelMass * this.slipRelaxation;
      }

      // Circulo de atrito: um orcamento so, com prioridade lateral.
      const restante = Math.sqrt(Math.max(0,
        impulseLimit * impulseLimit - lateralImpulse * lateralImpulse));
      longitudinalImpulse = clamp(longitudinalImpulse, -restante, restante);

      // Ponto de aplicacao levantado ate perto do centro de massa: aplicar todo
      // o impulso lateral no chao gera um torque de rolagem que capota o kart.
      // Isso e o que um centro de rolagem alto faz num carro real.
      _tmp.subVectors(body.position, wheel.contact);
      _applyAt.copy(wheel.contact).addScaled(_tmp, this.rollCentre);

      _force.copy(wheel.wheelRight).multiplyScalar(lateralImpulse)
        .addScaled(wheel.wheelForward, longitudinalImpulse);
      body.applyImpulse(_force, _applyAt);
    }
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
