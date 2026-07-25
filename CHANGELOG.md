# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento conforme [SemVer](https://semver.org/lang/pt-BR/).

## [1.1.0] — 2026-07-25

Duas mudancas na engine que sairam da construcao do exemplo de kart. As duas
valem para qualquer jogo, nao so para veiculos.

### Adicionado

- **`CollisionWorld.onSubstep(fn)`** e **`CollisionWorld.onVelocityConstraint(fn)`**:
  ganchos para rodar codigo na taxa do solver, e nao na do frame.

  Um controlador que aplica forcas em resposta a velocidade — pneu, propulsor,
  mola controlada — precisa dos dois. `onSubstep` roda antes da integracao e e
  onde forcas funcionam. `onVelocityConstraint` roda depois dela, e e onde
  restricoes de velocidade funcionam; ali o acumulador de forca ja foi zerado,
  entao use impulsos.

  A ordem importa e nao e detalhe: um pneu que roda antes da integracao le a
  velocidade sem a gravidade daquele passo e portanto nunca consegue anula-la.
  Na pratica, um veiculo parado numa rampa escorrega para sempre, por mais
  aderencia que se de a ele. Foi exatamente esse bug que motivou os ganchos.

### Corrigido

- **Malha some ao se mover, mas continua projetando sombra.**

  `Scene.updateMatrices` marcava para o broadphase apenas os meshes cuja matriz
  mudou naquela chamada. Quem chamasse `updateWorldMatrix(true)` por conta
  propria — coisa legitima, para ler uma posicao de mundo no meio do frame —
  consumia os flags de sujeira, e a cena concluia que nada se moveu. O proxy
  ficava com os bounds do nascimento e a malha desaparecia assim que saia do
  lugar onde comecou. A sombra continuava, porque o passe de sombra nao consulta
  o broadphase.

  Agora a decisao compara versoes (`Mesh._bvhVersion` contra
  `worldMatrixVersion`), o que torna o resultado independente de quem atualizou
  a matriz. Custo: uma comparacao de inteiro por no, dentro de um walk que ja
  existia.

  Atinge qualquer hierarquia em que o pai se move e os filhos tem transformacao
  local fixa — um personagem, um veiculo, uma torre. No kart, o corpo inteiro
  sumia e sobravam as quatro rodas, que so escapavam porque tem a matriz local
  reescrita todo frame.

## [1.0.0] — 2026-07-25

Primeira versao publicavel. A engine passa a ser consumivel como pacote.

### Empacotamento

- `exports` map com a raiz e doze subpaths por area (`aicoders-engine/math`,
  `/physics`, `/render`, …), cada um com tipos.
- Tipos TypeScript gerados do JSDoc que ja existia no codigo e **commitados** em
  `types/`: quem consome nunca precisa rodar o `tsc`.
- `sideEffects: false`, para bundlers eliminarem o que nao for usado.
- `tools/check-package.mjs` valida o que nenhum teste do repositorio pegaria —
  alvo de `exports` inexistente, `files` incompleto e, principalmente, arquivo
  de `src/` importando de fora de `src/`, que instala quebrado sem falhar aqui.
- Barris por area gerados por `tools/gen-barrels.mjs`, com colisao de nome
  virando erro em vez de export sumindo em silencio.

### Renderizacao

- `WaterMaterial`: superficie de agua com deslocamento por onda, Fresnel de
  Schlick, brilho de sol e marolas. A normal e avaliada por fragmento a partir
  da forma fechada, entao o sombreamento independe da tesselacao.
- `createDisc(raio, segmentos, aneis)` em `Primitives`, com espacamento por raiz
  quadrada para manter a area dos aneis constante.

### Fisica

- `WaterVolume`: empuxo por Arquimedes, arrasto linear e quadratico,
  amortecimento angular e correnteza. A fracao submersa e analitica para esfera
  e integrada ao longo do eixo para capsula, o que a mantem continua.
- Nado no `CharacterController` (`submersion`, `inWater`, `swimming`), com o
  ponto de equilibrio em `submersion * buoyancy === 1`.
- `CollisionWorld.addStaticInstanced`: milhares de instancias compartilhando uma
  BVH de triangulos, reportando quantas precisaram ser bakeadas.
- Substep automatico: o solver passa a ver passos de no maximo `maxSubStepTime`
  independente do frame rate. Sem isso, a 3 fps a correcao de penetracao chegou
  a lancar um corpo a 2.666 m.

### Entrada

- Captura de teclas com escopo (`captureMode`, `captureKeys`,
  `captureAllShortcuts`) para que comandos do jogo nao disparem atalhos do
  navegador.
- Keyboard Lock API via `enterGameMode()`: a unica forma de uma pagina receber
  Ctrl+W, Ctrl+T e F11. `shortcutStatus()` informa o que o ambiente atual
  realmente consegue bloquear.

### Correcoes

- `Renderer._resolveProgram` checava `shaderLib.has(name)` antes de chamar
  `material.getProgram()`, que e quem registraria o shader — nenhum
  `ShaderMaterial` conseguia se registrar, tornando a API de material
  customizado inutilizavel.
- `FirstPersonControls` zerava a componente vertical fora do pulo, entao o
  personagem nunca conseguia nadar para cima nem mergulhar.
- `serve.mjs` avanca de porta quando a padrao esta ocupada, situacao comum sob
  WSL2 com rede espelhada, onde um processo do Windows segura a porta sem
  aparecer no `ss`.

[1.1.0]: https://github.com/vinilana/aicoders-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/vinilana/aicoders-engine/releases/tag/v1.0.0
