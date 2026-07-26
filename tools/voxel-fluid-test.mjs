/**
 * Agua corrente no mundo voxel, em Node puro.
 *
 * O `fluid-test.mjs` prova o solver da engine sobre uma grade abstrata. Este
 * prova a *integracao*: que o nivel e o id do bloco nunca se contradizem, que o
 * oceano gerado nao drena sozinho, que cavar ao lado da agua enche o buraco, e
 * que o mesher recebe o nivel para desenhar a superficie na altura certa.
 *
 * Nada aqui toca WebGL — World, Chunk, Mesher e o fluido rodam todos fora da
 * GPU, que e' o que torna este teste possivel.
 *
 * Uso: node tools/voxel-fluid-test.mjs
 */

import { World } from '../games/voxel/src/World.js';
import { Chunk, WORLD_HEIGHT, FLUID_MAX, fluidSurfaceHeight } from '../games/voxel/src/Chunk.js';
import { generateChunk, SEA_LEVEL } from '../games/voxel/src/WorldGen.js';
import { meshSection } from '../games/voxel/src/Mesher.js';
import { AIR, WATER, STONE } from '../games/voxel/src/Blocks.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failed++;
    console.log('  FALHA ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function equal(name, value, expected, detail) {
  check(name, value === expected,
    'obtido ' + value + ', esperado ' + expected + (detail ? '; ' + detail : ''));
}

/**
 * Chunk central da regiao oceanica desta seed. O terreno perto da origem fica
 * acima do nivel do mar, entao um teste de agua ancorado em (0,0) nao testaria
 * nada — procuramos o oceano de proposito.
 */
const OCEAN_CX = 10;
const OCEAN_CZ = 2;

/**
 * Mundo gerado de verdade, num raio de chunks ao redor do oceano.
 * @param {number} radius
 * @returns {World}
 */
function buildWorld(radius) {
  const world = new World({ seed: 1337 });
  for (let cz = OCEAN_CZ - radius; cz <= OCEAN_CZ + radius; cz++) {
    for (let cx = OCEAN_CX - radius; cx <= OCEAN_CX + radius; cx++) {
      const result = generateChunk(cx, cz, world.seed);
      const chunk = new Chunk(cx, cz);
      chunk.blocks.set(result.blocks);
      chunk.rebuildDerived();
      world.addChunk(chunk);
    }
  }
  return world;
}

/** @returns {number} soma de todos os niveis de fluido carregados. */
function totalFluid(world) {
  let sum = 0;
  for (const chunk of world.chunks.values()) {
    for (let i = 0; i < chunk.fluid.length; i++) sum += chunk.fluid[i] & 0x0f;
  }
  return sum;
}

/** Verifica a invariante que amarra o array de fluido ao de blocos. */
function invariantBreaks(world) {
  let broken = 0;
  for (const chunk of world.chunks.values()) {
    for (let i = 0; i < chunk.blocks.length; i++) {
      const wet = (chunk.fluid[i] & 0x0f) > 0;
      const isWater = chunk.blocks[i] === WATER;
      if (wet !== isWater) broken++;
    }
  }
  return broken;
}

/* ------------------------------------------------- o oceano se sustenta */

console.log('\n--- oceano gerado');
{
  const world = buildWorld(1);

  let waterCells = 0;
  for (const chunk of world.chunks.values()) {
    for (let i = 0; i < chunk.blocks.length; i++) if (chunk.blocks[i] === WATER) waterCells++;
  }
  check('a geracao produziu agua', waterCells > 0, waterCells + ' celulas');
  equal('bloco e nivel concordam apos gerar', invariantBreaks(world), 0);

  const before = totalFluid(world);
  world.fluid.settle();
  equal('o oceano nao drena sozinho', totalFluid(world), before,
    'agua gerada e' + "' " + 'fonte');

  // Em repouso a simulacao nao pode custar nada.
  let changed = 0;
  for (let i = 0; i < 120; i++) changed += world.fluid.update(1 / 60);
  equal('parado nao move nenhuma celula', changed, 0);
  check('e a fila fica vazia', world.fluid.pending === false,
    world.fluid.queueLength + ' na fila');
}

/* ----------------------------------- o caso que o usuario pediu, no jogo */

console.log('\n--- cavar ao lado da agua no mundo gerado');
{
  const world = buildWorld(2);

  // Procura uma parede: agua em (x,y,z) com um bloco solido encostado no mesmo
  // Y. E' exatamente a situacao do pedido — um bloco que, ao ser removido,
  // passa a ter agua do lado — e existe garantidamente na encosta do leito.
  // Nao exigimos ceu aberto acima: isso restringiria a busca a' linha da praia,
  // que nesta seed fica fora da regiao gerada aqui.
  let shore = null;
  const minX = (OCEAN_CX - 2) * 16;
  const maxX = (OCEAN_CX + 3) * 16;
  const minZ = (OCEAN_CZ - 2) * 16;
  const maxZ = (OCEAN_CZ + 3) * 16;
  outer:
  for (let x = minX; x < maxX; x++) {
    for (let z = minZ; z < maxZ; z++) {
      for (let y = SEA_LEVEL; y > 20; y--) {
        if (world.getBlock(x, y, z) !== WATER) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const nz = z + dz;
          const id = world.getBlock(nx, y, nz);
          if (id !== AIR && id !== WATER) {
            shore = { x: nx, y, z: nz };
            break outer;
          }
        }
      }
    }
  }

  check('achou um bloco encostado na agua', shore !== null,
    shore ? shore.x + ',' + shore.y + ',' + shore.z : 'nenhuma');

  if (shore !== null) {
    equal('a margem esta seca antes', world.getFluidLevel(shore.x, shore.y, shore.z), 0);

    // O jogador cava o bloco da margem.
    world.setBlock(shore.x, shore.y, shore.z, AIR);
    world.fluid.settle();

    check('o bloco cavado encheu de agua',
      world.getFluidLevel(shore.x, shore.y, shore.z) > 0,
      'nivel ' + world.getFluidLevel(shore.x, shore.y, shore.z));
    equal('e virou bloco de agua', world.getBlock(shore.x, shore.y, shore.z), WATER);
    equal('sem quebrar a invariante', invariantBreaks(world), 0);
    check('a agua que entrou nao e' + "' " + 'fonte',
      world.isFluidSource(shore.x, shore.y, shore.z) === false,
      'so' + "' " + 'a agua gerada e a do balde sao fonte');
  }
}

/* --------------------------------------------- poca controlada em terra */

console.log('\n--- balde de agua em terreno plano');
{
  const world = new World({ seed: 7 });
  // Plataforma de pedra artificial, longe de qualquer agua gerada.
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = new Chunk(cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) chunk.set(x, 60, z, STONE);
      }
      chunk.rebuildDerived();
      world.addChunk(chunk);
    }
  }
  equal('a plataforma nasce seca', totalFluid(world), 0);

  world.setBlock(0, 61, 0, WATER);
  check('agua colocada a mao e' + "' " + 'fonte', world.isFluidSource(0, 61, 0) === true);

  world.fluid.settle();

  equal('a fonte fica cheia', world.getFluidLevel(0, 61, 0), FLUID_MAX);
  equal('o vizinho perde um nivel', world.getFluidLevel(1, 61, 0), FLUID_MAX - 1);
  equal('a 7 celulas ainda molha', world.getFluidLevel(7, 61, 0), 1);
  equal('a 8 celulas seca', world.getFluidLevel(8, 61, 0), 0);
  equal('e nao vaza para baixo da pedra', world.getFluidLevel(0, 59, 0), 0);
  equal('invariante intacta', invariantBreaks(world), 0);

  // Cavar um buraco na plataforma: a agua tem que achar o buraco.
  world.setBlock(3, 60, 0, AIR);
  world.fluid.settle();
  equal('a agua desce pelo buraco cavado', world.getFluidLevel(3, 59, 0), FLUID_MAX);

  // Tirar a fonte seca tudo.
  world.setBlock(0, 61, 0, AIR);
  world.fluid.settle();
  equal('sem a fonte a poca some por inteiro', totalFluid(world), 0);
  equal('e nao sobra bloco de agua', invariantBreaks(world), 0);
}

/* ------------------------------------------------------- queda e degraus */

console.log('\n--- cachoeira');
{
  const world = new World({ seed: 9 });
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = new Chunk(cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) chunk.set(x, 40, z, STONE);
      }
      chunk.rebuildDerived();
      world.addChunk(chunk);
    }
  }

  world.setBlock(0, 50, 0, WATER);
  world.fluid.settle();

  equal('a coluna cai cheia', world.getFluidLevel(0, 45, 0), FLUID_MAX);
  check('a queda nao espalha no meio do ar',
    world.getFluidLevel(1, 45, 0) === 0 && world.getFluidLevel(0, 45, 1) === 0,
    'nada de cortina lateral');
  equal('e empoca so' + "' " + 'ao tocar o chao', world.getFluidLevel(1, 41, 0), FLUID_MAX - 1);
  equal('invariante intacta', invariantBreaks(world), 0);
}

/* ------------------------------------------------ o mesher ve os niveis */

console.log('\n--- superficie desenhada na altura do nivel');
{
  const world = new World({ seed: 11 });
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = new Chunk(cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) chunk.set(x, 32, z, STONE);
      }
      chunk.rebuildDerived();
      world.addChunk(chunk);
    }
  }
  world.setBlock(2, 33, 8, WATER);
  world.fluid.settle();

  const chunk = world.getChunk(0, 0);
  const padded = world.buildPadded(chunk, 2); // secao que contem y=32..47
  const { water } = meshSection(padded.blocks, padded.light, padded.fluid);

  check('a secao produziu geometria de agua', water !== null,
    water ? water.positions.length / 3 + ' vertices' : 'nenhuma');

  if (water !== null) {
    // Alturas distintas do topo provam que o nivel chegou ao mesher: com um
    // valor unico todas as superficies sairiam no mesmo Y. As posicoes vem em
    // coordenadas locais da secao (y=32 do mundo e' 0 aqui), nao mundiais.
    const tops = new Set();
    for (let i = 1; i < water.positions.length; i += 3) {
      const y = water.positions[i];
      if (y > 1 && y < 2) tops.add(Math.round((y - 1) * 1000) / 1000);
    }
    check('a superficie tem mais de uma altura', tops.size > 1,
      [...tops].sort((a, b) => b - a).join(' / '));

    const expectedFull = fluidSurfaceHeight(FLUID_MAX);
    check('a mais alta corresponde ao nivel cheio',
      tops.has(Math.round(expectedFull * 1000) / 1000),
      'esperado ' + expectedFull);
  }
}

/* ----------------------------------------------------------- correnteza */

console.log('\n--- correnteza empurra na direcao do escoamento');
{
  const world = new World({ seed: 13 });
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = new Chunk(cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) chunk.set(x, 20, z, STONE);
      }
      chunk.rebuildDerived();
      world.addChunk(chunk);
    }
  }
  world.setBlock(0, 21, 0, WATER);
  world.fluid.settle();

  const flow = world.fluid.flowAt(3, 21, 0);
  check('aponta para longe da fonte', flow.x > 0.9 && Math.abs(flow.z) < 1e-6,
    flow.x.toFixed(2) + ',' + flow.y.toFixed(2) + ',' + flow.z.toFixed(2));

  const dry = world.fluid.flowAt(12, 21, 0);
  check('celula seca nao empurra', dry.x === 0 && dry.y === 0 && dry.z === 0);
}

/* --------------------------------------------------- custo por vizinhanca */

console.log('\n--- chunk que chega depois');
{
  const world = new World({ seed: 1337 });
  // Carrega so' um chunk, deixa assentar, depois traz os vizinhos.
  const first = generateChunk(OCEAN_CX, OCEAN_CZ, world.seed);
  const c0 = new Chunk(OCEAN_CX, OCEAN_CZ);
  c0.blocks.set(first.blocks);
  c0.rebuildDerived();
  world.addChunk(c0);
  world.fluid.settle();

  const before = totalFluid(world);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cx = OCEAN_CX + dx;
    const cz = OCEAN_CZ + dz;
    const r = generateChunk(cx, cz, world.seed);
    const c = new Chunk(cx, cz);
    c.blocks.set(r.blocks);
    c.rebuildDerived();
    world.addChunk(c);
  }
  world.fluid.settle();

  check('a vizinhanca nova nao apagou a agua do chunk antigo',
    totalFluid(world) > before, before + ' -> ' + totalFluid(world));
  equal('invariante intacta atravessando a borda', invariantBreaks(world), 0);
}

/* ----------------------------------------------------------- resultado */

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
  ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
process.exit(failed === 0 ? 0 : 1);
