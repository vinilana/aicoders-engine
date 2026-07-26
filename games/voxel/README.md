# Voxel Core

Núcleo técnico de um jogo estilo Minecraft, construído sobre a AICoders Engine.
Mundo voxel infinito, meshing, física e interação — sem UI de jogo e sem progressão,
de propósito. É uma base limpa para você construir o jogo em cima.

```bash
node tools/serve.mjs
# abra a URL que o servidor imprimir (padrao http://localhost:8080/games/voxel/)
```

Parâmetros de URL: `?seed=1337` (número ou texto) e `?distance=8` (raio em chunks).

---

## O que existe

| Sistema | Arquivo | Resumo |
|---|---|---|
| Registro de blocos | `src/Blocks.js` | 20 tipos, tabelas planas (`IS_OPAQUE`, `LIGHT_ABSORB`…) e a ordem canônica de texturas |
| Armazenamento | `src/Chunk.js` | Coluna 16×128×16 em `Uint16Array`, dividida em 8 seções de 16³ |
| Geração | `src/WorldGen.js` | Perlin 3D/2D, 7 biomas, cavernas por ruído ridged, veios de minério, árvores |
| Iluminação | `src/Lighting.js` | Flood fill BFS de skylight e blocklight, com remoção correta e orçamento por frame |
| Água corrente | `src/VoxelFluid.js` | Adaptador do `CellularFluid` da engine: nível por célula, escoamento, secagem e correnteza |
| Meshing | `src/Mesher.js` | Greedy meshing com AO por vértice e luz suave por canto |
| Mundo | `src/World.js` | Mapa esparso de chunks, acesso global, vizinhança padded 18³ |
| Streaming | `src/ChunkManager.js` | Pool de workers, carga por distância, upload limitado por frame |
| Texturas | `src/TextureAtlas.js` | 22 texturas procedurais 16×16 em uma `sampler2DArray` |
| Material | `src/VoxelMaterial.js` | Shader dedicado: AO + luz assada, sombreamento fixo por face |
| Raycast | `src/VoxelRaycast.js` | DDA de Amanatides & Woo, com a face atingida |
| Física | `src/VoxelPhysics.js` | AABB varrida por eixo, com step-up automático |
| Jogador | `src/Player.js` | Caminhar, nadar, voar; colisão e câmera em primeira pessoa |
| Interação | `src/Interaction.js` | Quebrar e colocar blocos, com destaque do alvo |

---

## Água corrente

Cavar ao lado de um lago enche o bloco cavado. Furar o leito faz a água descer
pelo buraco, enchê-lo até a borda e só então seguir adiante. Tirar a fonte seca
a poça inteira. Nadar rio abaixo é mais rápido do que rio acima.

Nada disso mora aqui: a regra toda está no `CellularFluid` da engine, que opera
sobre uma grade abstrata e não sabe o que é um chunk. O que este jogo fornece são
os quatro acessores (`getLevel`, `setLevel`, `isSolid`, `isSource`) e a tradução
entre nível e id de bloco.

A superfície é uma **lâmina contínua**, não degraus por célula: a altura é
calculada por *canto*, a partir da média dos níveis que tocam aquele canto. Como
vira função só da posição do canto, células vizinhas concordam por construção.
Isso importa porque não existe parede entre duas células de água — `facesVisible`
funde líquidos iguais — então qualquer diferença de altura entre vizinhas viraria
uma fresta por onde se enxerga através da água de raspão. É também o que faz a
água correr visivelmente para baixo em vez de descer em degraus. Água parada
continua mesclando: um lago plano de 16×16 ainda vira um único quad.

**A água sobe.** Uma sala escavada abaixo do nível do lago enche até o nível do
lago, e dois poços ligados pelo fundo se nivelam — carga hidrostática, não
espalhamento. Um balde solitário num plano continua sendo um balde, porque não há
nada em cima dele e portanto não há carga. O que separa os dois casos é que só
uma **fonte** ancora carga e só uma coluna **confinada** ancora carga; sem a
segunda condição, uma cachoeira pressurizaria a própria poça.

**Água gerada é fonte; água que escorreu não é.** Essa única distinção é o que
faz um oceano se sustentar sem custo nenhum em repouso (fontes nunca mudam, então
nunca entram na fila) e ao mesmo tempo faz uma poça derramada secar quando o
balde é recolhido.

O nível vive num `Uint8Array` paralelo ao de blocos, não no id. Codificar oito
níveis como oito ids de água multiplicaria a tabela de blocos — e todas as
tabelas indexadas por id junto — por causa de um único atributo de um único
bloco.

Na hotbar, a tecla **9** é o balde: coloca uma fonte, e colocar de novo sobre uma
fonte existente a recolhe. O raycast atravessa líquidos de propósito (você
precisa poder cavar o bloco atrás de uma cachoeira), então mirar na própria água
é impossível — sem o recolhimento, água colocada à mão seria permanente.

---

## As quatro decisões que importam

### 1. Array de texturas, não atlas

Greedy meshing produz quads que cobrem N blocos. Com um atlas clássico isso é
impossível sem sangrar para os vizinhos, porque a UV precisaria passar de 1.0.
Com `sampler2DArray` a UV simplesmente vai de `0` a `N` com wrap `REPEAT`, e os
mipmaps são por camada — então terreno distante filtra certo em vez de borrar
texturas não relacionadas umas nas outras.

### 2. O que pode ser mesclado

A chave de merge do greedy meshing inclui bloco, camada, **os quatro cantos de
AO e os quatro cantos de luz**. Ignorar isso é o bug clássico que deixa a malha
visualmente chapada e espalha sombra por um campo inteiro. O custo é que uma
parede iluminada de forma irregular gera mais quads — e é exatamente o que
deveria acontecer.

### 3. Luz é um flood fill, e remover é a metade difícil

Apagar uma fonte de luz não é zerar a célula: é apagar exatamente a região que
aquela fonte iluminava e depois deixar os vizinhos mais brilhantes reentrarem.
São duas filas (`remove` antes de `add`), o que também torna o resultado
independente da ordem em que as edições chegaram. Skylight tem uma regra a mais:
cai na vertical sem atenuar, que é o que faz um poço receber luz até o fundo.

### 4. A ordem das texturas é um contrato entre threads

O mesher roda no worker, que tem a **própria instância de módulo** de
`Blocks.js`. Se os índices de camada fossem atribuídos ao construir o atlas —
algo que só a thread principal faz —, a tabela do worker ficaria zerada e o
mundo inteiro seria desenhado com a textura 0. Por isso `TEXTURE_NAMES` é uma
constante da qual os dois lados derivam os índices, sem nenhum handshake.

*(Esse bug aconteceu de verdade durante a construção; o mundo inteiro saiu cinza.)*

---

## Pipeline de um frame

```
requestAnimationFrame
  │
  ├─ Player.update ............ intenção → velocidade → AABB varrida por eixo
  │
  ├─ ChunkManager.update
  │    ├─ fila de geração ..... (cx,cz) → worker → Uint16Array de blocos
  │    ├─ Lighting.update ..... BFS com orçamento (~60k voxels/frame)
  │    ├─ fila de meshing ..... vizinhança 18³ → worker → buffers de vértice
  │    └─ uploads ............. no máximo N geometrias por frame
  │
  ├─ Interaction.update ....... DDA do olho → quebrar / colocar / destacar
  │
  └─ Renderer.render .......... culling por BVH → opacos → água (transparente)
```

Geração e meshing são funções puras da entrada, o que os torna seguros para
espalhar num pool. Todo array que cruza a fronteira é **transferido**, não
copiado: uma seção custa a passagem de um ponteiro em vez de 17 kB de clone
estruturado por mensagem.

---

## Por que o render é "chapado"

A engine é instanciada com `hdr: false`, `shadows: false`, `clustered: false`.
Não é economia — é correção: um mundo voxel assa a própria luz na malha, então
sombra dinâmica e luz clusterizada custariam tempo real e não mudariam nada na
tela. O que sobra é o modelo que o Minecraft estabeleceu:

- **luz** vem do flood fill, por vértice;
- **oclusão ambiente** vem do mesher, por canto;
- **sombreamento** é fixo por eixo de face (topo 1.0, laterais 0.86/0.72, base 0.45).

Sem esse último passo toda silhueta de cubo vira uma mancha de cor só.

---

## Verificação

```bash
node tools/voxel-test.mjs      # Chrome real, WebGL2 via ANGLE
```

Sobe o servidor, carrega o jogo, espera o mundo aparecer e valida 13 asserções:
chunks gerados, malhas criadas, geometria desenhada, terreno com estrutura,
skylight cheio na superfície e bloqueado no fundo, edição de bloco, jogador
assentado no solo, tela não preta e com variância, sem erro de GL, sem exceção,
sem erro de console. Salva um screenshot para inspeção visual.

Estado estável em `--distance 8` (225 chunks): 893 seções com malha,
627.448 triângulos residentes, 260 draw calls, fila de luz zerada.
Converge em ~40 s e não cresce depois disso.

Modos úteis: `--distance N`, `--seconds N` e `--walk` (voa em linha reta para
exercitar carga e descarga contínua de chunks — um teste parado nunca toca
esse caminho).

> O FPS medido aqui (1–4) **não** representa a engine: o ambiente de CI não tem
> GPU e o Chrome roda com SwiftShader, que rasteriza na CPU.

---

## Limitações conhecidas

- **Sem persistência.** Editar um bloco e sair do alcance de carregamento perde a
  edição. `Chunk.toSave()` existe e devolve o snapshot, mas nada o consome ainda.
- **Sem UI de jogo.** Sem inventário, craft, vida ou mobs — foi o escopo pedido.
  A seleção de bloco pela roda/teclas 1–9 é uma conveniência de desenvolvimento.
- **Água é estática.** Preenche até o nível do mar na geração e não escoa.
- **Sem oclusão entre chunks.** O culling é por frustum via BVH da engine; não há
  descarte por visibilidade de caverna, então olhar para uma parede ainda submete
  o que está atrás dela.
- **Altura fixa em 128.** Suficiente para terreno e cavernas, metade do Minecraft
  moderno.
- **Iluminação roda na thread principal.** Tem orçamento por frame e nunca trava,
  mas uma edição grande leva alguns frames para assentar.
- **Voar muito rápido deixa o meshing para trás.** A ~24 blocos/s o backlog
  cresce mais rápido do que os workers drenam, e o horizonte fica esburacado até
  você parar. É throughput, não vazamento: a fila drena sozinha.

---

## Estendendo

**Adicionar um bloco:** inclua a textura em `TEXTURE_NAMES` e seu gerador em
`GENERATORS` (`TextureAtlas.js`), depois um `def(...)` em `BLOCKS`. As tabelas
planas e os índices de camada se atualizam sozinhos.

**Mudar o terreno:** `sampleColumn()` devolve altura e bioma para uma coluna;
`generateChunk()` preenche a coluna e roda a decoração. Ambos são puros e
determinísticos — mesma seed, mesmo mundo, em qualquer ordem.

**Salvar o mundo:** persista `chunk.toSave()` para os chunks com `modified`
verdadeiro e reinjete os blocos antes de `world.addChunk()`. A luz e as tabelas
derivadas se reconstroem sozinhas via `rebuildDerived()` e `seedChunk()`.
