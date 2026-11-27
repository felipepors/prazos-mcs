-- Trava ATÔMICA contra alvará duplicado (apontado na revisão do PR #21).
--
-- A função processar-alvara já procura o nº do alvará antes de gravar, mas duas
-- requisições simultâneas (duas abas) podiam passar pela busca antes de qualquer
-- uma gravar. Este índice único faz o próprio banco recusar o segundo registro
-- (erro 23505), que a função converte em "alvará já cadastrado".
--
-- Alvarás sem número (extração falhou) ficam de fora: não há o que comparar.

create unique index if not exists alvaras_user_numero_unico
  on public.alvaras (user_id, numero_alvara)
  where coalesce(numero_alvara, '') <> '';
