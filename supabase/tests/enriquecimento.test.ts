// Teste do Passo 2 (enriquecimento). 100% offline e determinístico — sem rede,
// sem API key, sem PDF. Usa um assert mínimo inline para não baixar dependências.
//
// Rodar:  deno test supabase/tests/enriquecimento.test.ts
//
// O fixture reproduz a transcrição CRUA do alvará real (o que o Passo 1 devolve)
// e exige que o enriquecimento produza EXATAMENTE os valores do CLAUDE.md —
// em especial o líquido R$ 19.142,00.

import {
  dataBRparaISO,
  dataExtensoParaISO,
  enriquecer,
  formatarCentavosBRL,
  limparNome,
  parseValorParaCentavos,
  resolverDocumento,
  validarCNPJ,
  validarCPF,
} from "../functions/_shared/enriquecimento.ts";
import type { AlvaraExtraido } from "../functions/_shared/extracao.ts";

function assertEquals<T>(atual: T, esperado: T, msg?: string): void {
  if (atual !== esperado) {
    throw new Error(`${msg ?? "assertEquals"}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Transcrição crua do alvará de referência (saída esperada do Passo 1).
const FIXTURE_CRU: AlvaraExtraido = {
  numero_alvara: "001.26/500190264",
  processo: "5141986-86.2023.8.21.0001",
  juizo: "1ª Vara Cível",
  beneficiario_nome: "EXCELENCIA ASSISTENCIA EM SAUDE EIRELI (INTIMADO)",
  beneficiario_doc: "19.009.309/0001-70",
  valor_alvara: "19.150,00",
  despesa_bancaria: "8,00",
  imposto_renda: "0,00",
  data_creditamento: "08/04/2026",
  data_expedicao: "07 de abril de 2026",
  banco: "Banco do Brasil",
  agencia: "1234-5",
  conta: "67890-1",
};

Deno.test("enriquecer bate EXATAMENTE o fixture do alvará real", () => {
  const r = enriquecer(FIXTURE_CRU);

  assertEquals(r.prestador, "EXCELENCIA ASSISTENCIA EM SAUDE EIRELI", "prestador");
  assertEquals(r.documento, "19.009.309/0001-70", "documento");
  assertEquals(r.documento_tipo, "CNPJ", "documento_tipo");
  assertEquals(r.documento_valido, true, "documento_valido");
  assertEquals(r.processo, "5141986-86.2023.8.21.0001", "processo");
  assertEquals(r.numero_alvara, "001.26/500190264", "numero_alvara");
  assertEquals(r.valor_bruto_brl, "R$ 19.150,00", "valor_bruto_brl");
  assertEquals(r.despesa_bancaria_brl, "R$ 8,00", "despesa_bancaria_brl");
  assertEquals(r.imposto_renda_brl, "R$ 0,00", "imposto_renda_brl");
  assertEquals(r.valor_liquido_creditado_brl, "R$ 19.142,00", "valor_liquido_creditado_brl");
  assertEquals(r.valor_liquido_creditado_centavos, 1914200, "liquido_centavos");
  assertEquals(r.data_creditamento, "2026-04-08", "data_creditamento");
  assertEquals(r.data_expedicao, "2026-04-07", "data_expedicao");
});

Deno.test("documento rotulado errado como CPF mas com 14 dígitos vira CNPJ", () => {
  const d = resolverDocumento("CPF: 19.009.309/0001-70");
  assertEquals(d.tipo, "CNPJ", "tipo");
  assertEquals(d.documento, "19.009.309/0001-70", "documento");
  assertEquals(d.valido, true, "valido");
});

Deno.test("valores: parse e formatação BRL", () => {
  assertEquals(parseValorParaCentavos("19.150,00"), 1915000, "bruto");
  assertEquals(parseValorParaCentavos("8,00"), 800, "despesa");
  assertEquals(parseValorParaCentavos("0,00"), 0, "ir");
  assertEquals(parseValorParaCentavos("R$ 1.234,56"), 123456, "com prefixo");
  assertEquals(formatarCentavosBRL(1914200), "R$ 19.142,00", "fmt grande");
  assertEquals(formatarCentavosBRL(800), "R$ 8,00", "fmt pequeno");
});

Deno.test("limpeza de sufixos de status do nome", () => {
  assertEquals(limparNome("FULANO LTDA (INTIMADO)"), "FULANO LTDA", "intimado");
  assertEquals(limparNome("BELTRANA ME (CITADA)"), "BELTRANA ME", "citada");
  assertEquals(limparNome("SEM SUFIXO SA"), "SEM SUFIXO SA", "sem sufixo");
});

Deno.test("datas em ISO", () => {
  assertEquals(dataBRparaISO("08/04/2026"), "2026-04-08", "creditamento");
  assertEquals(dataExtensoParaISO("07 de abril de 2026"), "2026-04-07", "expedicao");
  assertEquals(dataExtensoParaISO("1 de março de 2026"), "2026-03-01", "com acento");
});

Deno.test("validadores de dígito verificador", () => {
  assert(validarCNPJ("19009309000170"), "CNPJ válido");
  assert(!validarCNPJ("19009309000171"), "CNPJ inválido");
  assert(validarCPF("52998224725"), "CPF válido");
  assert(!validarCPF("52998224724"), "CPF inválido");
  assert(!validarCNPJ("11111111111111"), "CNPJ repetido inválido");
});
