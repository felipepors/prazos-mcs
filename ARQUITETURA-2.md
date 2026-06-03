# Monitor DJEN — Arquitetura do Sistema

> Sistema de captação de oportunidades oncológicas no DJEN para o escritório **Martins, Corrêa da Silva Advogados** (Felipe Müller Corrêa da Silva, OAB/RS 82.728 — Direito à Saúde).

**Última atualização:** 02/06/2026 — v12 (App.jsx v9: badge de tribunal no card de Prazo [derivado do CNJ] + data de entrada no processo + tipo "Acompanhar" pré-selecionado; correção: estado do MCS Prazos sincroniza via `estado_usuario`)

---

> **📌 Manutenção deste documento:**
> Atualize as seções correspondentes sempre que houver mudança estrutural do sistema (novo componente, nova tabela/coluna, nova versão de arquivo, nova flag/comando, nova convenção). Não registre status temporal aqui — isso vai em `ESTADO_ATUAL.md`. Sempre atualize a data e versão no topo.

---

## Visão geral

```
┌────────────────────────────────────────────────────────────────┐
│  DJEN (Diário de Justiça Eletrônico Nacional)                   │
│  API pública: https://comunicaapi.pje.jus.br/api/v1/comunicacao │
└────────────────────────────────────────────────────────────────┘
            ↓ (1ª passada: gatilhos oncológicos × 18 tribunais)
            ↓ (2ª passada: processos sob acompanhamento)
┌────────────────────────────────────────────────────────────────┐
│  monitor_djen.py  (Python 3, rodando no Mac do Felipe)          │
│  - Captura, filtra, classifica P1/P2/P9                          │
│  - Salva em historico.db (SQLite local)                          │
│  - Envia e-mail HTML com novidades                               │
│  - Backup automático no Google Drive                             │
└────────────────────────────────────────────────────────────────┘
            ↓                                       ↓
┌─────────────────────────┐         ┌──────────────────────────────┐
│  dashboard.html         │         │  Supabase                    │
│  (single-file local)    │←───────→│  - publicacoes_djen          │
│  - Filtros + status     │   sync  │  - estado_usuario            │
│  - Estados (descarte/   │         │  - movimentacoes_djen        │
│    adiar/enviar) exclu- │         │  RLS por user_id (auth.users)│
│    sivos no localStorage│         └──────────────────────────────┘
│  - "Enviar p/ MCS" +    │                       ↕ (realtime)
│    acompanhar           │         ┌──────────────────────────────┐
└─────────────────────────┘         │  MCS Prazos (Vite+React)     │
                                    │  prazos-mcs.vercel.app        │
                                    │  - Aba Prazos / Aba DJEN     │
                                    │  - Toggle "Acompanhar"       │
                                    │  - Adicionar processo manual │
                                    └──────────────────────────────┘
```

---

## Componentes — detalhe técnico

### 1. Monitor (`monitor_djen.py`)

**Localização:** `~/Desktop/DJEN/monitor_djen.py` no Mac do Felipe.
**Versão atual:** v12 — ~67.250 bytes, ~1.475 linhas.
**Linguagem:** Python 3.14 (instalado via Python.org Framework).

**Função:**
- **18 tribunais monitorados** (configurável via `DJEN_TRIBUNAIS` no `.env`): TJSP, TJRJ, TJMG, TJPR, TJSC, TJBA, TJPE, TJGO, TJDFT, TJCE, TJMA, TJPB, TJRN, TJMT, TJMS, TJPA, TJAM, TJPI
- **32 termos de busca** (configurável via `DJEN_TERMOS` no `.env`): nome pt + nome comercial de cada medicamento. Nome em inglês removido (raramente aparece sozinho em peças brasileiras). Ver lista completa em ESTADO_ATUAL.md

> 📎 **Defaults do código vs `.env`:** os valores **ativos** são os do `.env` (18 tribunais / 32 termos — confirmado em 31/05). Os defaults *hard-coded* no `monitor_djen.py` são maiores (26 tribunais / 49 termos) e servem só de fallback caso a variável não exista no `.env`. Ao auditar pelo código, lembrar que o `.env` sobrescreve esses defaults.
- **5 gatilhos** detectados via regex no texto:
  - G1_TUTELA_DEFERIDA → prioridade 1
  - G2_INTIMACAO_CUMPRIMENTO → prioridade 2
  - G3_DESCUMPRIMENTO → prioridade 1
  - G4_ORCAMENTOS → prioridade 2 (P1 na prática — ver código)
  - G5_TUTELA_INDEFERIDA → prioridade 9 (rejeita se sozinho)
- **16 medicamentos** catalogados (lista ativa):

| Chave | Sinônimos principais |
|---|---|
| osimertinibe | osimertinib, tagrisso |
| acalabrutinibe | acalabrutinib, calquence |
| ruxolitinibe | ruxolitinib, jakavi |
| ocrelizumabe | ocrelizumab, ocrevus |
| pembrolizumabe | pembrolizumab, keytruda |
| nintedanibe | nintedanib, ofev, vargatef |
| trastuzumab_deruxtecano | trastuzumab deruxtecan, enhertu |
| abemaciclibe | abemaciclib, verzenios, verzenio |
| ribociclibe | ribociclib, kisqali |
| nivolumabe | nivolumab, opdivo, opdualag |
| ibrutinibe | ibrutinib, imbruvica |
| ustequinumabe | ustekinumab, stelara |
| daratumumabe | daratumumab, darzalex |
| brentuximabe | brentuximab, adcetris |
| rituximabe | rituximab, mabthera, truxima, rixathon |
| trastuzumabe | trastuzumab, herceptin |

- **Filtros anti-falso-positivo:**
  - Exige evidência de pedido de fornecimento (`tem_evidencia_fornecimento`)
  - Aceita apenas réus públicos: Estado, Município, Fazenda, Prefeitura, SUS, FNS (`tem_reu_publico`)
  - Exclui planos privados e particulares dessa captura
- **Dedup por processo:** mesmo despacho com vários intimados vira 1 entrada (`deduplicar_por_processo`)

> ⚠️ **Atenção ao tempo de execução:** 18 tribunais × 32 termos = 576 combinações (configuração atual via `.env`). Com pausa de 4,5s, estima-se **~45 minutos** por rodada completa.

**Duas passadas:**

1. **1ª passada** (sempre roda): para cada tribunal × cada termo, busca no DJEN, filtra por gatilho oncológico, classifica e salva.

2. **2ª passada** (se Supabase configurado e processos marcados):
   - Autentica no Supabase com email/senha (gera JWT)
   - Consulta `publicacoes_djen WHERE acompanhar=true`
   - Para cada número de processo único, busca no DJEN por `numeroProcesso`
   - **Captura TUDO** (não filtra por gatilho) — para processos já conhecidos, qualquer movimentação interessa
   - Marca campo `origem='acompanhamento'` no dict de runtime (não persistido no banco)
   - **Grava a última movimentação no Supabase** (v12): após processar as publicações novas de cada processo, faz upsert da **mais recente** em `movimentacoes_djen` (ver tabela na seção Supabase). Aditivo e tolerante a falha — não interrompe a rodada. Funções: `supabase_login`, `_user_id_do_token`, `upsert_movimentacao_supabase`

**Persistência:**
- SQLite local em `historico.db` (mesma pasta)
- Dedup por `id_djen` (ON CONFLICT DO UPDATE)
- 3 índices: `idx_pub_prio`, `idx_pub_data`, `idx_pub_proc`
- Tabela `execucoes` registra cada rodada (início, fim, contagens)

**Backup:**
- Cria cópia em `~/Google Drive/Meu Drive/Backups DJEN/historico_YYYYMMDD_HHMMSS.db`
- Mantém 30 versões mais recentes (rotação automática)
- Configurável via `DJEN_BACKUP_ENABLED=true/false`

**Notificações:**
- E-mail HTML via SMTP Gmail
- 2 seções: 🆕 Oncológicas + 🔔 Processos acompanhados
- Subject inteligente: `[DJEN] N oncológicas + M em acompanhados (DATA)`
- Slack/Telegram opcionais (desligados por padrão)

**Rate limit handling:**
- HTTP 429: backoff exponencial com base `BACKOFF_INICIAL=10s` (10, 20, 40, 80, 160, 320s)
- Respeita header `Retry-After` quando presente
- Combinações que esgotam tentativas por 429 são reenfileiradas e reprocessadas após `RETRY_FALHAS_ESPERA=60s`

**Comandos (flags):**

```bash
cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje

cd ~/Desktop/DJEN && python3 monitor_djen.py --desde 2026-05-22 --ate 2026-05-22

cd ~/Desktop/DJEN && python3 monitor_djen.py --dias 3

cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje --dry-run

cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje --so-acompanhados

cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje --sem-email --sem-slack --sem-telegram
```

> A flag `--so-acompanhados` (apelido `--mcs`) pula a 1ª passada (oncológicas) e roda **só** a busca por `numeroProcesso` dos processos com `acompanhar=true`. É aditiva: envolve a 1ª passada num `if not args.so_acompanhados:`, sem alterar a lógica da rodada completa. Combina com qualquer janela de datas. Útil para checar movimentações de processos acompanhados em segundos, sem esperar os ~45min da varredura completa.

---

### 2. Dashboard local (`dashboard.html`)

**Localização:** `~/Desktop/DJEN/dashboard.html`
**Versão atual:** v17 — ~133.820 bytes.
**Tipo:** Single-file HTML+CSS+JS. Abre direto no navegador (Chrome recomendado) via duplo-clique no Finder. Sem servidor.

**Estética:** editorial — tipografia Fraunces (display) + IBM Plex Sans/Mono, paleta papel/tinta quente (creme/quase-preto) com acento verde-oliva (`--accent #5c6b3a`), bordeaux para P1 (`--hot`), mostarda para P2 (`--warm`), cinza para P9 (`--cold`). Título no masthead: "Monitor DJEN" (sobrescrito com nome do escritório).

**Funcionamento:**
- Usuário seleciona `historico.db` manualmente (File API do browser)
- Carrega via `sql.js` (WebAssembly do SQLite no cliente)
- Renderiza interface editorial

**Funcionalidades:**
- **Navegação de abas** (v17): **Publicações** (a view original — cards, gráficos, tabela) e **Acompanhados**.
- **Aba Acompanhados** (v17): lista os processos com `acompanhar=true` lidos do **Supabase** (`SELECT numero_processo, tribunal, id_djen ... WHERE acompanhar=true`, dedup por número). Para cada processo, cruza por número **normalizado** (`replace(/\D/g,'')` — ignora máscara CNJ) com as linhas do `historico.db` local e lista as movimentações (dedup por data+início-do-texto, pois a 2ª passada grava 1 linha por intimado). **Sinaliza movimentação nova** comparando `primeira_vista` de cada movimentação com um carimbo por processo em `localStorage` (`djen.acompanhados.lastseen.v1`): badge pulsante no card + contador na aba. Abrir o card grava o carimbo (marca visto) e zera o sinal. "ver decisão" reusa `openModal`. Desconectado → portão "Conecte ao MCS". Botão "↻ Atualizar" refaz a leitura no Supabase.
- **Filtros:** busca textual, tribunal, prioridade, gatilho, **status** (Novos/Enviados ao MCS/Adiados/Descartados), data inicial/final, "mostrar descartadas"
- **Cards de resumo:** Total no banco, Últimos 7 dias, Alta prioridade (P1, com filete bordeaux), Processos únicos
- **Gráficos** (Chart.js): barras por tribunal, barras por gatilho (usam o banco inteiro, não os filtros)
- **Tabela paginada** (25/página) com sort em colunas e **faixa lateral colorida por prioridade** (P1 bordeaux / P2 mostarda / P9 cinza, via atributo `data-prio` na linha)
- **Modal de detalhes:** texto completo com destaques coloridos por gatilho, link para autos/tribunal, detecção de processo de origem, ações (Descartar, Copiar nº, Enviar para MCS, Acompanhar)

**Estados locais da publicação (descarte / enviado ao MCS / adiado):**

O dashboard NÃO escreve no SQLite (arquivo binário selecionado pelo usuário). As decisões do usuário vivem em **localStorage** e são reaplicadas ao recarregar o banco.

- **3 chaves de estado:** `djen.discarded.v1`, `djen.enviados_mcs.v1`, `djen.adiados.v1` (+ `djen.acompanhados.lastseen.v1`, carimbo "última vez visto" por processo, usado só pela aba Acompanhados — fora da camada genérica de estados exclusivos)
- **Camada genérica** (`STATUS_KEYS` + `_loadMapa` / `_salvarMapa` / `_limparOutrosEstados`): um único núcleo lê/grava os três mapas. Antes eram três trios de funções quase idênticos.
- **Exclusividade mútua:** cada transição (`descartarPublicacao`, `adiarPublicacao`, `salvarEnviadoMCS`) chama `_limparOutrosEstados(id, ...)` removendo o id dos outros mapas. Uma publicação fica em **no máximo um** estado por vez ("última ação vence").
- **Derivação única ao carregar:** `aplicarEstadosAoCarregar()` define `status_comercial` de todas as linhas a partir dos mapas, com precedência **DESCARTADO > ENVIADO_MCS > ADIADO** (a precedência só desempata dados legados — id em mais de um mapa de versões antigas). É chamada no load do banco e no fim do import.
- **Descarte de 1 clique:** o botão "Descartar" no modal descarta direto (sem caixa de confirmação, sem campo de motivo); toast "Publicação descartada · ↺ Desfazer" (6s) restaura. *Consequência:* desfazer o descarte de um item que estava "enviado ao MCS" o devolve como NOVO (a exclusividade mútua removeu o marcador de enviado).
- **Adiar:** botão "Adiar"/"↺ Retomar" em cada linha (estado temporário; linha âmbar).
- **Processo de origem:** `extrairProcessoOrigem` lê o texto e, em publicações de recurso, identifica o nº de 1º grau → badge "recurso" na lista + bloco no modal.

**Toast (`mcsShowToast`):** cancela o timer pendente antes de exibir um novo e força reflow para re-disparar a animação (evita que um toast apague o seguinte); aceita botão de ação opcional (usado no "Desfazer").

**Integração MCS Prazos:**
- Barra superior editorial (faixa creme, texto de alto contraste; "abrir MCS" botão cheio oliva; "Conectar/Sair" botão contornado) com status de conexão (ponto oliva = conectado)
- Login via modal Supabase (Esc + clique fora para fechar); logout com modal de confirmação
- Botão **"Enviar para MCS"** faz upsert em `publicacoes_djen` **já com `acompanhar=true`** (entra direto na 2ª passada do monitor)
- Botão **Acompanhar/Desmarcar** no modal: `mcsSetAcompanhar` (UPDATE `acompanhar` no Supabase, filtrando por `user_id`+`id_djen`); ao reabrir um item já enviado, `mcsGetAcompanhar` lê o estado real (com trava para não sobrescrever um clique do usuário durante a leitura)

**Export/Import de status:**
- **Export/Import unificado** (versao 2) — `djen-status_DATA.json` cobre os 3 estados (descartes + enviados MCS + adiados); retrocompatível com versao 1 (só descartes). No import, os status são derivados via `aplicarEstadosAoCarregar()` (mesma precedência do load).

> 💡 Como os estados vivem no localStorage, exportar de vez em quando evita perda ao limpar o navegador.

---

### 3. Supabase (banco de dados em nuvem)

**Projeto:** `frprebgyfnbeetuwmrzd` (MCS-Prazos)
**Região:** sa-east-1 (São Paulo)
**URL:** `https://frprebgyfnbeetuwmrzd.supabase.co`
**Chave publishable:** `sb_publishable_e1Xx9UGhvma2O0LxN0csYw_yM40XJoA`
- Pública por design — pode ficar em código frontend
- RLS protege os dados (sem autenticação não acessa)

#### Tabela `publicacoes_djen`

Schema completo:

```sql
id                 uuid PRIMARY KEY DEFAULT gen_random_uuid()
user_id            uuid NOT NULL REFERENCES auth.users(id)
id_djen            text NOT NULL              -- ID original da publicação no DJEN
                                              -- processos manuais: 'manual_<timestamp>'
numero_processo    text
tribunal           text
data_publicacao    date
prioridade         integer
gatilhos           text                       -- string serializada "G1; G3"
medicamentos       text                       -- string serializada "pembrolizumab; nivolumab"
texto_publicacao   text                       -- texto completo da publicação
status             text DEFAULT 'NOVO'
                   CHECK status IN ('NOVO','EM_ANALISE','CONTATADO','PROMOVIDO','DESCARTADO')
observacao         text
cliente_id         text                       -- usado quando virar Prazo
prazo_id           text                       -- usado quando virar Prazo
enviado_em         timestamptz DEFAULT now()
atualizado_em      timestamptz DEFAULT now()
acompanhar         boolean DEFAULT false      -- marca para 2ª passada do monitor
```

**Índices:**
- `idx_djen_user_acompanhar` (parcial) em `(user_id, numero_processo) WHERE acompanhar=true`

**RLS:** habilitado, 4 policies (SELECT/INSERT/UPDATE/DELETE) com `auth.uid() = user_id`

**Pontos de escrita da coluna `acompanhar`:** dois clientes escrevem nessa coluna —
1. **App.jsx** (MCS Prazos): toggle "Acompanhar este processo no DJEN" no modal.
2. **dashboard.html**: o envio ao MCS grava `acompanhar=true`; o botão Acompanhar/Desmarcar no modal faz UPDATE.

**Leitura de `acompanhar`:** além do monitor (2ª passada), o **dashboard (aba Acompanhados, v17)** lê `WHERE acompanhar=true` para montar a lista de processos seguidos.

> Descartar uma publicação no dashboard NÃO desmarca `acompanhar` no Supabase — são sistemas independentes (estado local vs. nuvem).

#### Tabela `estado_usuario`

```sql
user_id         uuid PRIMARY KEY REFERENCES auth.users(id)
dados           jsonb DEFAULT '{}'
atualizado_em   timestamptz DEFAULT now()
```

Guarda **todo o estado do MCS Prazos por usuário** num único blob JSON — não só preferências de UI. As chaves persistidas incluem `prazos`, `tarefas`, `clientes`, `tiposCustom`, `feriados`, `feriadosNomes`, `modo`, `email`, `ultimoBackup` (lista em `App.jsx`, função `_hidratarDoServidor`). É o que faz a aba Prazos **sincronizar entre dispositivos**.

**Mecânica (App.jsx):** o hook `useStorage` escreve em `localStorage` (offline) **e** num objeto `_estado` em memória; quando há sessão logada, `_scheduleFlush()` faz `upsert` de `_estado` inteiro em `estado_usuario.dados` (debounce 2s). Na entrada, `_hidratarDoServidor()` lê a linha e popula localStorage; um canal **realtime** em `estado_usuario` propaga mudanças de outros dispositivos. Sem login → fica só em localStorage (fallback). Consequência: qualquer campo novo dentro do objeto do prazo (ex.: `orcamentoEnviado`, `dataEntrada`) sincroniza automaticamente, sem schema novo.

> ⚠️ Modelo "blob único, última escrita vence": edições simultâneas no mesmo `dados` em dois dispositivos podem se sobrescrever. Na prática (1 usuário, raramente em paralelo) não é problema; registrar caso vire dor.

**RLS:** habilitado, 3 policies.

---

#### Tabela `movimentacoes_djen`

Gestão de carteira: **uma linha por processo acompanhado**, sempre com a última movimentação. Gravada pelo monitor (v12+) via upsert ao final da 2ª passada; lida/editada pelo Claude via MCP (Project de controle de carteira).

```sql
user_id                   uuid REFERENCES auth.users(id)
numero_processo           text
tribunal                  text
orgao                     text        -- vara/órgão julgador (campo nomeOrgao do DJEN)
comarca                   text        -- do DJEN quando vier no órgão; senão preenchido pelo Felipe
ultima_movimentacao       text        -- texto da publicação mais recente
data_ultima_movimentacao  date
juiz                      text        -- preenchido pelo Felipe (opcional)
fase                      text        -- preenchido pelo Felipe
observacao                text        -- preenchido pelo Felipe
atualizado_em             timestamptz DEFAULT now()
PRIMARY KEY (user_id, numero_processo)
```

**Origem dos campos:** `tribunal`, `orgao`, `ultima_movimentacao`, `data_ultima_movimentacao` vêm do DJEN (gravados pelo monitor). `comarca` (fallback), `juiz`, `fase`, `observacao` são preenchidos pelo Felipe.

**Upsert do monitor (preservação):** o monitor faz `POST .../movimentacoes_djen?on_conflict=user_id,numero_processo` com `Prefer: resolution=merge-duplicates`, enviando **só os campos do DJEN** (+ `user_id` do JWT). No conflito, o `DO UPDATE` toca apenas as colunas enviadas — portanto `juiz`/`fase`/`observacao` **nunca são sobrescritos**. A PK composta garante 1 linha por processo (sobrescreve, não empilha).

**RLS:** habilitado, 4 policies (SELECT/INSERT/UPDATE/DELETE) com `auth.uid() = user_id`.

---

### 4. SQLite local (`historico.db`)

Schema em `~/Desktop/DJEN/historico.db`:

```sql
CREATE TABLE publicacoes_vistas (
    id_djen           TEXT PRIMARY KEY,
    numero_processo   TEXT,
    tribunal          TEXT,
    data_pub          TEXT,          -- YYYY-MM-DD, pode vir com hora
    prioridade        INTEGER,
    medicamentos      TEXT,          -- "; "-separados
    gatilhos          TEXT,          -- "; "-separados (nomes G1/G2/...)
    primeira_vista    TEXT NOT NULL, -- ISO 8601 da primeira captura
    ultima_vista      TEXT NOT NULL, -- ISO 8601 da última captura (atualiza)
    status_comercial  TEXT DEFAULT 'NOVO',  -- não usado atualmente
    observacao        TEXT,
    texto             TEXT           -- texto completo da publicação
);

CREATE TABLE execucoes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inicio          TEXT NOT NULL,
    fim             TEXT,
    janela_ini      TEXT,
    janela_fim      TEXT,
    brutos          INTEGER,
    relevantes      INTEGER,
    novos           INTEGER,
    sucesso         INTEGER,
    erro            TEXT
);

CREATE INDEX idx_pub_prio ON publicacoes_vistas(prioridade);
CREATE INDEX idx_pub_data ON publicacoes_vistas(data_pub);
CREATE INDEX idx_pub_proc ON publicacoes_vistas(numero_processo);
```

**Observações importantes:**
- O nome da coluna é `data_pub` (não `data_publicacao` como no Supabase). São schemas independentes.
- Não há coluna `origem` no SQLite — o campo `origem` que o monitor seta no dict de runtime é ignorado no INSERT (não causa erro, apenas não é persistido).
- `status_comercial` existe no SQLite mas **não é usada** — o workflow de estados do dashboard vive no localStorage do navegador (ver seção 2), e o workflow comercial vive no Supabase (via MCS).

---

### 5. MCS Prazos (`App.jsx`)

**URL pública:** https://prazos-mcs.vercel.app
**Stack:** Vite + React + `@supabase/supabase-js`
**Hospedagem:** Vercel (auto-deploy a cada push para `main`)
**Repositório:** https://github.com/felipepors/prazos-mcs (público)
**Localização local:** `~/Desktop/prazos-mcs/`
**Versão atual:** v9 — ~3.042 linhas (`App v9: badge de tribunal no card de Prazo [derivado do CNJ], data de entrada no processo, tipo "Acompanhar" pré-selecionado; v8: marcador "Orçamento enviado"; v7: exclusão DJEN com prazos vinculados`)

**Abas:**
- **Prazos** (original): gestão de prazos processuais com cliente, processo, datas
- **DJEN**: workflow comercial das publicações capturadas

**Navegação cruzada Prazos↔DJEN (v6):**
- **DJEN → Prazos:** "Promover a Prazo →" no modal preenche o formulário de novo prazo na aba Prazos; cards do DJEN também têm link para ver na aba Prazos.
- **Prazos → DJEN (v6):** o número do processo em cada card de Prazos é clicável (sublinhado pontilhado) e abre a aba DJEN buscando aquele processo, limpando os filtros de status/tribunal/prioridade para garantir que o card apareça. Implementação: estado `processoAlvoDjen` no App (lifted), prop `processoAlvo` + callback `onProcessoAlvoConsumido` no `PainelDJEN`, aplicado via `useEffect` que seta a busca e zera o alvo (suporta cliques repetidos no mesmo processo). Processo fora da carteira DJEN → busca vazia (esperado, não é bug).
- **Exclusão DJEN → Prazos (v7):** apagar uma publicação no DJEN casa o número com os prazos da aba Prazos (`soDig` = só dígitos, neutraliza máscara CNJ; helper `prazosDoProcesso`) e oferece apagar também os prazos vinculados — sempre por escolha explícita, nunca em cascata silenciosa. Direção única: apagar um prazo **não** remove o acompanhamento no DJEN. Detalhe no item "Aba DJEN — componentes / Botão Apagar".

**Aba DJEN — componentes:**
- Hook `usePublicacoesDjen()` — gerencia state e CRUD via Supabase
  - `items` — lista de publicações
  - `atualizarStatus(id, novoStatus, observacao)`
  - `atualizarAcompanhar(id, valor)`
  - `atualizarObservacao(id, observacao)` — UPDATE só da coluna `observacao` (não toca status nem acompanhar); usado pela edição de observação no modal (v5)
  - `adicionarProcessoManual(numero, tribunal, observacao)` — insere com `id_djen='manual_<timestamp>'` e `acompanhar=true`
  - `remover(id)`
- Lista de cards com filtros por status (NOVO / EM_ANALISE / CONTATADO / PROMOVIDO / DESCARTADO)
- Badge `🔔 ACOMP` (cor #5c6b3a) ao lado do número quando `acompanhar=true`
- Badge `✏️ MANUAL` nos cards de processos adicionados manualmente
- Botão **"＋ Adicionar processo"** na barra de filtros — abre modal com:
  - Campo número (máscara CNJ automática)
  - Campo tribunal (opcional)
  - Campo observação
- Modal de detalhes ao clicar em "Detalhes":
  - Texto completo, partes, advogados
  - **Observação editável** (v5): seção com `textarea` + botão "Salvar" (ativo só quando o texto muda) + toast "Observação salva". Grava na coluna `observacao` via `atualizarObservacao`. Substituiu o campo OBS. que era só leitura no grid de metadados.
  - Card "Acompanhar este processo no DJEN" (acima do Workflow)
  - Seção Workflow (botões de transição de status)
  - Botão "Promover a Prazo →" preenche formulário automático na aba Prazos
  - **Botão "Apagar" (v7):** casa o número do processo com os prazos da aba Prazos (`soDig` = só dígitos, ignora máscara CNJ; helper `prazosDoProcesso`). Sem vínculo → confirmação simples. Com vínculo → modal lista os prazos (tipo, parte, vencimento, selo Ativo/Concluído) e oferece "apagar só a publicação" vs "apagar publicação + N prazo(s)". O `PainelDJEN` recebe a prop `prazos` (leitura) além de `setPrazos` (escrita). Estado `confirmApagar = { pub, vinculados }`. Direção única DJEN→Prazos — apagar um prazo nunca remove o acompanhamento no DJEN.

**Aba Prazos — card de prazo:**
- Cada prazo é um objeto persistido via `useStorage("mcs.prazos")`: `{ id, processo, parte, tipo, dataLimite, responsavel, concluido, obs, prioridade, orcamentoEnviado?, dataEntrada?, djenId?, djenAcompanhar?, ... }`. **Não há tabela `prazos` dedicada no Supabase**, mas a lista inteira de prazos **sincroniza entre dispositivos** dentro do blob JSON `estado_usuario.dados` (ver seção Supabase → `estado_usuario`). Offline/deslogado, fica só no localStorage.
- Checkbox de conclusão (`toggleConcluidoComRecorrencia`); número do processo clicável → DJEN (v6); toggle "Monitorar no DJEN" para prazos captados do monitor (escreve `acompanhar` no Supabase quando há vínculo).
- **Chip "Orçamento enviado" (v8):** toggle visual na linha de status do card. Contornado (verde claro) = pendente; verde-cheio `✓ Orçamento enviado` = enviado. Handler `toggleOrcamento(id)` grava a flag booleana `orcamentoEnviado` no objeto do prazo. Sincroniza entre dispositivos junto com o prazo (blob `estado_usuario`); **não tem coluna própria no Supabase** — é um campo dentro do JSON. Marca de controle comercial, independente de `concluido` e do status; não altera a ordenação por vencimento.
- **Badge de tribunal (v9):** ao lado do número do processo, pílula com a sigla do tribunal (TJBA, TJRS, TRF4, etc.). **Derivada do próprio número CNJ** pela função `tribunalDoCNJ` (lê o segmento `J` e o código `TR` das posições 14–16 do número; mapeia Justiça Estadual → TJ por UF, Federal → TRF1–6, Trabalho → TRT). Zero armazenamento; some se o número não for um CNJ válido de 20 dígitos. Funciona inclusive em prazos adicionados na mão.
- **Data de entrada no processo (v9):** chip clicável na linha de status (`📌 Data de entrada` → `📌 Entrei DD/MM/AAAA`). Abre o seletor de data nativo (`showPicker`); handler `setDataEntrada(id, valor)` grava `dataEntrada` (ISO `YYYY-MM-DD`) no objeto do prazo. Editável a qualquer momento; sincroniza pelo blob `estado_usuario` (sem coluna nova). Marca de gestão do Felipe — quando se habilitou nos autos para acompanhar.
- **Tipo "Acompanhar" (v9):** primeiro item de `TIPOS_DEFAULT` e **default pré-selecionado** no formulário de Novo Prazo, tanto no manual (`openNovo`) quanto ao promover do DJEN (`promoverPrazo`, que antes vinha "Manifestação"). Reflete que a maioria dos prazos criados é só para acompanhar o andamento; outros tipos seguem disponíveis na lista. Obs.: `dataLimite` continua obrigatória mesmo para "Acompanhar" (validação de `salvar` inalterada).

**Sincronização:** Realtime via Supabase (mudanças aparecem em todos os dispositivos conectados imediatamente).

---

## Fluxos críticos

### Fluxo 1 — Descoberta de oportunidade oncológica

```
1. Felipe roda monitor (manual, diário): cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje
2. Monitor captura publicação P1 com gatilho "G1_TUTELA_DEFERIDA" + medicamento
3. Salva em historico.db (id_djen único)
4. E-mail HTML enviado ao Felipe
5. Felipe abre dashboard.html no Chrome (duplo-clique no Finder)
6. Seleciona historico.db
7. Lê o texto da publicação no modal e decide:
   - Se NÃO interessa: "Descartar" (1 clique) → some da lista; toast com "↺ Desfazer" (rede de segurança)
   - Se SIM interessa: "Enviar para MCS" → login Supabase (1x) → INSERT em publicacoes_djen JÁ COM acompanhar=true
     (botão Acompanhar/Desmarcar no modal permite reverter)
8. No MCS Prazos (https://prazos-mcs.vercel.app), publicação aparece em "NOVO"
9. Felipe entra em contato com o paciente (via WhatsApp da banca)
10. Status muda: NOVO → CONTATADO → PROMOVIDO (vira cliente)
11. Felipe clica "Promover a Prazo →" e cria entrada formal na aba Prazos
```

### Fluxo 2 — Acompanhamento contínuo de processo

```
1. Felipe abre MCS Prazos
2. Aba DJEN → clica em "Detalhes" de uma publicação
3. Marca toggle "Acompanhar este processo no DJEN"
   (ou: o envio ao MCS pelo dashboard já marca acompanhar=true automaticamente)
4. Supabase: UPDATE publicacoes_djen SET acompanhar=true WHERE id=...
5. Card passa a mostrar badge 🔔 ACOMP

   [no dia seguinte ou em qualquer execução futura]

6. Monitor roda
7. 1ª passada: captura novas P1 oncológicas (normal)
8. 2ª passada:
   8.1. Autentica no Supabase com email/senha do .env
   8.2. Consulta: SELECT numero_processo, tribunal FROM publicacoes_djen WHERE acompanhar=true
   8.3. Dedup por numero_processo
   8.4. Para cada processo único, GET no DJEN com numeroProcesso=N (todos os tribunais ou só o cadastrado)
9. Filtra publicações novas (não vistas em historico.db nem na 1ª passada)
10. Salva em historico.db (mesma tabela, sem distinção persistida)
11. E-mail enviado com 2 seções:
    - 🆕 Oncológicas (descobertas)
    - 🔔 Movimentações em processos acompanhados (gestão)
```

### Fluxo 3 — Adicionar processo manualmente para acompanhamento

```
1. Felipe abre MCS Prazos → Aba DJEN
2. Clica "＋ Adicionar processo"
3. Preenche número CNJ (máscara automática), tribunal opcional, observação
4. Supabase: INSERT em publicacoes_djen com id_djen='manual_<timestamp>', acompanhar=true
5. Card aparece com badge ✏️ MANUAL e 🔔 ACOMP

   [próxima execução do monitor]

6. 2ª passada busca o número no DJEN e captura movimentações normalmente
```

---

## Configuração local — `~/Desktop/DJEN/.env`

Variáveis necessárias (sem valores reais aqui):

```env
# SMTP Gmail (notificações)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=felipepors@gmail.com
SMTP_PASS=<senha-de-app-do-gmail>
EMAIL_FROM=felipepors@gmail.com
EMAIL_TO=contato@correadasilvamartins.com.br

# Supabase (2ª passada de acompanhamento)
SUPABASE_URL=https://frprebgyfnbeetuwmrzd.supabase.co
SUPABASE_KEY=sb_publishable_e1Xx9UGhvma2O0LxN0csYw_yM40XJoA
SUPABASE_EMAIL=felipepors@gmail.com
SUPABASE_PASSWORD=<senha-do-mcs-prazos>
ACOMPANHAR_ENABLED=true

# Backup
DJEN_BACKUP_ENABLED=true

# Opcionais
LOG_LEVEL=INFO
# DJEN_TRIBUNAIS=TJSP                  # restringe a 1 tribunal (útil para testes)
# DJEN_DIAS_RETROATIVOS=7              # janela padrão
# SLACK_WEBHOOK=...
# TELEGRAM_TOKEN=...
# TELEGRAM_CHAT_ID=...
# HEALTHCHECK_URL=...
```

---

## Convenções de código (regras permanentes)

### Petições e peças jurídicas (drafting standard)

- **Seção I sempre "DA GRATUIDADE DA JUSTIÇA"** (exceto quando inaplicável)
- Numeração romana bold-caps com em-dash: `I — DA QUESTÃO TAL`
- Closing: alíneas `a) b) c)` em negrito + `Nestes Termos, Pede o deferimento` + assinaturas duplas (Felipe + Janine)
- Health plan petitions sempre incluem: CDC inversão (exceto IPE/autogestão — Súmula 608/STJ), disclosure contrato, astreinte, Sisbajud, dados do plano do plaintiff
- Medicamentos: sempre incluir registro ANVISA + fonte
- **Súmula 102 TJSP REVOGADA em 10/09/2025** — substituir por Lei 14.454/2022 + ADI 7.265 STF + jurisprudência STJ
- **Não imputar "erro" a decisões de juízos inferiores** — usar "merece reexame", "data venia", "permite-se outra leitura"
- SUS jurisdiction (PMVG zero-rate CMED): ≥210 salários mínimos → Federal (Núcleo Justiça 4.0 RS) / <210 → Estadual (Vara Estadual Saúde Pública POA)
- **Verbatim citations only from primary sources** — não citar citação ("não devemos citar citação")

### Estilo de escrita

- Fluido, voz humana (não burocrático)
- Argumentação em camadas: preliminares procedimentais antes do mérito
- Tabelas estruturadas (compliance/comparativos) — não opcional
- Sem estatísticas inventadas; todo dado precisa de fonte verificável

### Marketing (OAB compliance)

- **NUNCA** usar "garantir" / "promessas de resultado"
- Brand: navy `#1B2A4A` + gold `#F5C518`
- CTA buttons sempre prontos para WordPress (HTML+CSS inline)
- Tom OAB-compliant, E-E-A-T/YMYL otimizado

---

## URLs e identificadores importantes

| Item | Valor |
|---|---|
| Supabase project ID | `frprebgyfnbeetuwmrzd` |
| Supabase URL | https://frprebgyfnbeetuwmrzd.supabase.co |
| GitHub MCS Prazos | https://github.com/felipepors/prazos-mcs (público) |
| GitHub Monitor DJEN | https://github.com/felipepors/monitor-djen (privado) |
| MCS Prazos online | https://prazos-mcs.vercel.app |
| Site escritório | https://www.correadasilvamartins.com.br |
| WhatsApp escritório | https://wa.me/555140423543 |
| E-mail escritório | contato@correadasilvamartins.com.br |
| E-mail Felipe (login) | felipepors@gmail.com |
| Pasta principal | `~/Desktop/DJEN/` |
| Pasta MCS local | `~/Desktop/prazos-mcs/` |
| Backups DJEN | `~/Google Drive/Meu Drive/Backups DJEN/` |
| Atalho rodar monitor | `~/Desktop/Monitor DJEN.command` |

---

## Notas operacionais para Claude (em sessões futuras)

### Sobre o Felipe (estilo de trabalho)

- Familiaridade limitada com Terminal — sempre orientações passo a passo, **um comando por vez**, esperar Enter
- Mac (zsh), Chrome como navegador padrão (decisão tomada nesta sessão)
- Novas janelas de Terminal abrem em `~` — sempre incluir `cd ~/Desktop/DJEN &&` no início dos comandos
- Quando colar comandos no Terminal, costuma juntar várias linhas — preferir comandos únicos
- Comentários no shell (`#`) podem gerar erros "command not found" — evitar
- Não usa gerenciador de senhas

### Sobre senhas

- **Nunca** pedir para colar senhas no chat
- Usar `read` com `stty -echo` para senha oculta no Terminal:
  ```bash
  printf "Digite a senha: " && stty -echo && read SENHA && stty echo && echo "" && \
    sed -i '' "s|^VAR=.*|VAR=${SENHA}|" .env && unset SENHA
  ```
- A senha de app do Gmail foi exposta em uma sessão anterior — Felipe afirmou ter revogado mas vale confirmar em https://myaccount.google.com/apppasswords

### Sobre o sistema

- RLS do Supabase protege os dados — pode usar publishable key livremente no código frontend
- Antes de adicionar feature nova: perguntar se Felipe **já usou** o existente por alguns dias
- Decisões arquiteturais: sempre apresentar trade-offs (custo, risco, tempo), recomendar caminho mais simples (YAGNI)
- Quando perceber sinais de cansaço (frases curtas, "desisto", "prosseguir" sem responder), **sugerir pausa**
- **Mudanças no dashboard:** validar com testes antes de entregar (há harness jsdom usado nas últimas sessões); estados locais e export/import são pontos sensíveis — não quebrar as chaves do localStorage nem o formato do JSON de status
