-- Passo 3 — Tabela `alvaras` (registro + status do fluxo de aprovação).
-- Mesmo modelo de RLS por usuário das demais tabelas (auth.uid() = user_id).
--
-- Status do ciclo de vida (regra de ouro nº 1 — nada envia sozinho):
--   'extraido'              -> dados extraídos/enriquecidos
--   'aguardando_aprovacao'  -> rascunho de e-mail pronto, esperando o Felipe clicar Enviar
--   'enviado'               -> e-mail enviado após aprovação manual
--
-- Valores em centavos (bigint) — mesma representação determinística do Passo 2,
-- sem ponto flutuante. Datas já em ISO (date).

create table if not exists public.alvaras (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  status        text not null default 'extraido',

  -- Identificação do alvará (transcrição do Passo 1):
  numero_alvara text,
  processo      text,
  juizo         text,

  -- Beneficiário (enriquecido no Passo 2):
  prestador        text,            -- nome já sem sufixo "(INTIMADO)"
  documento        text,            -- formatado (ex.: 19.009.309/0001-70)
  documento_tipo   text,            -- 'CNPJ' | 'CPF' | 'DESCONHECIDO'
  documento_valido boolean,

  -- Valores (centavos) — líquido SEMPRE calculado em código, nunca pela IA:
  valor_bruto_centavos             bigint,
  despesa_bancaria_centavos        bigint,
  imposto_renda_centavos           bigint,
  valor_liquido_creditado_centavos bigint,

  -- Datas (ISO):
  data_creditamento date,
  data_expedicao    date,

  -- Dados bancários:
  banco   text,
  agencia text,
  conta   text,

  -- Matching e envio:
  prestador_id  uuid references public.prestadores (id) on delete set null,
  email_destino text,              -- e-mail resolvido (null até casar o prestador)
  pdf_path      text,              -- caminho no bucket de Storage (Passo 5)

  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  constraint alvaras_status_valido
    check (status in ('extraido', 'aguardando_aprovacao', 'enviado'))
);

comment on table public.alvaras is
  'Alvaras processados + status do fluxo de aprovacao manual. RLS por usuario.';

create index if not exists alvaras_user_status_idx
  on public.alvaras (user_id, status);

alter table public.alvaras enable row level security;

create policy "own_select" on public.alvaras
  for select using (auth.uid() = user_id);

create policy "own_insert" on public.alvaras
  for insert with check (auth.uid() = user_id);

create policy "own_update" on public.alvaras
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_delete" on public.alvaras
  for delete using (auth.uid() = user_id);
