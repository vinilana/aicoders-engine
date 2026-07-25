/**
 * Converts a single sRGB channel (0..1) to linear light.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c: number): number;
/**
 * Converts a single linear channel (0..1) to sRGB.
 * @param {number} c
 * @returns {number}
 */
export function linearToSRGB(c: number): number;
/**
 * RGB color stored in LINEAR space (all engine lighting is linear).
 * Inputs given in sRGB (hex, CSS strings, HSL) are converted on the way in.
 */
export class Color {
    /**
     * Accepts linear components `(r, g, b)`, a single sRGB hex (`0xff8800`),
     * a CSS string (`'#ff8800'`, `'rgb(255,136,0)'`), another Color, or a
     * single scalar (grey level).
     * @param {number|string|Color} [r=1]
     * @param {number} [g]
     * @param {number} [b]
     */
    constructor(r?: number | string | Color, g?: number, b?: number);
    /** @type {number} Linear red. */ r: number;
    /** @type {number} Linear green. */ g: number;
    /** @type {number} Linear blue. */ b: number;
    /**
     * Sets linear components directly.
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @returns {Color}
     */
    set(r: number, g: number, b: number): Color;
    /**
     * Sets all linear components to the same value.
     * @param {number} s
     * @returns {Color}
     */
    setScalar(s: number): Color;
    /**
     * Sets the color from a packed 0xRRGGBB value.
     * @param {number} hex
     * @param {string} [colorSpace='srgb'] 'srgb' converts to linear, 'linear' keeps the values.
     * @returns {Color}
     */
    setHex(hex: number, colorSpace?: string): Color;
    /**
     * Packs the color back into 0xRRGGBB.
     * @param {string} [colorSpace='srgb']
     * @returns {number}
     */
    getHex(colorSpace?: string): number;
    /**
     * '#rrggbb' representation (sRGB encoded).
     * @returns {string}
     */
    getHexString(): string;
    /**
     * Sets the color from sRGB channel values in 0..1.
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @returns {Color}
     */
    setSRGB(r: number, g: number, b: number): Color;
    /**
     * Sets the color from HSL.
     * @param {number} h Hue in 0..1 (wrapped).
     * @param {number} s Saturation 0..1.
     * @param {number} l Lightness 0..1.
     * @param {string} [colorSpace='srgb'] HSL is interpreted in sRGB by default.
     * @returns {Color}
     */
    setHSL(h: number, s: number, l: number, colorSpace?: string): Color;
    /**
     * Writes the HSL representation of this color into `out`.
     * @param {{h:number, s:number, l:number}} out
     * @returns {{h:number, s:number, l:number}}
     */
    getHSL(out: {
        h: number;
        s: number;
        l: number;
    }): {
        h: number;
        s: number;
        l: number;
    };
    /**
     * Parses a CSS-like color string: '#rgb', '#rrggbb', 'rgb(r,g,b)',
     * 'rgba(r,g,b,a)', 'hsl(h,s%,l%)' or a basic color name.
     * Unknown strings leave the color untouched.
     * @param {string} style
     * @returns {Color}
     */
    setStyle(style: string): Color;
    /**
     * @param {Color} c
     * @returns {Color}
     */
    copy(c: Color): Color;
    /** @returns {Color} */
    clone(): Color;
    /**
     * @param {Color} c
     * @param {number} t
     * @returns {Color}
     */
    lerp(c: Color, t: number): Color;
    /**
     * @param {Color} a
     * @param {Color} b
     * @param {number} t
     * @returns {Color}
     */
    lerpColors(a: Color, b: Color, t: number): Color;
    /**
     * @param {number} s
     * @returns {Color}
     */
    multiplyScalar(s: number): Color;
    /**
     * @param {Color} c
     * @returns {Color}
     */
    multiply(c: Color): Color;
    /**
     * @param {Color} c
     * @returns {Color}
     */
    add(c: Color): Color;
    /**
     * Clamps every channel into 0..1.
     * @returns {Color}
     */
    clampChannels(): Color;
    /**
     * Relative luminance of the linear color (Rec. 709).
     * @returns {number}
     */
    luminance(): number;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Color}
     */
    fromArray(a: ArrayLike<number>, o?: number): Color;
    /**
     * @param {Color} c
     * @returns {boolean}
     */
    equals(c: Color): boolean;
    /**
     * @param {Color} c
     * @param {number} [eps=1e-6]
     * @returns {boolean}
     */
    nearlyEquals(c: Color, eps?: number): boolean;
}
export namespace Color {
    const WHITE: Readonly<Color>;
    const BLACK: Readonly<Color>;
}
