/**
 * Testes do scene graph em Node puro (nada aqui precisa de WebGL).
 *
 * Cobre a classe de bug mais dificil de notar olhando a tela: o proxy do
 * broadphase ficar com limites velhos. O sintoma nunca e' "sumiu"; e' "some
 * dependendo do angulo", porque a malha continua sendo desenhada sempre que os
 * limites obsoletos por acaso caem dentro do frustum. Foi assim com o corpo do
 * kart e depois com a agua do voxel.
 *
 * Uso: node tools/scene-test.mjs
 */

import { Scene } from '../src/scene/Scene.js';
import { Mesh } from '../src/scene/Mesh.js';
import { Geometry } from '../src/render/Geometry.js';
import { AABB } from '../src/math/AABB.js';

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
 * Quad no plano XY indo da origem ate (size, size).
 * @param {number} size
 * @returns {Geometry}
 */
function quad(size) {
  const g = new Geometry();
  g.setAttribute('aPosition', new Float32Array([
    0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0,
  ]), 3);
  g.setIndex(new Uint32Array([0, 1, 2, 0, 2, 3]));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** @returns {number} quantas malhas o broadphase reporta na caixa dada. */
function query(scene, minX, minY, maxX, maxY) {
  const box = new AABB();
  box.min.set(minX, minY, -1);
  box.max.set(maxX, maxY, 1);
  return scene.bvh.queryAABB(box, []);
}

/* -------------------------------------- geometria trocada numa malha parada */

console.log('\n--- trocar a geometria de uma malha que nao se move');
{
  const scene = new Scene();
  const mesh = new Mesh(quad(1), null);
  // Exatamente o que um chunk de voxel faz: posicao fixa, matriz manual.
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  scene.updateMatrices();
  scene.updateBVH();

  equal('limites iniciais vem da primeira geometria', mesh.boundingBoxWorld.max.x, 1);
  equal('longe dali o broadphase nao acha nada', query(scene, 40, 40, 60, 60), 0);

  // A malha nao se mexeu; so' a geometria foi substituida.
  mesh.geometry = quad(50);
  scene.updateMatrices();
  scene.updateBVH();

  equal('os limites acompanham a geometria nova', mesh.boundingBoxWorld.max.x, 50,
    'a matriz nao mudou, entao a guarda por worldMatrixVersion sozinha desistiria');
  equal('e o broadphase enxerga a extensao nova', query(scene, 40, 40, 60, 60), 1,
    'e' + "' " + 'este o teste que importa: o frustum culling consulta o BVH');
}

console.log('\n--- geometria que encolhe');
{
  const scene = new Scene();
  const mesh = new Mesh(quad(50), null);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  scene.updateMatrices();
  scene.updateBVH();
  equal('a malha grande aparece longe da origem', query(scene, 40, 40, 60, 60), 1);

  mesh.geometry = quad(1);
  scene.updateMatrices();
  scene.updateBVH();

  equal('encolher tambem atualiza os limites', mesh.boundingBoxWorld.max.x, 1);
  equal('e o broadphase para de reporta-la longe', query(scene, 40, 40, 60, 60), 0,
    'limites inflados custam travessia de BVH e draw calls a toa');
  equal('mas continua sendo achada onde de fato esta', query(scene, -1, -1, 2, 2), 1);
}

console.log('\n--- a troca so conta quando muda mesmo');
{
  const scene = new Scene();
  const g = quad(1);
  const mesh = new Mesh(g, null);
  scene.add(mesh);
  scene.updateMatrices();
  scene.updateBVH();

  const version = mesh._geometryVersion;
  mesh.geometry = g;
  equal('reatribuir a mesma geometria nao versiona', mesh._geometryVersion, version,
    'senao toda atribuicao redundante refaria o proxy');

  mesh.geometry = quad(1);
  check('trocar por outra geometria versiona', mesh._geometryVersion > version,
    version + ' -> ' + mesh._geometryVersion);
}

/* ------------------------------------- matriz mexida fora do walk da cena */

console.log('\n--- matriz atualizada por fora do walk');
{
  const scene = new Scene();
  const mesh = new Mesh(quad(1), null);
  scene.add(mesh);
  scene.updateMatrices();
  scene.updateBVH();
  equal('nasce na origem', query(scene, -1, -1, 2, 2), 1);

  // Ler uma posicao de mundo no meio do frame e' legitimo, e consome os flags
  // de sujeira. A cena tem que continuar percebendo que a malha mudou.
  mesh.position.set(50, 50, 0);
  mesh.updateWorldMatrix(true);

  scene.updateMatrices();
  scene.updateBVH();
  equal('o broadphase segue a malha ate o novo lugar', query(scene, 40, 40, 60, 60), 1,
    'regressao do corpo do kart, que sumia mas continuava projetando sombra');
  equal('e nao a reporta mais no lugar antigo', query(scene, -1, -1, 2, 2), 0);
}

console.log('\n--- movimento normal');
{
  const scene = new Scene();
  const mesh = new Mesh(quad(1), null);
  scene.add(mesh);
  scene.updateMatrices();
  scene.updateBVH();

  mesh.position.set(50, 50, 0);
  scene.updateMatrices();
  scene.updateBVH();
  equal('mover pelo caminho comum continua funcionando', query(scene, 40, 40, 60, 60), 1);
}

/* ----------------------------------------------------------- resultado */

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
  ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
process.exit(failed === 0 ? 0 : 1);
