# Arquitetura da AICoders Engine

Este documento descreve como um frame e produzido, quais contratos binarios existem entre CPU e GPU,
como funcionam os subsistemas nao triviais (clustered forward, CSM, as duas BVHs), como os modulos
dependem uns dos outros e como estender a engine sem quebrar nada.

Tudo aqui vem do codigo em `src/`. Os numeros de linha nao sao citados de proposito, mas cada arquivo
mencionado e a fonte da verdade.

---

## 1. Pipeline de um frame

O loop vive em `core/Engine.js`; todo o resto e `render/Renderer.js::_renderFrame`.

```
requestAnimationFrame(now)
  |
  +-- Engine._frame(now) ------------------------------------------------------
  |     reagenda o proximo rAF, aborta se pausado / contexto perdido / disposed
  |
  +-- Engine._runFrame(now)
  |     stats.begin()
  |     resize pendente?  ->  _applyLayoutSize()
  |     time.update(now)  ->  dt = time.delta  (= unscaledDelta * timeScale)
  |
  |     [1] fixed steps      onFixedUpdate(fn, hz), acumulador proprio por callback,
  |                          no maximo 5 substeps por frame, backlog descartado
  |     [2] variable update  onUpdate(fn) -> updatables[].update(dt) -> events.emit('update')
  |     [3] animacao         mixers[].update(dt)
  |     [4] RENDER           renderer.render(scene, camera)   <----------------+
  |     [5] onRender(fn)     callbacks de overlay (DebugRenderer, gizmos)      |
  |         events.emit('render')                                             |
  |     [6] input.update()   rola os estados de borda (pressed/released)       |
  |     stats.end() / stats.update(renderer)                                   |
  |                                                                            |
  +----------------------------------------------------------------------------+
                                                                               |
Renderer._renderFrame(scene, camera, target)  <--------------------------------+

   0. PROLOGO
      info.frame++;  state.resetStats();  shaderLib.poll();  _beginGPUTimer()
      invalida os caches "ultimo material / ultimo programa / ultima geometria"

   1. TRANSFORMS E CAMERA
      scene.updateMatrices()      recompoe matrizes locais so quando mudaram,
                                  multiplica pela do pai, coleta a lista de dirty
      scene.updateBVH()           reinsere/atualiza os proxies dos meshes dirty
      _updateCameraTransform()    sobe ate a raiz da camera (ela pode estar fora da cena)
      camera.updateProjectionIfNeeded() / updateViewMatrix() / updateFrustum()

   2. LOD + CULLING
      _updateLODs(scene, camera)  cada LOD escolhe seu nivel (com histerese)
      _cull(scene, camera)        DynamicBVH.query(frustum) com plane coherency,
                                  depois filtra visible / layers / geometry / material
                                  / ancestral invisivel. Fallback linear se nao ha BVH.
      -> info.visibleMeshes, info.culledMeshes, info.cullTimeMs

   3. LUZES
      LightManager.collect()      separa dirLights (max 4) e punctualLights,
                                  frustum culla o volume de influencia, ordena por
                                  importancia perceptual, distribui slots de sombra
      escolhe shadowLight = 1a dirLight com castShadow
      ClusteredLighting.update()  monta o grid de froxels e as 3 texturas de luz

   4. CONTEXTO DE PERMUTACAO
      sceneTarget = target ?? _acquireFrameTarget()   (HDR rgba16f, ou null)
      environment = scene.environment ?? renderer.ibl
      ctx = { shadows, shadowCascades, clustered, clusterX/Y/Z, ibl, fog,
              toneMapping, instancing, skinning, maxDirLights, maxPunctualLights }
      ctx.toneMapping = true SOMENTE quando o frame vai direto ao framebuffer
                        padrao (sem cadeia de post): exatamente um tonemap por frame

   5. RENDER LIST
      _buildRenderList(camera)    1 item por (mesh, group, material), com o programa
                                  ja resolvido e a profundidade ate o plano da camera
      renderList.sortOpaque()     radix por depth, depois radix por state key
      renderList.sortTransparent()introsort estrito back-to-front

   6. SHADOW MAPS   (so quando existe shadowLight)
      ShadowMapper.update()       4 cascatas -> depth32f 2D array + compare mode
      -> info.shadowDrawCalls

   7. UNIFORM BLOCKS  (std140, upload so do range sujo)
      ubo.updateCamera(camera, w, h, tempo)   binding 0
      ubo.updateLights(lights, scene, clusterReady) binding 1
      ubo.updateShadows(shadowMapper) | disableShadows()  binding 2
      ubo.updateFog(scene)                    binding 3
      ubo.bindAll(state)

   8. BIND DO DESTINO
      sceneTarget ? sceneTarget.bind(state) : (FBO 0 + viewport)

   9. CLEAR
      cor = scene.background quando for uma Color pura, senao a clear color
      clear(color = true, depth = true, stencil = false)

  10. DEPTH PREPASS   (opcional: renderer.depthPrepass && shaderLib.has('depth'))
      colorMask(false x4), depthFunc LESS, depthWrite true
      desenha a lista opaca com o shader 'depth' e os defines do material

  11. PASSES DE COR
      +-- opacos       lista opaca, front-to-back agrupada por estado
      |                (com prepass: depthFunc EQUAL, depthWrite false)
      +-- background   scene.background como Material (SkyMaterial) ou cubemap:
      |                cubo centrado na camera, depthFunc LEQUAL, depthWrite false
      +-- transparentes lista transparente, back-to-front

  12. RESOLVE + POS-PROCESSAMENTO
      sceneTarget.resolve()             blit do MSAA quando samples > 0
      post.render(sceneTarget, null):
          SSAO   -> aoTarget (+ blur)                        [se ssao]
          BLOOM  -> prefilter, N downsamples, N upsamples aditivos  [se bloom]
          COMPOSITE: exposicao + bloom + AO + tonemap + encode sRGB
                     -> ldrTarget quando ainda ha passe final, senao -> destino
          FINAL:     FXAA + vinheta + aberracao cromatica + grao -> destino
      bindFramebuffer(null); viewport(0, 0, drawingBufferWidth, drawingBufferHeight)

  13. EPILOGO
      _endGPUTimer()   (ring de 2 queries, leitura sem stall)
      _collectStats()  copia os contadores do StateCache para renderer.info
      info.cpuTimeMs = agora - inicio
```

Notas de implementacao que valem para o pipeline inteiro:

- **Nada aloca no regime permanente.** A render list e um pool; os scratch de matematica vivem em
  escopo de modulo; as listas de visiveis e de luzes sao reaproveitadas com `length = 0`.
- **Toda mudanca de estado GL passa pelo `StateCache`.** O renderer nunca chama `gl.enable`,
  `gl.bindBuffer` ou `gl.useProgram` diretamente no caminho quente.
- **Subsistemas opcionais degradam.** `ShadowMapper`, `ClusteredLighting`, `PostProcessing` e `IBL` sao
  construidos dentro de `Renderer._build()`: se um deles lanca (driver limitado, sem
  `EXT_color_buffer_float`), ele vira `null`, o passe correspondente e pulado e o frame continua.
- **`renderToTarget(scene, camera, rt)`** roda os passes 1 a 11 dentro do alvo e **pula** o
  pos-processamento; quem chamou e dono do conteudo.

---

## 2. Tabelas de referencia (o contrato)

### 2.1 Attribute locations

Fixas em toda a engine. Declaradas em `render/Geometry.js` (`ATTRIB`, `ATTRIB_NAME_TO_LOC`) e
espelhadas em `render/Program.js` (`DEFAULT_ATTRIB_LOCATIONS`) para que a camada de shader nao precise
importar a camada de geometria. Todo shader tambem declara `layout(location = N)` explicitamente; a
tabela e a rede de seguranca.

| Location | Nome | Tipo tipico | Observacoes |
|---:|---|---|---|
| 0 | `aPosition` | `vec3` | obrigatorio |
| 1 | `aNormal` | `vec3` | |
| 2 | `aUV0` | `vec2` | TEXCOORD_0 |
| 3 | `aTangent` | `vec4` | w = handedness; ativa `USE_TANGENT` |
| 4 | `aColor` | `vec4` | ativa `USE_VERTEX_COLOR` |
| 5 | `aUV1` | `vec2` | TEXCOORD_1; ativa `USE_UV1` |
| 6 | `aJoints` | `uvec4`/`vec4` | ativa `USE_SKINNING` |
| 7 | `aWeights` | `vec4` | |
| 8..11 | `aInstanceMatrix` | `mat4` | 4 locations consecutivas, `divisor = 1` |
| 12 | `aInstanceColor` | `vec4` | ativa `USE_INSTANCE_COLOR` |
| 13 | `aInstanceData` | `vec4` | dado livre por instancia |

### 2.2 Uniform blocks std140

Binding points fixos: `Camera` 0, `Lights` 1, `Shadows` 2, `Fog` 3. Declarados em
`render/UniformBuffers.js` (`UBO_BINDING_POINTS`), em `render/Program.js` (`UBO_BINDINGS`) e no GLSL de
`chunks/camera_ubo.glsl.js` e `chunks/lights_ubo.glsl.js`. `tools/check-glsl.mjs` valida que os quatro
blocos estao declarados `layout(std140)` nos bindings certos.

Todos os membros sao `vec4` ou `mat4`, entao **nao existe padding escondido**: o offset em bytes e
sempre `4 * offset_em_floats`.

**Block `Camera` (binding 0) - 384 bytes / 96 floats**

| Membro | Offset (bytes) | Floats | Conteudo |
|---|---:|---|---|
| `mat4 uView` | 0 | 0..15 | mundo -> view |
| `mat4 uProj` | 64 | 16..31 | view -> clip |
| `mat4 uViewProj` | 128 | 32..47 | mundo -> clip |
| `mat4 uInvView` | 192 | 48..63 | view -> mundo |
| `mat4 uInvProj` | 256 | 64..79 | clip -> view |
| `vec4 uCameraPos` | 320 | 80..83 | `xyz` = posicao no mundo, `w` = 1 |
| `vec4 uCameraParams` | 336 | 84..87 | `near`, `far`, `1/(far-near)`, `fovY` |
| `vec4 uResolution` | 352 | 88..91 | `w`, `h`, `1/w`, `1/h` |
| `vec4 uTimeParams` | 368 | 92..95 | `elapsed`, `delta`, `frame`, reservado |

**Block `Lights` (binding 1) - 160 bytes / 40 floats**

| Membro | Offset | Floats | Conteudo |
|---|---:|---|---|
| `vec4 uAmbient` | 0 | 0..3 | `rgb` linear, `w` = intensidade |
| `vec4 uDirLightDir[4]` | 16 | 4..19 | `xyz` = direcao **para** a luz (normalizada), `w` = castShadow |
| `vec4 uDirLightColor[4]` | 80 | 20..35 | `rgb * intensidade`, `w` = shadowIndex |
| `vec4 uLightCounts` | 144 | 36..39 | `dirCount`, `punctualCount`, `clusterEnabled`, reservado |

`DIR_LIGHT_SLOTS = 4` e um limite fisico: quatro luzes direcionais, nao mais.

**Block `Shadows` (binding 2) - 304 bytes / 76 floats**

| Membro | Offset | Floats | Conteudo |
|---|---:|---|---|
| `mat4 uCascadeMatrix[4]` | 0 | 0..63 | mundo -> clip da cascata |
| `vec4 uCascadeSplits` | 256 | 64..67 | distancia em view space do fim de cada cascata |
| `vec4 uShadowParams` | 272 | 68..71 | `texelSize`, `depthBias`, `normalBias`, `softness` |
| `vec4 uShadowParams2` | 288 | 72..75 | `cascadeCount`, `pcfRadius`, `blendWidth`, `fadeDistance` |

`ShadowMapper.uboData` **e** exatamente esse layout, e `cascadeMatrices` / `splits` / `params` /
`params2` sao views dentro dele - `UniformBuffers.updateShadows()` faz um unico `set()`.

**Block `Fog` (binding 3) - 32 bytes / 8 floats**

| Membro | Offset | Floats | Conteudo |
|---|---:|---|---|
| `vec4 uFogColor` | 0 | 0..3 | `rgb` linear, `w` = opacidade maxima |
| `vec4 uFogParams` | 16 | 4..7 | `mode`, `near`&#124;`density`, `far`, `heightFalloff` |

`mode`: `0` linear, `1` exp, `2` exp2.

**Upload incremental.** Cada bloco e um `Float32Array` unico. As escritas passam por helpers que
comparam antes de gravar e alargam um range sujo de floats; `bufferSubData` so envia esse range. Uma
camera parada custa **zero** chamadas de driver.

### 2.3 Unidades de textura

Fixas em `render/Material.js` (`TEXTURE_UNITS`), espelhadas em `ClusteredLighting.CLUSTER_TEXTURE_UNITS`
e `IBL.IBL_TEXTURE_UNITS`, e declaradas com o mesmo numero nos chunks GLSL.

| Unidade | Uniform | Tipo GLSL | Quem faz o bind |
|---:|---|---|---|
| 0 | `uBaseColorMap` | `sampler2D` | Material |
| 1 | `uNormalMap` | `sampler2D` | Material |
| 2 | `uMetallicRoughnessMap` | `sampler2D` | Material (G = roughness, B = metallic) |
| 3 | `uOcclusionMap` | `sampler2D` | Material (R) |
| 4 | `uEmissiveMap` | `sampler2D` | Material |
| 5 | `uClearcoatMap` | `sampler2D` | *reservado, nenhum shader le hoje* |
| 6 | `uBoneTexture` | `sampler2D` | Renderer (`_bindSkeleton`), 1x por frame por esqueleto |
| 7 | `uLightIndices` | `usampler2D` | ClusteredLighting |
| 8 | `uShadowMap` | `sampler2DArrayShadow` | Renderer (`_bindGlobalUniforms`) |
| 9 | `uClusterGrid` | `usampler3D` | ClusteredLighting |
| 10 | `uLightData` | `sampler2D` (RGBA32F) | ClusteredLighting |
| 11 | `uIrradianceMap` | `samplerCube` | Renderer, a partir de `scene.environment` |
| 12 | `uPrefilteredMap` | `samplerCube` | Renderer |
| 13 | `uBRDFLUT` | `sampler2D` | Renderer |

As unidades 6..13 sao "globais do renderer": `_bindGlobalUniforms(program)` so as reamarrasse quando o
**programa** muda, porque valores de sampler sao por programa e essas texturas nao mudam dentro de um
frame. Sequencias longas de draws com o mesmo programa custam zero.

### 2.4 Defines de permutacao

`Material.getDefines(geometry, ctx)` calcula uma assinatura numerica de 32 bits a partir da geometria +
contexto do frame + estado do material e devolve um objeto de defines **cacheado por assinatura**. A
identidade desse objeto e estavel, e o `Renderer` a usa como chave de um `WeakMap` para achar o
`Program` sem montar string nenhuma no caminho quente.

**Derivados da geometria**

| Define | Condicao |
|---|---|
| `USE_INSTANCING` | mesh e `InstancedMesh` ou a geometria tem `aInstanceMatrix` |
| `USE_INSTANCE_COLOR` | geometria tem `aInstanceColor` |
| `USE_SKINNING` | geometria tem `aJoints` + `aWeights` |
| `USE_VERTEX_COLOR` | geometria tem `aColor` |
| `USE_TANGENT` | geometria tem `aTangent` |
| `USE_UV1` | geometria tem `aUV1` |

**Derivados do material (base)**

| Define | Condicao |
|---|---|
| `ALPHA_MODE_MASK` | `alphaMode === 'mask'` ou `alphaTest > 0` |
| `ALPHA_MODE_BLEND` | `alphaMode === 'blend'` ou `transparent` |
| `DOUBLE_SIDED` | `side === 'double'` |

**Derivados do contexto do frame**

| Define | Valor / condicao |
|---|---|
| `USE_SHADOWS` + `SHADOW_CASCADES` | existe luz direcional com sombra; cascatas 1..4 |
| `USE_CLUSTERED` + `CLUSTER_X/Y/Z` | clustered ativo; dimensoes do grid (1..64 cada) |
| `USE_IBL` | `scene.environment` (ou `renderer.ibl`) presente |
| `USE_FOG` | `scene.fog !== null` |
| `USE_TONEMAP` | o frame vai direto ao framebuffer padrao (sem cadeia de post) |
| `USE_MOTION_VECTORS` | `ctx.motionVectors` - **nunca ligado pelo renderer hoje** |
| `DEPTH_ONLY` | passes de depth prepass e de sombra |
| `MAX_DIR_LIGHTS` | 1..4 |
| `MAX_PUNCTUAL_LIGHTS` | 1..4096 |

**Derivados do `StandardMaterial`** (`applyOwnDefines`)

| Define | Condicao |
|---|---|
| `USE_BASECOLOR_MAP` / `BASECOLOR_UV1` | mapa presente / usa TEXCOORD_1 |
| `USE_NORMAL_MAP` / `NORMAL_UV1` / `FLIP_NORMAL_Y` | idem + inversao do canal verde |
| `USE_MR_MAP` / `MR_UV1` | metallic-roughness |
| `USE_OCCLUSION_MAP` / `OCCLUSION_UV1` | oclusao |
| `USE_EMISSIVE_MAP` / `EMISSIVE_UV1` | emissivo |
| `USE_UV_TRANSFORM` | transform de UV diferente da identidade |
| `MANUAL_SRGB_DECODE` | `srgbDecode = true` |
| `USE_SPECULAR_AA` | `specularAntiAliasing = true` |

**Outros produtores**

| Define | Quem define |
|---|---|
| `SHADOW_CLAMP_NEAR` | `ShadowMapper._getProgram` (variante do shader `shadow`) |
| `MAX_LIGHTS_PER_CLUSTER` | `ClusteredLighting` |
| `USE_CLOUDS` | `SkyMaterial` |
| `USE_BLOOM`, `USE_SSAO`, `USE_FXAA`, `USE_VIGNETTE`, `USE_CHROMATIC_ABERRATION`, `USE_GRAIN`, `SSAO_SAMPLES` | `PostProcessing._updatePrograms` |
| `DEBUG_CAMERA_UBO`, `DEBUG_SRGB_OUTPUT` | `DebugRenderer` (`DEBUG_ALPHA_TEST` existe no shader `debug`, mas so e ligado manualmente) |

Defines escritos em `material.defines` sao mesclados **por cima** dos derivados; valor `false`/`null`/
`undefined` **remove** a chave, `true` vira `1`.

O `ShaderPreprocessor` injeta as linhas `#define K V` (ordenadas, para chave deterministica) logo depois
de `#version 300 es`, junto com `precision highp float; precision highp int;` nos fragment shaders - por
isso as fontes cruas nao declaram precisao.

---

## 3. Clustered forward (froxels)

Arquivo: `render/ClusteredLighting.js`, consumido por `render/chunks/cluster.glsl.js`.

### 3.1 O grid

O frustum e dividido em `CLUSTER_X x CLUSTER_Y x CLUSTER_Z` froxels - por padrao **16 x 9 x 24** =
3456 celulas. X e Y sao tiles uniformes da tela; Z e exponencial:

```
logRatio = log(far / near)
scale    = CLUSTER_Z / logRatio
bias     = -CLUSTER_Z * log(near) / logRatio
slice    = floor(log(viewDepth) * scale + bias)
```

A distribuicao exponencial da a cada slice a mesma razao `zFar/zNear` local, ou seja, resolucao
angularmente uniforme em profundidade: perto da camera as fatias sao finas (onde as luzes pontuais
importam), longe elas sao grossas (onde tudo ja e pequeno na tela). A CPU e o GLSL derivam `scale` e
`bias` da **mesma** fonte (`uCameraParams.x/.y`), entao a atribuicao e a consulta nunca divergem.

### 3.2 Atribuicao das luzes

O laco **nunca** percorre o grid inteiro. Para cada luz:

1. A esfera de influencia (raio = `light.range`, ou derivado da intensidade quando `range = 0`) e
   projetada **analiticamente** para uma AABB em NDC. A projecao usa os dois pontos de tangencia da
   silhueta da esfera no plano formado pelo eixo e pela profundidade; quando a esfera cruza o near
   plane, a secao no near tambem entra na uniao. Esfera que contem o olho -> eixo inteiro.
2. Isso da o intervalo exato de tiles em X e Y; o intervalo de profundidade da o intervalo de slices em Z.
3. So esse sub-volume e visitado, e cada froxel dentro dele ainda faz um teste real **esfera x AABB**
   (mais **cone x esfera** para spots).

### 3.3 Codificacao das texturas

| Textura | Formato | Unidade | Conteudo |
|---|---|---:|---|
| `uClusterGrid` | `usampler3D` R32UI, `X x Y x Z` | 9 | `(offset << 12) &#124; count` |
| `uLightIndices` | `usampler2D` R32UI | 7 | lista plana de indices de luz, row major |
| `uLightData` | `sampler2D` RGBA32F | 10 | 4 texels consecutivos por luz |

Layout de uma luz em `uLightData` (`TEXELS_PER_LIGHT = 4`, `FLOATS_PER_LIGHT = 16`):

```
texel 0 : position.xyz (mundo)                    | range
texel 1 : color.rgb (ja multiplicado por intensity)| intensity
texel 2 : direction.xyz (eixo do spot, apontando para fora da luz) | innerConeCos
texel 3 : type (0 = point, 1 = spot)              | shadowIndex | decay | outerConeCos
```

A celula do grid guarda 20 bits de offset (ate 1.048.576 entradas na lista de indices) e 12 bits de
contagem (ate 4095 luzes por froxel, na pratica limitadas por `MAX_LIGHTS_PER_CLUSTER`, 128 por padrao).

No fragment shader:

```glsl
ivec3 coord = getClusterCoord(gl_FragCoord.xy, viewDepth);
uint  cell  = texelFetch(uClusterGrid, coord, 0).r;
int   offset = int(cell >> 12u);
int   count  = int(cell & 4095u);
for (int i = 0; i < count; ++i) {
  PunctualLight light = fetchPunctualLight(fetchLightIndex(offset + i));
  color += evaluatePunctualLight(px, light, 1.0);
}
```

Quando `ClusteredLighting.update()` nao consegue montar o grid (camera nao perspectiva), ela devolve
`false`, o grid e zerado e `uLightCounts.z` (`clusterEnabled`) fica em 0: o shader entao cai no laco
plano sobre `uLightData`, sem froxels.

---

## 4. Cascaded shadow maps (CSM)

Arquivo: `render/ShadowMapper.js`, consumido por `render/chunks/shadow.glsl.js`.

O alvo e um `RenderTarget` **sem attachment de cor**, com `depth32f` como **textura 2D array** de
`max(2, cascades)` camadas e `compareMode` ligado, amostrada no shader por um
`highp sampler2DArrayShadow` na unidade 8.

### 4.1 Splits

`_computeSplits(near, far, count)` mistura a serie logaritmica com a uniforme pelo classico `lambda`
(padrao 0.6, ajustavel com `setLambda`):

```
p    = i / count
log  = near * (far / near)^p
lin  = near + (far - near) * p
split[i-1] = lambda * log + (1 - lambda) * lin
```

`far` aqui e `shadowDistance` (nao o far da camera): cobrir 140 m com 4 cascatas da uma densidade de
texel radicalmente melhor do que cobrir 900 m.

Cascatas vizinhas se sobrepoem por `blendWidth`, e o `sliceNear` de cada uma recua esse tanto - e isso
que permite a transicao suave entre cascatas no shader.

### 4.2 Esfera envolvente e snap de texel

Para cada cascata:

1. Os 8 cantos da fatia do frustum da camera sao reconstruidos em espaco de mundo interpolando os 8
   cantos do frustum completo. A profundidade em view space e funcao afim da posicao no mundo, entao a
   interpolacao e **exata** tanto para camera perspectiva quanto ortografica.
2. Ajusta-se uma **esfera** envolvente a esses cantos. Uma esfera e invariante sob rotacao: girar a
   cabeca nao muda o tamanho do volume da luz. Essa e a cura classica do shimmering de cascata.
3. O centro da esfera e **quantizado para um texel inteiro** do shadow map, no espaco da luz. Isso
   remove o crawling sub-texel que sobra quando so o tamanho e estabilizado.
4. Uma camera ortografica e montada em volta da esfera "snapada", com o near plane **empurrado para
   tras** ao longo da direcao da luz, para que occluders fora do frustum da camera ainda escrevam no
   mapa. O shader complementa isso clampando o `z` de clip no near (`SHADOW_CLAMP_NEAR`), o que mantem
   casters ainda mais distantes projetando sombra.
5. So os casters relevantes sao desenhados: a `DynamicBVH` da cena e consultada com a AABB de mundo do
   volume da cascata, e cada candidato e rejeitado exatamente contra a caixa em espaco de luz.

### 4.3 Bias

Tres mecanismos, complementares:

| Mecanismo | Onde e aplicado | Parametro |
|---|---|---|
| Depth bias constante | shader, sobre a coordenada de profundidade | `uShadowParams.y` (`setBias`) |
| Normal offset | shader, desloca o ponto de amostragem ao longo da normal, proporcional ao tamanho de mundo de um texel | `uShadowParams.z` (`setBias`) |
| Slope-scaled offset | rasterizador, `glPolygonOffset` durante o desenho das cascatas | `slopeScaleBias` / `depthOffsetUnits` |

O filtro e um PCF com disco rotacionado por ruido, raio `uShadowParams2.y` e suavidade
`uShadowParams.w` (`setSoftness(radius, softness)`).

### 4.4 Variantes do shader de sombra

`ShadowMapper._getProgram(variant)` mantem 32 permutacoes (5 bits) pre-resolvidas:

| Bit | Define |
|---:|---|
| 1 | `USE_INSTANCING` |
| 2 | `USE_SKINNING` |
| 4 | `ALPHA_MODE_MASK` |
| 8 | `USE_BASECOLOR_MAP` |
| 16 | `SHADOW_CLAMP_NEAR` |

Existem tambem caminhos de spot (atlas perspectivo) e de point (cube maps) no `ShadowMapper`. Eles
renderizam, mas **o shader `standard` ainda nao os consome**: `chunks/cluster.glsl.js` chama
`evaluatePunctualLight(..., 1.0)`, ou seja, visibilidade fixa em 1 para luzes punctuais.

---

## 5. Formato de dados das BVHs

### 5.1 `DynamicBVH` (broadphase da cena)

Arquivo: `spatial/DynamicBVH.js`. **Sem nenhum import** - le apenas campos `.min.x` / `.max.z` dos
objetos que recebe, entao roda em worker ou em teste puro.

Armazenamento em structure-of-arrays; cada no `i` ocupa a mesma posicao em todos os arrays:

```
_bounds[i*6 + 0..5]       fat AABB   : minX minY minZ maxX maxY maxZ
_tightBounds[i*6 + 0..5]  AABB exata : minX minY minZ maxX maxY maxZ
_parent[i]                Int32, -1 = raiz
_child1[i]                Int32, -1 em folha; tambem serve de free list
_child2[i]                Int32, -1 em folha
_height[i]                Int32, 0 em folha, -1 em no livre
_userData[i]              Array JS, o payload (o Mesh)
```

- **Folhas guardam dois AABBs**: o *fat* (com margem `DEFAULT_MARGIN = 0.1`, mais uma extensao de
  `2 * deslocamento` na direcao do movimento) sustenta a hierarquia, para que micro movimentos nao
  reestruturem a arvore; o *tight* torna o resultado das queries exato, sem falsos positivos.
- **Insercao** desce pela heuristica de area de superficie (SAH), escolhendo o irmao que minimiza o
  custo de uniao.
- **Rebalanceamento** com rotacoes tipo AVL apos cada mudanca estrutural.
- **Nos livres** sao reciclados por uma free list encadeada em `_child1`: o regime permanente nao aloca.
- **`rebuild()`** faz uma reconstrucao bottom-up: codigos de Morton de 30 bits, radix sort de 4 passes,
  e fusao de clusters por SAH numa janela simetrica de 12 vizinhos.

**Query de frustum com plane coherency.** A travessia carrega uma mascara de 6 bits com os planos que
*ainda* podem rejeitar a subarvore atual. Quando um no esta totalmente dentro de um plano, o bit desse
plano e apagado para toda a subarvore - nenhum descendente testa aquele plano de novo. Quando a mascara
chega a zero, todo o resto da subarvore e aceito sem nenhum teste. A aceitacao da folha usa o AABB
*tight*.

**Raycast** usa um heap binario com a distancia de entrada do slab, visitando os nos em ordem de
proximidade, e chama um callback por folha.

### 5.2 `TriangleBVH` (narrow phase)

Arquivo: `spatial/TriangleBVH.js`. Tambem **sem imports**. Estatica, construida com varredura SAH
binada (12 bins), com pilha explicita (uma malha de 500k triangulos nao estoura a pilha de chamadas).

```
nodeBounds[i*6 + 0..5]   minX minY minZ maxX maxY maxZ
nodeTriCount[i]          0 num no interno; tamanho da folha caso contrario
nodeLeftFirst[i]         indice do filho esquerdo (interno) OU primeiro triangulo (folha)
triIndices[]             permutacao sobre os indices/posicoes originais
```

- Filhos sao **sempre contiguos**: o direito e `left + 1`, entao um unico inteiro descreve os dois.
- Triangulos **nunca sao movidos**: `triIndices` e uma permutacao, o que mantem a construcao barata e
  dispensa remapear qualquer outro atributo.
- Construida sob demanda por `Mesh.getTriangleBVH()` e compartilhada entre o `Raycaster` e o
  `CollisionWorld` (o `StaticCollider` reusa a mesma arvore).
- Operacoes: `raycast`, `queryAABB` / `queryAABBMinMax`, `querySphere`, `closestPointOnSurface`,
  `serialize`.

---

## 6. Mapa de dependencias entre modulos

Arestas reais entre diretorios (contagem = numero de `import ... from` cruzando a fronteira). Nao ha
nenhum ciclo entre diretorios.

```
  CAMADA 0 - folhas, zero imports
  +-------------------+  +-------------------+  +-----------------------------+
  | math/             |  | spatial/          |  | util/                       |
  | Vec, Quat, Mat,   |  | DynamicBVH        |  | Stats, TypedArrayUtils      |
  | AABB, Sphere, Ray |  | TriangleBVH       |  +-----------------------------+
  | Plane, Frustum,   |  |                   |  | core/ Logger EventBus       |
  | Color, MathUtils  |  | (duck typing puro)|  |       Time Pool             |
  +-------------------+  +-------------------+  +-----------------------------+
            ^                     ^                        ^
            |                     |                        |
  CAMADA 1 -+---------------------+------------------------+
  +----------------------+   +----------------------+   +--------------------+
  | input/       -> math |   | physics/     -> math |   | animation/  -> math|
  | Input, Orbit,        |   | Raycaster, Collision |   | Track, Clip,       |
  | FirstPerson          |   | Character, RigidBody |   | Action, Mixer      |
  +----------------------+   |              -> spatial|  |             -> core|
                             |              -> core   |  +--------------------+
                             +----------------------+

  CAMADA 2 - camada GL
  +--------------------------------------------------------------------------+
  | render/            -> math (15)  -> core/Logger (7)  -> util (1)         |
  |   GLContext, StateCache, Buffer, VertexArray, Geometry, Texture,          |
  |   RenderTarget, ShaderPreprocessor, Program, ShaderLib, Material,         |
  |   UniformBuffers, RenderList, ShadowMapper, ClusteredLighting,            |
  |   LightManager, PostProcessing, IBL, DebugRenderer, Renderer             |
  |                                                                          |
  |   render/chunks/    (16 chunks GLSL, folhas)                             |
  |   render/shaders/   (9 modulos de programa, folhas)                      |
  |   render/materials/ -> math (8)  -> render (4)                           |
  +--------------------------------------------------------------------------+
        ^  ^                                          |
        |  |                          Renderer -> geometry/Primitives (skybox)
        |  |                          Renderer -> render/chunks, render/shaders
        |  |
  CAMADA 3
  +-------------------------------+     +-----------------------------------+
  | scene/     -> math (26)       |     | geometry/   -> math (2)           |
  |            -> spatial (2)     |     |             -> render (3)         |
  |            -> render (1)      |     | Primitives, GeometryUtils,        |
  |  (Skeleton usa createDataTexture)|  | ProceduralTexture                 |
  +-------------------------------+     +-----------------------------------+
        ^                                          ^
        |                                          |
  CAMADA 4
  +--------------------------------------------------------------------------+
  | loaders/  -> scene (9)  -> math (5)  -> core (4)  -> render (3)          |
  |           -> render/materials (3)  -> geometry (2)  -> animation (2)     |
  +--------------------------------------------------------------------------+
  | audio/    -> scene (1)   (AudioSource e um Node3D)                       |
  +--------------------------------------------------------------------------+

  CAMADA 5 - fachada
  +--------------------------------------------------------------------------+
  | core/Engine.js  -> render (Renderer, GLContext)                          |
  |                 -> scene (Scene, PerspectiveCamera)                      |
  |                 -> input (Input)   -> util (Stats)   -> core (bus, time)  |
  +--------------------------------------------------------------------------+
  | src/index.js    barrel: reexporta tudo, sem nenhum efeito colateral       |
  +--------------------------------------------------------------------------+
```

Regras que o `tools/check-imports.mjs` garante em todo commit:

1. Todo arquivo alvo existe no disco.
2. Todo binding nomeado importado existe de fato como export nomeado (seguindo cadeias de `export * from`).
3. **Nenhum** `import` ou `export` default em lugar nenhum.
4. Toda especificacao relativa termina em `.js` explicito (o navegador carrega o codigo cru).
5. Nenhuma dependencia de terceiros (apenas builtins `node:` dentro de `tools/`).

Observacoes de design que valem a pena:

- `math/` e `spatial/` sao **totalmente independentes**. As BVHs usam duck typing (`.min.x`, `.normal.x`)
  em vez de importar as classes, o que as torna utilizaveis em workers e em testes puros.
- `render/Program.js` duplica de proposito a tabela de attribute locations de `render/Geometry.js`, para
  que a camada de shader nao tenha dependencia de import na camada de geometria.
- `core/Engine.js` e o unico ponto que amarra render + scene + input; todo o resto de `core/` e folha.

---

## 7. Como estender

### 7.1 Material customizado

Duas rotas. A rapida usa `ShaderMaterial`; a estruturada registra o shader na `ShaderLib` e estende
`Material`.

**Rota A - `ShaderMaterial`** (bom para efeitos pontuais)

```js
import { ShaderMaterial, Mesh, createPlane } from '../src/index.js';

const water = new ShaderMaterial({
  name: 'Water',
  vertexShader: `#version 300 es
#include <common>
#include <camera_ubo>
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;
uniform mat4 uModelMatrix;
uniform float uTime;
out vec2 vUV0;
void main() {
  vUV0 = aUV0;
  vec3 p = aPosition;
  p.y += sin(p.x * 4.0 + uTime) * 0.05;
  gl_Position = uViewProj * uModelMatrix * vec4(p, 1.0);
}
`,
  fragmentShader: `#version 300 es
#include <common>
in vec2 vUV0;
uniform vec3 uTint;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(uTint * vec3(vUV0, 1.0), 1.0); }
`,
  uniforms: { uTime: 0, uTint: new Float32Array([0.2, 0.5, 0.9]) }
});

const geometry = createPlane(20, 20, 64, 64);

// OBRIGATORIO antes do primeiro frame: o Renderer descarta objetos cujo
// shaderName ainda nao esta na ShaderLib, e o ShaderMaterial so se registra
// dentro de getProgram(). Uma chamada resolve.
water.getProgram(engine.renderer.shaderLib, water.getDefines(geometry, null));

scene.add(new Mesh(geometry, water));
engine.onUpdate(() => water.setUniform('uTime', engine.time.elapsed));
```

**Rota B - shader registrado + subclasse de `Material`** (bom para um material reutilizavel)

```js
import { Material, Mesh, Color, createSphere } from '../src/index.js';

const TOON_VERTEX = `#version 300 es
#include <common>
#include <camera_ubo>
#include <instancing>

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;

uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;

out vec3 vNormal;

void main() {
  vec4 worldPosition = getModelMatrix(uModelMatrix) * vec4(aPosition, 1.0);
  vNormal = normalize(uNormalMatrix * aNormal);
  gl_Position = uViewProj * worldPosition;
}
`;

const TOON_FRAGMENT = `#version 300 es
#include <common>
#include <camera_ubo>
#include <lights_ubo>

in vec3 vNormal;
uniform vec3 uToonColor;
uniform float uSteps;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 L = normalize(uDirLightDir[0].xyz);      // ja aponta PARA a luz
  float ndl = max(dot(normalize(vNormal), L), 0.0);
  float banded = floor(ndl * uSteps) / uSteps;
  outColor = vec4(uToonColor * (0.2 + 0.8 * banded), 1.0);
}
`;

engine.renderer.shaderLib.register('toon', { vertex: TOON_VERTEX, fragment: TOON_FRAGMENT });

class ToonMaterial extends Material {
  constructor(options = {}) {
    super(Object.assign({ shaderName: 'toon' }, options));
    this.color = new Color(options.color !== undefined ? options.color : 0xffcc33);
    this.steps = options.steps !== undefined ? options.steps : 4;
    this._color = new Float32Array(3);          // alocado uma vez, nunca por frame
    this._ready = true;                         // libera o sync (ver nota abaixo)
    this.needsUpdate = true;
  }

  // O renderer le `uniforms` a cada troca de material; sincronize aqui.
  get uniforms() { return this.syncUniforms(); }
  set uniforms(value) { this._uniforms = value || {}; }

  syncUniforms() {
    // O construtor de Material ja escreve em `this.uniforms`, e nesse instante os
    // campos abaixo ainda nao existem: o guarda impede um sync prematuro.
    if (this._ready !== true) return this._uniforms;
    this._color[0] = this.color.r;
    this._color[1] = this.color.g;
    this._color[2] = this.color.b;
    this._uniforms.uToonColor = this._color;
    this._uniforms.uSteps = this.steps;
    return this._uniforms;
  }

  // Defines que dependem so deste material. Mudar `steps` exige needsUpdate = true.
  applyOwnDefines(defines, geometry, renderContext) {
    defines.TOON_STEPS = this.steps;
  }
}

scene.add(new Mesh(createSphere(0.7, 24, 12), new ToonMaterial({ color: 0x66ddff, steps: 3 })));
```

Checklist de um shader que se comporta bem na engine:

- Comece com `#version 300 es` e **nao** declare precisao (o preprocessador injeta).
- Use os chunks: `common`, `camera_ubo`, `lights_ubo`, `brdf`, `lighting`, `shadow`, `cluster`,
  `skinning`, `instancing`, `fog`, `tonemap`, `normal_mapping`, `ibl`, `noise`, `depth`.
- Respeite as locations e as unidades de textura das tabelas da secao 2.
- Passe pelos helpers `getModelMatrix(uModelMatrix)` (instancing) e `applySkinning(...)` (skinning)
  se quiser que as permutacoes `USE_INSTANCING` / `USE_SKINNING` funcionem de graca.
- Escreva em espaco **linear** na saida 0. So aplique tonemap sob `#ifdef USE_TONEMAP`.
- Rode `node tools/check-glsl.mjs` - ele pega chave desbalanceada, include inexistente, varying sem par
  e sintaxe GLSL 1.00 antes de qualquer GPU ver o codigo.

### 7.2 Adicionar um passe de pos-processamento

A cadeia de `PostProcessing` e fixa. Ha duas formas honestas de encaixar um passe proprio.

**Rota A - estender `PostProcessing`** (o passe entra no fluxo normal do renderer)

```js
import { PostProcessing, RenderTarget } from '../src/index.js';

class PostComMeuPasse extends PostProcessing {
  render(inputRT, outputFBO = null) {
    // Alvo intermediario proprio, redimensionado junto com a cadeia.
    if (this._mine === null || this._mine === undefined ||
        this._mine.width !== this.width || this._mine.height !== this.height) {
      if (this._mine) this._mine.dispose(this.state);
      this._mine = new RenderTarget(this.gl, this.width, this.height, {
        colorAttachments: 1, colorFormat: 'rgba8', depth: false,
        state: this.state, name: 'meupasse'
      });
    }

    // A cadeia padrao escreve no MEU alvo em vez de escrever na tela.
    super.render(inputRT, this._mine);

    // Agora o meu passe: alvo -> destino real.
    const program = this.shaderLib.get('meu_passe', null);   // registrado antes
    if (program !== null && program.use(this.state)) {
      this._bindOutput(outputFBO);
      program.setTexture('uSource', this._mine.textures[0], 0, this.state);
      program.setUniform('uAmount', 0.5);
      this._quadVAO.bind(this.state);
      this._draw();                     // desenha o triangulo full screen
    }
    return this;
  }
}

const renderer = engine.renderer;
renderer.shaderLib.register('meu_passe', { vertex: MEU_VERT, fragment: MEU_FRAG });
renderer.post.dispose();
renderer.post = new PostComMeuPasse(engine.gl, renderer, { toneMapping: 'aces', exposure: 1 });
renderer.post.resize(renderer.drawingBufferWidth, renderer.drawingBufferHeight);
```

O fragment do passe recebe o triangulo full screen do `PostProcessing` (`_quadVAO` + `_draw()` fazem
`drawArrays(TRIANGLES, 0, 3)`); escreva um shader com `layout(location = 0) out vec4 outColor` e um
`uniform sampler2D uSource`.

**Rota B - pipeline manual** (controle total, fora do `Renderer`)

```js
const rt = new RenderTarget(engine.gl, w, h, { colorAttachments: 1, colorFormat: 'rgba16f', depth: true });

engine.onUpdate(() => {
  engine.renderer.renderToTarget(scene, camera, rt);   // roda a cena, PULA o post
  // ... seus passes full screen lendo rt.textures[0], terminando no framebuffer 0
});
```

Ativar/desativar efeitos ja existentes nao exige nada disso: `post.setBloom`, `post.setSSAO`,
`post.setFXAA`, `post.setVignette`, `post.setChromaticAberration`, `post.setGrain`,
`post.setToneMapping`, `post.setExposure`, `post.setBloomAdvanced`.

### 7.3 Adicionar um loader

`AssetManager` e um registro de tipos: `registerType(type, handler)` onde
`handler(resolvedURL, options, manager)` devolve (ou promete) o asset. O cache, a contagem de
referencia, o coalescing de requisicoes concorrentes, o progresso em bytes e o `dispose` sao do gerente.

```js
import { AssetManager, fetchText, fetchBytes } from '../src/index.js';

const assets = new AssetManager(engine.gl, { basePath: './assets/' });

// Um formato de texto simples.
assets.registerType('csv', async (url, options) => {
  const text = await fetchText(url, options);
  return text.trim().split('\n').map((linha) => linha.split(','));
});

// Um formato binario proprio, com dispose para o gerente saber liberar.
assets.registerType('vox', async (url, options) => {
  const bytes = await fetchBytes(url, options);     // options traz onBytes p/ progresso
  const geometry = parseVox(bytes);                 // sua funcao
  return { geometry, dispose() { geometry.dispose(); } };
});

assets.onProgress((url, type, phase) => console.log(phase, type, url));

const grid  = await assets.load('mapa.csv');          // tipo deduzido da extensao
const model = await assets.load('nave.vox', 'vox');   // ou forcado
assets.unload('mapa.csv');                            // decrementa o refcount
```

Detalhes que importam:

- `guessAssetType(url)` deduz o tipo pela extensao; passar `type` explicitamente ignora a deducao.
- Retornar um objeto com `dispose()` faz `AssetManager.unload()` / `dispose()` liberarem os recursos.
- As `options` recebidas pelo handler ja carregam um hook `onBytes(loaded, total)` que alimenta
  `assets.stats.bytesLoaded` / `bytesTotal` - repasse-as para `fetchBytes` / `fetchText` e o progresso
  agregado funciona sozinho.
- Chamadas concorrentes para a mesma URL compartilham a mesma promise; o handler roda **uma** vez.
- Para escrever um loader de malha "de verdade", use `GLTFLoader.js` como referencia: ele mostra o
  padrao de construir `Geometry` com `setAttribute` / `setInterleaved` / `setIndex`, montar
  `StandardMaterial`, criar `Skeleton` + `SkinnedMesh` e devolver clips de `AnimationClip`.

### 7.4 Substituir um subsistema inteiro

`Renderer` acessa `shadowMapper`, `clustered`, `post`, `lightManager` e `ibl` por duck typing e trata
`null` como "passe desligado". Da para trocar qualquer um em runtime:

```js
renderer.shadowMapper = null;                 // desliga sombras neste frame em diante
renderer.shadowsEnabled = false;

renderer.lightManager = meuGerenteDeLuzes;    // precisa de collect(scene, camera) +
                                              // .dirLights e .punctualLights como arrays
```

O contrato minimo de cada um esta documentado no topo do arquivo correspondente em `src/render/`.
