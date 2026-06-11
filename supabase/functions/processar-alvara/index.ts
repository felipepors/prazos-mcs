// Passo 4 — Edge Function orquestradora: processar-alvara
//
// Fluxo: PDF -> extracao (Claude, Passo 1) -> enriquecimento deterministico
// (Passo 2) -> matching CNPJ/CPF -> e-mail na tabela `prestadores` -> grava em
// `alvaras` com status 'aguardando_aprovacao'.
//
// REGRAS DE OURO:
//  - nº 1: grava como 'aguardando_aprovacao'. NUNCA envia e-mail aqui (isso é o
//          Passo 6, e só na aprovacao manual do Felipe).
//  - nº 4: o valor liquido vem do enriquecimento (codigo), nunca do modelo.
//  - nº 5: usa o JWT do chamador, entao o RLS por usuario (auth.uid() = user_id)
//          continua valendo — sem service_role aqui.
//
// Entrada (POST JSON): { pdf_base64?: string, storage_path?: string }
//  - pdf_base64: o PDF em base64 (caminho direto / testes)
//  - storage_path: caminho no bucket 'alvaras' (usado pelo gatilho do Passo 5)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { extrairAlvara } from "../_shared/extracao.ts";
import { enriquecer } from "../_shared/enriquecimento.ts";

const BUCKET = "alvaras";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY ausente nos secrets" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Sem Authorization (JWT do usuario)" }, 401);

    // Cliente vinculado ao JWT do chamador -> RLS por usuario continua valendo.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Usuario nao autenticado" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const storagePath: string | undefined = body.storage_path;
    let pdfBase64: string | undefined = body.pdf_base64;

    // Se veio caminho de Storage, baixa o PDF pelo proprio cliente do usuario.
    if (!pdfBase64 && storagePath) {
      const { data: file, error: dlErr } = await supabase.storage.from(BUCKET).download(storagePath);
      if (dlErr || !file) return json({ error: `Falha ao baixar ${storagePath}: ${dlErr?.message}` }, 400);
      pdfBase64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
    }
    if (!pdfBase64) return json({ error: "Informe pdf_base64 ou storage_path" }, 400);

    // 1) Extracao (so transcricao)  2) Enriquecimento (calculo deterministico)
    const extraido = await extrairAlvara(pdfBase64, apiKey);
    const alvara = enriquecer(extraido);

    // 3) Matching CNPJ/CPF -> e-mail em prestadores (documento = so digitos).
    const documentoDigitos = alvara.documento.replace(/\D/g, "");
    let prestadorId: string | null = null;
    let emailDestino: string | null = null;
    if (documentoDigitos) {
      const { data: prestador } = await supabase
        .from("prestadores")
        .select("id, email")
        .eq("documento", documentoDigitos)
        .maybeSingle();
      if (prestador) {
        prestadorId = prestador.id;
        emailDestino = prestador.email;
      }
    }

    // 4) Grava em alvaras como aguardando_aprovacao (rascunho — nao envia nada).
    const { data: inserido, error: insErr } = await supabase
      .from("alvaras")
      .insert({
        user_id: userId,
        status: "aguardando_aprovacao",
        numero_alvara: alvara.numero_alvara,
        processo: alvara.processo,
        juizo: alvara.juizo,
        prestador: alvara.prestador,
        documento: alvara.documento,
        documento_tipo: alvara.documento_tipo,
        documento_valido: alvara.documento_valido,
        valor_bruto_centavos: alvara.valor_bruto_centavos,
        despesa_bancaria_centavos: alvara.despesa_bancaria_centavos,
        imposto_renda_centavos: alvara.imposto_renda_centavos,
        valor_liquido_creditado_centavos: alvara.valor_liquido_creditado_centavos,
        data_creditamento: alvara.data_creditamento || null,
        data_expedicao: alvara.data_expedicao || null,
        banco: alvara.banco,
        agencia: alvara.agencia,
        conta: alvara.conta,
        prestador_id: prestadorId,
        email_destino: emailDestino,
        pdf_path: storagePath ?? null,
      })
      .select()
      .single();

    if (insErr) return json({ error: `Falha ao gravar alvara: ${insErr.message}` }, 500);

    return json({
      ok: true,
      alvara: inserido,
      // sinaliza ao dashboard quando o CNPJ ainda nao tem e-mail cadastrado
      prestador_encontrado: prestadorId !== null,
      documento_digitos: documentoDigitos,
    }, 201);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
