/**
 * Testes do fluido celular em Node puro.
 *
 * O solver e' pura logica de grade, entao da' para verifica-lo com numeros em
 * vez de olhar a agua na tela — que e' justamente o tipo de coisa que "parece
 * certo" e esta' errado. Cobre o comportamento que o jogador percebe: cavar ao
 * lado da agua, a agua achar o buraco antes de continuar espalhando, a poca
 * secar quando a fonte some, e o avanco de exatamente uma celula por tick.
 *
 * Uso: node tools/fluid-test.mjs
 */

import { CellularFluid } from '../src/physics/CellularFluid.js';

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

/* --------------------------------------------------------------- grade */

const SIZE = 24;
const HEIGHT = 16;

/**
 * Grade densa de teste. Fora da caixa e' "nao carregado", nao parede: assim o
 * teste tambem exercita o caminho de regiao ausente.
 */
class Grid {
  constructor() {
    this.level = new Uint8Array(SIZE * HEIGHT * SIZE);
    this.solid = new Uint8Array(SIZE * HEIGHT * SIZE);
    this.source = new Uint8Array(SIZE * HEIGHT * SIZE);
    this.pressure = new Uint8Array(SIZE * HEIGHT * SIZE);
    this.writes = 0;
  }

  inside(x, y, z) {
    return x >= 0 && x < SIZE && y >= 0 && y < HEIGHT && z >= 0 && z < SIZE;
  }

  index(x, y, z) { return x + z * SIZE + y * SIZE * SIZE; }

  get(x, y, z) { return this.inside(x, y, z) ? this.level[this.index(x, y, z)] : 0; }

  set(x, y, z, v) {
    if (!this.inside(x, y, z)) return;
    this.level[this.index(x, y, z)] = v;
    this.writes++;
  }

  setSolid(x, y, z, v) {
    if (this.inside(x, y, z)) this.solid[this.index(x, y, z)] = v ? 1 : 0;
  }

  setSource(x, y, z, v = true) {
    if (!this.inside(x, y, z)) return;
    this.source[this.index(x, y, z)] = v ? 1 : 0;
    if (v) this.level[this.index(x, y, z)] = 8;
  }

  /** Piso solido em y, cobrindo toda a caixa. */
  floor(y) {
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) this.setSolid(x, y, z, true);
    }
  }

  total() {
    let sum = 0;
    for (let i = 0; i < this.level.length; i++) sum += this.level[i];
    return sum;
  }

  /** Bloco solido de (x0,y0,z0) a (x1,y1,z1), inclusive. */
  fill(x0, y0, z0, x1, y1, z1, v) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) this.setSolid(x, y, z, v);
      }
    }
  }

  /** @returns {CellularFluid} */
  solver(options = {}) {
    return new CellularFluid({
      getLevel: (x, y, z) => this.get(x, y, z),
      setLevel: (x, y, z, v) => this.set(x, y, z, v),
      isSolid: (x, y, z) => this.inside(x, y, z) && this.solid[this.index(x, y, z)] === 1,
      isSource: (x, y, z) => this.inside(x, y, z) && this.source[this.index(x, y, z)] === 1,
      isLoaded: (x, y, z) => this.inside(x, y, z),
      ...options,
    });
  }

  /** Solver com hidrostatica ligada. */
  pressureSolver(options = {}) {
    return this.solver({
      getPressure: (x, y, z) => (this.inside(x, y, z) ? this.pressure[this.index(x, y, z)] : 0),
      setPressure: (x, y, z, v) => {
        if (this.inside(x, y, z)) this.pressure[this.index(x, y, z)] = v;
      },
      ...options,
    });
  }
}

/* ------------------------------------------------- fonte e espalhamento */

console.log('\n--- fonte em piso plano');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);

  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);
  const ticks = fluid.settle();

  equal('fonte permanece cheia', g.get(12, 1, 12), 8);
  equal('vizinho imediato perde um nivel', g.get(13, 1, 12), 7);
  equal('a 4 celulas', g.get(16, 1, 12), 4);
  equal('a 7 celulas ainda molha', g.get(19, 1, 12), 1);
  equal('a 8 celulas seca', g.get(20, 1, 12), 0,
    'o alcance e' + "' " + 'exatamente maxLevel-1');
  check('convergiu em poucos ticks', ticks > 0 && ticks < 40, ticks + ' ticks');

  // Simetria: o alcance nao pode depender do eixo nem do sinal.
  const arms = [g.get(19, 1, 12), g.get(5, 1, 12), g.get(12, 1, 19), g.get(12, 1, 5)];
  check('espalhamento simetrico nos 4 sentidos',
    arms.every((v) => v === 1), arms.join(','));

  // Idempotencia: assentar de novo nao pode mexer em nada.
  const before = g.total();
  fluid.markDirty(12, 1, 12);
  fluid.settle();
  equal('reassentar nao altera o resultado', g.total(), before);
}

/* --------------------------------------- o caso que o usuario descreveu */

console.log('\n--- cavar ao lado da agua');
{
  const g = new Grid();
  g.floor(0);
  // Lago: uma coluna de fontes com uma parede de terra em x=10.
  for (let x = 5; x <= 9; x++) {
    for (let z = 10; z <= 14; z++) g.setSource(x, 1, z, true);
  }
  for (let z = 0; z < SIZE; z++) g.setSolid(10, 1, z, true);

  const fluid = g.solver();
  for (let x = 5; x <= 9; x++) {
    for (let z = 10; z <= 14; z++) fluid.markDirty(x, 1, z);
  }
  fluid.settle();

  equal('parede segura a agua', g.get(10, 1, 12), 0);
  equal('do outro lado esta seco', g.get(11, 1, 12), 0);

  // O jogador cava o bloco da parede.
  g.setSolid(10, 1, 12, false);
  fluid.markDirty(10, 1, 12);
  fluid.settle();

  equal('o bloco cavado enche de agua', g.get(10, 1, 12), 7);
  check('a agua segue adiante', g.get(11, 1, 12) === 6 && g.get(12, 1, 12) === 5,
    g.get(11, 1, 12) + ',' + g.get(12, 1, 12));
  equal('a parede intacta ao lado continua segurando', g.get(10, 1, 8), 0);
}

/* ------------------------------------------------ preferencia pelo buraco */

console.log('\n--- a agua procura o buraco antes de espalhar');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(2, 1, 12);
  // Buraco no piso a 3 celulas da fonte.
  g.setSolid(5, 0, 12, false);

  const fluid = g.solver();
  fluid.markDirty(2, 1, 12);

  // Roda tick a tick e observa a ordem dos eventos.
  let pitFullAt = -1;
  let pastPitAt = -1;
  for (let t = 1; t <= 60 && fluid.pending; t++) {
    fluid.tick();
    if (pitFullAt < 0 && g.get(5, 0, 12) === 8) pitFullAt = t;
    if (pastPitAt < 0 && g.get(6, 1, 12) > 0) pastPitAt = t;
  }
  fluid.settle();

  equal('o buraco enche ate' + "' " + 'a borda', g.get(5, 0, 12), 8);
  check('a agua so passa do buraco depois de enche-lo',
    pitFullAt > 0 && pastPitAt > 0 && pitFullAt <= pastPitAt,
    'cheio no tick ' + pitFullAt + ', passou no tick ' + pastPitAt);
  equal('depois do buraco o fluxo continua', g.get(6, 1, 12), 4);
}

/* ------------------------------------------------------------- queda */

console.log('\n--- queda vertical');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 10, 12);

  const fluid = g.solver();
  fluid.markDirty(12, 10, 12);
  fluid.settle();

  equal('a coluna abaixo da fonte fica cheia', g.get(12, 5, 12), 8);
  equal('chega ao fundo cheia', g.get(12, 1, 12), 8);
  equal('a base espalha como uma fonte', g.get(13, 1, 12), 7);
  equal('nao atravessa o piso', g.get(12, 0, 12), 0);
  check('nao espalha no meio da queda',
    g.get(13, 5, 12) === 0 && g.get(11, 5, 12) === 0,
    'agua caindo nao molha as laterais');
}

/* ------------------------------------------------------------- secagem */

console.log('\n--- a poca seca quando a fonte some');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);

  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);
  fluid.settle();
  const wet = g.total();
  check('havia agua antes', wet > 0, wet + ' de nivel somado');

  g.setSource(12, 1, 12, false);
  g.set(12, 1, 12, 0);
  fluid.markDirty(12, 1, 12);
  fluid.settle();

  equal('nao sobra nenhuma poca', g.total(), 0,
    'o mesmo criterio que espalha tambem drena');
}

/* -------------------------------------------------- uma celula por tick */

console.log('\n--- ritmo de propagacao');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);

  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);

  fluid.tick();
  equal('tick 1 molha a distancia 1', g.get(13, 1, 12), 7);
  equal('tick 1 nao molha a distancia 2', g.get(14, 1, 12), 0);
  fluid.tick();
  equal('tick 2 molha a distancia 2', g.get(14, 1, 12), 6);
  equal('tick 2 nao molha a distancia 3', g.get(15, 1, 12), 0);
}

console.log('\n--- relogio proprio');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);

  const fluid = g.solver({ flowInterval: 0.25 });
  fluid.markDirty(12, 1, 12);

  fluid.update(0.1);
  equal('nao corre antes do intervalo', g.get(13, 1, 12), 0);
  fluid.update(0.2);
  equal('roda ao completar o intervalo', g.get(13, 1, 12), 7);
  equal('e nao roda dois ticks de uma vez', g.get(14, 1, 12), 0);

  // Aba em segundo plano: um dt enorme nao pode virar centenas de ticks.
  const before = fluid.ticks;
  fluid.update(30);
  check('dt gigante fica limitado por maxCatchUpTicks',
    fluid.ticks - before <= 4, fluid.ticks - before + ' ticks para dt=30s');
}

/* ------------------------------------------------------------ orcamento */

console.log('\n--- orcamento por tick');
{
  const build = (budget) => {
    const g = new Grid();
    g.floor(0);
    g.setSource(12, 1, 12);
    const fluid = g.solver({ budget });
    fluid.markDirty(12, 1, 12);
    fluid.settle(2000);
    return g;
  };

  const full = build(100000);
  const starved = build(3);

  equal('orcamento apertado chega ao mesmo estado', starved.total(), full.total(),
    'o corte adia trabalho, nao o descarta');
  check('e celula a celula tambem confere',
    starved.get(16, 1, 12) === full.get(16, 1, 12), 'nivel ' + full.get(16, 1, 12));
}

/* ----------------------------------------------------------- contencao */

console.log('\n--- contencao e regiao nao carregada');
{
  const g = new Grid();
  g.floor(0);
  // Tanque 3x3 de paredes com uma fonte dentro.
  for (let x = 10; x <= 14; x++) {
    for (let z = 10; z <= 14; z++) {
      const edge = x === 10 || x === 14 || z === 10 || z === 14;
      if (edge) g.setSolid(x, 1, z, true);
    }
  }
  g.setSource(12, 1, 12);

  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);
  fluid.settle();

  check('a agua fica presa no tanque',
    g.get(15, 1, 12) === 0 && g.get(9, 1, 12) === 0);
  equal('e enche o interior', g.get(11, 1, 12), 7);

  // A borda da caixa e' "nao carregado": a agua nao pode escorrer para la'.
  const g2 = new Grid();
  g2.floor(0);
  g2.setSource(1, 1, 12);
  const f2 = g2.solver();
  f2.markDirty(1, 1, 12);
  f2.settle();
  equal('regiao nao carregada nao recebe agua', g2.get(-1, 1, 12), 0);
  equal('e nao impede o lado carregado', g2.get(2, 1, 12), 7);
}

/* ------------------------------------------------------------ correnteza */

console.log('\n--- vetor de correnteza');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);
  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);
  fluid.settle();

  const out = { x: 0, y: 0, z: 0 };

  fluid.flowAt(15, 1, 12, out);
  check('a correnteza aponta para longe da fonte',
    out.x > 0.9 && Math.abs(out.z) < 1e-6, out.x.toFixed(2) + ',' + out.z.toFixed(2));

  fluid.flowAt(12, 1, 15, out);
  check('e acompanha o eixo Z do mesmo jeito',
    out.z > 0.9 && Math.abs(out.x) < 1e-6, out.x.toFixed(2) + ',' + out.z.toFixed(2));

  fluid.flowAt(20, 1, 12, out);
  check('celula seca nao tem correnteza',
    out.x === 0 && out.y === 0 && out.z === 0);

  // Beirada: agua com queda disponivel puxa para baixo.
  const g3 = new Grid();
  g3.floor(0);
  g3.setSource(2, 1, 12);
  g3.setSolid(5, 0, 12, false);
  const f3 = g3.solver();
  f3.markDirty(2, 1, 12);
  f3.tick();
  f3.tick();
  f3.tick();
  f3.flowAt(5, 1, 12, out);
  check('sobre um vao a correnteza puxa para baixo', out.y < -0.5, 'y=' + out.y.toFixed(2));
}

/* ---------------------------------------------------------- escrita util */

console.log('\n--- custo em repouso');
{
  const g = new Grid();
  g.floor(0);
  g.setSource(12, 1, 12);
  const fluid = g.solver();
  fluid.markDirty(12, 1, 12);
  fluid.settle();

  const writesAfterSettle = g.writes;
  for (let i = 0; i < 100; i++) fluid.update(1 / 60);
  equal('parado nao escreve nada', g.writes, writesAfterSettle,
    'setLevel so' + "' " + 'e chamado quando o nivel muda de verdade');
  check('e a fila fica vazia', fluid.pending === false);
}

/* -------------------------------------------------- vasos comunicantes */

console.log('\n--- vasos comunicantes (tubo em U)');
{
  const g = new Grid();
  // Bloco macico, com um U escavado dentro dele.
  g.fill(0, 0, 0, SIZE - 1, HEIGHT - 1, SIZE - 1, true);
  const Z = 12;
  const LEFT = 5;
  const RIGHT = 9;
  const TOP = 10;
  for (let y = 1; y <= TOP; y++) {
    g.setSolid(LEFT, y, Z, false);   // braco esquerdo
    g.setSolid(RIGHT, y, Z, false);  // braco direito
  }
  for (let x = LEFT; x <= RIGHT; x++) g.setSolid(x, 1, Z, false); // fundo

  // Fonte no alto do braco esquerdo. A agua desce, atravessa o fundo e tem
  // que subir do outro lado ate' o mesmo nivel.
  g.setSource(LEFT, TOP, Z);

  const fluid = g.pressureSolver();
  fluid.markDirty(LEFT, TOP, Z);
  fluid.settle(4000);

  equal('o braco esquerdo enche', g.get(LEFT, 2, Z), 8);
  equal('o fundo enche', g.get(LEFT + 2, 1, Z), 8);

  // Altura da coluna do braco direito.
  let rise = 0;
  for (let y = 1; y <= TOP; y++) if (g.get(RIGHT, y, Z) > 0) rise = y;
  check('a agua sobe pelo braco oposto', rise > 1,
    'topo em y=' + rise + ' (sem pressao ficaria em y=1)');
  check('e alcanca praticamente o nivel da fonte', rise >= TOP - 1,
    'y=' + rise + ' contra a fonte em y=' + TOP);
  check('mas nao passa dela', g.get(RIGHT, TOP + 1, Z) === 0,
    'agua nao sobe acima do proprio nivel');
}

console.log('\n--- sala escavada abaixo do nivel do lago');
{
  const g = new Grid();
  g.fill(0, 0, 0, SIZE - 1, HEIGHT - 1, SIZE - 1, true);
  const Z = 12;
  // Lago 8 de profundidade em x=3..7, y=1..8.
  for (let y = 1; y <= 8; y++) {
    for (let x = 3; x <= 7; x++) g.setSolid(x, y, Z, false);
  }
  for (let y = 1; y <= 8; y++) {
    for (let x = 3; x <= 7; x++) g.setSource(x, y, Z);
  }
  // Sala vazia em x=10..14, y=1..8, separada por uma parede em x=8..9.
  for (let y = 1; y <= 8; y++) {
    for (let x = 10; x <= 14; x++) g.setSolid(x, y, Z, false);
  }

  const fluid = g.pressureSolver();
  for (let y = 1; y <= 8; y++) for (let x = 3; x <= 7; x++) fluid.markDirty(x, y, Z);
  fluid.settle(4000);
  equal('a parede segura o lago', g.get(12, 1, Z), 0);

  // Um tunel de dois blocos no fundo da parede.
  g.setSolid(8, 1, Z, false);
  g.setSolid(9, 1, Z, false);
  fluid.markDirty(8, 1, Z);
  fluid.markDirty(9, 1, Z);
  fluid.settle(4000);

  equal('o tunel enche', g.get(9, 1, Z), 8);
  equal('o chao da sala enche', g.get(12, 1, Z), 8);

  let level = 0;
  for (let y = 1; y <= 8; y++) if (g.get(12, y, Z) > 0) level = y;
  check('a sala sobe ate' + "' " + 'o nivel do lago', level >= 7,
    'topo da sala em y=' + level + ', lago em y=8');
  check('e nao transborda', g.get(12, 9, Z) === 0);
}

console.log('\n--- pressao nao inventa agua');
{
  // O caso que separa hidrostatica de inundacao descontrolada: uma unica fonte
  // num plano aberto nao tem nada em cima dela, entao nao tem pressao, e o
  // resultado tem que ser identico ao do solver sem pressao.
  const a = new Grid();
  a.floor(0);
  a.setSource(12, 1, 12);
  const fa = a.solver();
  fa.markDirty(12, 1, 12);
  fa.settle();

  const b = new Grid();
  b.floor(0);
  b.setSource(12, 1, 12);
  const fb = b.pressureSolver();
  fb.markDirty(12, 1, 12);
  fb.settle();

  equal('fonte isolada se comporta igual com e sem pressao', b.total(), a.total(),
    'uma lamina fina nao carrega carga hidraulica');
  equal('e o alcance continua sendo maxLevel-1', b.get(20, 1, 12), 0);
  equal('sem afogar o plano', b.get(12, 2, 12), 0);
}

console.log('\n--- a carga some junto com a agua que a sustentava');
{
  const g = new Grid();
  g.fill(0, 0, 0, SIZE - 1, HEIGHT - 1, SIZE - 1, true);
  const Z = 12;
  for (let y = 1; y <= 6; y++) {
    for (let x = 5; x <= 9; x++) g.setSolid(x, y, Z, false);
  }
  for (let y = 1; y <= 6; y++) g.setSource(5, y, Z);

  const fluid = g.pressureSolver();
  for (let y = 1; y <= 6; y++) fluid.markDirty(5, y, Z);
  fluid.settle(4000);

  const filled = g.get(8, 3, Z);
  check('a coluna pressurizada enche o tanque', filled > 0, 'nivel ' + filled);
  const pressureBefore = g.pressure[g.index(8, 1, Z)];
  check('e ha' + "' " + 'carga registrada no fundo', pressureBefore > 0, pressureBefore + ' unidades');

  // Remove a coluna que sustentava tudo.
  for (let y = 1; y <= 6; y++) {
    g.setSource(5, y, Z, false);
    g.set(5, y, Z, 0);
    fluid.markDirty(5, y, Z);
  }
  fluid.settle(6000);

  equal('sem a fonte nao sobra agua', g.total(), 0);
  let stale = 0;
  for (let i = 0; i < g.pressure.length; i++) if (g.pressure[i] > 0) stale++;
  equal('nem carga presa em ciclo', stale, 0,
    'um max-flood sem custo por aresta seguraria o valor para sempre');
}

/* ----------------------------------------------------------- resultado */

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
  ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
process.exit(failed === 0 ? 0 : 1);
