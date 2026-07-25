# AICoders Engine

Engine 3D WebGL2 completa, escrita do zero em JavaScript puro: sem dependencias, sem build step, sem framework.

`WebGL2` &middot; `Zero dependencias` &middot; `Zero build` &middot; `ES Modules nativos` &middot; `MIT`

---

## Destaques

- **104 modulos ES** em `src/`, todos com `export` nomeado (nenhum `export default`), todos os
  especificadores terminando em `.js` - o navegador carrega o codigo cru, sem bundler.
- **Forward+ (clustered)**: grid de froxels 16x9x24, milhares de luzes pontuais e spot por frame.
- **PBR metallic-roughness** com IBL (irradiancia + prefiltered + BRDF LUT gerados na GPU),
  iluminacao em espaco LINEAR e tonemap ACES aplicado uma unica vez, no passe final.
- **CSM** (cascaded shadow maps) com 4 cascatas, esfera envolvente invariante a rotacao e snap de texel.
- **Broadphase por DynamicBVH** em structure-of-arrays, SAH na insercao, rotacoes tipo AVL,
  e query de frustum com *plane coherency*.
- **Zero alocacao no frame**: render list em pool, sort keys uint32, scratch em escopo de modulo,
  UBOs com upload incremental por range sujo.
- **Instancing** (matriz + cor + vec4 livre por instancia), **skinning na GPU** por bone texture,
  **LOD** com histerese.
- **Fisica**: sweep de esfera/capsula contra TriangleBVH, `CharacterController` collide-and-slide com
  step offset e slope limit, `RigidBody` com esfera/caixa/capsula.
- **Loaders**: glTF 2.0 completo (`.gltf` + `.glb`, skinning, animacao, cameras, luzes, 8 extensoes KHR/EXT)
  e OBJ/MTL.
- **Pos-processamento**: SSAO, bloom com piramide de down/upsample, exposicao, tonemap, FXAA, vinheta,
  aberracao cromatica e grao.
- **Ferramentas proprias** em `tools/`: teste de matematica, verificacao do grafo de imports, validacao
  estatica de GLSL, smoke test headless com WebGL2 mockado, harness em Chrome real via CDP (WebSocket
  nativo do Node, sem playwright/puppeteer) e servidor estatico.

---

## Instalacao

Tres formas de consumir, todas com o mesmo codigo de aplicacao.

**npm** — com bundler (Vite, esbuild, webpack, Rollup):

```bash
npm install aicoders-engine
```

```js
import { Engine, Mesh, StandardMaterial, createBox } from 'aicoders-engine';
// ou por area:
import { Vec3, Mat4 } from 'aicoders-engine/math';
import { CollisionWorld, WaterVolume } from 'aicoders-engine/physics';
```

**Sem ferramenta nenhuma** — import map no HTML, que e como a propria demo roda:

```html
<script type="importmap">
{ "imports": {
    "aicoders-engine": "./node_modules/aicoders-engine/src/index.js",
    "aicoders-engine/": "./node_modules/aicoders-engine/src/"
} }
</script>
<script type="module" src="./main.js"></script>
```

**Submodulo git** — quando voce quer editar a engine junto com o jogo:

```bash
git submodule add https://github.com/vinilana/aicoders-engine.git vendor/engine
```

### Ponto de partida

`templates/starter/` e um projeto minimo e funcional: cena, luz, PBR, um corpo
rigido caindo e camera orbital. Copie a pasta e comece dali — ela vem no pacote,
entao `cp -r node_modules/aicoders-engine/templates/starter meu-jogo` funciona.

### Tipos

Os `.d.ts` sao gerados do JSDoc do proprio codigo e **vao commitados** em
`types/`, entao autocompletar e checagem funcionam em TypeScript e em JS com
`// @ts-check` sem que voce instale ou compile nada. A engine continua sendo
JavaScript puro; o TypeScript e um devDependency usado so por `npm run types`.

### Subpaths disponiveis

| Import | Conteudo |
|---|---|
| `aicoders-engine` | tudo (~470 exports) |
| `aicoders-engine/math` | Vec2/3/4, Quat, Mat3/4, AABB, Ray, Frustum, Color |
| `aicoders-engine/core` | Engine, Time, EventBus, Pool, Logger |
| `aicoders-engine/scene` | Node3D, Scene, cameras, Mesh, luzes, LOD |
| `aicoders-engine/render` | Renderer, materiais, texturas, shaders, pos-processamento |
| `aicoders-engine/physics` | CollisionWorld, RigidBody, CharacterController, WaterVolume |
| `aicoders-engine/geometry` | primitivas e texturas procedurais |
| `aicoders-engine/spatial` | DynamicBVH, TriangleBVH |
| `aicoders-engine/animation` | AnimationMixer, clips, tracks |
| `aicoders-engine/loaders` | GLTFLoader, OBJLoader, AssetManager |
| `aicoders-engine/input` | Input, OrbitControls, FirstPersonControls |
| `aicoders-engine/audio` | AudioEngine, AudioSource |
| `aicoders-engine/util` | Stats, utilitarios de TypedArray |
| `aicoders-engine/src/<caminho>.js` | qualquer modulo interno, sem intermediario |

---

## Comecando

```bash
npm start                  # equivalente a: node tools/serve.mjs
# abra http://localhost:8080/
```

Opcoes do servidor:

```bash
node tools/serve.mjs --port 3000 --host 0.0.0.0 --root . --quiet
```

### Por que `file://` nao funciona

A engine e distribuida como ES Modules crus (`<script type="module">`). O navegador aplica a politica
de mesma origem ao resolver cada `import`, e o protocolo `file://` **nao tem origem** - toda requisicao
de modulo vira uma origem `null` que falha na checagem de CORS. Abrir `index.html` direto do disco
resulta em erro do tipo *"Cross origin requests are only supported for protocol schemes: http, https..."*
e a tela de carregamento nunca sai do lugar.

Qualquer servidor HTTP resolve. `tools/serve.mjs` esta ali para nao precisar de nenhum: usa apenas
`node:http`, `node:fs` e `node:path`, serve os MIME types certos (incluindo `.glb`/`.bin`), suporta
range requests e protege contra path traversal.

---

## Hello World

Um cubo girando, com chao, luz direcional com sombra, camera e loop. Copie para `hello.html` +
`hello.js` na raiz do projeto e abra pelo servidor.

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Hello</title>
<style>html,body{margin:0;height:100%;background:#111}canvas{display:block;width:100%;height:100%}</style>
</head>
<body>
<canvas id="app"></canvas>
<script type="module" src="./hello.js"></script>
</body>
</html>
```

```js
// hello.js
import {
  Engine, Mesh, StandardMaterial, DirectionalLight, Color,
  createBox, createPlane
} from './src/index.js';

const engine = new Engine({ canvas: 'app', stats: true });
const { scene, camera, renderer } = engine;

camera.position.set(0, 1.6, 4);
camera.lookAt(0, 0.4, 0);

const cube = new Mesh(
  createBox(1, 1, 1),
  new StandardMaterial({ baseColor: 0xff7043, metallic: 0.1, roughness: 0.35 })
);
cube.position.set(0, 0.5, 0);
cube.castShadow = true;
scene.add(cube);

const ground = new Mesh(createPlane(20, 20), new StandardMaterial({ baseColor: 0x8899aa, roughness: 0.9 }));
ground.rotateX(-Math.PI / 2);
scene.add(ground);

const sun = new DirectionalLight(0xfff3df, 3.2);
sun.position.set(4, 6, 3);
sun.useTarget = true;
sun.target.set(0, 0, 0);
sun.castShadow = true;
scene.add(sun);

scene.setAmbient(new Color(0x334455), 0.6);
renderer.setClearColor(new Color(0.05, 0.06, 0.08));

engine.onUpdate((dt) => { cube.rotateY(dt); });

renderer.compile(scene, camera);   // opcional: compila tudo antes do primeiro frame
engine.start();
```

`new Engine()` cria o contexto WebGL2, o `Renderer`, uma `Scene`, uma `PerspectiveCamera`, a camada de
`Input` e o loop com `requestAnimationFrame`, timestep fixo opcional, pausa automatica quando a aba
fica oculta e recuperacao de context loss.

---

## Guia por subsistema

### Cena e transformacoes

`Node3D` e a base de tudo. `position` / `quaternion` / `scale` sao a fonte da verdade; a matriz local so
e recomposta quando algo realmente mudou.

```js
import { Node3D, Vec3 } from './src/index.js';

const rig = new Node3D('rig');
rig.position.set(0, 2, 0);
rig.setScale(2);                          // setScale(x, y = x, z = x)
rig.rotateY(Math.PI / 4);                 // rotateX / rotateY / rotateZ / rotateOnWorldAxis
rig.lookAt(0, 0, 0);
scene.add(rig, cube);                     // add aceita varios filhos

rig.setLayer(2);                          // mascara de 32 bits; camera.layers filtra o culling
rig.userData.tag = 'player';

const world = rig.getWorldPosition(new Vec3());
scene.traverse((node) => { if (node.isMesh) node.receiveShadow = true; });

// Objetos estaticos: desligue o auto update e chame updateMatrix() uma unica vez.
rig.matrixAutoUpdate = false;
rig.updateMatrix();
```

Estado da cena:

```js
scene.setAmbient(new Color(0x8fb4e8), 0.35);
scene.setFogExp2(new Color(0x93b4d6), 0.0032);   // ou setFogLinear(color, near, far) / clearFog()
scene.background = skyMaterial;                   // Color, textura cube ou um Material (SkyMaterial)
scene.environment = ibl;                          // sonda IBL usada pelo PBR
```

`scene.meshes`, `scene.lights` e `scene.skinnedMeshes` sao listas planas mantidas incrementalmente no
`add`/`remove`; `scene.bvh` e a broadphase.

### Geometria e primitivas

```js
import {
  createBox, createSphere, createPlane, createCylinder, createCone, createCapsule,
  createTorus, createTorusKnot, createIcosphere, createTerrain, createGridLines,
  Geometry, computeTangents, mergeGeometries, simplify, optimizeVertexCache
} from './src/index.js';

const terrain = createTerrain(200, 128, (x, z) => Math.sin(x * 0.05) * 4, 8);

// Geometria propria: nomes canonicos de atributo, locations fixas.
const custom = new Geometry();
custom.setAttribute('aPosition', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
custom.setAttribute('aUV0', new Float32Array([0, 0, 1, 0, 0, 1]), 2);
custom.setIndex(new Uint16Array([0, 1, 2]));
custom.computeNormals();
computeTangents(custom);                 // precisa de aPosition + aUV0
custom.computeBoundingSphere();

const lowPoly = simplify(terrain, 0.25); // QEM, mantem 25% dos triangulos
const atlas = mergeGeometries([a, b, c], true);  // true = um group por entrada

// optimizeVertexCache trabalha sobre o array de indices, nao sobre a Geometry:
terrain.setIndex(optimizeVertexCache(terrain.index.data));
```

Texturas procedurais (todas retornam uma `Texture` pronta):

```js
import { noiseTexture, normalMapFromHeight, noiseHeightField, uvGridTexture, checkerTexture } from './src/index.js';

const gl = engine.gl;
const color  = noiseTexture(gl, 512, 5, { frequency: 7 });
const height = noiseHeightField(512, 9, 5, 3.5);
const normal = normalMapFromHeight(gl, height, 512, 2.4);
const grid   = uvGridTexture(gl, 512, { cells: 8 });
```

### Materiais PBR

`StandardMaterial` e metallic-roughness. Escalares podem ser escritos todo frame de graca; trocar um
mapa levanta `needsUpdate` e recompila a permutacao.

```js
import { StandardMaterial, UnlitMaterial, Color } from './src/index.js';

const rock = new StandardMaterial({
  name: 'Rock',
  baseColor: new Color(0.42, 0.40, 0.37),
  metallic: 0.0,
  roughness: 0.85,
  ior: 1.5,
  specularIntensity: 1.0
});

rock.baseColorMap = color;
rock.normalMap = normal;
rock.normalScale = 1.2;
rock.metallicRoughnessMap = mrTexture;   // G = roughness, B = metallic (convencao glTF)
rock.occlusionMap = aoTexture;
rock.emissiveMap = emissive;
rock.setEmissive(0xff6600, 2.5);
rock.setUVTransform(4, 4, 0, 0, 0);      // escala, offset, rotacao
rock.setAlphaMode('mask', 0.5);          // 'opaque' | 'mask' | 'blend'
rock.side = 'double';
rock.specularAntiAliasing = true;

const flat = new UnlitMaterial({ baseColor: 0x22ddaa });
```

Unidades de textura sao fixas na engine (`uBaseColorMap` 0, `uNormalMap` 1, `uMetallicRoughnessMap` 2,
`uOcclusionMap` 3, `uEmissiveMap` 4). Veja `docs/ARCHITECTURE.md` para a tabela completa.

### Luzes e sombras (CSM)

```js
import { DirectionalLight, PointLight, SpotLight } from './src/index.js';

const sun = new DirectionalLight(0xfff3df, 3.4);
sun.position.set(120, 200, 90);
sun.useTarget = true;
sun.target.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.bias = 0.0006;
sun.shadow.normalBias = 0.04;
scene.add(sun);

const lamp = new PointLight(0xffaa55, 20, 12);   // (cor, intensidade, range)
lamp.position.set(3, 2, -4);
scene.add(lamp);

const spot = new SpotLight(0xffffff, 40, 25, Math.PI / 8, 0.25);
spot.useTarget = true;
spot.target.set(0, 0, 0);
scene.add(spot);
```

Ajuste fino do CSM pelo `ShadowMapper` (uma cascata por split, esfera envolvente + snap de texel):

```js
const mapper = engine.renderer.shadowMapper;   // null quando shadows: false
if (mapper !== null) {
  mapper.setShadowDistance(140);   // distancia coberta pelas cascatas
  mapper.setCascadeCount(4);       // 1..4
  mapper.setLambda(0.6);           // mistura entre split logaritmico e uniforme
  mapper.setSoftness(1.0, 1.15);   // (raio do PCF, suavidade)
  mapper.setBias(-0.0005, 0.02);   // (depth bias, normal bias)
}
```

`Renderer` usa **a primeira** luz direcional com `castShadow === true` como sombra do frame.

### Instancing (20k objetos, 1 draw call)

```js
import { InstancedMesh, createIcosphere, StandardMaterial, Vec3, Quat, Color } from './src/index.js';

const rocks = new InstancedMesh(
  createIcosphere(0.5, 1),
  new StandardMaterial({ roughness: 0.85 }),
  20000,
  { useColor: true }               // ou rocks.enableInstanceColor() depois
);

const p = new Vec3(), q = new Quat(), s = new Vec3();
for (let i = 0; i < 20000; i++) {
  p.set(Math.random() * 400 - 200, 0, Math.random() * 400 - 200);
  q.setFromAxisAngle(Vec3.UP, Math.random() * Math.PI * 2);
  s.setScalar(0.6 + Math.random());
  rocks.setTransformAt(i, p, q, s);
  rocks.setColorAt(i, new Color(0.4, 0.42, 0.38));
}
rocks.setCount(20000);             // quantas instancias realmente desenhar
scene.add(rocks);
```

Escritas marcam apenas o range sujo: mexer em 10 instancias por frame envia 10 matrizes, nao 20000.
`setDataAt(i, x, y, z, w)` (apos `enableInstanceData()`) preenche `aInstanceData` para o shader.

Para milhares de objetos espalhados, use **varias** `InstancedMesh` menores (uma por chunk espacial):
cada uma vira um proxy independente na BVH e pode ser descartada pelo frustum inteira.

### Skinning e animacao

```js
import {
  SkinnedMesh, Skeleton, AnimationMixer, AnimationClip, KeyframeTrack
} from './src/index.js';

// bones e um array de Node3D ja montado na hierarquia
root.updateWorldMatrix(true);              // pose de bind precisa das matrizes atuais
const mesh = new SkinnedMesh(geometry, material);   // geometry com aJoints + aWeights
root.add(mesh);
const skeleton = new Skeleton(bones);      // inversos de bind calculados automaticamente
mesh.bind(skeleton, mesh.worldMatrix);

const clip = new AnimationClip('walk', -1, [
  new KeyframeTrack('LeftLeg.quaternion', [0, 0.5, 1], qValues, 4),
  new KeyframeTrack('Hips.position',      [0, 0.5, 1], pValues, 3)
]);

const mixer = new AnimationMixer(root);
const walk = mixer.clipAction(clip);
walk.setLoop('repeat');                    // 'once' | 'repeat' | 'pingpong'
walk.timeScale = 1;
walk.play();

engine.addMixer(mixer);                    // atualizado todo frame com o delta escalado
// walk.crossFadeTo(run, 0.3);  walk.fadeIn(0.2);  walk.setEffectiveWeight(0.5);
```

As matrizes de osso vao para a GPU por uma **bone texture** (unidade 6), enviada no maximo uma vez por
frame por esqueleto, mesmo que a malha seja desenhada em varios passes.

### Carregar glTF

```js
import { GLTFLoader, AnimationMixer } from './src/index.js';

const loader = new GLTFLoader(engine.gl, { basePath: './assets/', generateTangents: true });
const gltf = await loader.load('personagem.glb');

scene.add(gltf.scene);

if (gltf.animations.length > 0) {
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  engine.addMixer(mixer);
}

// gltf: { scene, scenes, animations, cameras, materials, meshes, nodes,
//         skeletons, textures, lights, asset, json, dispose() }
```

Suporta `.gltf` + `.glb`, buffers/imagens externos e embutidos (data URI), skinning, morph-free node
animation, cameras, `KHR_lights_punctual`, `KHR_materials_emissive_strength`, `KHR_texture_transform`,
`KHR_materials_unlit`, `KHR_materials_ior`, `KHR_mesh_quantization`, `EXT_texture_webp`, `EXT_texture_avif`.

Para carregar varios assets com cache e contagem de referencia:

```js
import { AssetManager } from './src/index.js';

const assets = new AssetManager(engine.gl, { basePath: './assets/' });
assets.onProgress((url, type, phase) => console.log(phase, url));
const [tex, model] = await assets.loadMany(['grama.png', 'arvore.glb']);
```

### Raycast

```js
import { Raycaster } from './src/index.js';

const raycaster = new Raycaster();

engine.onUpdate(() => {
  if (!engine.input.isMousePressed(0)) return;

  const m = engine.input.mouse;
  raycaster.setFromCamera(m.ndcX, m.ndcY, camera);
  raycaster.far = 500;

  const hits = raycaster.intersectScene(scene);   // ordenado por distancia
  if (hits.length > 0) {
    const hit = hits[0];
    console.log(hit.object.name, hit.distance, hit.point, hit.normal, hit.faceIndex, hit.instanceId);
  }
  raycaster.releaseIntersections(hits);           // devolve os registros ao pool
});
```

O raycast usa a `DynamicBVH` da cena na broadphase e a `TriangleBVH` de cada malha (construida sob
demanda, com SAH binado) na narrow phase. `InstancedMesh` reporta `instanceId`.

### Fisica e character controller

```js
import { CollisionWorld, CharacterController, RigidBody, Vec3 } from './src/index.js';

const world = new CollisionWorld({ gravity: new Vec3(0, -26, 0) });
world.addStatic(terrainMesh, { friction: 0.7 });      // usa a TriangleBVH da geometria

const player = new CharacterController(world, {
  radius: 0.35,
  height: 1.8,
  stepOffset: 0.45,
  slopeLimit: 50,
  position: new Vec3(0, 10, 0)
});

engine.onFixedUpdate((step) => {
  player.move(desiredVelocity, step);   // collide-and-slide + step up + ground snap
  if (jumpPressed) player.jump(8);
  player.syncNode(cameraRig);           // escreve a posicao no Node3D
}, 60);

// player.isGrounded, player.groundNormal, player.hitWall, player.velocity

// Corpos rigidos:
const ball = new RigidBody({ shape: 'sphere', radius: 0.4, mass: 2, position: new Vec3(0, 8, 0) });
world.addDynamic(ball);
engine.onFixedUpdate((step) => { world.step(step); ball.syncNode(ballMesh); }, 60);
```

Queries diretas tambem estao disponiveis: `world.sphereCast`, `world.capsuleCast`, `world.raycast`,
`world.overlapSphere`, `world.overlapCapsule`.

**Controladores na taxa do solver.** Qualquer coisa que aplique forcas em
resposta a velocidade — pneu de veiculo, propulsor, mola controlada — precisa
rodar junto com o solver, e nao uma vez por frame:

```js
// Forcas: antes da integracao, onde o acumulador ainda sera lido.
world.onSubstep((h) => {
  body.applyForce(molaDaSuspensao(h));
});

// Restricoes de velocidade: depois da integracao. Use IMPULSOS aqui — o
// acumulador de forca acabou de ser zerado.
world.onVelocityConstraint((h) => {
  const deslize = velocidadeLateralNoContato();
  body.applyImpulse(cancelar(deslize, h), pontoDeContato);
});
```

**A ordem das duas fases nao e detalhe.** Um pneu que roda antes da integracao
le a velocidade sem a gravidade daquele passo, e portanto nunca consegue anula-la:
o veiculo parado numa rampa escorrega para sempre, por mais aderencia que se de
a ele. Rodando depois, ele ve exatamente a velocidade que precisa zerar. A
mesma armadilha vale para uma forca aplicada uma vez por frame, que entrega
`F * h` e nao `F * dt`, porque o primeiro substep zera o acumulador.

Ambos aceitam varios callbacks e devolvem a funcao registrada, para remover
depois com `offSubstep` / `offVelocityConstraint`.

**Cenas inteiras colidiveis.** Para milhares de props instanciados, `addStaticInstanced` constroi
uma unica BVH de triangulos e da a cada instancia so a sua matriz:

```js
const matrizes = [];
for (let i = 0; i < 5000; i++) matrizes.push(novaMatrizDeInstancia(i));

const r = world.addStaticInstanced(rochaMesh, matrizes, { friction: 0.6 });
console.log(r.colliders.length, r.shared, r.baked);
```

`shared` so e `true` quando toda matriz tem **escala uniforme**. Com escala nao uniforme o colisor
precisa assar a propria copia em espaco de mundo (uma consulta so pode ser mapeada para o espaco
local compartilhado quando a escala e uniforme), e `baked` conta quantas foram. Para props com
proporcao variavel, colida contra um proxy de baixo poligono em vez da malha desenhada — e o que a
demo faz com arvores e pedras.

### Agua e empuxo

`WaterVolume` e uma regiao de fluido com superficie. O que faz um objeto boiar nao e uma flag: e
Arquimedes aplicado de verdade, entao um corpo sobe, afunda ou fica em equilibrio como consequencia
da sua densidade em relacao a do fluido.

```js
import { WaterVolume } from './src/index.js';

const lago = WaterVolume.fromBox(0, -5, 0, 40, 10, 40, { density: 1 });
world.addWater(lago);

// massa = densidade * volume -> uma caixa com 0.35 da densidade da agua
// estabiliza com 35% do volume submerso. Ninguem escreveu esse numero.
const volume = 1.1 * 1.1 * 1.1;
const caixa = new RigidBody({ shape: 'box', mass: 0.35 * volume, ... });
```

Cada corpo ganha `body.submersion` (0..1) e `body.inWater` a cada passo — use para respingo, som
abafado ou troca de estado. O `CharacterController` nada sozinho: ele expoe `submersion`, `inWater`
e `swimming`, e o ponto de equilibrio e onde `submersion * buoyancy === 1`, ou seja `buoyancy`
escolhe diretamente a linha d'agua (o padrao 1.35 deixa cabeca e ombros de fora).

Verificado em `tools/physics-test.mjs`: densidades 0.25 / 0.5 / 0.8 estabilizam em 0.250 / 0.500 /
0.800 de submersao.

### Input

`engine.input` ja existe e ja esta plugado no canvas. Os estados de borda sao rolados no fim de cada frame.

**Teclas do jogo x atalhos do browser.** Space rola a pagina, Tab tira o foco do canvas, Ctrl+S
salva, `/` abre a busca do Firefox. A engine engole essas teclas enquanto o jogo tem o teclado:

```js
input.setCaptureMode('pointerlock'); // padrao: so com o ponteiro capturado
input.captureKeys(['KeyR', 'ctrl+KeyE']);
```

Modos: `'pointerlock'` (padrao — a pagina se comporta normalmente ate voce clicar no jogo),
`'focus'`, `'always'` e `'off'`. Com `captureAllShortcuts = true` qualquer combinacao com
modificador e engolida, nao so as listadas.

**Ctrl+W, Ctrl+T e Ctrl+N sao um caso a parte.** `preventDefault` nao funciona neles, por decisao
dos navegadores: uma pagina nao pode prender o usuario. A unica forma de recebe-los e a Keyboard
Lock API, que o navegador so libera em tela cheia:

```js
canvas.addEventListener('click', async () => {
  const r = await input.enterGameMode(canvas); // fullscreen + pointer lock + keyboard lock
  console.log(r); // { fullscreen: true, pointer: true, keyboard: true }
});

input.shortcutStatus(); // o que este navegador realmente consegue bloquear
```

Disponivel em navegadores Chromium; Firefox e Safari nao implementam, e la essas teclas seguem
reservadas — `canLockKeyboard()` diz qual e o caso. Mesmo com o lock, segurar Esc por dois
segundos sai da tela cheia: o navegador garante isso e nenhuma pagina remove. E justamente essa
garantia que torna aceitavel entregar Ctrl+W a uma pagina.

### Superficie de agua

`WaterMaterial` desloca a superficie com **a mesma funcao de onda que a fisica usa**, e
`syncFromVolume` copia os parametros do `WaterVolume` para que a crista que voce ve seja a crista
que empurra os corpos:

```js
import { WaterMaterial, WaterVolume, createDisc } from './src/index.js';

const lago = WaterVolume.fromBox(0, -5, 0, 40, 10, 40, {
  density: 1, waveAmplitude: 0.16, waveLength: 7.5, waveSpeed: 1.05,
});
world.addWater(lago);

const material = new WaterMaterial({ deepColor, skyColor, opacity: 0.66 });
scene.add(new Mesh(createDisc(20, 96, 28), material));

engine.onUpdate(() => material.syncFromVolume(lago));
```

A normal e avaliada **por fragmento** a partir da forma fechada, nao interpolada dos vertices:
interpolar amarra o sombreamento a tesselacao, e numa malha grosseira o lobulo especular cobre a
superficie inteira de uma vez e a agua vira um lencol branco.

Use `createDisc(raio, segmentos, aneis)` e nao a tampa de um cilindro: uma tampa e um leque de
triangulos — um vertice no meio e o resto na borda —, entao deslocar aquilo vira uma estrela
radial em vez de ondas.

```js
const input = engine.input;

engine.onUpdate((dt) => {
  if (input.isKeyDown('KeyW')) moveForward(dt);
  if (input.isKeyPressed('Space')) jump();          // apenas no frame em que desceu
  if (input.isMousePressed(0)) input.requestPointerLock();

  const { dx, dy, ndcX, ndcY, wheel } = input.mouse;
  const pad = input.getGamepadAxis(0, 0);
});

// Eixos e acoes virtuais
input.bindAxis('Horizontal', { positive: ['KeyD', 'ArrowRight'], negative: ['KeyA', 'ArrowLeft'],
                               gamepadAxis: 0 });
input.bindAction('Fire', ['Mouse0', 'Space', 'Pad0B0']);   // tokens: KeyX, MouseN, PadNBm
const h = input.getAxis('Horizontal');
```

Controles prontos:

```js
import { OrbitControls, FirstPersonControls } from './src/index.js';

const orbit = new OrbitControls(camera, engine.canvas);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
engine.addUpdatable(orbit);      // qualquer objeto com update(dt) serve

const fps = new FirstPersonControls(camera, engine.input, {
  controller: player,            // opcional: delega o movimento ao CharacterController
  moveSpeed: 6,
  eyeHeight: 1.62,
  lookSensitivity: 0.0022
});
engine.addUpdatable(fps);
```

### Audio 3D

```js
import { AudioEngine, AudioSource } from './src/index.js';

const audio = new AudioEngine({ basePath: './sfx/', masterVolume: 0.8 });
const buffer = await audio.loadSound('passo.wav');

// One-shot, com posicao no mundo
audio.play(buffer, { volume: 0.6, bus: 'sfx', position: { x: 4, y: 0, z: -2 } });

// Fonte que vive na cena (Node3D, entao anda junto com o pai)
const motor = new AudioSource(audio, await audio.loadSound('motor.wav'), {
  loop: true, positional: true, refDistance: 3, maxDistance: 60, bus: 'sfx'
});
carro.add(motor);
motor.play();

engine.onUpdate((dt) => {
  audio.setListenerFromCamera(camera);
  audio.update(dt);
});

audio.setBusVolume('music', 0.4, 0.5);   // rampa de 0.5s
```

O contexto WebAudio so pode iniciar apos um gesto do usuario; `AudioEngine` instala o desbloqueio
automatico (desligue com `unlockOnGesture: false` e chame `audio.resume()` voce mesmo).

### Pos-processamento

A cadeia existe quando `hdr` e `postprocessing` estao ligados (padrao). Ela e dona do tonemap e do
encode sRGB do frame.

```js
const post = engine.renderer.post;   // null quando desativado
if (post !== null) {
  post.setBloom(true, 0.5, 1.15, 1.0);          // (on, intensidade, threshold, raio)
  post.setBloomAdvanced(0.5, 6, 8.0);           // (knee, niveis, clamp)
  post.setSSAO(true, 0.65, 0.85);               // (on, raio, intensidade)
  post.setToneMapping('aces', 1.0);             // none|linear|reinhard|aces|aces-fit|uncharted2|agx
  post.setExposure(1.2);
  post.setFXAA(true);
  post.setVignette(true, 0.35, 0.55, 1.0);
  post.setChromaticAberration(true, 0.0016);
  post.setGrain(true, 0.022, 0.6);
  post.compile();                               // pre-compila todas as permutacoes
}
```

IBL a partir de um ceu procedural ou de um cubemap:

```js
const ibl = engine.renderer.createIBL();
ibl.fromProceduralSky({ sunDirection: { x: 0.3, y: 0.6, z: 0.7 }, turbidity: 2.6, rayleigh: 1.15 });
// ou: ibl.fromCubeTexture(cube);  ibl.fromEquirectangular(hdrTexture);
ibl.intensity = 1.0;
scene.environment = ibl;
```

### Debug renderer

Batch de linhas imediato, desenhado por cima do frame.

```js
import { DebugRenderer } from './src/index.js';

const debug = new DebugRenderer(engine.gl, engine.renderer, { depthTest: true });

engine.onRender((renderer, camera) => {
  debug.clear();
  debug.drawBVH(scene.bvh, 6, 0x33ff88);
  debug.meshBounds(cube);
  debug.axes(cube.worldMatrix, 1);
  debug.arrow(from, to, 0xff3355);
  debug.grid(50, 50, 0x444444, 0);
  debug.frustum(camera, 0x22aaff);
  debug.drawSkeleton(character, 0xffaa00);
  debug.drawNormals(cube, 0.15);
  debug.render(camera);
});
```

---

## Performance

### O que a engine faz sozinha

| Mecanismo | Onde | O que evita |
|---|---|---|
| Culling por `DynamicBVH` com plane coherency | `spatial/DynamicBVH.js`, `Renderer._cull` | Testar 6 planos por objeto: um plano provado interno some da mascara para toda a subarvore |
| Bounds exatos nas folhas | `DynamicBVH.query` | Falsos positivos vindos da margem do fat AABB |
| Ordenacao por radix sort estavel | `RenderList.sortOpaque` | Trocas redundantes de programa/material/geometria; opacos saem agrupados por estado e front-to-back |
| Cache de estado GL | `render/StateCache.js` | Chamadas `gl.*` repetidas; toda mudanca de estado passa por aqui |
| UBOs com range sujo | `render/UniformBuffers.js` | `bufferSubData` do bloco inteiro quando so um float mudou; camera parada custa zero |
| Cache de permutacao por `WeakMap` | `Renderer._programCache` | Montar string de chave e consultar a `ShaderLib` a cada draw |
| Reuso de VAO entre draws consecutivos | `Renderer.drawMesh` | `getVAO()` e a varredura de atributos sujos quando a geometria e a mesma do draw anterior |
| Clustered forward | `render/ClusteredLighting.js` | Iterar todas as luzes por fragmento; cada froxel so ve as luzes que o tocam |
| Upload incremental de instancias | `InstancedMesh._uploadRange` | Reenviar o buffer inteiro quando poucas instancias mudaram |
| Bone texture uma vez por frame | `Renderer._bindSkeleton` | Reupload do esqueleto em cada passe (sombra, depth, cor) |
| Pools e scratch em escopo de modulo | render list, raycaster, math, BVH | Pressao de GC: o frame em regime permanente nao aloca |
| Timer queries em ring de 2 slots | `Renderer._beginGPUTimer` | Stall de pipeline ao ler o tempo de GPU |

### Uma armadilha que vale conhecer

Chamar `node.updateWorldMatrix(true)` por conta propria e legitimo — e como se
le uma posicao de mundo no meio do frame. Mas isso limpa os flags de sujeira que
a cena usa para saber o que se moveu, e ate a versao 1.0.0 isso fazia a malha
manter os bounds de broadphase que tinha ao nascer: ela sumia da tela assim que
saia do lugar, continuando a projetar sombra (o passe de sombra nao consulta o
broadphase).

Desde 1.1.0 a cena compara versoes de matriz em vez de confiar nos flags, entao
o comportamento e correto independentemente de quem atualizou o quer que seja.
Ainda assim, prefira apenas escrever `position` / `quaternion` e deixar
`Scene.updateMatrices()` fazer o trabalho: e mais barato e nao depende de ordem.

### O que voce deve fazer

- **`matrixAutoUpdate = false` em objetos estaticos.** Chame `updateMatrix()` uma vez depois de
  posicionar. Isso tira o no da deteccao de mudanca de transform todo frame.
- **Reuse geometrias e materiais.** A sort key e montada com `programId`, `materialId` e `geometryId`:
  10 malhas com o *mesmo* material viram um bloco contiguo de draws sem troca de estado. 10 clones do
  material viram 10 blocos.
- **Use `InstancedMesh` acima de ~100 copias do mesmo par geometria/material**, e quebre em varias
  instanced meshes por regiao para que o frustum culling ainda funcione.
- **Orce as sombras.** `mapper.setShadowDistance()` e o parametro mais barato: cascatas cobrindo 140m
  custam muito menos que cobrindo 900m. Marque `castShadow = true` apenas no que realmente projeta.
- **Orce as luzes.** `maxLights` limita o buffer; luzes com `range` explicito produzem froxels menores
  e listas mais curtas. Luz sem `range` tem o raio derivado da intensidade, que costuma ser generoso.
- **Use `LOD`** com histerese para silhuetas caras (`lod.addLevel(node, distance, hysteresis)`).
- **Chame `renderer.compile(scene, camera)`** antes de `engine.start()` para nao pagar compilacao de
  shader no primeiro frame.
- **Limite o pixel ratio**: `new Engine({ maxPixelRatio: 1.75 })`. Custo de fragmento e quadratico.
- **Ligue o depth prepass** so em cenas com overdraw pesado: `engine.renderer.depthPrepass = true`.
- **Simplifique**: `simplify(geometry, 0.3)` no import, e
  `geometry.setIndex(optimizeVertexCache(geometry.index.data))` para o cache pos-transform.

Contadores por frame ficam em `engine.renderer.info`: `drawCalls`, `triangles`, `programs`, `textures`,
`visibleMeshes`, `culledMeshes`, `shadowDrawCalls`, `cpuTimeMs`, `cullTimeMs`, `gpuTimeMs`,
`memory.buffers`, `memory.textures`. O overlay `Stats` (`new Engine({ stats: true })`) plota tudo isso.

---

## Referencia da API publica

Tudo abaixo e exportado por `src/index.js`. Nao existe `export default` em lugar nenhum da engine.

### Math (`src/math/`)

| Nome | Arquivo | Descricao |
|---|---|---|
| `Vec2`, `Vec3`, `Vec4` | `math/Vec2.js`, `Vec3.js`, `Vec4.js` | Vetores com API in-place, sem alocacao |
| `Quat` | `math/Quat.js` | Quaternion: slerp, eixo-angulo, de/para matriz e Euler |
| `Euler` | `math/Euler.js` | Angulos de Euler com ordem configuravel |
| `Mat3` | `math/Mat3.js` | Matriz 3x3, matriz normal, transform de UV |
| `Mat4` | `math/Mat4.js` | Matriz 4x4 column-major: compose/decompose, perspectiva, lookAt |
| `Color`, `srgbToLinear`, `linearToSRGB` | `math/Color.js` | Cor em espaco LINEAR; entradas sRGB convertidas na entrada |
| `Plane`, `Frustum`, `AABB`, `Sphere`, `Ray` | `math/*.js` | Primitivas geometricas e testes de intersecao |
| `clamp`, `lerp`, `inverseLerp`, `smoothstep`, `smootherstep`, `damp`, `moveTowards`, `degToRad`, `radToDeg`, `euclideanModulo`, `pingPong`, `wrapAngle`, `deltaAngle`, `nearlyEqual`, `randFloat`, `randInt`, `seededRandom`, `hash32`, `hashFloat`, `nextPowerOfTwo`, `floorPowerOfTwo`, `isPowerOfTwo` | `math/MathUtils.js` | Helpers escalares |
| `EPSILON`, `DEG2RAD`, `RAD2DEG`, `PI2`, `PI_HALF` | `math/MathUtils.js` | Constantes |

### Core e util (`src/core/`, `src/util/`)

| Nome | Arquivo | Descricao |
|---|---|---|
| `Engine` | `core/Engine.js` | Ponto de entrada: contexto, renderer, cena, camera, input e loop |
| `Time` | `core/Time.js` | Relogio: `delta`, `unscaledDelta`, `elapsed`, `timeScale`, `fps` |
| `EventBus` | `core/EventBus.js` | Pub/sub com `on`/`once`/`off`/`emit`, sem alocacao no emit |
| `Pool` | `core/Pool.js` | Pool generico de objetos (`acquire`/`release`/`prealloc`) |
| `Logger`, `LogLevel` | `core/Logger.js` | Log com nivel e variantes "uma vez so" |
| `Stats` | `util/Stats.js` | Overlay canvas 2D com FPS, CPU, GPU (timer queries), draws e memoria |
| `radixSortUint32`, `radixSortUint32Pairs`, `insertionSortByKey`, `compareAndSwapSort`, `packHalfFloat`, `unpackHalfFloat`, `packHalfFloatArray`, `unpackHalfFloatArray`, `packUnorm8`/`16`, `packSnorm8`/`16` (+ unpack), `growTypedArray`, `ensureCapacity`, `concatTypedArrays`, `copyRange`, `fillRange`, `byteLengthOf` | `util/TypedArrayUtils.js` | Ordenacao e empacotamento de typed arrays |

### Grafo de cena (`src/scene/`)

| Nome | Arquivo | Descricao |
|---|---|---|
| `Node3D` | `scene/Node3D.js` | No base: hierarquia, transform, layers, traversal iterativo |
| `Scene` | `scene/Scene.js` | Raiz do mundo: listas planas, broadphase, fog, ambiente, background |
| `Camera` | `scene/Camera.js` | Base de camera: view matrix, frustum, unproject |
| `PerspectiveCamera` | `scene/PerspectiveCamera.js` | Camera perspectiva com fov/aspect/near/far e helpers de lente |
| `OrthographicCamera` | `scene/OrthographicCamera.js` | Camera ortografica |
| `Mesh` | `scene/Mesh.js` | Geometria + material, bounds no mundo, `raycast`, `getTriangleBVH()` |
| `InstancedMesh` | `scene/InstancedMesh.js` | Milhares de instancias com matriz, cor e vec4 livre por instancia |
| `SkinnedMesh` | `scene/SkinnedMesh.js` | Malha com skinning na GPU, `bind(skeleton, bindMatrix)` |
| `Skeleton` | `scene/Skeleton.js` | Ossos + inversos de bind, empacotados numa bone texture |
| `Light`, `DirectionalLight`, `PointLight`, `SpotLight` | `scene/Light.js` | Luzes com atenuacao fisica e raio de influencia |
| `LOD` | `scene/LOD.js` | Troca de nivel por distancia com histerese |

### Espaco e geometria (`src/spatial/`, `src/geometry/`)

| Nome | Arquivo | Descricao |
|---|---|---|
| `DynamicBVH` | `spatial/DynamicBVH.js` | Arvore de AABB dinamica em SoA: insert/remove/update, query de frustum, raycast, rebuild SAH |
| `TriangleBVH` | `spatial/TriangleBVH.js` | BVH estatica de triangulos com SAH binado: raycast, queries, ponto mais proximo |
| `createBox`, `createSphere`, `createPlane`, `createCylinder`, `createCone`, `createCapsule`, `createTorus`, `createTorusKnot`, `createIcosphere`, `createTerrain`, `createGridLines`, `createQuadFullscreen`, `createSkyboxCube` | `geometry/Primitives.js` | Geradores de geometria |
| `computeNormals`, `computeTangents`, `computeAABB`, `computeBoundingSphere`, `toIndexed`, `toNonIndexed`, `mergeGeometries`, `optimizeVertexCache`, `simplify` | `geometry/GeometryUtils.js` | Processamento de malha (simplificacao por QEM) |
| `checkerTexture`, `noiseTexture`, `gradientTexture`, `normalMapFromHeight`, `uvGridTexture`, `brdfLUTTexture`, `solidColorTexture`, `noiseHeightField` | `geometry/ProceduralTexture.js` | Texturas geradas na CPU |
| `perlin3`, `perlin3Periodic`, `simplex3`, `fbm`, `fbmPeriodic`, `ridgedFbm` | `geometry/ProceduralTexture.js` | Ruido procedural |

### Camada GL (`src/render/`)

| Nome | Arquivo | Descricao |
|---|---|---|
| `createGLContext`, `Capabilities` | `render/GLContext.js` | Cria o contexto WebGL2 e detecta capacidades/extensoes |
| `StateCache`, `getStateCache` | `render/StateCache.js` | Espelho do estado GL; toda mudanca passa por aqui |
| `GLBuffer`, `bufferTargetToGL`, `bufferUsageToGL` | `render/Buffer.js` | Buffers com contabilidade de memoria |
| `VertexArray` | `render/VertexArray.js` | VAO, incluindo atributos de matriz por instancia |
| `Geometry`, `GeometryAttribute` | `render/Geometry.js` | Atributos, indices, groups, bounds, upload e VAO |
| `ATTRIB`, `ATTRIB_NAME_TO_LOC`, `GL_TYPE`, `DRAW_MODES`, `glTypeBytes`, `glTypeFromArray`, `drawModeToGL` | `render/Geometry.js` | Tabelas do contrato de atributos |
| `Texture`, `createTexture2D`, `createTextureCube`, `createTextureArray`, `createTexture3D`, `createDataTexture`, `createWhiteTexture`, `resolveFormat`, `validateTextureSize` | `render/Texture.js` | Texturas 2D/cube/array/3D |
| `RenderTarget` | `render/RenderTarget.js` | FBO com MSAA, multiplos attachments, depth texture e resolve |

### Shaders e materiais

| Nome | Arquivo | Descricao |
|---|---|---|
| `ShaderPreprocessor`, `formatDefines`, `definesKey` | `render/ShaderPreprocessor.js` | Resolve `#include <chunk>`, injeta defines, mapeia linhas de erro |
| `Program`, `UBO_BINDINGS`, `DEFAULT_ATTRIB_LOCATIONS` | `render/Program.js` | Compilacao/link (com `KHR_parallel_shader_compile`), uniforms e samplers |
| `ShaderLib` | `render/ShaderLib.js` | Registro de fontes + cache de permutacoes compiladas |
| `CHUNKS`, `CHUNK_NAMES`, `registerAllChunks`, `getChunk` | `render/chunks/index.js` | Os 16 chunks GLSL reutilizaveis |
| `registerAllShaders`, `registerCoreShaders`, `registerAllShadersAsync`, `loadOptionalShaders`, `shaderModulesReady`, `optionalShaderStatus`, `registerShaderModule`, `registerOptionalShaderLoader`, `applyShaderModule`, `CORE_SHADER_NAMES`, `OPTIONAL_SHADER_NAMES` | `render/shaders/index.js` | Registro dos programas embutidos |
| `registerShadowShader`, `registerPostShaders`, `registerIBLShaders`, `registerDebugShader` (+ `SHADOW_SHADER_NAME`, `POST_SHADER_NAMES`, `IBL_SHADER_NAMES`, `DEBUG_SHADER_NAME`) | `render/shaders/*.js` | Registro por modulo |
| `Material`, `SIDE_CODE`, `TEXTURE_UNITS` | `render/Material.js` | Base de material: permutacoes, estado GL, uniforms, sort key |
| `StandardMaterial` | `render/materials/StandardMaterial.js` | PBR metallic-roughness com 5 mapas e transform de UV |
| `UnlitMaterial` | `render/materials/UnlitMaterial.js` | Cor plana, sem iluminacao |
| `ShaderMaterial`, `SHADER_MATERIAL_DEFAULT_VERTEX`, `SHADER_MATERIAL_DEFAULT_FRAGMENT` | `render/materials/ShaderMaterial.js` | GLSL do usuario com acesso aos chunks e as permutacoes |
| `SkyMaterial` | `render/materials/SkyMaterial.js` | Ceu procedural (Preetham + nuvens) usavel como background e fonte de IBL |

### Pipeline de render

| Nome | Arquivo | Descricao |
|---|---|---|
| `Renderer` | `render/Renderer.js` | O frame inteiro: culling, luzes, sombras, UBOs, passes e post |
| `RenderList`, `RenderItem`, `makeSortKey` | `render/RenderList.js` | Fila de draws em pool, ordenada por estado e por profundidade |
| `UniformBuffers`, `UniformBlock` | `render/UniformBuffers.js` | Os quatro blocos std140 compartilhados por todos os shaders |
| `UBO_BINDING_POINTS`, `CAMERA_OFFSETS`, `CAMERA_FLOATS`, `LIGHTS_OFFSETS`, `LIGHTS_FLOATS`, `DIR_LIGHT_SLOTS`, `SHADOWS_OFFSETS`, `SHADOWS_FLOATS`, `CASCADE_SLOTS`, `FOG_OFFSETS`, `FOG_FLOATS` | `render/UniformBuffers.js` | Layout exato dos blocos |
| `ShadowMapper` | `render/ShadowMapper.js` | CSM direcional (+ mapas de spot e point) |
| `ClusteredLighting`, `CLUSTER_TEXTURE_UNITS`, `TEXELS_PER_LIGHT`, `FLOATS_PER_LIGHT` | `render/ClusteredLighting.js` | Grid de froxels e atribuicao analitica de luzes |
| `LightManager` | `render/LightManager.js` | Coleta, filtra e ordena as luzes visiveis |
| `PostProcessing`, `ToneMapping` | `render/PostProcessing.js` | SSAO, bloom, exposicao, tonemap, FXAA, vinheta, CA, grao |
| `IBL`, `IBL_TEXTURE_UNITS` | `render/IBL.js` | Gera irradiancia, prefiltered e BRDF LUT na GPU |
| `DebugRenderer` | `render/DebugRenderer.js` | Batch de linhas: BVH, bounds, esqueleto, normais, frustum, grid |

### Animacao, loaders, fisica, input, audio

| Nome | Arquivo | Descricao |
|---|---|---|
| `KeyframeTrack`, `InterpolationMode` | `animation/KeyframeTrack.js` | Canal de keyframes com cursor cacheado (step/linear/cubicspline) |
| `AnimationClip` | `animation/AnimationClip.js` | Conjunto de tracks com duracao, `optimize()`, `trim()` |
| `AnimationAction`, `LoopMode` | `animation/AnimationAction.js` | Play/stop, loop, peso, fade e cross-fade |
| `AnimationMixer`, `PropertyBinding`, `BindingType` | `animation/AnimationMixer.js` | Resolve paths, acumula pesos e escreve nos alvos |
| `AssetManager` (+ `resolveURL`, `extractBasePath`, `guessAssetType`, `isDataURI`, `isAbsoluteURL`, `parseDataURI`, `fetchBytes`, `fetchText`, `fetchJSON`) | `loaders/AssetManager.js` | Cache, refcount, progresso e coalescing de requisicoes |
| `loadImage`, `loadImageBitmap`, `loadTexture`, `loadImageSource`, `createTextureFromImage`, `isImageBitmapSupported` | `loaders/ImageLoader.js` | Decodificacao de imagem e upload |
| `GLTFLoader`, `GLTFParser` | `loaders/GLTFLoader.js` | glTF 2.0 / GLB completo |
| `OBJLoader`, `parseMTL` | `loaders/OBJLoader.js` | Wavefront OBJ + MTL |
| `Raycaster`, `getMeshTriangleData` | `physics/Raycaster.js` | Picking exato com pool de intersecoes |
| `CollisionWorld`, `StaticCollider`, `createSweepHit` | `physics/CollisionWorld.js` | Sweeps de esfera/capsula, overlaps, solver de contatos |
| `CharacterController` | `physics/CharacterController.js` | Capsula collide-and-slide com step offset e slope limit |
| `RigidBody`, `BodyType`, `BodyShape` | `physics/RigidBody.js` | Corpo rigido com inercia, sleep e sincronia com `Node3D` |
| `Input` | `input/Input.js` | Teclado, mouse, touch/pinch, gamepad, eixos e acoes virtuais |
| `OrbitControls` | `input/OrbitControls.js` | Orbita com damping, pan, dolly e pinch |
| `FirstPersonControls` | `input/FirstPersonControls.js` | WASD + mouse look, com ou sem `CharacterController` |
| `AudioEngine` | `audio/AudioEngine.js` | WebAudio: buses, buffers, one-shots, listener a partir da camera |
| `AudioSource` | `audio/AudioSource.js` | Fonte espacial que e um `Node3D` |
| `VERSION` | `src/index.js` | Versao da engine |

---

## Verificacao

Nenhuma das ferramentas precisa de rede, de pacote npm ou de GPU.

```bash
npm run check        # roda os quatro na sequencia
```

| Comando | O que faz |
|---|---|
| `node tools/test-math.mjs` | 158 asserts sobre `src/math`: vetores, quaternions, matrizes, Euler, cor, AABB, esfera, raio, frustum e plano. Falha com status != 0. |
| `node tools/check-imports.mjs` | Percorre `src/`, `examples/` e `tools/` e verifica: o arquivo alvo existe; todo binding importado e realmente exportado (seguindo cadeias de `export * from`); nenhum `import`/`export default`; toda especificacao relativa termina em `.js`; nenhuma dependencia de terceiros. |
| `node tools/check-glsl.mjs` | Valida os 43 blocos GLSL embutidos: chaves/parenteses balanceados, 81 `#include` resolvendo para chunks reais, `#version 300 es` presente, varyings casando entre os 19 pares vertex/fragment, ausencia de sintaxe GLSL 1.00 e blocos `Camera`/`Lights`/`Shadows`/`Fog` declarados `std140` nos bindings 0/1/2/3. |
| `node tools/smoke.mjs` | Monta uma cena real (malha estatica, 1000 instancias, luz direcional com sombra, 50 luzes pontuais, malha com skinning, mixer) e renderiza 10 frames contra o WebGL2 mockado de `tools/mockgl.js`, depois faz raycast. Reporta draw calls, triangulos, programas, texturas, buffers, FBOs, VAOs e uniforms. Caminho principal quebrado = exit 1; subsistemas opcionais viram aviso. |
| `node tools/browser-test.mjs` | Roda a engine em **Chrome real** (WebGL2 de verdade via ANGLE/SwiftShader). Sobe `serve.mjs` numa porta livre, fala CDP pelo WebSocket nativo do Node 22 (`tools/cdp.mjs`, sem playwright/puppeteer), carrega `tools/browser-scene.html`, espera `window.__TEST_DONE`, valida os pixels com `gl.readPixels`, checa `gl.getError()` por etapa, roda a demo real e salva screenshots. Flags: `--keep-open`, `--verbose`, `--headful`, `--skip-demo`, `--timeout`, `--demo-time`, `--out`. |
| `node tools/serve.mjs` | Servidor estatico de desenvolvimento (`--port`, `--host`, `--root`, `--quiet`). |

Saida esperada, no estado deste commit (os totais de arquivo sobem conforme a engine cresce; o que
importa e `erros: 0`):

```
math tests: 158 passed, 0 failed (158 total)
arquivos: 114   imports: 403   bindings nomeados: 671   erros de sintaxe: 0   erros: 0
chunks: 16   arquivos de shader: 9   blocos GLSL: 43   includes: 81   pares vertex/fragment: 19   erros: 0
draw calls (driver) 281   programas compilados 12   OK - a engine roda headless sem erros
```

---

## Limitacoes conhecidas

Coisas que a engine **nao** faz, ou faz de forma simplificada. Nenhuma delas quebra o demo, mas todas
importam se voce for construir algo em cima.

**Iluminacao e sombras**

- **So a primeira luz direcional com `castShadow` produz sombra.** `Renderer._renderFrame` escolhe a
  primeira da lista e ignora as demais; o bloco `Shadows` tem espaco para exatamente 4 cascatas de
  **uma** luz.
- **Luzes pontuais e spot nao projetam sombra no shader `standard`.** O `ShadowMapper` sabe renderizar
  atlas de spot e cubemaps de point, mas `chunks/cluster.glsl.js` chama `evaluatePunctualLight(..., 1.0)`:
  a visibilidade e sempre 1. O caminho existe no lado CPU, o consumo no lado GPU nao.
- **Maximo de 4 luzes direcionais** (`DIR_LIGHT_SLOTS`), limite fisico do bloco `Lights`.
- Filtro de sombra e PCF com rotacao por ruido. Nao ha PCSS, contact hardening nem shadow cache
  (as cascatas sao redesenhadas todo frame).

**Transparencia**

- Ordenacao por objeto, back-to-front pela distancia ao plano da camera. Nao ha OIT, nem sort por
  triangulo: objetos transparentes que se interpenetram vao errar.
- Transparentes rodam depois do skybox e nao escrevem profundidade; nao ha passe de refracao,
  nem transmissao (`KHR_materials_transmission` nao e suportado).

**Pos-processamento**

- A cadeia e **fixa**: SSAO -> bloom -> composite (exposicao/tonemap/sRGB) -> final (FXAA/vinheta/CA/grao).
  Nao ha grafo de passes plugavel; para inserir um passe proprio voce estende `PostProcessing` ou
  renderiza com `renderer.renderToTarget()` e faz seus proprios passes.
- **Sem TAA, sem motion blur, sem depth of field.** O define `USE_MOTION_VECTORS` existe no shader
  `standard`, mas o renderer nunca liga `ctx.motionVectors`, entao nada consome esses vetores.
- SSAO e half/quarter res conforme `ssaoScale` e usa a depth texture do alvo HDR; sem GTAO/HBAO.

**Materiais**

- Somente metallic-roughness. Nao ha clearcoat, sheen, anisotropia, iridescencia ou subsurface
  (`uClearcoatMap` esta reservado na unidade 5, mas nenhum shader o le).
- **`ShaderMaterial` precisa de um "priming".** `Renderer._resolveProgram` descarta o objeto quando
  `material.shaderName` ainda nao esta na `ShaderLib`, e o `ShaderMaterial` so se registra dentro de
  `getProgram`. Rode uma vez, antes do primeiro frame:
  `material.getProgram(renderer.shaderLib, material.getDefines(geometry, null))`.

**Geometria e loaders**

- **Sem morph targets.** `SkinnedMesh` faz skinning linear (LBS) com ate 4 influencias por vertice.
- glTF: **sem Draco, sem meshopt, sem KTX2/Basis** - arquivos que *exigem* essas extensoes sao
  rejeitados com mensagem explicita.
- Sem exportador: a engine le glTF/OBJ, nao escreve.
- `simplify()` roda na thread principal; para malhas grandes prefira pre-processar offline.

**Fisica**

- Colisao estatica e sempre **malha de triangulos**; dinamica e limitada a esfera, caixa e capsula.
  Nao ha convex hull, nem compound shapes, nem joints/constraints.
- Solver e sequencial com contatos gerados por frame; empilhamento alto de corpos vai ceder.
- `CharacterController` nao empurra `RigidBody` (a interacao e so um sentido).

**Infra**

- **WebGL2 apenas.** Sem fallback WebGL1 e sem WebGPU. Sem contexto WebGL2 a engine falha na
  construcao com mensagem clara.
- Loaders rodam na thread principal (sem Web Workers, sem OffscreenCanvas).
- Sem sistema de UI/texto, sem particulas, sem terreno com streaming, sem networking.
- `new Engine()` exige DOM. O modulo pode ser *importado* headless (nenhum efeito colateral no import),
  mas instanciar a engine precisa de um `document` e de um `<canvas>`; para testes headless use
  `tools/mockgl.js`.
- Algumas opcoes do `Renderer` **nao** sao repassadas pelo construtor do `Engine`
  (`depthPrepass`, `bloom`, `ssao`, `fxaa`, `clusterX/Y/Z`, `sortObjects`, `autoClear`): ajuste-as
  depois em `engine.renderer` / `engine.renderer.post`.

---

## Estrutura do repositorio

```
index.html            pagina do demo
package.json          scripts start / check (sem dependencies)
src/
  math/               Vec2/3/4, Quat, Mat3/4, Euler, AABB, Sphere, Ray, Plane, Frustum, Color
  core/               Engine, Time, EventBus, Pool, Logger
  util/               Stats, TypedArrayUtils
  scene/              Node3D, Scene, cameras, Mesh, InstancedMesh, SkinnedMesh, Skeleton, Light, LOD
  spatial/            DynamicBVH, TriangleBVH
  geometry/           Primitives, GeometryUtils, ProceduralTexture
  render/             camada GL, shaders, materiais e o pipeline do frame
    chunks/           16 chunks GLSL reutilizaveis
    shaders/          9 modulos de programa
    materials/        Standard, Unlit, Shader, Sky
  animation/          KeyframeTrack, AnimationClip, AnimationAction, AnimationMixer
  loaders/            AssetManager, ImageLoader, GLTFLoader, OBJLoader
  physics/            Raycaster, CollisionWorld, CharacterController, RigidBody
  input/              Input, OrbitControls, FirstPersonControls
  audio/              AudioEngine, AudioSource
  index.js            barrel: toda a API publica
examples/             demo.js + style.css
tools/
  serve.mjs           servidor estatico de desenvolvimento
  test-math.mjs       158 asserts sobre src/math
  check-imports.mjs   verificacao do grafo de modulos ES
  check-glsl.mjs      validacao estatica de todo o GLSL embutido
  smoke.mjs           10 frames contra WebGL2 mockado
  mockgl.js           shims de DOM + WebGL2 usados pelo smoke
  cdp.mjs             cliente Chrome DevTools Protocol sem dependencias
  browser-test.mjs    harness em Chrome real (usa cdp.mjs + browser-scene.*)
  browser-scene.html  pagina de teste deterministica
  browser-scene.js
docs/ARCHITECTURE.md  pipeline do frame, tabelas do contrato e guia de extensao
```

---

## Documentacao adicional

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - diagrama do frame passe a passe, layout std140 com
  offsets, unidades de textura, attribute locations, defines de permutacao, clustered forward, CSM,
  formato das BVHs, mapa de dependencias e receitas de extensao.

---

## Licenca

MIT.

```
Copyright (c) 2026 AICoders Engine

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
