-- Passo 5 — Storage: bucket privado `alvaras` + RLS por usuário.
--
-- Os PDFs de alvará são DADO SENSÍVEL: bucket NÃO público. Convenção de caminho:
-- cada arquivo vai em "{auth.uid()}/<nome>.pdf", e as policies garantem que o
-- usuário só enxerga/escreve na própria pasta (mesmo modelo auth.uid() = dono).

insert into storage.buckets (id, name, public)
values ('alvaras', 'alvaras', false)
on conflict (id) do nothing;

-- storage.objects já vem com RLS habilitado; aqui só adicionamos as policies.

create policy "alvaras_own_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'alvaras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "alvaras_own_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'alvaras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "alvaras_own_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'alvaras'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'alvaras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "alvaras_own_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'alvaras'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
