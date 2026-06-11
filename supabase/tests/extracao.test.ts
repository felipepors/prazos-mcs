// Teste do Passo 1 (extração). Faz uma chamada REAL à Claude API, então só roda
// quando você tem (a) ANTHROPIC_API_KEY no ambiente e (b) um PDF de alvará real
// em supabase/tests/fixtures/. Caso falte algo, o teste é ignorado (não falha) —
// assim o repo permanece testável sem expor segredos nem PDFs sensíveis.
//
// Rodar:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   deno test --allow-env --allow-read --allow-net supabase/tests/extracao.test.ts
//
// Dica: deno run --env-file=.env … carrega a chave do .env automaticamente.

import { encodeBase64 } from "jsr:@std/encoding/base64";
import { extrairAlvara } from "../functions/_shared/extracao.ts";

const FIXTURE = new URL("./fixtures/alvara-excelencia.pdf", import.meta.url);

function fixtureExiste(): boolean {
  try {
    Deno.statSync(FIXTURE);
    return true;
  } catch {
    return false;
  }
}

const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const podeRodar = apiKey.length > 0 && fixtureExiste();

Deno.test({
  name: "extrairAlvara transcreve os campos do PDF real",
  ignore: !podeRodar,
  fn: async () => {
    const pdfBase64 = encodeBase64(Deno.readFileSync(FIXTURE));
    const r = await extrairAlvara(pdfBase64, apiKey);

    // O modelo SÓ transcreve — validamos que veio o texto cru, sem cálculo.
    console.log("Extração:", JSON.stringify(r, null, 2));

    if (!r.processo) throw new Error("processo vazio");
    if (!r.valor_alvara) throw new Error("valor_alvara vazio");
    if (!r.beneficiario_doc) throw new Error("beneficiario_doc vazio");
    // Conferência leve contra o alvará de referência (ver fixtures/README.md):
    if (!r.processo.includes("5141986-86.2023.8.21.0001")) {
      throw new Error(`processo inesperado: ${r.processo}`);
    }
  },
});
