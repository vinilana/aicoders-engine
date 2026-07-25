/**
 * Animated water surface material.
 */
export class WaterMaterial extends ShaderMaterial {
    /**
     * @param {Object} [options]
     * @param {Color} [options.deepColor] Body colour of the water.
     * @param {Color} [options.skyColor] Colour reflected at grazing angles.
     * @param {number} [options.opacity=0.72] Opacity looking straight down.
     * @param {number} [options.fresnelPower=4] Sharpness of the Fresnel falloff.
     * @param {number} [options.specular=1.6] Sun glint strength.
     * @param {number} [options.shininess=220] Sun glint tightness.
     * @param {number} [options.rippleStrength=0.06] Fine ripple amplitude.
     * @param {number} [options.rippleScale=2.4] Fine ripple frequency.
     */
    constructor(options?: {
        deepColor?: Color;
        skyColor?: Color;
        opacity?: number;
        fresnelPower?: number;
        specular?: number;
        shininess?: number;
        rippleStrength?: number;
        rippleScale?: number;
    });
    /** @private */
    private _wave;
    /** @private */
    private _deep;
    /** @private */
    private _sky;
    /** @private */
    private _surface;
    /**
     * Copies the wave parameters from the physics volume, so the rendered crest
     * is the crest that pushes floating bodies.
     * @param {import('../../physics/WaterVolume.js').WaterVolume} volume
     * @returns {WaterMaterial} this
     */
    syncFromVolume(volume: import('../../physics/WaterVolume.js').WaterVolume): WaterMaterial;
    /**
     * Advances the animation clock directly, for surfaces with no physics volume.
     * @param {number} time Seconds.
     * @returns {WaterMaterial} this
     */
    setTime(time: number): WaterMaterial;
    /** @param {Color} color */
    setDeepColor(color: Color): WaterMaterial;
    /** @param {Color} color */
    setSkyColor(color: Color): WaterMaterial;
    /** @param {number} value */
    setOpacityBase(value: number): WaterMaterial;
}
import { ShaderMaterial } from "./ShaderMaterial.js";
import { Color } from "../../math/Color.js";
/**
 * Wave field shared by the vertex shader and the physics.
 * Keep in sync with `WaterVolume.surfaceHeightAt` / `WaterVolume` docs.
 */
export const WAVE_GLSL: "\n// uWaveParams = (amplitude, wavelength, speed, time)\nfloat waterHeight(vec2 p) {\n  if (uWaveParams.x <= 0.0) return 0.0;\n  float k = 6.28318530718 / max(uWaveParams.y, 1e-4);\n  float t = uWaveParams.w * uWaveParams.z;\n  return sin(p.x * k + t) * uWaveParams.x * 0.6\n       + sin((p.y * 0.83 + p.x * 0.31) * k - t * 0.85) * uWaveParams.x * 0.4;\n}\n\n// Analytic normal: the exact gradient of waterHeight, not a finite difference.\nvec3 waterNormal(vec2 p) {\n  if (uWaveParams.x <= 0.0) return vec3(0.0, 1.0, 0.0);\n  float k = 6.28318530718 / max(uWaveParams.y, 1e-4);\n  float t = uWaveParams.w * uWaveParams.z;\n  float c1 = cos(p.x * k + t) * uWaveParams.x * 0.6 * k;\n  float c2 = cos((p.y * 0.83 + p.x * 0.31) * k - t * 0.85) * uWaveParams.x * 0.4 * k;\n  float dhdx = c1 + c2 * 0.31;\n  float dhdz = c2 * 0.83;\n  return normalize(vec3(-dhdx, 1.0, -dhdz));\n}\n";
