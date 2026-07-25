# Circuito

Kart racer sobre a AICoders Engine. Circuito fechado, física de veículo com
suspensão por raycast, três voltas cronometradas e o fantasma da sua melhor volta.

```bash
node tools/serve.mjs
# abra a URL que ele imprimir, em /games/kart/
```

| | |
|---|---|
| **W / S** | acelerar e ré |
| **A / D** | virar |
| **espaço** | freio |
| **shift** | freio de mão |
| **R** | reposicionar na pista |
| **M · G · C · N** | som · fantasma · mapa gira/fixo · mapa on/off |

Gamepad e toque também funcionam — o gatilho analógico dá controle de acelerador
que o teclado não tem.

---

## Por que este exemplo existe

Ele foi escolhido para cobrir quatro partes da engine que **nenhum outro exemplo
tocava**: 6.909 linhas de API pública estavam sem exercício algum.

| Sistema | Como o jogo força |
|---|---|
| `RenderTarget` + `OrthographicCamera` | o minimapa é uma segunda câmera renderizando a cena para textura |
| `AudioEngine` / `AudioSource` | motor sintetizado, posicional, com pitch pelo RPM |
| Gamepad analógico | acelerador é um eixo contínuo, não uma tecla |
| `RigidBody` em alta velocidade | contato sustentado a 30 m/s contra barreiras |

---

## As decisões que importam

### Suspensão por raycast

O chassi é **um** corpo rígido. As rodas não são corpos: cada uma é um raio
lançado para baixo de um ponto de fixação. Onde o raio bate, uma mola empurra o
chassi para cima e um modelo de pneu o empurra para frente.

Como as forças são aplicadas **no ponto de contato** e não no centro de massa,
transferência de peso, rolagem em curva e agachamento na aceleração saem da
matemática de graça — ninguém animou nada disso.

### O pneu é o que separa um carro de um tijolo flutuante

Uma roda resiste muito mais ao movimento lateral que ao longitudinal, e essa
assimetria é a diferença inteira. A aderência é limitada por um **círculo de
atrito**: um pneu a quem se pede frenagem máxima *e* curva máxima entrega menos
dos dois. É daí que saem o trail braking e a derrapagem, sem script.

### Uma curva gera tudo

Pista, barreiras, colisão, checkpoints, largada, posição das árvores e o
minimapa derivam da **mesma spline**. É o que impede a superfície de colisão, o
que se vê e a lógica de volta de discordarem sobre onde a pista está. A
inclinação das curvas vem da curvatura — nenhum ângulo foi colocado à mão.

### Checkpoints em ordem

Um checkpoint é um plano atravessado na pista, e a volta só fecha quando todos
foram pagos na sequência. Sem essa regra, dar ré sobre a linha marca volta e
qualquer atalho pelo miolo conta. O teste verifica os dois casos.

### Áudio sem nenhum arquivo

A nota do motor é um loop sintetizado em runtime — pilha de harmônicos mais uma
irregularidade por ciclo — e o RPM controla o `playbackRate`. É assim que jogos
de corrida fazem de verdade: gravar cada rotação é impossível.

---

## Três armadilhas que este exemplo desenterrou

Nenhuma delas aparece em teste estático; todas custaram depuração real.

**O overlay era descartado por back-face culling.** A câmera do minimapa na tela
usa `top = 0, bottom = altura` para que Y cresça para baixo como no CSS. Isso
torna a projeção um espelho: determinante negativo, **winding de todo triângulo
invertido**. O quad era submetido, rasterizado e jogado fora — um draw call que
não desenhava nada. Daí o material ser `side: 'double'`.

**Gamma aplicado duas vezes.** O render target guarda cor já tonemapeada e em
sRGB; o passe de composição desenha direto para a tela, onde o shader aplica
tonemap e sRGB de novo. O mapa saía lavado de branco. `srgbDecode` na amostragem
desfaz exatamente a primeira das duas.

**Não há caminho suportado para desenhar sobre um frame pós-processado.** Com HDR
ligado o frame vai para um alvo intermediário e o pós escreve a tela inteira —
compositar por cima apagaria o mundo. O minimapa desliga `hdrEnabled` só durante
o seu passe. Isso é uma lacuna da engine, não deste jogo.

---

## Verificação

```bash
node tools/kart-test.mjs      # Chrome real, WebGL2 via ANGLE
```

25 asserções. A mais forte lê pixels **de dentro do RenderTarget** do minimapa:
é a única prova de que o segundo passe desenhou de fato, e não apenas rodou sem
erro. Última execução: 100% dos pixels com conteúdo, alfa 255.

Também cobre: suspensão achando o solo nas 4 rodas, aceleração de parado a
81 km/h, direção mudando o rumo, freio parando o kart, volta fechando só com os
checkpoints na ordem, atalho **não** contando volta, fantasma promovido só na
melhor volta, e a nota do motor sintetizada com pico dentro do headroom.

> O FPS aqui não representa a engine: o ambiente de teste não tem GPU e o Chrome
> roda com SwiftShader, que rasteriza na CPU.

---

## Limitações conhecidas

- **Um kart só.** Não há oponentes nem IA. O fantasma é a única referência.
- **Sem dano nem desgaste de pneu.** A aderência não muda ao longo da corrida.
- **Um circuito.** O traçado está codificado em `CONTROL_POINTS`; trocar os
  pontos gera outra pista inteira, incluindo colisão e minimapa.
- **Sem partículas.** A derrapagem é audível, não visível — não há marca de pneu
  nem fumaça.
- **A largada não tem semáforo 3D**, só a contagem no HUD.
