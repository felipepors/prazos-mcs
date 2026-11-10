// Diagnóstico de SMTP: testa APENAS se a Edge Function consegue abrir
// conexão TCP no host/porta configurados. Nunca trava (timeout de 6s)
// e nunca revela a senha.
// v3 (10/11/2026): exige usuário logado ou service role — antes respondia a
// qualquer chamador com a chave pública, expondo host, usuário e e-mail de alerta.

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

  const host = Deno.env.get("SMTP_HOST") ?? "";
  const porta = Number(Deno.env.get("SMTP_PORT") ?? 0);
  const usuario = Deno.env.get("SMTP_USER") ?? "";
  const temSenha = Boolean(Deno.env.get("SMTP_PASS"));
  const alerta = Deno.env.get("ALERTA_EMAIL") ?? "";

  const base = {
    host_configurado: host || null,
    porta_configurada: porta || null,
    usuario_configurado: usuario || null,
    senha_presente: temSenha,
    alerta_email: alerta || null,
  };

  if (!host || !porta) {
    return new Response(
      JSON.stringify({ ...base, conexao: "secrets incompletos" }, null, 2),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const t0 = Date.now();
  let resultado: Record<string, unknown>;
  try {
    const conn = await Promise.race([
      Deno.connect({ hostname: host, port: porta }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("TIMEOUT_6s")), 6000)
      ),
    ]);
    // Lê o banner de saúda do servidor SMTP (220 ...)
    const buf = new Uint8Array(200);
    const n = await Promise.race([
      conn.read(buf),
      new Promise<null>((res) => setTimeout(() => res(null), 4000)),
    ]);
    const banner = n
      ? new TextDecoder().decode(buf.subarray(0, n as number)).trim()
      : "(sem banner em 4s)";
    conn.close();
    resultado = { conexao: "OK", ms: Date.now() - t0, banner };
  } catch (e) {
    resultado = {
      conexao: "FALHOU",
      ms: Date.now() - t0,
      erro: String(e),
      nome_erro: (e as Error)?.name ?? null,
    };
  }

  return new Response(JSON.stringify({ ...base, ...resultado }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
