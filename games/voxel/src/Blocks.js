/**
 * Block registry.
 *
 * A block type is a plain descriptor; the numeric id is what lives in the world
 * storage, so every lookup here is an array index rather than a hash.
 *
 * Three booleans drive the rest of the engine and they are NOT the same thing:
 *   - `solid`   the player collides with it
 *   - `opaque`  it blocks light AND hides the neighbouring face (full cube)
 *   - `liquid`  it renders in the transparent pass and does not collide
 *
 * Leaves are the interesting case: solid and collidable, but not opaque, so the
 * mesher keeps the interior faces and light still leaks through.
 */

/** Block ids. Keep these dense: they index `BLOCKS` directly. */
export const AIR = 0;
export const STONE = 1;
export const DIRT = 2;
export const GRASS = 3;
export const SAND = 4;
export const GRAVEL = 5;
export const LOG = 6;
export const LEAVES = 7;
export const PLANKS = 8;
export const COBBLESTONE = 9;
export const BEDROCK = 10;
export const COAL_ORE = 11;
export const IRON_ORE = 12;
export const GOLD_ORE = 13;
export const DIAMOND_ORE = 14;
export const SNOW = 15;
export const WATER = 16;
export const GLASS = 17;
export const GLOWSTONE = 18;
export const SANDSTONE = 19;

/** Face order used everywhere: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

/** Unit normal per face, in the same order. */
export const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/**
 * Fixed per-face shading, the trick that gives voxel worlds their readable
 * silhouette without any real normal lighting. Top is full bright, the two
 * horizontal axes differ so corners stay legible, the bottom is darkest.
 */
export const FACE_SHADE = [0.72, 0.72, 1.0, 0.45, 0.86, 0.86];

/**
 * @param {string} name
 * @param {Object} opts
 * @returns {Object} block descriptor
 */
function def(name, opts) {
  const t = opts.textures;
  return {
    name,
    /** @type {boolean} Collides with entities. */
    solid: opts.solid !== false,
    /** @type {boolean} Full cube that occludes light and neighbouring faces. */
    opaque: opts.opaque !== false,
    /** @type {boolean} Rendered in the transparent pass, no collision. */
    liquid: opts.liquid === true,
    /** @type {boolean} Alpha tested rather than blended. */
    cutout: opts.cutout === true,
    /** @type {number} 0..15 light emitted by the block itself. */
    light: opts.light || 0,
    /** @type {number} 0..15 light absorbed when passing through (opaque = 15). */
    absorb: opts.absorb !== undefined ? opts.absorb : (opts.opaque !== false ? 15 : 1),
    /** @type {string[]} Texture name per face, in FACE_* order. */
    textures: typeof t === 'string' ? [t, t, t, t, t, t] : t,
    /** @type {Int32Array|null} Resolved atlas layer per face, filled by TextureAtlas. */
    layers: null,
    /** @type {boolean} Whether the block should be picked by the crosshair. */
    pickable: opts.pickable !== false,
    /**
     * @type {boolean} Whether two adjacent blocks of this type hide the face
     * between them. True for glass and water (a pane stack should read as one
     * volume); false for leaves, whose alpha holes would otherwise let you see
     * straight through a tree into the sky.
     */
    selfCull: opts.selfCull !== false,
  };
}

/**
 * The registry. Index == block id.
 * @type {Object[]}
 */
export const BLOCKS = [
  def('air', { solid: false, opaque: false, absorb: 0, textures: null, pickable: false }),
  def('stone', { textures: 'stone' }),
  def('dirt', { textures: 'dirt' }),
  // top, side, bottom -> the classic grass block
  def('grass', { textures: ['grass_side', 'grass_side', 'grass_top', 'dirt', 'grass_side', 'grass_side'] }),
  def('sand', { textures: 'sand' }),
  def('gravel', { textures: 'gravel' }),
  def('log', { textures: ['log_side', 'log_side', 'log_top', 'log_top', 'log_side', 'log_side'] }),
  def('leaves', { opaque: false, cutout: true, selfCull: false, absorb: 2, textures: 'leaves' }),
  def('planks', { textures: 'planks' }),
  def('cobblestone', { textures: 'cobblestone' }),
  def('bedrock', { textures: 'bedrock' }),
  def('coal_ore', { textures: 'coal_ore' }),
  def('iron_ore', { textures: 'iron_ore' }),
  def('gold_ore', { textures: 'gold_ore' }),
  def('diamond_ore', { textures: 'diamond_ore' }),
  def('snow', { textures: ['snow', 'snow', 'snow', 'dirt', 'snow', 'snow'] }),
  def('water', { solid: false, opaque: false, liquid: true, absorb: 2, textures: 'water', pickable: false }),
  def('glass', { opaque: false, cutout: true, absorb: 0, textures: 'glass' }),
  def('glowstone', { light: 14, textures: 'glowstone' }),
  def('sandstone', { textures: ['sandstone_side', 'sandstone_side', 'sandstone_top', 'sandstone_top', 'sandstone_side', 'sandstone_side'] }),
];

/** Number of registered blocks. */
export const BLOCK_COUNT = BLOCKS.length;

/**
 * Flat lookup tables. The mesher and the lighting run over millions of voxels,
 * so they read these typed arrays instead of chasing object properties.
 */
export const IS_OPAQUE = new Uint8Array(BLOCK_COUNT);
export const IS_SOLID = new Uint8Array(BLOCK_COUNT);
export const IS_LIQUID = new Uint8Array(BLOCK_COUNT);
export const IS_CUTOUT = new Uint8Array(BLOCK_COUNT);
export const SELF_CULL = new Uint8Array(BLOCK_COUNT);
export const LIGHT_EMISSION = new Uint8Array(BLOCK_COUNT);
export const LIGHT_ABSORB = new Uint8Array(BLOCK_COUNT);

for (let i = 0; i < BLOCK_COUNT; i++) {
  const b = BLOCKS[i];
  IS_OPAQUE[i] = b.opaque ? 1 : 0;
  IS_SOLID[i] = b.solid ? 1 : 0;
  IS_LIQUID[i] = b.liquid ? 1 : 0;
  IS_CUTOUT[i] = b.cutout ? 1 : 0;
  SELF_CULL[i] = b.selfCull ? 1 : 0;
  LIGHT_EMISSION[i] = b.light;
  LIGHT_ABSORB[i] = b.absorb;
}

/**
 * Canonical texture order. **This array is the contract between the main thread
 * and the workers.**
 *
 * The mesher runs inside a worker, which has its own module instance of this
 * file. If layer indices were assigned when the GL atlas is built — something
 * only the main thread ever does — the worker's table would stay all zeros and
 * every block in the world would be drawn with texture 0. Deriving the indices
 * from a constant list instead means both sides agree with no handshake at all.
 *
 * TextureAtlas uploads layers in exactly this order.
 * @type {string[]}
 */
export const TEXTURE_NAMES = [
  'stone', 'dirt', 'sand', 'gravel', 'cobblestone', 'bedrock', 'snow',
  'grass_top', 'grass_side', 'log_side', 'log_top', 'leaves', 'planks',
  'sandstone_top', 'sandstone_side', 'water', 'glass', 'glowstone',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
];

/** Texture name -> atlas layer. */
export const LAYER_BY_NAME = new Map();
for (let i = 0; i < TEXTURE_NAMES.length; i++) LAYER_BY_NAME.set(TEXTURE_NAMES[i], i);

/**
 * Face layer table: `FACE_LAYERS[id * 6 + face]`.
 * Flat so the mesher does one indexed read per face.
 * @type {Int32Array}
 */
export const FACE_LAYERS = new Int32Array(BLOCK_COUNT * 6);

for (let id = 0; id < BLOCK_COUNT; id++) {
  const b = BLOCKS[id];
  if (b.textures === null) continue;
  const layers = new Int32Array(6);
  for (let f = 0; f < 6; f++) {
    const layer = LAYER_BY_NAME.get(b.textures[f]);
    if (layer === undefined) {
      throw new Error('Blocks: bloco "' + b.name + '" usa a textura desconhecida "' +
        b.textures[f] + '". Adicione-a a TEXTURE_NAMES.');
    }
    layers[f] = layer;
    FACE_LAYERS[id * 6 + f] = layer;
  }
  b.layers = layers;
}

/**
 * Whether a face between `here` and `neighbour` should be emitted.
 *
 * The rule that matters: two liquids of the same type never show a face between
 * them (otherwise an ocean is a wall of quads), and a non-opaque block only
 * hides a face against an identical block, which is what keeps leaf interiors
 * and stacked glass looking right.
 *
 * @param {number} here Block id owning the face.
 * @param {number} neighbour Block id on the other side.
 * @returns {boolean}
 */
export function facesVisible(here, neighbour) {
  if (here === AIR) return false;
  if (neighbour === AIR) return true;
  if (IS_OPAQUE[neighbour] === 1) return false;
  // Same non-opaque block: merge the volume unless the type wants its interior
  // faces kept (leaves).
  if (neighbour === here) return SELF_CULL[here] === 0;
  return true;
}

/**
 * Blocks the player is allowed to place, in hotbar order.
 * @type {number[]}
 */
export const PLACEABLE = [
  GRASS, DIRT, STONE, COBBLESTONE, SAND, SANDSTONE,
  LOG, PLANKS, LEAVES, GLASS, GLOWSTONE, SNOW,
];

/**
 * @param {number} id
 * @returns {string}
 */
export function blockName(id) {
  return id >= 0 && id < BLOCK_COUNT ? BLOCKS[id].name : 'unknown';
}
