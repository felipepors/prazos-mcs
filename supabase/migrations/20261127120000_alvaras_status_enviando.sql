-- Status intermediário 'enviando' — trava contra envio duplo.
--
-- A função enviar-alvara agora "reserva" o alvará ANTES de falar com o SMTP:
--   update ... set status = 'enviando' where id = ? and status = 'aguardando_aprovacao'
-- Só quem conseguir essa troca envia; um segundo clique/aba/retentativa recebe
-- 409. Depois do envio vira 'enviado'; se o SMTP falhar, volta para
-- 'aguardando_aprovacao'.
--
-- APLICAR ANTES de publicar a nova versão da função enviar-alvara.

alter table public.alvaras drop constraint if exists alvaras_status_valido;

alter table public.alvaras
  add constraint alvaras_status_valido
  check (status in ('extraido', 'aguardando_aprovacao', 'enviando', 'enviado'));
