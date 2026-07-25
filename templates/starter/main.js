/**
 * Starter da AICoders Engine.
 *
 * O menor projeto que ainda e representativo: cena, luz, material PBR, um corpo
 * rigido caindo e uma camera orbital. Copie esta pasta e comece a partir dela.
 *
 * Os imports usam o nome do pacote, resolvido pelo import map do index.html.
 * O mesmo codigo funciona sem ferramenta alguma e depois de um `npm install`
 * com bundler — so o mapeamento muda.
 */

import {
  Engine,
  Vec3,
  Color,
  Mesh,
  DirectionalLight,
  StandardMaterial,
  OrbitControls,
  CollisionWorld,
  RigidBody,
  BodyShape,
  createBox,
  createSphere,
  createPlane,
} from 'aicoders-engine';

const canvas = document.getElementById('viewport');

try {
  const engine = new Engine({ canvas, shadows: true, stats: false });
  const { scene, camera } = engine;

  scene.background = new Color(0.05, 0.07, 0.11);
  scene.ambientLight.set(0.45, 0.55, 0.75);
  scene.ambientIntensity = 0.35;

  camera.position.set(6, 4.5, 8);
  camera.lookAt(0, 1, 0);

  // --- luz -----------------------------------------------------------------
  const sun = new DirectionalLight();
  sun.position.set(8, 14, 6);
  sun.target.set(0, 0, 0);
  sun.intensity = 2.4;
  sun.castShadow = true;
  scene.add(sun);

  // --- chao ----------------------------------------------------------------
  const ground = new Mesh(
    createPlane(40, 40, 1, 1),
    new StandardMaterial({ baseColor: new Color(0.22, 0.24, 0.28), roughness: 0.95 })
  );
  // createPlane e um quad em XY virado para +Z; deita ele.
  ground.rotateOnAxis(new Vec3(1, 0, 0), -Math.PI * 0.5);
  ground.receiveShadow = true;
  // Chao nao se move: fora da passada de transformacao da engine.
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  scene.add(ground);

  // --- fisica --------------------------------------------------------------
  const world = new CollisionWorld({ gravity: new Vec3(0, -18, 0) });
  world.addStatic({
    positions: new Float32Array([-20, 0, -20, 20, 0, -20, 20, 0, 20, -20, 0, 20]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  }, { friction: 0.8 });

  const boxMesh = new Mesh(
    createBox(1, 1, 1),
    new StandardMaterial({ baseColor: new Color(0.85, 0.45, 0.2), roughness: 0.4, metallic: 0.1 })
  );
  boxMesh.castShadow = true;
  scene.add(boxMesh);

  const body = new RigidBody({
    shape: BodyShape.BOX,
    mass: 1,
    restitution: 0.35,
    node: boxMesh, // a engine sincroniza a malha com o corpo a cada passo
  });
  body.setShape(BodyShape.BOX, { halfExtents: new Vec3(0.5, 0.5, 0.5) });
  body.position.set(0, 6, 0);
  world.addDynamic(body);

  // --- objeto girando ------------------------------------------------------
  const sphere = new Mesh(
    createSphere(0.8, 32, 20),
    new StandardMaterial({ baseColor: new Color(0.9, 0.85, 0.4), roughness: 0.25, metallic: 0.9 })
  );
  sphere.position.set(3, 1.2, 0);
  sphere.castShadow = true;
  scene.add(sphere);

  // --- controles -----------------------------------------------------------
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1, 0);
  controls.minDistance = 3;
  controls.maxDistance = 40;

  // --- loop ----------------------------------------------------------------
  engine.onUpdate((dt) => {
    controls.update(dt);
    world.step(dt);

    sphere.position.y = 1.2 + Math.sin(engine.time.elapsed * 1.6) * 0.35;
    sphere.rotateOnAxis(new Vec3(0, 1, 0), dt * 0.8);

    // Devolve a caixa quando ela cai fora do mundo.
    if (body.position.y < -5) {
      body.position.set((Math.random() - 0.5) * 3, 8, (Math.random() - 0.5) * 3);
      body.velocity.set(0, 0, 0);
      body.wake();
    }
  });

  engine.start();

  // Para inspecionar do console do navegador.
  globalThis.app = { engine, scene, camera, world, body };
} catch (error) {
  const fatal = document.getElementById('fatal');
  fatal.style.display = 'flex';
  document.getElementById('fatal-msg').textContent =
    String(error && error.message ? error.message : error);
  console.error(error);
}
