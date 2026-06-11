// Passo 6 — Edge Function de ENVIO: enviar-alvara (SMTP Locaweb).
//
// REGRA DE OURO Nº 1: esta função é a ÚNICA que envia e-mail, e só roda quando
// chamada explicitamente (o botão "Enviar" da tela de aprovação — Passo 7).
// Não há gatilho automático apontando para cá.
//
// Fluxo: recebe { alvara_id } -> lê o alvará (com o JWT do usuário, RLS preservado)
// -> valida (status 'aguardando_aprovacao' e e-mail do prestador cadastrado)
// -> monta o corpo (bruto E líquido, data do creditamento, conta) -> envia via
// SMTP Locaweb -> só após sucesso marca status = 'enviado'.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { formatarCentavosBRL } from "../_shared/enriquecimento.ts";

const REMETENTE = Deno.env.get("LOCAWEB_SMTP_USER") ?? "contato@martinscorreadasilva.com.br";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/** "2026-04-08" -> "08/04/2026" (exibição no e-mail). */
function isoParaBR(iso: string | null): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const smtpPass = Deno.env.get("LOCAWEB_SMTP_PASS") ?? "";
    if (!smtpPass) return json({ error: "LOCAWEB_SMTP_PASS ausente nos secrets" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Sem Authorization (JWT do usuario)" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Usuario nao autenticado" }, 401);

    const { alvara_id } = await req.json().catch(() => ({}));
    if (!alvara_id) return json({ error: "Informe alvara_id" }, 400);

    // Lê o alvará (RLS garante que é do próprio usuário).
    const { data: alvara, error: selErr } = await supabase
      .from("alvaras")
      .select("*")
      .eq("id", alvara_id)
      .single();
    if (selErr || !alvara) return json({ error: "Alvara nao encontrado" }, 404);

    // Validações (nada envia se não estiver no estado certo).
    if (alvara.status === "enviado") {
      return json({ error: "Este alvara ja foi enviado" }, 409);
    }
    if (alvara.status !== "aguardando_aprovacao") {
      return json({ error: `Status invalido para envio: ${alvara.status}` }, 409);
    }
    if (!alvara.email_destino) {
      return json({ error: "Prestador sem e-mail cadastrado. Cadastre antes de enviar." }, 400);
    }

    // Monta o corpo: bruto E líquido, data do creditamento, conta.
    const linhas = [
      `Prezado(a) ${alvara.prestador || "prestador"},`,
      ``,
      `Informamos que foi expedido alvara judicial em seu favor nos autos do processo ${alvara.processo || "-"}.`,
      ``,
      `Alvara n.: ${alvara.numero_alvara || "-"}`,
      `Valor bruto: ${formatarCentavosBRL(alvara.valor_bruto_centavos ?? 0)}`,
      `Valor liquido creditado: ${formatarCentavosBRL(alvara.valor_liquido_creditado_centavos ?? 0)}`,
      `Data do creditamento: ${isoParaBR(alvara.data_creditamento)}`,
      `Conta de credito: banco ${alvara.banco || "-"}, agencia ${alvara.agencia || "-"}, conta ${alvara.conta || "-"}`,
      ``,
      `Atenciosamente,`,
      `Martins, Correa da Silva Advogados`,
    ];
    const corpo = linhas.join("\n");
    const assunto = `Aviso de alvara expedido - processo ${alvara.processo || alvara.numero_alvara || ""}`.trim();

    // Suporte a múltiplos destinatários: email_destino pode conter e-mails
    // separados por vírgula ou ponto-e-vírgula (ex.: "a@x.com, b@x.com").
    const destinatarios = alvara.email_destino
      .split(/[,;]+/)
      .map((e: string) => e.trim())
      .filter((e: string) => e.includes("@"));
    if (destinatarios.length === 0) {
      return json({ error: "Nenhum e-mail válido em email_destino" }, 400);
    }

    // Envio SMTP Locaweb. Remetente = conta autenticada (exigência da Locaweb).
    const client = new SMTPClient({
      connection: {
        hostname: "email-ssl.com.br",
        port: 465,
        tls: true,
        auth: { username: REMETENTE, password: smtpPass },
      },
    });

    try {
      await client.send({
        from: REMETENTE,
        to: destinatarios,
        subject: assunto,
        content: corpo,
      });
    } finally {
      await client.close();
    }

    // Só marca 'enviado' APÓS o envio bem-sucedido.
    const { error: upErr } = await supabase
      .from("alvaras")
      .update({ status: "enviado", atualizado_em: new Date().toISOString() })
      .eq("id", alvara_id);
    if (upErr) {
      // E-mail saiu, mas falhou marcar — sinaliza para evitar reenvio cego.
      return json({
        ok: true,
        aviso: `E-mail enviado, mas falhou atualizar status: ${upErr.message}`,
        email_destino: alvara.email_destino,
      }, 200);
    }

    return json({ ok: true, status: "enviado", email_destino: destinatarios }, 200);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
