# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento conforme [SemVer](https://semver.org/lang/pt-BR/).

## [1.2.0] — 2026-07-25

Fluido em grade. Saiu do exemplo voxel, mas a regra inteira mora na engine e nao
sabe o que e' um chunk.

### Adicionado

- **`CellularFluid`**: liquido que escoa sobre uma grade discreta — enche
  buracos, transborda beiradas, desce ladeira e **seca quando a fonte some**.

  E' a outra metade do `WaterVolume`. Aquele modela um corpo de agua *fixo*
  agindo sobre corpos rigidos (empuxo, arrasto, correnteza) e nunca muda de
  forma. Este modela a agua como aquilo que se move. Um jogo voxel precisa dos
  dois: um para boiar um barco, este para responder "cavei do lado do lago, e
  agora?".

  O solver nao tem armazenamento proprio: le e escreve celulas pelos acessores
  passados na construcao (`getLevel`, `setLevel`, `isSolid`, `isSource`,
  `isLoaded`). E' o que o mantem independente de como o hospedeiro guarda o
  mundo — colunas de chunk, array plano, mapa de tiles — e o que permite ao
  hospedeiro aplicar os proprios efeitos colaterais (remesh, reiluminar, marcar
  para salvar) dentro do `setLevel`.

  O nivel de uma celula nao e' integrado a partir de vazoes: e' **derivado** dos
  vizinhos. Isso torna o estado de repouso um campo de distancia BFS medido a
  partir das fontes, o que importa por dois motivos. **Sempre converge** — nao ha
  oscilacao para amortecer nem condicao de CFL a respeitar — e **seca certo**:
  apague a fonte e a mesma regra drena a poca, porque nenhuma celula consegue
  sustentar um nivel que os vizinhos nao justifiquem.

  Massa nao e' conservada, de proposito. Um solver conservativo numa grade
  grosseira da' pocas que nunca somem e margens que tremem; uma fonte que
  espalha uma distancia limitada e para e' o que o jogador espera e o que se
  mantem estavel quando editam o mundo por baixo dela.

  Duas regras fazem o resultado parecer deliberado em vez de difuso:

  - **quem tem para onde cair nao espalha para os lados.** Agua que chega na
    borda de um buraco despeja nele em vez de continuar rastejando pelo chao, e
    so' volta a espalhar depois que o buraco encheu. Sem isso um derramamento
    cresce como um disco uniforme e ignora o buraco ao lado, o que le como
    obviamente falso;
  - **agua de passagem tambem nao alimenta os lados.** Uma coluna em queda livre
    fica cheia em toda a altura, entao o teste ingenuo de "tem espaco embaixo"
    vira falso assim que a queda atinge o chao e cada nivel da coluna passa a se
    comportar como poca — a cachoeira virava uma cortina. O que decide nao e' se
    ha espaco embaixo, e sim se a agua de baixo **esta indo a algum lugar**.

  Fluido corre no relogio proprio, nao no do frame: `update(dt)` acumula tempo e
  roda um tick a cada `flowInterval`, avancando a frente exatamente uma celula.
  Rodar por frame faria a agua saltar para a forma final em poucos frames,
  perdendo o espalhamento — e o espalhamento *e'* o retorno que diz ao jogador
  que o mundo reagiu.

  `flowAt(x, y, z, out)` devolve a direcao da correnteza a partir do gradiente de
  nivel, para empurrar quem estiver dentro dela.

### Exemplo voxel

- Agua corrente completa: cavar ao lado do lago enche o bloco, furar o leito
  abre um ralo, tirar a fonte seca a poca, e a superficie e' desenhada na altura
  do nivel (o mesher passou a receber o nivel, entao um riacho mostra o degrau de
  cada celula). Correnteza empurra o jogador nadando. Balde na tecla 9.
- Passou a usar `enterGameMode()`: com o ponteiro travado, Ctrl+W nao fecha mais
  a aba no meio de uma escavacao.

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

[1.2.0]: https://github.com/vinilana/aicoders-engine/releases/tag/v1.2.0
[1.1.0]: https://github.com/vinilana/aicoders-engine/releases/tag/v1.1.0
[1.0.0]: https://github.com/vinilana/aicoders-engine/releases/tag/v1.0.0
