// Quem pode usar as funções de alvará (processar e enviar).
//
// O cadastro de novos usuários está fechado no Supabase Auth (desde 02/08/2026),
// mas um JWT válido não basta: se o cadastro for reaberto por engano, qualquer
// conta nova poderia gastar a ANTHROPIC_API_KEY e disparar e-mails pelo SMTP do
// escritório. Por isso as funções exigem que o e-mail do usuário logado esteja
// no secret EMAILS_AUTORIZADOS (separados por vírgula).
//
// Falha FECHADA: sem o secret configurado, ninguém passa — e a mensagem de erro
// diz exatamente o que configurar.

export interface ResultadoAutorizacao {
  ok: boolean;
  erro?: string;
  status?: number;
}

export function emailsAutorizados(): string[] {
  return (Deno.env.get("EMAILS_AUTORIZADOS") ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

export function autorizarEmail(email: string | null | undefined): ResultadoAutorizacao {
  const lista = emailsAutorizados();
  if (lista.length === 0) {
    return {
      ok: false,
      status: 500,
      erro: "Secret EMAILS_AUTORIZADOS nao configurado no Supabase (Edge Functions -> Secrets).",
    };
  }
  if (!email || !lista.includes(email.trim().toLowerCase())) {
    return { ok: false, status: 403, erro: "Usuario sem permissao para alvaras" };
  }
  return { ok: true };
}
