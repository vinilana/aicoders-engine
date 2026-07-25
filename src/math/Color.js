import { clamp, euclideanModulo, lerp as lerpScalar } from './MathUtils.js';

/**
 * Converts a single sRGB channel (0..1) to linear light.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/**
 * Converts a single linear channel (0..1) to sRGB.
 * @param {number} c
 * @returns {number}
 */
export function linearToSRGB(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666666) - 0.055;
}

/**
 * Hue helper for HSL -> RGB.
 * @param {number} p
 * @param {number} q
 * @param {number} t
 * @returns {number}
 */
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
  return p;
}

/** Small CSS color name table used by {@link Color#setStyle}. */
const NAMED_COLORS = {
  black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x008000,
  blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, aqua: 0x00ffff,
  magenta: 0xff00ff, fuchsia: 0xff00ff, gray: 0x808080, grey: 0x808080,
  silver: 0xc0c0c0, maroon: 0x800000, olive: 0x808000, lime: 0x00ff00,
  teal: 0x008080, navy: 0x000080, purple: 0x800080, orange: 0xffa500,
  gold: 0xffd700, pink: 0xffc0cb, brown: 0xa52a2a, skyblue: 0x87ceeb,
  transparent: 0x000000
};

/**
 * RGB color stored in LINEAR space (all engine lighting is linear).
 * Inputs given in sRGB (hex, CSS strings, HSL) are converted on the way in.
 */
export class Color {
  /** @type {number} Linear red. */ r;
  /** @type {number} Linear green. */ g;
  /** @type {number} Linear blue. */ b;

  /**
   * Accepts linear components `(r, g, b)`, a single sRGB hex (`0xff8800`),
   * a CSS string (`'#ff8800'`, `'rgb(255,136,0)'`), another Color, or a
   * single scalar (grey level).
   * @param {number|string|Color} [r=1]
   * @param {number} [g]
   * @param {number} [b]
   */
  constructor(r = 1, g, b) {
    this.r = 1;
    this.g = 1;
    this.b = 1;

    if (g !== undefined || b !== undefined) {
      this.r = /** @type {number} */ (r);
      this.g = g;
      this.b = b;
      return;
    }

    if (typeof r === 'string') {
      this.setStyle(r);
    } else if (typeof r === 'object' && r !== null) {
      this.copy(r);
    } else if (r > 1) {
      this.setHex(r);
    } else {
      this.setScalar(r);
    }
  }

  /**
   * Sets linear components directly.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {Color}
   */
  set(r, g, b) {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }

  /**
   * Sets all linear components to the same value.
   * @param {number} s
   * @returns {Color}
   */
  setScalar(s) {
    this.r = s;
    this.g = s;
    this.b = s;
    return this;
  }

  /**
   * Sets the color from a packed 0xRRGGBB value.
   * @param {number} hex
   * @param {string} [colorSpace='srgb'] 'srgb' converts to linear, 'linear' keeps the values.
   * @returns {Color}
   */
  setHex(hex, colorSpace = 'srgb') {
    hex = Math.floor(hex);
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    if (colorSpace === 'linear') {
      this.r = r;
      this.g = g;
      this.b = b;
    } else {
      this.r = srgbToLinear(r);
      this.g = srgbToLinear(g);
      this.b = srgbToLinear(b);
    }
    return this;
  }

  /**
   * Packs the color back into 0xRRGGBB.
   * @param {string} [colorSpace='srgb']
   * @returns {number}
   */
  getHex(colorSpace = 'srgb') {
    let r = this.r, g = this.g, b = this.b;
    if (colorSpace !== 'linear') {
      r = linearToSRGB(r);
      g = linearToSRGB(g);
      b = linearToSRGB(b);
    }
    const ri = Math.round(clamp(r, 0, 1) * 255);
    const gi = Math.round(clamp(g, 0, 1) * 255);
    const bi = Math.round(clamp(b, 0, 1) * 255);
    return (ri << 16) | (gi << 8) | bi;
  }

  /**
   * '#rrggbb' representation (sRGB encoded).
   * @returns {string}
   */
  getHexString() {
    return '#' + ('000000' + this.getHex().toString(16)).slice(-6);
  }

  /**
   * Sets the color from sRGB channel values in 0..1.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {Color}
   */
  setSRGB(r, g, b) {
    this.r = srgbToLinear(r);
    this.g = srgbToLinear(g);
    this.b = srgbToLinear(b);
    return this;
  }

  /**
   * Sets the color from HSL.
   * @param {number} h Hue in 0..1 (wrapped).
   * @param {number} s Saturation 0..1.
   * @param {number} l Lightness 0..1.
   * @param {string} [colorSpace='srgb'] HSL is interpreted in sRGB by default.
   * @returns {Color}
   */
  setHSL(h, s, l, colorSpace = 'srgb') {
    h = euclideanModulo(h, 1);
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);

    let r, g, b;
    if (s === 0) {
      r = l;
      g = l;
      b = l;
    } else {
      const q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    if (colorSpace === 'linear') return this.set(r, g, b);
    return this.setSRGB(r, g, b);
  }

  /**
   * Writes the HSL representation of this color into `out`.
   * @param {{h:number, s:number, l:number}} out
   * @returns {{h:number, s:number, l:number}}
   */
  getHSL(out) {
    const r = linearToSRGB(this.r);
    const g = linearToSRGB(this.g);
    const b = linearToSRGB(this.b);

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    let hue = 0;
    let saturation = 0;
    const lightness = (min + max) / 2;

    if (min !== max) {
      const delta = max - min;
      saturation = lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
      if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue /= 6;
    }

    out.h = hue;
    out.s = saturation;
    out.l = lightness;
    return out;
  }

  /**
   * Parses a CSS-like color string: '#rgb', '#rrggbb', 'rgb(r,g,b)',
   * 'rgba(r,g,b,a)', 'hsl(h,s%,l%)' or a basic color name.
   * Unknown strings leave the color untouched.
   * @param {string} style
   * @returns {Color}
   */
  setStyle(style) {
    if (typeof style !== 'string') return this;
    const s = style.trim().toLowerCase();

    if (s.charCodeAt(0) === 35) { // '#'
      const hex = s.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex.charAt(0), 16);
        const g = parseInt(hex.charAt(1), 16);
        const b = parseInt(hex.charAt(2), 16);
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return this;
        return this.setHex((r * 17) * 65536 + (g * 17) * 256 + (b * 17));
      }
      if (hex.length === 6 || hex.length === 8) {
        const v = parseInt(hex.slice(0, 6), 16);
        if (Number.isNaN(v)) return this;
        return this.setHex(v);
      }
      return this;
    }

    const open = s.indexOf('(');
    if (open > 0 && s.charAt(s.length - 1) === ')') {
      const fn = s.slice(0, open);
      const args = s.slice(open + 1, s.length - 1).split(/[,\s/]+/);
      if (fn === 'rgb' || fn === 'rgba') {
        const r = parseChannel(args[0]);
        const g = parseChannel(args[1]);
        const b = parseChannel(args[2]);
        return this.setSRGB(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
      }
      if (fn === 'hsl' || fn === 'hsla') {
        const h = parseFloat(args[0]) / 360;
        const sa = parsePercent(args[1]);
        const l = parsePercent(args[2]);
        return this.setHSL(h, sa, l);
      }
      return this;
    }

    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, s)) {
      return this.setHex(NAMED_COLORS[s]);
    }
    return this;
  }

  /**
   * @param {Color} c
   * @returns {Color}
   */
  copy(c) {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    return this;
  }

  /** @returns {Color} */
  clone() {
    return new Color(this.r, this.g, this.b);
  }

  /**
   * @param {Color} c
   * @param {number} t
   * @returns {Color}
   */
  lerp(c, t) {
    this.r = lerpScalar(this.r, c.r, t);
    this.g = lerpScalar(this.g, c.g, t);
    this.b = lerpScalar(this.b, c.b, t);
    return this;
  }

  /**
   * @param {Color} a
   * @param {Color} b
   * @param {number} t
   * @returns {Color}
   */
  lerpColors(a, b, t) {
    this.r = lerpScalar(a.r, b.r, t);
    this.g = lerpScalar(a.g, b.g, t);
    this.b = lerpScalar(a.b, b.b, t);
    return this;
  }

  /**
   * @param {number} s
   * @returns {Color}
   */
  multiplyScalar(s) {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }

  /**
   * @param {Color} c
   * @returns {Color}
   */
  multiply(c) {
    this.r *= c.r;
    this.g *= c.g;
    this.b *= c.b;
    return this;
  }

  /**
   * @param {Color} c
   * @returns {Color}
   */
  add(c) {
    this.r += c.r;
    this.g += c.g;
    this.b += c.b;
    return this;
  }

  /**
   * Clamps every channel into 0..1.
   * @returns {Color}
   */
  clampChannels() {
    this.r = clamp(this.r, 0, 1);
    this.g = clamp(this.g, 0, 1);
    this.b = clamp(this.b, 0, 1);
    return this;
  }

  /**
   * Relative luminance of the linear color (Rec. 709).
   * @returns {number}
   */
  luminance() {
    return this.r * 0.2126 + this.g * 0.7152 + this.b * 0.0722;
  }

  /**
   * @param {Array<number>|Float32Array} [a=[]]
   * @param {number} [o=0]
   * @returns {Array<number>|Float32Array}
   */
  toArray(a = [], o = 0) {
    a[o] = this.r;
    a[o + 1] = this.g;
    a[o + 2] = this.b;
    return a;
  }

  /**
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Color}
   */
  fromArray(a, o = 0) {
    this.r = a[o];
    this.g = a[o + 1];
    this.b = a[o + 2];
    return this;
  }

  /**
   * @param {Color} c
   * @returns {boolean}
   */
  equals(c) {
    return this.r === c.r && this.g === c.g && this.b === c.b;
  }

  /**
   * @param {Color} c
   * @param {number} [eps=1e-6]
   * @returns {boolean}
   */
  nearlyEquals(c, eps = 1e-6) {
    return Math.abs(this.r - c.r) <= eps &&
      Math.abs(this.g - c.g) <= eps &&
      Math.abs(this.b - c.b) <= eps;
  }
}

/**
 * Parses '255' or '100%' into 0..1.
 * @param {string} v
 * @returns {number}
 */
function parseChannel(v) {
  if (v === undefined) return 0;
  if (v.charAt(v.length - 1) === '%') return parseFloat(v) / 100;
  return parseFloat(v) / 255;
}

/**
 * Parses '50%' or '0.5' into 0..1.
 * @param {string} v
 * @returns {number}
 */
function parsePercent(v) {
  if (v === undefined) return 0;
  if (v.charAt(v.length - 1) === '%') return parseFloat(v) / 100;
  return parseFloat(v);
}

/** White (frozen). @type {Color} */
Color.WHITE = Object.freeze(new Color(1, 1, 1));
/** Black (frozen). @type {Color} */
Color.BLACK = Object.freeze(new Color(0, 0, 0));
