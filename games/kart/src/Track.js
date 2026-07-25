/**
 * Circuit geometry.
 *
 * The track is a closed Catmull-Rom spline through hand placed control points,
 * sampled into a ribbon. Everything else derives from that single curve: the
 * road mesh, the barriers, the checkpoint planes, where the props go and where
 * the grid sits. Authoring the curve once and deriving the rest is what keeps
 * the collision surface, the minimap and the lap logic from ever disagreeing
 * about where the track actually is.
 *
 * Banking comes from curvature, so corners lean into themselves without anyone
 * hand placing a single angle.
 */

import { Vec3 } from '../../../src/math/Vec3.js';
import { Geometry } from '../../../src/render/Geometry.js';

/** Half width of the drivable surface, in metres. */
export const ROAD_HALF_WIDTH = 7.0;
/** Height of the wall that stops a kart leaving the circuit. */
export const BARRIER_HEIGHT = 1.35;
/** How far the barrier sits beyond the road edge, past the kerb. */
export const BARRIER_OFFSET = 1.85;
/** Width of the red and white kerb outside the racing surface. */
export const KERB_WIDTH = 1.0;
/** Length of one kerb stripe along the track, in metres. */
export const KERB_STRIPE = 3.0;
/** Samples taken along the spline; also the resolution of the road mesh. */
export const TRACK_SAMPLES = 720;
/** How many checkpoints the lap is split into. */
export const CHECKPOINT_COUNT = 24;

const _up = new Vec3(0, 1, 0);

/**
 * Control points of the circuit, in order. Y carries the elevation change.
 *
 * Laid out as a rough figure of eight with one long straight, a hairpin and a
 * banked sweeper, so that a lap exercises braking, a slow corner and a fast one.
 */
const CONTROL_POINTS = [
  [0, 0, -110], [46, 1.5, -100], [74, 3.5, -66], [78, 5.0, -24],
  [62, 5.5, 8], [30, 4.5, 26], [4, 3.0, 40], [-18, 2.0, 66],
  [-52, 1.0, 74], [-84, 0.5, 56], [-92, 1.5, 20], [-78, 3.5, -14],
  [-52, 4.5, -34], [-58, 4.0, -66], [-44, 2.0, -94], [-16, 0.5, -112],
];

/**
 * Catmull-Rom interpolation on a closed loop.
 * @param {number[][]} points Control points.
 * @param {number} t Position along the whole loop, 0..1.
 * @param {Vec3} out
 * @returns {Vec3} out
 */
function sampleSpline(points, t, out) {
  const n = points.length;
  const scaled = ((t % 1) + 1) % 1 * n;
  const i = Math.floor(scaled);
  const f = scaled - i;

  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i % n];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];

  const f2 = f * f;
  const f3 = f2 * f;

  // Standard Catmull-Rom basis.
  for (let axis = 0; axis < 3; axis++) {
    const v = 0.5 * (
      2 * p1[axis] +
      (-p0[axis] + p2[axis]) * f +
      (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * f2 +
      (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * f3
    );
    if (axis === 0) out.x = v;
    else if (axis === 1) out.y = v;
    else out.z = v;
  }
  return out;
}

/**
 * One sample of the circuit: everything downstream needs this frame.
 */
class TrackSample {
  constructor() {
    /** @type {Vec3} Centre line position. */
    this.position = new Vec3();
    /** @type {Vec3} Unit tangent, the racing direction. */
    this.forward = new Vec3();
    /** @type {Vec3} Unit right, across the road. */
    this.right = new Vec3();
    /** @type {Vec3} Road surface normal, tilted by the banking. */
    this.normal = new Vec3(0, 1, 0);
    /** @type {number} Distance from the start line along the centre line. */
    this.distance = 0;
    /** @type {number} Signed curvature; drives the banking. */
    this.curvature = 0;
  }
}

/**
 * A closed circuit built from a spline.
 */
export class Track {
  constructor() {
    /** @type {TrackSample[]} */
    this.samples = [];
    /** @type {number} Length of one lap along the centre line, in metres. */
    this.length = 0;
    /**
     * @type {Array<{index: number, position: Vec3, forward: Vec3, right: Vec3}>}
     * Checkpoints in lap order; index 0 is the start/finish line.
     */
    this.checkpoints = [];

    this._build();
  }

  /** @private */
  _build() {
    const n = TRACK_SAMPLES;
    const pos = new Vec3();
    const ahead = new Vec3();
    const behind = new Vec3();

    for (let i = 0; i < n; i++) {
      const t = i / n;
      const sample = new TrackSample();
      sampleSpline(CONTROL_POINTS, t, pos);
      sample.position.copy(pos);

      // Tangent by central difference: cheaper than differentiating the basis
      // and immune to the parameterisation being non uniform in arc length.
      sampleSpline(CONTROL_POINTS, t + 1 / n, ahead);
      sampleSpline(CONTROL_POINTS, t - 1 / n, behind);
      sample.forward.subVectors(ahead, behind).normalize();

      sample.right.crossVectors(sample.forward, _up).normalize();
      this.samples.push(sample);
    }

    // Curvature from how fast the tangent turns, then banking from curvature.
    for (let i = 0; i < n; i++) {
      const prev = this.samples[(i - 1 + n) % n];
      const next = this.samples[(i + 1) % n];
      const sample = this.samples[i];

      const turn = next.forward.dot(sample.right) - prev.forward.dot(sample.right);
      sample.curvature = turn;

      // Lean the surface into the corner. Clamped so a hairpin does not become
      // a wall, and smooth because curvature itself is smooth.
      const bank = Math.max(-0.42, Math.min(0.42, turn * 9));
      sample.normal.set(0, 1, 0).addScaled(sample.right, -bank).normalize();
      // Rebuild right so the frame stays orthonormal after the tilt.
      sample.right.crossVectors(sample.forward, sample.normal).normalize();
    }

    // Arc length, used by the ghost, the props and the lap progress readout.
    let distance = 0;
    for (let i = 0; i < n; i++) {
      this.samples[i].distance = distance;
      const next = this.samples[(i + 1) % n];
      distance += this.samples[i].position.distanceTo(next.position);
    }
    this.length = distance;

    for (let c = 0; c < CHECKPOINT_COUNT; c++) {
      const index = Math.round((c / CHECKPOINT_COUNT) * n) % n;
      const sample = this.samples[index];
      this.checkpoints.push({
        index,
        position: sample.position.clone(),
        forward: sample.forward.clone(),
        right: sample.right.clone(),
      });
    }
  }

  /**
   * Sample at a normalised position along the lap.
   * @param {number} t 0..1, wrapped.
   * @returns {TrackSample}
   */
  sampleAt(t) {
    const n = this.samples.length;
    const i = Math.floor((((t % 1) + 1) % 1) * n) % n;
    return this.samples[i];
  }

  /**
   * Nearest centre line sample to a world position.
   *
   * Linear scan over 720 samples, called once per kart per frame: cheaper than
   * the spatial index it would take to avoid it, and immune to the failure mode
   * where a kart cutting a corner snaps to the wrong part of the loop.
   *
   * @param {Vec3} point
   * @returns {{index: number, sample: TrackSample, distance: number, lateral: number}}
   */
  nearest(point) {
    const samples = this.samples;
    let best = 0;
    let bestSq = Infinity;
    for (let i = 0, n = samples.length; i < n; i++) {
      const p = samples[i].position;
      const dx = p.x - point.x;
      const dy = (p.y - point.y) * 0.35; // height matters less than plan position
      const dz = p.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestSq) { bestSq = d; best = i; }
    }
    const sample = samples[best];
    const lateral =
      (point.x - sample.position.x) * sample.right.x +
      (point.y - sample.position.y) * sample.right.y +
      (point.z - sample.position.z) * sample.right.z;
    return { index: best, sample, distance: sample.distance, lateral };
  }

  /**
   * Sample a given distance along the centre line, wrapping the lap.
   *
   * Not the same as `sampleAt`: that one takes a fraction of the sample INDEX,
   * and the spline is not parameterised by arc length, so the two disagree by
   * metres wherever the control points are unevenly spaced. Anything positioned
   * by distance — the grid, split markers — has to use this one.
   *
   * @param {number} distance Metres from the start line; may be negative.
   * @returns {TrackSample}
   */
  sampleAtDistance(distance) {
    const total = this.length;
    let d = ((distance % total) + total) % total;
    const samples = this.samples;
    // The table is sorted, so a binary search finds the segment directly.
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].distance <= d) lo = mid;
      else hi = mid - 1;
    }
    return samples[lo];
  }

  /**
   * Grid slot for a kart, staggered left and right behind the start line.
   * @param {number} slot 0 based.
   * @param {Vec3} outPosition
   * @returns {number} heading in radians
   */
  gridSlot(slot, outPosition) {
    const back = 6 + slot * 5.5;
    const side = (slot % 2 === 0 ? -1 : 1) * 2.6;
    const sample = this.sampleAtDistance(-back);
    outPosition.copy(sample.position)
      .addScaled(sample.right, side)
      .addScaled(sample.normal, 0.6);
    return Math.atan2(sample.forward.x, sample.forward.z);
  }

  /* ------------------------------------------------------------- meshes */

  /**
   * Road surface: a ribbon with a shoulder on each side.
   *
   * The shoulder is not decoration — it is what the physics uses to tell "on
   * the track" from "off it", and it gives the barrier something to stand on.
   *
   * @returns {Geometry}
   */
  buildRoadGeometry() {
    const samples = this.samples;
    const n = samples.length;

    // Cross section, from the left verge to the right one. The kerb is a real
    // strip of geometry rather than a texture: it has to be there for the tyre
    // model to notice the surface change, and it is what tells a driver where
    // the track actually ends.
    const K = ROAD_HALF_WIDTH + KERB_WIDTH;
    const across = [-K - 2.5, -K, -ROAD_HALF_WIDTH, 0, ROAD_HALF_WIDTH, K, K + 2.5];
    const drop = [-0.45, -0.06, 0, 0, 0, -0.06, -0.45];
    // 0 = asphalt, 1 = kerb, 2 = verge. Drives the vertex colour.
    const kind = [2, 1, 1, 0, 1, 1, 2];
    const cols = across.length;

    const positions = new Float32Array(n * cols * 3);
    const normals = new Float32Array(n * cols * 3);
    const uvs = new Float32Array(n * cols * 2);
    const colors = new Float32Array(n * cols * 4);
    const indices = new Uint32Array(n * (cols - 1) * 6);

    let v = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      // Kerb stripes alternate along the lap, in whole stripe lengths.
      const stripe = Math.floor(s.distance / KERB_STRIPE) % 2 === 0;

      for (let c = 0; c < cols; c++) {
        const o = v * 3;
        positions[o] = s.position.x + s.right.x * across[c] + s.normal.x * drop[c];
        positions[o + 1] = s.position.y + s.right.y * across[c] + s.normal.y * drop[c];
        positions[o + 2] = s.position.z + s.right.z * across[c] + s.normal.z * drop[c];
        normals[o] = s.normal.x;
        normals[o + 1] = s.normal.y;
        normals[o + 2] = s.normal.z;

        // U across the road, V streaming along it.
        uvs[v * 2] = c / (cols - 1);
        uvs[v * 2 + 1] = s.distance * 0.14;

        // The material is white and the colour lives here, so one mesh and one
        // draw call carry asphalt, kerb and verge.
        const co = v * 4;
        let r, g, b;
        if (kind[c] === 0) { r = 0.075; g = 0.076; b = 0.080; }
        else if (kind[c] === 1) {
          if (stripe) { r = 0.72; g = 0.10; b = 0.09; }
          else { r = 0.86; g = 0.86; b = 0.87; }
        } else { r = 0.26; g = 0.30; b = 0.18; }
        colors[co] = r; colors[co + 1] = g; colors[co + 2] = b; colors[co + 3] = 1;
        v++;
      }
    }

    let t = 0;
    for (let i = 0; i < n; i++) {
      const row = i * cols;
      const nextRow = ((i + 1) % n) * cols;
      for (let c = 0; c < cols - 1; c++) {
        const a = row + c;
        const b = row + c + 1;
        const d = nextRow + c;
        const e = nextRow + c + 1;
        indices[t++] = a; indices[t++] = d; indices[t++] = b;
        indices[t++] = b; indices[t++] = d; indices[t++] = e;
      }
    }

    const geometry = new Geometry();
    geometry.setAttribute('aPosition', positions, 3);
    geometry.setAttribute('aNormal', normals, 3);
    geometry.setAttribute('aUV0', uvs, 2);
    geometry.setAttribute('aColor', colors, 4);
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Barrier walls on both sides, as one mesh.
   * @returns {Geometry}
   */
  buildBarrierGeometry() {
    const samples = this.samples;
    const n = samples.length;
    const sides = [-1, 1];
    const offset = ROAD_HALF_WIDTH + BARRIER_OFFSET;

    // Two vertices per side per sample (bottom, top), both sides.
    const vertsPerRow = sides.length * 2;
    const positions = new Float32Array(n * vertsPerRow * 3);
    const normals = new Float32Array(n * vertsPerRow * 3);
    const uvs = new Float32Array(n * vertsPerRow * 2);
    const indices = new Uint32Array(n * sides.length * 6);

    let v = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      for (let si = 0; si < sides.length; si++) {
        const side = sides[si];
        const bx = s.position.x + s.right.x * offset * side;
        const by = s.position.y + s.right.y * offset * side;
        const bz = s.position.z + s.right.z * offset * side;
        // Inward facing, so the wall is lit and visible from the track.
        const nx = -s.right.x * side;
        const ny = -s.right.y * side;
        const nz = -s.right.z * side;

        for (let h = 0; h < 2; h++) {
          const o = v * 3;
          positions[o] = bx + s.normal.x * BARRIER_HEIGHT * h;
          positions[o + 1] = by + s.normal.y * BARRIER_HEIGHT * h;
          positions[o + 2] = bz + s.normal.z * BARRIER_HEIGHT * h;
          normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
          uvs[v * 2] = s.distance * 0.25;
          uvs[v * 2 + 1] = h;
          v++;
        }
      }
    }

    let t = 0;
    for (let i = 0; i < n; i++) {
      const row = i * vertsPerRow;
      const nextRow = ((i + 1) % n) * vertsPerRow;
      for (let si = 0; si < sides.length; si++) {
        const a = row + si * 2;
        const b = a + 1;
        const c = nextRow + si * 2;
        const d = c + 1;
        if (sides[si] < 0) {
          indices[t++] = a; indices[t++] = c; indices[t++] = b;
          indices[t++] = b; indices[t++] = c; indices[t++] = d;
        } else {
          indices[t++] = a; indices[t++] = b; indices[t++] = c;
          indices[t++] = b; indices[t++] = d; indices[t++] = c;
        }
      }
    }

    const geometry = new Geometry();
    geometry.setAttribute('aPosition', positions, 3);
    geometry.setAttribute('aNormal', normals, 3);
    geometry.setAttribute('aUV0', uvs, 2);
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Ground plane under and around the circuit, following its elevation loosely.
   * @param {number} size
   * @param {number} segments
   * @returns {Geometry}
   */
  buildGroundGeometry(size = 320, segments = 96) {
    const positions = new Float32Array((segments + 1) * (segments + 1) * 3);
    const normals = new Float32Array((segments + 1) * (segments + 1) * 3);
    const uvs = new Float32Array((segments + 1) * (segments + 1) * 2);
    const indices = new Uint32Array(segments * segments * 6);

    const half = size * 0.5;
    const samples = this.samples;
    const sampleCount = samples.length;

    // Verge width: where the ground stops hugging the circuit and goes back to
    // being landscape.
    // O solo segue a ELEVACAO da pista numa faixa larga, e o ruido entra como
    // perturbacao por cima em vez de substituir a altura.
    //
    // Duas tentativas erradas antes desta: um campo de altura independente sobe
    // acima do asfalto e a grama engole a pista em pedacos; uma faixa estreita
    // resolve isso mas deixa os trechos elevados como tapetes voadores sobre o
    // terreno baixo em volta. O que a pista precisa e de um morro embaixo dela.
    const inner = ROAD_HALF_WIDTH + 2;
    const outer = ROAD_HALF_WIDTH + 58;
    // Dentro deste raio o solo NUNCA sobe acima do asfalto, aconteca o que
    // acontecer com o ruido.
    const clampRadius = ROAD_HALF_WIDTH + 5;

    let v = 0;
    for (let z = 0; z <= segments; z++) {
      for (let x = 0; x <= segments; x++) {
        const wx = (x / segments) * size - half;
        const wz = (z / segments) * size - half;

        // Paisagem: uma base ampla mais um detalhe de frequencia maior.
        const scenicBase = Math.sin(wx * 0.011) * 5.0 + Math.cos(wz * 0.013) * 4.0;
        const detail = Math.sin(wx * 0.047) * 0.9 + Math.cos(wz * 0.053) * 0.8;

        // Nearest point on the centre line, in plan. The ground has to follow
        // the circuit's elevation: an independent height field will sooner or
        // later rise above the asphalt, and then the grass swallows the track
        // in pieces — which looks like broken geometry and is not.
        let bestSq = Infinity;
        let bestY = 0;
        for (let i = 0; i < sampleCount; i++) {
          const p = samples[i].position;
          const dx = p.x - wx;
          const dz = p.z - wz;
          const d = dx * dx + dz * dz;
          if (d < bestSq) { bestSq = d; bestY = p.y; }
        }
        const distance = Math.sqrt(bestSq);

        // 1 right beside the road, 0 out in the landscape.
        let influence;
        if (distance <= inner) influence = 1;
        else if (distance >= outer) influence = 0;
        else {
          const t = (distance - inner) / (outer - inner);
          influence = 1 - (t * t * (3 - 2 * t));
        }

        // Beside the road the ground sits just below it, so the shoulder of the
        // road mesh always meets grass and never pokes through it.
        // Altura de base: longe e a paisagem, perto e a pista.
        const verge = bestY - 1.0;
        const base = scenicBase + (verge - scenicBase) * influence;
        // Ondulacao por cima, amortecida junto da pista para o acostamento
        // ficar plano onde o carro pisa.
        let wy = base + detail * (1 - influence * 0.85);
        if (distance < clampRadius) {
          const ceiling = bestY - 0.25;
          if (wy > ceiling) wy = ceiling;
        }

        const o = v * 3;
        positions[o] = wx; positions[o + 1] = wy; positions[o + 2] = wz;
        normals[o] = 0; normals[o + 1] = 1; normals[o + 2] = 0;
        uvs[v * 2] = wx * 0.05;
        uvs[v * 2 + 1] = wz * 0.05;
        v++;
      }
    }

    let t = 0;
    for (let z = 0; z < segments; z++) {
      for (let x = 0; x < segments; x++) {
        const a = z * (segments + 1) + x;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        indices[t++] = a; indices[t++] = c; indices[t++] = b;
        indices[t++] = b; indices[t++] = c; indices[t++] = d;
      }
    }

    const geometry = new Geometry();
    geometry.setAttribute('aPosition', positions, 3);
    geometry.setAttribute('aNormal', normals, 3);
    geometry.setAttribute('aUV0', uvs, 2);
    geometry.setIndex(indices);
    geometry.computeNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
