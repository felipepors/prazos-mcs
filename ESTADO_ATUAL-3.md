# Estado Atual do Sistema — 28/05/2026

> Snapshot do que está pronto, em uso e pendente.

**Última atualização:** 02/06/2026 — v14 (App.jsx v9: badge de tribunal no card de Prazo [derivado do CNJ] + data de entrada no processo + tipo "Acompanhar" pré-selecionado. Correção de doc: o estado do MCS Prazos — incl. prazos e orçamento — sincroniza entre dispositivos via `estado_usuario`, não é local-only. Pendente: guard de segurança do `historico.db` no monitor)

---

> **📌 Manutenção deste documento:**
> Atualize este arquivo a cada sessão significativa. Eventos que disparam atualização:
> - **Feature implementada:** mover de "Pendente" para "Pronto e funcionando"
> - **Feature solicitada:** adicionar em "Pendente — alta prioridade"
> - **Bug descoberto:** adicionar em "Bugs conhecidos não resolvidos"
> - **Bug corrigido:** mover para "Bugs corrigidos nesta sessão" + atualizar tabela "Histórico de versões"
> - **Nova versão de arquivo (monitor/dashboard/App.jsx):** atualizar tabela "Histórico de versões" + linha do componente em "Pronto"
> - **Decisão arquitetural:** registrar contexto, alternativas, escolha
>
> Não duplique estrutura permanente aqui — isso vai em `ARQUITETURA.md`. Aqui é só status temporal.

---

## ✅ Pronto e funcionando

### Monitor (`monitor_djen.py`)
- [x] Versão atual: **v12** (~67.250 bytes)
- [x] **Grava a última movimentação de cada processo acompanhado no Supabase** (v12) — ao final da 2ª passada, para cada processo com publicação nova, faz upsert da publicação **mais recente** em `movimentacoes_djen` (1 linha por processo, sobrescreve). Aditivo: a 1ª passada, a gravação no `historico.db` e o e-mail ficaram inalterados; falha na gravação só loga aviso e não interrompe a rodada. Funções novas: `supabase_login`, `_user_id_do_token`, `upsert_movimentacao_supabase`
- [x] **18 tribunais** (via `DJEN_TRIBUNAIS` no `.env`) × **32 termos** (via `DJEN_TERMOS` no `.env`) × 5 gatilhos × **16 medicamentos**
- [x] **Flag `--so-acompanhados` (apelido `--mcs`)** — pula a 1ª passada e roda só os processos com `acompanhar=true` no Supabase. Combina com `--hoje`/`--dias`/`--desde/--ate`. Reduz a rodada de ~45min para segundos/poucos minutos (v11)
- [x] Termos de busca: nome pt + nome comercial dos 16 medicamentos (32 termos — ver decisão abaixo)
- [x] Catálogo reduzido a 16 medicamentos ativos (ver lista em ARQUITETURA.md)
- [x] Rate-limit handling (HTTP 429 com backoff exponencial)
- [x] Captura texto completo da publicação
- [x] Backup automático em Google Drive (30 versões com rotação)
- [x] E-mail HTML com 2 seções (oncológicas + acompanhados)
- [x] 2ª passada lê Supabase com auth (publishable key + JWT do usuário)
- [x] Dedup contra histórico e contra a 1ª passada
- [x] `.env` configurado com SMTP + Supabase + DJEN_TERMOS + DJEN_TRIBUNAIS

> ⚠️ **Atenção ao tempo de execução:** 18 tribunais × 32 termos = 576 combinações. Com pausa de 4,5s, estima-se ~45 minutos por rodada completa.

### Dashboard local (`dashboard.html`)
- [x] Versão atual: **v17**
- [x] Carrega `historico.db` via sql.js (SQLite no navegador)
- [x] **Aba "Acompanhados"** (v17) — nova navegação de abas (Publicações | Acompanhados). A aba lista os processos com `acompanhar=true` lidos do **Supabase** (fonte da verdade — pega também os adicionados manualmente no App.jsx), cruza por número (normalizado, ignora máscara CNJ) com as movimentações já salvas no `historico.db`, e **sinaliza movimentação NOVA** desde a última vez que o processo foi aberto na aba (carimbo em `localStorage`): badge pulsante no card + contador na aba. Abrir o card marca como visto e zera o sinal. "ver decisão" reusa o modal existente. Desconectado → portão "Conecte ao MCS". Botão "↻ Atualizar" refaz a leitura.
- [x] Filtros, gráficos, cards de resumo
- [x] Modal de detalhes com destaques coloridos por gatilho
- [x] Detecção de processo de origem (`extrairProcessoOrigem`) + badge "recurso" na lista
- [x] Integração MCS Prazos (login Supabase + enviar publicação)
- [x] **Descarte de 1 clique** — descarta direto do modal de detalhes, sem caixa de confirmação; toast "Publicação descartada · ↺ Desfazer" (6s) restaura. Campo de motivo removido (v9)
- [x] **Botão "Adiar"/"↺ Retomar"** em cada linha da tabela
- [x] **Acompanhar ao enviar** — envio ao MCS já grava `acompanhar=true`; botão no modal alterna acompanhar/desmarcar (UPDATE no Supabase), lê o estado real ao reabrir (v10)
- [x] **Filtro por status** na barra de filtros (Novos / Enviados ao MCS / Adiados / Descartados); status="Descartados" mostra descartadas mesmo com o checkbox off (v11)
- [x] **Estados mutuamente exclusivos** — descartado/enviado/adiado: cada publicação fica em no máximo um estado; "última ação vence". Derivação única em `aplicarEstadosAoCarregar()` com precedência DESCARTADO > ENVIADO_MCS > ADIADO (v11)
- [x] **Camada genérica de estados** (`STATUS_KEYS` + `_loadMapa`/`_salvarMapa`/`_limparOutrosEstados`) — os 3 blocos de localStorage unificados num núcleo só (v11)
- [x] **Export/Import unificado** (versao 2) — `djen-status_DATA.json` cobre descartes + enviados MCS + adiados; retrocompatível com versao 1
- [x] localStorage: `djen.discarded.v1`, `djen.enviados_mcs.v1`, `djen.adiados.v1`, `djen.acompanhados.lastseen.v1` (carimbo "última vez visto" por processo, para a aba Acompanhados)
- [x] **Refino visual** (v12): faixa lateral por prioridade na tabela (P1 bordeaux / P2 mostarda / P9 cinza, via `data-prio`); badges de status unificadas e na paleta; filete no card de P1
- [x] **Título** reduzido a "Monitor DJEN" (sem "— oncológicos") (v13)
- [x] **Barra MCS** redesenhada (v13–v14): faixa creme editorial no lugar do bloco navy; texto de alto contraste; "abrir MCS" como botão cheio oliva; "Conectar/Sair" como botão contornado
- [x] **Legibilidade** (v15–v16): texto secundário escurecido (`--ink-3` 6,65 → 9,17 de contraste); rótulos/cabeçalhos maiores (11px), mais grossos (peso 600, mono 600 carregado), menos espaçados e em `--ink-2` (~11,45 de contraste); placeholder da busca visível

### MCS Prazos (`App.jsx`)
- [x] Versão atual: **v9** (~3.042 linhas) — v9: badge de tribunal + data de entrada + tipo "Acompanhar"; v8: "Orçamento enviado"; v7: "Exclusão DJEN com prazos vinculados"
- [x] **Badge de tribunal no card de Prazo** (v9) — pílula com a sigla (TJBA, TJRS, TRF4...) ao lado do número, **derivada do CNJ** (`tribunalDoCNJ`: segmento J + código TR). Zero armazenamento; vale para prazos manuais também. ⚠️ Ainda não validado em produção
- [x] **Data de entrada no processo no card de Prazo** (v9) — chip `📌 Data de entrada` / `📌 Entrei DD/MM/AAAA`, abre seletor de data nativo, editável a qualquer momento. Handler `setDataEntrada`; campo `dataEntrada` (ISO) no objeto do prazo; sincroniza pelo blob `estado_usuario`. ⚠️ Ainda não validado em produção
- [x] **Tipo "Acompanhar" pré-selecionado** (v9) — 1º item de `TIPOS_DEFAULT` e default no Novo Prazo (manual e ao promover do DJEN, que antes vinha "Manifestação"). ⚠️ Ainda não validado em produção
- [x] Deploy automático no Vercel
- [x] Toggle "Acompanhar este processo no DJEN" no modal de detalhes
- [x] Badge `🔔 ACOMP` ao lado do número nos cards
- [x] Botão **"＋ Adicionar processo"** na barra de filtros da aba DJEN
- [x] Modal com campo número (máscara CNJ automática), tribunal opcional, observação
- [x] Insere linha em `publicacoes_djen` com `id_djen='manual_<timestamp>'` e `acompanhar=true`
- [x] Badge `✏️ MANUAL` nos cards de processos adicionados manualmente
- [x] **Observação editável no modal** (v5) — o campo OBS. deixou de ser leitura: virou seção própria com textarea + botão "Salvar" (ativo só quando o texto muda) + toast "Observação salva". Grava na coluna `observacao` da `publicacoes_djen` via handler dedicado `atualizarObservacao` (UPDATE só de `observacao`; não toca status nem acompanhar). Validado em produção 31/05/2026
- [x] **Navegação cruzada Prazos→DJEN** (v6) — o número do processo em cada card da aba Prazos virou clicável (sublinhado pontilhado, cor do tema); clicar abre a aba DJEN buscando aquele processo e limpando os filtros de status/tribunal/prioridade, garantindo que o card apareça. Completa o par com o caminho que já existia (DJEN→Prazos via "Promover a Prazo"). Implementação: estado `processoAlvoDjen` lifted no App + prop `processoAlvo`/callback `onProcessoAlvoConsumido` no `PainelDJEN`, aplicado por `useEffect` (suporta cliques repetidos). Processo fora da carteira DJEN → busca vazia (esperado)
- [x] **Exclusão DJEN com prazos vinculados** (v7) — ao apagar uma publicação na aba DJEN, o sistema procura prazos do mesmo processo (casa por dígitos via `soDig`, ignora máscara CNJ; helper `prazosDoProcesso`) e abre modal de confirmação: sem vínculo → confirmação simples; com 1+ prazos → lista cada prazo (tipo, parte, vencimento, selo Ativo/Concluído) e oferece escolha explícita "apagar só a publicação" vs "apagar publicação + N prazo(s)". Direção única DJEN→Prazos (apagar prazo nunca remove o acompanhamento). `PainelDJEN` passou a receber a prop `prazos` (leitura) além de `setPrazos`. Estado `confirmApagar = { pub, vinculados }`. ⚠️ Ainda não validado em produção
- [x] **Marcador "Orçamento enviado"** (v8) — chip clicável em cada card da aba Prazos, na linha de status/vencimento. Contornado (verde claro) = pendente; verde-cheio `✓ Orçamento enviado` = enviado. Toggle via `toggleOrcamento(id)`; grava `orcamentoEnviado` no objeto do prazo (localStorage `mcs.prazos`, sem Supabase). Independente de `concluido` e do status do prazo; não interfere na ordenação por vencimento. ⚠️ Ainda não validado em produção

### Supabase
- [x] Tabela `publicacoes_djen` (schema completo em ARQUITETURA.md), RLS habilitado com 4 policies
- [x] Tabela `estado_usuario`, RLS habilitado com 3 policies
- [x] **Tabela `movimentacoes_djen`** (v8 desta doc / monitor v12) — gestão de carteira: 1 linha por processo acompanhado, PK `(user_id, numero_processo)`, RLS com 4 policies. Campos do DJEN (`tribunal`, `orgao`, `ultima_movimentacao`, `data_ultima_movimentacao`) gravados pelo monitor; campos do Felipe (`comarca` quando faltar no órgão, `juiz`, `fase`, `observacao`) preenchidos por ele. Schema em ARQUITETURA.md
- [x] Coluna `acompanhar` (boolean, default false) + índice parcial `idx_djen_user_acompanhar`
- [x] **Dois pontos de escrita em `acompanhar`:** App.jsx (toggle no modal) e agora também o dashboard (envio ao MCS + botão acompanhar/desmarcar)

### Infraestrutura
- [x] Repositório GitHub `monitor-djen` (privado) com `INSTALACAO.md` para recuperação
- [x] Repositório GitHub `prazos-mcs` (público) com auto-deploy Vercel
- [x] Atalho de Desktop "Monitor DJEN.command" para rodar com 2 cliques
- [x] Backup automático em Google Drive Desktop (sync local-nuvem nativo)
- [x] Projeto Claude com documentação portável (`ARQUITETURA.md`, `ESTADO_ATUAL.md`, `INSTRUCOES_PROJETO.md`)

---

## 🛟 Incidente recuperado nesta sessão (02/06/2026)

### Perda e recuperação do `historico.db`
- **Sintoma:** depois da leitura de quinta/sexta, o dashboard não mostrava os processos anteriores — só os recentes.
- **Diagnóstico:** o `historico.db` na pasta `~/Desktop/DJEN` estava com **680 KB** (devia ter ~6,7 MB). A curva dos backups confirma a queda: 6,7 MB em 29/05 e 30/05 → **680 KB** em 01/06 18:26.
- **Causa raiz:** o `historico.db` foi **apagado manualmente** (confirmado pelo Felipe). Como o monitor cria o banco do zero (`CREATE TABLE IF NOT EXISTS`) e deduplica contra ele, a rodada seguinte gravou só as publicações novas → arquivo encolhido. **Não foi bug de código nem de sync** — o `historico.db` não fica dentro do Google Drive (só os backups ficam); o monitor fez o esperado com um banco vazio na frente.
- **Recuperação:** restaurado o backup `~/Google Drive/Meu Drive/Backups DJEN/historico_20260530_162323.db` (6,7 MB) sobre o `historico.db`. O arquivo encolhido foi preservado como `historico_encolhido_20260601.db`. **Nenhum dado perdido** — no pior caso, re-rodar a janela de quinta/sexta (idempotente, deduplica).
- **Follow-up aberto:** (1) recarregar o dashboard com o `historico.db` restaurado e confirmar os processos antigos; (2) re-rodar o monitor na janela de quinta/sexta (datas a confirmar) para garantir que nada novo daquela leitura ficou de fora; (3) decidir sobre o guard no monitor (ver "Pendente — alta prioridade").

---

## 🐛 Bugs corrigidos nesta sessão (28/05/2026)

### Toast de descarte não aparecia (corrigido em dashboard v9)
- **Causa:** o timer de um toast anterior resetava o toast seguinte quase imediatamente (timeouts sobrepostos).
- **Correção:** `mcsShowToast` cancela o timer pendente antes de mostrar um novo toast e força reflow para re-disparar a animação de forma confiável. Passou também a suportar botão de ação (usado no "↺ Desfazer" do descarte).

### "Descartar precisava de 2 cliques" — não era bug
- O primeiro clique abria a caixa de confirmação; o segundo confirmava. Resolvido pelo redesenho de **descarte de 1 clique** (v9), que removeu a confirmação e colocou um "Desfazer" no toast como rede de segurança.

### Precedência de status inconsistente (corrigido em dashboard v11)
- **Causa:** uma publicação podia ficar em mais de um mapa de localStorage (descartado/enviado/adiado) ao mesmo tempo; na carga, o último aplicado vencia → enviar + descartar reaparecia como "enviado" ao recarregar.
- **Correção:** exclusividade mútua na escrita (cada transição remove o id dos outros mapas) + derivação única com precedência definida. Agora descartar um item enviado fica DESCARTADO de vez.

---

## 🐛 Bugs corrigidos em sessões anteriores

### Bug do dict da 2ª passada (corrigido em v9 do monitor — VALIDADO em produção em 26/05/2026 09:35)
- 2ª passada usa as mesmas chaves de `processar_publicacao`; e-mail de acompanhados ajustado (`data_pub`→`data_publicacao`, `texto`→`texto_completo`).

---

## ⏳ Pendente — alta prioridade

- **Guard de segurança no monitor: abortar se `historico.db` sumir e existirem backups.** Motivado pelo incidente 02/06. Hoje, se o banco for apagado/movido, o monitor cria um vazio silenciosamente (`CREATE TABLE IF NOT EXISTS`), deduplica contra ele e grava só o novo — "escondendo" todo o histórico até a próxima restauração. **Mudança proposta:** na inicialização, se `DB_PATH` não existir **e** houver `historico_*.db` na `BACKUP_DIR`, abortar com aviso claro ("banco ausente — restaure um backup antes de rodar") em vez de criar do zero. Pequena e localizada (em `db_conectar`/início do `main`). **Não construir sem o OK do Felipe** (YAGNI até ele decidir). Alternativa/complemento: tornar `DJEN_DB` um caminho absoluto no `.env` para blindar contra rodar da pasta errada.
- **Validar em produção o POST de gravação da movimentação (monitor v12).** O teste de 30/05 (`--hoje --so-acompanhados`) rodou limpo nos 18 acompanhados, mas com **0 publicações novas** → nenhum upsert disparou (tabela seguiu vazia). A mecânica da tabela já foi provada manualmente (upsert sobrescreve e preserva `fase`/`juiz`/`observacao`). **A leitura da `movimentacoes_djen` por MCP foi validada em 31/05** (conexão OK; tabela confirmada vazia, 18 acompanhados em `publicacoes_djen`). Falta só ver o POST do monitor disparar com dado real — **acontece sozinho na 1ª movimentação nova** de qualquer acompanhado. Quando popular a 1ª linha, conferir que `orgao`/`data`/`texto` chegaram corretos.

---

## 🐛 Bugs conhecidos não resolvidos

*(nenhum bug de código em aberto — o incidente do `historico.db` foi de exclusão manual, já recuperado; o guard contra recorrência está em "Pendente — alta prioridade")*

---

## 📋 Próximas features (não solicitadas ainda — ideias)

- **Botão para rodar o monitor com escolha de datas** — pedido em 28/05/2026, **adiado a pedido do Felipe**. O dashboard `file://` não roda Python (sandbox do navegador). Opções avaliadas: (1) servidor local — rejeitada (fricção, perde portabilidade); (2) **app de Desktop que pergunta as datas e roda o `monitor_djen.py --desde X --ate Y`** — recomendada; (3) painel de datas no dashboard que só monta/copia o comando pro Terminal. (Nota: a flag `--so-acompanhados` da v11 já cobre o caso de rodar rápido só os acompanhados.)
- Adicionar TJRS ao monitor quando o escritório quiser monitorar o tribunal local
- Agendamento automático com launchd (rodar 8h diariamente) — especialmente importante porque a execução leva ~45min
- Notificação WhatsApp (via API externa) ou Telegram
- Ampliar lista de medicamentos (atualmente 16 — Felipe vai adicionando aos poucos)
- Migrar descartes/adiados/enviados do localStorage para Supabase (multi-dispositivo) — "talvez no futuro"
- ~~Aba "Processos Acompanhados" separada da DJEN~~ — **feito no dashboard (v17)**. (No App.jsx do MCS eles ainda convivem na mesma aba DJEN; separar lá continua sendo ideia futura, se valer a pena.)
- Histórico de movimentações por processo (timeline)
- Integração com Asaas / cobrança automática para clientes promovidos
- **Refino visual restante** (não solicitado): zebra striping na tabela, estados de foco/acessibilidade, polimento do modal, modo escuro, gráficos seguirem o filtro

---

## ⚠️ Avisos importantes

### Nunca apagar o `historico.db` manualmente
O `historico.db` é o **banco cumulativo** (texto completo de todas as publicações já capturadas). Apagá-lo faz o monitor recriar um banco vazio na rodada seguinte e gravar só as novas publicações — escondendo todo o histórico (incidente 02/06/2026). Se precisar "zerar" ou recomeçar, **mova/renomeie** o arquivo em vez de apagar, e confirme que há backup recente em `~/Google Drive/Meu Drive/Backups DJEN/`. **Recuperação:** copiar o último backup grande sobre o `historico.db` —
`cd ~/Desktop/DJEN && cp ~/Google\ Drive/Meu\ Drive/Backups\ DJEN/historico_AAAAMMDD_HHMMSS.db historico.db`.

### Incidente de segurança — senha de app Gmail
A senha de app do Gmail (`SMTP_PASS`) foi exposta no chat em sessões anteriores. Felipe deve confirmar em https://myaccount.google.com/apppasswords que a senha foi revogada e que **só existe uma senha de app ativa**. A senha comprometida começa com `nhvm geoo`.

### Gerenciador de senhas
Felipe não usa gerenciador de senhas (confirmado). Recomendação: Apple Keychain.

### Pasta do Terminal
Sempre incluir `cd ~/Desktop/DJEN &&` no início de comandos quando estiver guiando (novas janelas abrem em `~`).

### Comentários no shell
Evitar instruir colagem de blocos com `#` (gera erros `command not found: #`).

### Export de status
Como os estados (descartes/adiados/enviados) vivem no localStorage, exportar de vez em quando ("⬇ Exportar status") evita perda ao limpar o Chrome. Formato do arquivo não mudou nesta sessão (versao 2 — `djen-status_DATA.json`).

### `ARQUITETURA.md` sincronizado (31/05/2026)
- Os dois documentos foram revisados e batidos contra código e Supabase em 31/05. O `ARQUITETURA.md` já reflete dashboard **v17**, monitor **v12**, App.jsx **v5**, e a tabela `movimentacoes_djen`. (A antiga pendência "ARQUITETURA lista dashboard como v7" está **resolvida** — já estava reconciliado.) Schemas SQLite/Supabase conferidos; tamanhos de arquivo conferidos; 18 tribunais / 32 termos confirmados no `.env`.

> ⚠️ **Correção (02/06/2026):** aquela revisão descreveu errado a persistência do MCS Prazos. O doc dizia que a aba Prazos era "local por dispositivo" e que o "Orçamento enviado" não tinha relação com o Supabase. **Não é o caso:** o `useStorage` do App.jsx grava todo o estado (prazos, tarefas, clientes, tiposCustom, etc.) no blob `estado_usuario.dados` e sincroniza entre dispositivos por realtime. Conferido no código (`_flush`, `_hidratarDoServidor`, `_conectarRealtime`, array `KEYS`). `ARQUITETURA.md` v12 corrigido. Princípio reforçado: conferir comportamento no código, não só na doc.

---

## Decisões arquiteturais (30/05/2026)

### Espelhar a última movimentação dos acompanhados no Supabase (monitor v12 + tabela `movimentacoes_djen`)
**Contexto:** Felipe quer acompanhar a carteira do escritório **conversando com o Claude** (que tem conexão MCP com o Supabase), e não construir mais software. Para isso, o Claude precisa enxergar as movimentações — mas elas só existiam no `historico.db` local, fora do alcance do Claude.
**Decisão:** o monitor passa a gravar a **última** movimentação de cada processo acompanhado numa tabela nova `movimentacoes_djen` (1 linha por processo, upsert que sobrescreve). O Claude lê/escreve essa tabela direto por MCP. Campos do DJEN são do monitor; `juiz`/`fase`/`observacao` são do Felipe (`juiz` opcional) e **nunca são tocados pelo upsert do monitor** (só os campos do DJEN entram no `DO UPDATE`).
**Alternativas descartadas:** (1) **ler o `historico.db` pelos backups do Google Drive** — possível (o Claude alcança os backups via Drive), mas transfere o banco inteiro (~7 MB) a cada consulta, é lento e defasado; serve só como fallback/foto eventual; (2) **upload manual do `.db` no chat** — mesma limitação de tamanho, zero infra; (3) **guardar todas as movimentações no Supabase** — desnecessário, já que Felipe só quer a última e o histórico completo continua no `historico.db`.
**Custo Supabase:** desprezível. Formato "1 linha por processo, sobrescrita" mantém a tabela praticamente do mesmo tamanho para sempre (~poucos KB por processo); banco hoje em ~11 MB de 500 MB do plano grátis. Requisições são ilimitadas no plano grátis e não há cobrança por excesso.
**Pendente:** ver "Pendente — alta prioridade" (validar o POST com dado real). O **Project Claude de controle de carteira** foi criado em 31/05 (ver decisão abaixo).

---

## Decisões arquiteturais desta sessão (31/05/2026)

### Onde vivem as anotações de processo — Supabase, não memória de conversa
**Contexto:** Felipe perguntou se, ao protocolar uma petição e me contar, isso ficaria disponível em outra conversa. **Decisão:** anotação operacional de processo NÃO depende da memória de conversa do Claude (que é por-projeto, atualiza com atraso, é resumo e pode se perder). O lugar correto é dado no Supabase. **Hoje** o lugar é o campo `observacao` da `publicacoes_djen` (os 18 acompanhados já existem lá como linhas reais; a `movimentacoes_djen` ainda está vazia). Qualquer conversa com acesso ao Supabase lê de volta fielmente. Validado em produção 31/05 (escrita por MCP → leitura no MCS).

### Observação editável no MCS (App.jsx v5)
**Contexto:** o campo OBS. do modal DJEN era só leitura; Felipe queria poder editar sozinho, sem me chamar. **Decisão:** tornar o campo editável no próprio app (textarea + Salvar + toast), gravando em `publicacoes_djen.observacao`. Handler dedicado `atualizarObservacao` (UPDATE só de `observacao`) para não acoplar com `atualizarStatus`. **Justificativa de construir agora (não YAGNI):** é autonomia recorrente — anotar rápido sem depender do chat. Custo baixo, mudança localizada no modal.

### Project Claude de controle de carteira — criado
**Contexto:** próximo passo previsto na decisão de 30/05. **Decisão:** Project dedicado só à gestão da carteira (lê/escreve `movimentacoes_djen` por MCP), separado do Project do monitor. Instruções entregues (`INSTRUCOES_PROJETO_CARTEIRA.md`) com: project_id, schema, regra crítica (só escreve `comarca`/`juiz`/`fase`/`observacao`, nunca os campos do DJEN que são do monitor), operações típicas e a limitação de tabela vazia. **Acende de fato** quando a `movimentacoes_djen` popular (pendência #1).

### Divisão de projetos — desenvolvimento vs. operação
**Decisão (31/05):** dois Projects Claude com papéis separados. (1) **Este projeto** (monitor) = desenvolvimento: código (`App.jsx`, `monitor_djen.py`, `dashboard.html`), `ARQUITETURA.md`, `ESTADO_ATUAL.md` e toda alteração no sistema. (2) **Project "Controle de Carteira MCS"** = só operação: ler movimentações, anotar `fase`/`observacao`, panorama — sem arquivos de código. **Motivo:** Felipe alterna entre mexer no sistema e usá-lo; isolar evita misturar memória de "desenvolvi feature X" com "processo Y mudou de fase", e mantém as instruções de cada projeto enxutas. **Consequência:** alterações de código (incl. no app que a carteira usa) acontecem sempre aqui, com os arquivos à mão; o projeto de carteira não tem contexto técnico para isso, por desenho.

---

## Decisões arquiteturais (28/05/2026)

### Exclusão DJEN com prazos vinculados — escolha consciente, não cascata (App.jsx v7, 02/06/2026)
**Contexto:** Felipe relatou que, ao apagar um processo na aba DJEN, com frequência havia um prazo do mesmo processo na aba Prazos, exigindo apagar manualmente nos dois lugares.
**Decisão:** ao apagar no DJEN, casar o número do processo (só dígitos, ignora máscara CNJ) com os prazos e, se houver vínculo, abrir um modal que **lista** os prazos e pede **escolha explícita** ("apagar só a publicação" vs "apagar publicação + N prazo(s)").
**Alternativa descartada — cascata automática/silenciosa:** rejeitada por risco. Prazo é compromisso processual real; uma faxina na aba de oportunidades (DJEN) apagando um prazo fatal por engano seria desastre. A independência entre os dois "mundos" (DJEN = Supabase; Prazos = localStorage) é uma proteção, não um defeito. Direção única DJEN→Prazos: apagar um prazo nunca remove o acompanhamento no DJEN.

### Marcador "Orçamento enviado" — flag local por prazo (App.jsx v8, 02/06/2026)
**Contexto:** Felipe quis sinalizar visualmente, na aba Prazos, em quais processos já enviou o orçamento, sem alterar a ordenação por vencimento.
**Decisão:** flag booleana `orcamentoEnviado` no objeto do prazo, persistida no localStorage (`mcs.prazos`, junto com os demais campos do prazo). Renderizada como chip clicável na linha de status (verde-cheio = enviado). Sem coluna no Supabase — é uma marca de controle comercial local, não dado processual.
**Alternativa descartada:** coluna nova no Supabase — desnecessária para um marcador pessoal de um único usuário; manteria a complexidade e o custo sem ganho. Reavaliar só se virar dado compartilhado/relatável entre dispositivos.

### Aba "Acompanhados" no dashboard (v17)
**Contexto:** Felipe quis ver os processos enviados/acompanhados numa aba própria, com algo que chame atenção quando houver publicação nova, mostrando a decisão/movimentação.
**Decisão — 3 fontes combinadas:** (1) a **lista** de acompanhados vem do **Supabase** (`acompanhar=true`), não do localStorage — é a mesma marcação que dispara a 2ª passada do monitor, então "o que aparece na aba = o que o monitor vigia", e pega processos adicionados manualmente no App.jsx; (2) o **conteúdo** das movimentações vem do `historico.db` local (já gravado pela 2ª passada, com texto completo), cruzado por número de processo normalizado (só dígitos, neutraliza máscara CNJ) e deduzido por data+texto (a 2ª passada grava 1 linha por intimado); (3) a **sinalização de novidade** usa um carimbo local (`djen.acompanhados.lastseen.v1`): uma movimentação é "nova" se sua `primeira_vista` é posterior ao último carimbo do processo; abrir o card marca como visto.
**Alternativas descartadas:** lista por JSON exportado (100% offline, mas exige reexportar a cada mudança e envelhece em silêncio); Supabase realtime (geraria conexão contínua — sem necessidade, já que a novidade chega via monitor + recarregar o banco).
**Limite conhecido (não é bug):** a sinalização não é tempo real — depende de o monitor rodar (que já avisa por e-mail na seção 🔔) e de recarregar o `historico.db` no dashboard. O custo Supabase é nulo: é um SELECT pequeno, igual ao que o monitor já faz; uso fica em fração dos 5 GB/mês de egress do plano grátis.

### Detecção de processo de origem — só no dashboard, não no monitor
Regex contextual no texto já salvo (zero mudança no monitor/banco). Exibido no modal com badge "1º grau" e botão Copiar.

### Sistema de Adiar — localStorage, não banco
Chave `djen.adiados.v1`; linha âmbar + botão "Adiar"/"↺ Retomar". Incluído no export/import unificado.

### Descarte de 1 clique + Desfazer (dashboard v9)
**Contexto:** a confirmação de dois passos gerava fricção e a impressão de "não descartou". **Decisão:** descarte direto do modal + toast com "↺ Desfazer" (6s) como rede de segurança; removidos a caixa de confirmação e o campo de motivo.
**Consequência conhecida:** desfazer o descarte de um item que estava "enviado ao MCS" o devolve como **NOVO** (não como enviado), porque a exclusividade mútua removeu o marcador de enviado. Caso de borda raro; o registro permanece no Supabase.

### Acompanhar ao enviar ao MCS (dashboard v10)
**Decisão:** o envio ao MCS grava `acompanhar=true` (entra direto na 2ª passada do monitor); botão no modal permite desmarcar/remarcar (UPDATE no Supabase). **Nota:** o dashboard passou a ser um segundo ponto de escrita da coluna `acompanhar` (além do App.jsx). Descartar no dashboard **não** desmarca `acompanhar` no Supabase (sistemas independentes — local vs nuvem).

### Estados mutuamente exclusivos + unificação localStorage (dashboard v11)
**Contexto:** estados em mapas independentes causavam inconsistência de precedência. **Alternativas:** (1) precedência só na leitura — mantinha o id em vários mapas; (2) **exclusividade mútua na escrita** ← escolhida — cada transição remove o id dos outros mapas; um id fica em ≤1 estado. Precedência (para dados legados) DESCARTADO > ENVIADO_MCS > ADIADO. Os 3 blocos de localStorage foram unificados numa camada genérica no mesmo passo.

### Refino visual e legibilidade (dashboard v12–v16)
**Princípio:** prioridade domina o sinal de cor; status fica quieto e consistente. **Decisões:** faixa lateral por prioridade na tabela; badges de status unificadas e na paleta; card de P1 destacado; barra MCS editorial (creme) no lugar do bloco navy, com texto forte e ações em botão; aumento de contraste/tamanho/peso dos rótulos e textos pequenos (eram pequenos, finos e espaçados em fonte mono — não bastava só escurecer a cor). Tudo CSS/apresentação, sem mudança de lógica.

---

## Como rodar o monitor (referência rápida)

```bash
cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje

cd ~/Desktop/DJEN && python3 monitor_djen.py --desde 2026-05-22 --ate 2026-05-22

cd ~/Desktop/DJEN && python3 monitor_djen.py --dias 3

cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje --sem-email

cd ~/Desktop/DJEN && python3 monitor_djen.py --hoje --dry-run
```

---

## Histórico de versões do sistema

| Componente | Versão | O que mudou |
|---|---|---|
| Monitor | v7 (60 KB) | Versão antes do acompanhamento |
| Monitor | v8 (73.157 bytes) | + 2ª passada de acompanhamento (com bug do fallback) |
| Monitor | v9 (~73.900 bytes) | + fix do bug do fallback da 2ª passada |
| Monitor | **v10 (~61.655 bytes)** | Tribunais: 10 → 18. Termos: 6 genéricos → 32 sinônimos. Catálogo: 199 → 16 medicamentos |
| Monitor | **v11 (~62.500 bytes)** | + flag `--so-acompanhados`/`--mcs` (pula 1ª passada, roda só acompanhados). Aditiva — rodada normal inalterada |
| Monitor | **v12 (~67.250 bytes)** | + grava a última movimentação dos acompanhados na tabela `movimentacoes_djen` do Supabase (upsert, 1 linha/processo). Aditivo; preserva os campos preenchidos pelo Felipe |
| Dashboard | v5 | Sistema de descarte com motivo |
| Dashboard | v6 (91.870 bytes) | + export/import de descartes |
| Dashboard | v7 (96.134 bytes) | + 4 fixes do code review |
| Dashboard | v8 | + processo de origem no modal; badge "recurso"; botão "Adiar"; export/import unificado (versao 2) |
| Dashboard | v9 | Descarte de 1 clique (remove modal de confirmação + motivo); toast com "↺ Desfazer"; fix do bug do toast (timer pendente + reflow) |
| Dashboard | v10 | Envio ao MCS marca `acompanhar=true`; botão acompanhar/desmarcar no modal (UPDATE Supabase) |
| Dashboard | v11 | Filtro por status; exclusividade mútua entre estados (corrige precedência); unificação dos 3 blocos de localStorage num núcleo genérico |
| Dashboard | v12 | Refino visual: faixa lateral por prioridade na tabela; badges de status unificadas e na paleta; filete no card de P1 |
| Dashboard | v13 | Título reduzido a "Monitor DJEN"; barra de status MCS redesenhada (faixa creme editorial no lugar do bloco navy) |
| Dashboard | v14 | Barra MCS: texto alto-contraste e ações como botões (abrir MCS cheio oliva; Conectar/Sair contornado) |
| Dashboard | v15 | Legibilidade: token de texto secundário escurecido (`--ink-3` 6,65→9,17) e ticks dos gráficos |
| Dashboard | **v16** | Rótulos e textos pequenos legíveis: `--ink-2`, 11px, peso 600, menos tracking, placeholder visível, mono 600 carregado |
| Dashboard | **v17** | + aba "Acompanhados": navegação de abas; lista `acompanhar=true` do Supabase cruzada com movimentações do `historico.db`; sinalização de movimentação nova (carimbo `djen.acompanhados.lastseen.v1`); portão de conexão; reusa modal e estados existentes |
| App.jsx | v1 | Versão original com aba Prazos |
| App.jsx | v2 (157.367 bytes) | + aba DJEN com workflow |
| App.jsx | v3 (159.347 bytes) | + toggle "Acompanhar" + badge ACOMP |
| App.jsx | **v4 (~2.833 linhas)** | + botão "Adicionar processo manual" + modal + badge MANUAL |
| App.jsx | **v5 (~2.879 linhas)** | + observação editável no modal DJEN (textarea + Salvar + toast; handler `atualizarObservacao` faz UPDATE só de `observacao`). Deploy validado em produção 31/05 |
| App.jsx | **v6 (~2.898 linhas)** | + navegação cruzada Prazos→DJEN: número do processo clicável no card de Prazos abre a aba DJEN buscando o processo (limpa filtros). Completa o par com DJEN→Prazos |
| App.jsx | **v7 (~2.978 linhas)** | + exclusão no DJEN com opção de apagar também os prazos vinculados (modal com lista e escolha explícita; casa por dígitos; direção DJEN→Prazos) |
| App.jsx | **v8 (~2.993 linhas)** | + marcador "Orçamento enviado" (chip verde clicável por card de Prazo; flag `orcamentoEnviado` em localStorage) |
| App.jsx | **v9 (~3.042 linhas)** | + badge de tribunal no card de Prazo (derivado do CNJ via `tribunalDoCNJ`, zero armazenamento) + data de entrada no processo (chip `📌`, seletor nativo, campo `dataEntrada`) + tipo "Acompanhar" como 1º item e default no Novo Prazo (manual e ao promover do DJEN) |
| Supabase | — | + coluna `acompanhar` + índice parcial |
| Supabase | — 30/05/2026 | + tabela `movimentacoes_djen` (PK `user_id,numero_processo`; RLS 4 policies; gestão de carteira, 1 linha/processo) |
| `.env` | — 27/05/2026 | + DJEN_TERMOS (32 termos) + DJEN_TRIBUNAIS (18 tribunais) |
