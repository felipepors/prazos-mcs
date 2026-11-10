// Diagnóstico mínimo: uma única chamada à API Comunica, sem retry, sem SMTP.
// Objetivo: descobrir se a Edge Function alcança comunicaapi.pje.jus.br
// e quais campos a resposta traz de fato.
// v4 (10/11/2026): exige usuário logado ou service role — antes respondia a
// qualquer chamador com a chave pública, devolvendo amostra de intimação real.

// Quem pode chamar: usuário logado (JWT validado no Auth) ou a service role
// (painel do Supabase). O verify_jwt do gateway aceita a chave pública, então
// a autenticação real acontece aqui.
async function chamadorPrivilegiado(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return false;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (service && jwt === service) return true;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jwt}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const NAO_AUTORIZADO = () =>
  new Response(JSON.stringify({ error: "Nao autenticado" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (!(await chamadorPrivilegiado(req))) return NAO_AUTORIZADO();

  const url = "https://comunicaapi.pje.jus.br/api/v1/comunicacao" +
    "?numeroOab=82728&ufOab=RS" +
    "&dataDisponibilizacaoInicio=2026-07-15&dataDisponibilizacaoFim=2026-07-22" +
    "&pagina=1&itensPorPagina=5";
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const texto = await resp.text();
    let json: unknown = null;
    try { json = JSON.parse(texto); } catch { /* não é json */ }
    const j = json as Record<string, unknown> | null;
    const itens = (j?.items ?? j) as unknown;
    const primeiro = Array.isArray(itens) ? itens[0] : null;
    return new Response(JSON.stringify({
      ok: true,
      status: resp.status,
      ms: Date.now() - t0,
      count: j?.count ?? null,
      qtd_itens: Array.isArray(itens) ? itens.length : null,
      chaves_topo: j && !Array.isArray(j) ? Object.keys(j) : null,
      chaves_item: primeiro ? Object.keys(primeiro as object) : null,
      amostra: primeiro
        ? JSON.stringify(primeiro).slice(0, 1200)
        : texto.slice(0, 600),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, ms: Date.now() - t0, erro: String(e), nome: (e as Error)?.name,
    }, null, 2), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
