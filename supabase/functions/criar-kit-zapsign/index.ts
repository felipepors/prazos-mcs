import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const ZAPSIGN_API = "https://api.zapsign.com.br/api/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = Deno.env.get("ZAPSIGN_TOKEN");
    if (!token) throw new Error("ZAPSIGN_TOKEN nao configurado");
    const { nome, email, whatsapp, procuracao_b64, declaracao_b64, contrato_b64 } = await req.json();
    if (!nome || !email) throw new Error("nome e email sao obrigatorios");
    if (!procuracao_b64 || !declaracao_b64 || !contrato_b64) throw new Error("Os 3 documentos sao obrigatorios");
    const zH = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const signer: Record<string, string> = { name: nome, email };
    if (whatsapp) { const n = whatsapp.replace(/\D/g,"").replace(/^55/,""); signer.phone_country="55"; signer.phone_number=n; }
    const r1 = await fetch(`${ZAPSIGN_API}/docs/`, { method:"POST", headers:zH, body: JSON.stringify({ name:`Kit contratacao - ${nome}`, base64_pdf:procuracao_b64, folder_path:`Contratos/${nome.substring(0,40)}`, signers:[signer] }) });
    const env = await r1.json();
    if (!r1.ok) throw new Error(`ZapSign erro: ${JSON.stringify(env)}`);
    const token_doc: string = env.token;
    const sign_url: string = env.signers[0].sign_url;
    const r2 = await fetch(`${ZAPSIGN_API}/docs/${token_doc}/extra-docs/`, { method:"POST", headers:zH, body: JSON.stringify({ name:"Declaracao de hipossuficiencia", base64_pdf:declaracao_b64 }) });
    if (!r2.ok) { const e=await r2.json(); throw new Error(`ZapSign declaracao: ${JSON.stringify(e)}`); }
    const r3 = await fetch(`${ZAPSIGN_API}/docs/${token_doc}/extra-docs/`, { method:"POST", headers:zH, body: JSON.stringify({ name:"Contrato de honorarios", base64_pdf:contrato_b64 }) });
    if (!r3.ok) { const e=await r3.json(); throw new Error(`ZapSign contrato: ${JSON.stringify(e)}`); }
    return new Response(JSON.stringify({ sign_url, token_doc }), { headers: { ...CORS, "Content-Type":"application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status:400, headers: { ...CORS, "Content-Type":"application/json" } });
  }
});
