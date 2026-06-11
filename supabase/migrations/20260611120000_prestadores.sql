-- Passo 3 — Tabela `prestadores` (CNPJ/CPF → e-mail). DADO SENSÍVEL.
-- Regra de ouro nº 5: RLS OBRIGATÓRIO. Mesmo modelo das tabelas existentes:
-- cada usuário só enxerga as próprias linhas (auth.uid() = user_id).
--
-- `documento` guarda SÓ DÍGITOS (normalizado) para casar com o CNPJ que o
-- enriquecimento (Passo 2) extrai do alvará. A exibição formatada fica no front.

create table if not exists public.prestadores (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  documento      text not null,                  -- só dígitos (11=CPF, 14=CNPJ)
  documento_tipo text not null,                  -- 'CNPJ' | 'CPF'
  nome           text,
  email          text not null,
  atualizado_em  timestamptz not null default now(),

  constraint prestadores_documento_digitos check (documento ~ '^[0-9]+$'),
  constraint prestadores_documento_tamanho check (char_length(documento) in (11, 14)),
  constraint prestadores_documento_tipo_valido check (documento_tipo in ('CNPJ', 'CPF')),
  constraint prestadores_email_basico check (position('@' in email) > 1),
  -- um e-mail por documento, por usuário (suporta o "CNPJ novo → cadastrar e-mail")
  constraint prestadores_user_documento_unico unique (user_id, documento)
);

comment on table public.prestadores is
  'Cadastro CNPJ/CPF -> e-mail do prestador beneficiario. Dado sensivel, RLS por usuario.';

alter table public.prestadores enable row level security;

create policy "own_select" on public.prestadores
  for select using (auth.uid() = user_id);

create policy "own_insert" on public.prestadores
  for insert with check (auth.uid() = user_id);

create policy "own_update" on public.prestadores
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_delete" on public.prestadores
  for delete using (auth.uid() = user_id);
