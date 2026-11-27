// Passo 1 — Extração de alvará via Claude API (claude-haiku-4-5).
//
// REGRA DE OURO Nº 4: o modelo de IA SÓ TRANSCREVE os números do PDF.
// Nenhum cálculo, conversão de data ou validação de dígito acontece aqui — isso
// é responsabilidade do enriquecimento determinístico (Passo 2). Os campos saem
// exatamente como aparecem no PDF.
//
// A chamada usa structured outputs (output_config.format) para forçar o modelo a
// devolver precisamente o schema abaixo, sem texto extra para fazer parsing frágil.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODELO = "claude-haiku-4-5";

/** JSON cru devolvido pela extração — strings "como vieram no PDF". */
export interface AlvaraExtraido {
  numero_alvara: string;
  processo: string;
  juizo: string;
  beneficiario_nome: string;
  /** CPF ou CNPJ exatamente como rotulado no PDF (o tipo é inferido no Passo 2). */
  beneficiario_doc: string;
  valor_alvara: string;
  despesa_bancaria: string;
  imposto_renda: string;
  /** Formato DD/MM/AAAA, como no campo "Creditado em". */
  data_creditamento: string;
  /** Data por extenso do rodapé. */
  data_expedicao: string;
  banco: string;
  agencia: string;
  conta: string;
}

// Schema enviado ao modelo (structured outputs exige additionalProperties:false
// e, por robustez, todos os campos em `required`).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    numero_alvara: { type: "string" },
    processo: { type: "string" },
    juizo: { type: "string" },
    beneficiario_nome: { type: "string" },
    beneficiario_doc: { type: "string" },
    valor_alvara: { type: "string" },
    despesa_bancaria: { type: "string" },
    imposto_renda: { type: "string" },
    data_creditamento: { type: "string" },
    data_expedicao: { type: "string" },
    banco: { type: "string" },
    agencia: { type: "string" },
    conta: { type: "string" },
  },
  required: [
    "numero_alvara",
    "processo",
    "juizo",
    "beneficiario_nome",
    "beneficiario_doc",
    "valor_alvara",
    "despesa_bancaria",
    "imposto_renda",
    "data_creditamento",
    "data_expedicao",
    "banco",
    "agencia",
    "conta",
  ],
} as const;

const SYSTEM_PROMPT =
  "Você extrai dados de alvarás judiciais brasileiros (PDF). Transcreva os " +
  "valores EXATAMENTE como aparecem no documento. NÃO calcule, NÃO some, NÃO " +
  "subtraia, NÃO converta datas e NÃO valide documentos — apenas copie o que está " +
  "escrito. Se um campo não existir no PDF, devolva string vazia — nunca preencha " +
  "um campo com o conteúdo de outro. O PDF pode ser uma imagem escaneada ou uma " +
  "captura de tela, inclusive com a página girada 90°: leia na orientação do texto " +
  "e copie cada dígito com cuidado (CPF, CNPJ, agência e conta).";

// Há mais de um modelo de alvará. Os rótulos entre aspas são os que já vimos:
// o modelo "clássico" (fixture Excelência) e o extrato do sistema de alvarás
// eletrônicos ("Dados Gerais" / "Dados Pós Assinatura"), visto em 27/11/2026.
const INSTRUCAO =
  "Extraia os campos do alvará deste PDF e devolva no formato estruturado pedido. " +
  "Regras de transcrição (os rótulos mudam conforme o modelo do alvará):\n" +
  "- numero_alvara: o número após \"Alvará\" / \"Alvará nº\".\n" +
  "- processo: SOMENTE o número do processo judicial (padrão CNJ, ex.: " +
  "\"5141986-86.2023.8.21.0001\"). Se o documento não trouxer número de processo, " +
  "devolva vazio. Nunca use valor em dinheiro, número do alvará ou de pedido como processo.\n" +
  "- juizo: a vara / juízo / órgão julgador. Nome de juiz (\"Juiz Assinante\", " +
  "\"Juiz Indicado\") NÃO é juízo — se só houver o nome do juiz, devolva vazio.\n" +
  "- valor_alvara: \"Valor Alvará\" / \"Valor do alvará\" / valor bruto.\n" +
  "- despesa_bancaria: \"Despesa bancária\" ou \"Valor Tarifa\" / \"Tarifa\".\n" +
  "- imposto_renda: \"Imposto de renda\" ou \"Valor Imp. Renda\".\n" +
  "  Nos três valores, copie o número como está (ex.: \"19.150,00\", \"8,00\", " +
  "\"0,00\"), sem \"R$\" se preferir. Não calcule o líquido.\n" +
  "- beneficiario_nome: o nome após \"Beneficiário\", inteiro, inclusive sufixos " +
  "entre parênteses como \"(INTIMADO)\" ou \"(ADVOGADO EXEQUENTE)\" (a limpeza é feita depois).\n" +
  "- beneficiario_doc: \"CPF/CNPJ Beneficiário\" ou o documento do beneficiário, " +
  "como está, mesmo que rotulado \"CPF\".\n" +
  "- data_creditamento: o que vem após \"Creditado em\"; se não houver, \"Data Resgate\"; " +
  "se não houver, \"Data Prev. Pgto\" (DD/MM/AAAA).\n" +
  "- data_expedicao: a data por extenso do rodapé; se não houver, \"Data Assinatura\" " +
  "(copie como está, extenso ou DD/MM/AAAA).\n" +
  "- banco, agencia, conta: a conta que RECEBE o crédito do beneficiário " +
  "(\"Banco Transf.\", \"Agência Transf.\", \"Conta Transf.\", ou a conta de crédito). " +
  "NÃO use \"Agência Depósito\" / \"Conta Depósito\" — essa é a conta judicial de origem.";

/**
 * Chama a Claude API com o PDF (base64) e devolve o JSON do schema.
 * @param pdfBase64 conteúdo do PDF em base64 (sem prefixo data:)
 * @param apiKey    ANTHROPIC_API_KEY (vem de env/secret, nunca hardcoded)
 */
export async function extrairAlvara(
  pdfBase64: string,
  apiKey: string,
): Promise<AlvaraExtraido> {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY ausente");
  if (!pdfBase64) throw new Error("PDF (base64) vazio");

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            { type: "text", text: INSTRUCAO },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    }),
  });

  if (!resp.ok) {
    const corpo = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${corpo}`);
  }

  const data = await resp.json();

  if (data.stop_reason === "refusal") {
    throw new Error(`Extração recusada pelo modelo: ${JSON.stringify(data.stop_details)}`);
  }

  // Com structured outputs, o JSON vem dentro de um bloco de texto.
  const blocoTexto = Array.isArray(data.content)
    ? data.content.find((b: { type: string }) => b.type === "text")
    : null;
  if (!blocoTexto?.text) {
    throw new Error(`Resposta sem bloco de texto: ${JSON.stringify(data)}`);
  }

  return JSON.parse(blocoTexto.text) as AlvaraExtraido;
}
