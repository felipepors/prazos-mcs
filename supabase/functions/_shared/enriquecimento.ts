// Passo 2 — Enriquecimento determinístico do alvará (TypeScript puro).
//
// Recebe o JSON CRU da extração (Passo 1, só transcrição) e produz os campos
// derivados. REGRA DE OURO Nº 4: todo cálculo e validação vive AQUI, em código
// determinístico — o modelo de IA nunca calcula valor, converte data ou valida
// dígito. Nada de rede, nada de segredo: é função pura, testável offline.

import type { AlvaraExtraido } from "./extracao.ts";

export type TipoDocumento = "CNPJ" | "CPF" | "DESCONHECIDO";

export interface AlvaraEnriquecido {
  numero_alvara: string;
  processo: string;
  juizo: string;
  /** Nome do prestador já sem sufixos de status como "(INTIMADO)". */
  prestador: string;
  /** Documento formatado (CNPJ: NN.NNN.NNN/NNNN-NN | CPF: NNN.NNN.NNN-NN). */
  documento: string;
  documento_tipo: TipoDocumento;
  documento_valido: boolean;
  // Valores em centavos (inteiros) para cálculo exato, sem ponto flutuante:
  valor_bruto_centavos: number;
  despesa_bancaria_centavos: number;
  imposto_renda_centavos: number;
  valor_liquido_creditado_centavos: number;
  // Mesmos valores formatados em BRL para exibição:
  valor_bruto_brl: string;
  despesa_bancaria_brl: string;
  imposto_renda_brl: string;
  valor_liquido_creditado_brl: string;
  /** Data ISO (AAAA-MM-DD) do creditamento. */
  data_creditamento: string;
  /** Data ISO (AAAA-MM-DD) da expedição. */
  data_expedicao: string;
  banco: string;
  agencia: string;
  conta: string;
}

// --- Valores monetários (BRL) ---------------------------------------------

/** "19.150,00" → 1915000 (centavos). Tolera "R$", espaços e ausência de centavos. */
export function parseValorParaCentavos(valor: string): number {
  const limpo = (valor ?? "").trim().replace(/[^\d,.-]/g, "");
  if (!limpo) return 0;
  // Padrão brasileiro: "." separa milhar, "," separa decimal.
  const semMilhar = limpo.replace(/\./g, "");
  const negativo = semMilhar.startsWith("-");
  const [inteira, decimal = "0"] = semMilhar.replace("-", "").split(",");
  const centavos = decimal.padEnd(2, "0").slice(0, 2);
  const total = Number(inteira || "0") * 100 + Number(centavos || "0");
  return negativo ? -total : total;
}

/** 1914200 → "R$ 19.142,00" (espaço normal, ponto de milhar, vírgula decimal). */
export function formatarCentavosBRL(centavos: number): string {
  const sinal = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  const reais = Math.floor(abs / 100);
  const cent = abs % 100;
  const reaisStr = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sinal}R$ ${reaisStr},${String(cent).padStart(2, "0")}`;
}

// --- Documento (CPF/CNPJ) --------------------------------------------------

function soDigitos(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Valida dígitos verificadores de um CNPJ (14 dígitos). */
export function validarCNPJ(digitos: string): boolean {
  if (digitos.length !== 14 || /^(\d)\1{13}$/.test(digitos)) return false;
  const calc = (tamanho: number): number => {
    const pesos = tamanho === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(digitos[i]) * pesos[i];
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return calc(12) === Number(digitos[12]) && calc(13) === Number(digitos[13]);
}

/** Valida dígitos verificadores de um CPF (11 dígitos). */
export function validarCPF(digitos: string): boolean {
  if (digitos.length !== 11 || /^(\d)\1{10}$/.test(digitos)) return false;
  const calc = (tamanho: number): number => {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(digitos[i]) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calc(9) === Number(digitos[9]) && calc(10) === Number(digitos[10]);
}

function formatarCNPJ(d: string): string {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

function formatarCPF(d: string): string {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

interface DocResolvido {
  documento: string;
  tipo: TipoDocumento;
  valido: boolean;
}

/**
 * Infere o tipo pelo nº de dígitos (14 = CNPJ, 11 = CPF) — corrige rótulos
 * errados (PDF dizendo "CPF" num número de 14 dígitos) — e valida o dígito.
 */
export function resolverDocumento(docCru: string): DocResolvido {
  const dig = soDigitos(docCru);
  if (dig.length === 14) {
    return { documento: formatarCNPJ(dig), tipo: "CNPJ", valido: validarCNPJ(dig) };
  }
  if (dig.length === 11) {
    return { documento: formatarCPF(dig), tipo: "CPF", valido: validarCPF(dig) };
  }
  return { documento: (docCru ?? "").trim(), tipo: "DESCONHECIDO", valido: false };
}

// --- Nome do prestador -----------------------------------------------------

const SUFIXO_STATUS =
  /\s*\((?:INTIMAD[OA]|CITAD[OA]|ADVOGAD[OA](?:\s+EXEQUENTE)?|EXEQUENTE)\)\s*$/i;

/**
 * Remove sufixos de status/papel: "(INTIMADO)", "(INTIMADA)", "(CITADO)",
 * "(CITADA)", "(ADVOGADO)", "(ADVOGADO EXEQUENTE)", "(EXEQUENTE)".
 */
export function limparNome(nome: string): string {
  let n = (nome ?? "").trim();
  while (SUFIXO_STATUS.test(n)) n = n.replace(SUFIXO_STATUS, "").trim();
  return n;
}

// --- Datas → ISO -----------------------------------------------------------

/** "08/04/2026" → "2026-04-08". */
export function dataBRparaISO(s: string): string {
  const m = (s ?? "").trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const MESES: Record<string, string> = {
  janeiro: "01", fevereiro: "02", "março": "03", marco: "03", abril: "04",
  maio: "05", junho: "06", julho: "07", agosto: "08", setembro: "09",
  outubro: "10", novembro: "11", dezembro: "12",
};

/** "07 de abril de 2026" → "2026-04-07". */
export function dataExtensoParaISO(s: string): string {
  const m = (s ?? "").trim().toLowerCase().match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);
  if (!m) return "";
  const mes = MESES[m[2]];
  if (!mes) return "";
  return `${m[3]}-${mes}-${m[1].padStart(2, "0")}`;
}

// --- Conferência antes do envio --------------------------------------------

/** Número único CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO */
const PADRAO_CNJ = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

/** Campos de um alvará gravado (linha de `alvaras`) usados na conferência. */
export interface AlvaraParaConferir {
  valor_bruto_centavos?: number | null;
  despesa_bancaria_centavos?: number | null;
  imposto_renda_centavos?: number | null;
  valor_liquido_creditado_centavos?: number | null;
  documento_valido?: boolean | null;
  data_creditamento?: string | null;
  processo?: string | null;
  numero_alvara?: string | null;
}

export interface Conferencia {
  /** Impedem o envio: o aviso sairia com valor errado. */
  bloqueios: string[];
  /** Não impedem, mas pedem conferência humana no PDF. */
  avisos: string[];
}

/**
 * Regras determinísticas que separam "extração boa" de "extração falhou".
 * Uma transcrição vazia vira 0 centavos em parseValorParaCentavos — sem esta
 * conferência, um aviso com "Valor bruto: R$ 0,00" podia ser enviado.
 * ESPELHADA em src/App.jsx (conferirAlvara) — manter as duas em sincronia.
 */
export function conferirAlvara(a: AlvaraParaConferir): Conferencia {
  const bloqueios: string[] = [];
  const avisos: string[] = [];
  const bruto = a.valor_bruto_centavos ?? 0;
  const despesa = a.despesa_bancaria_centavos ?? 0;
  const ir = a.imposto_renda_centavos ?? 0;
  const liquido = a.valor_liquido_creditado_centavos ?? 0;

  if (bruto <= 0) bloqueios.push("Valor bruto zerado ou ausente — a extração provavelmente falhou");
  if (despesa < 0) bloqueios.push("Despesa bancária negativa");
  if (ir < 0) bloqueios.push("Imposto de renda negativo");
  if (liquido !== bruto - despesa - ir) {
    bloqueios.push("Valor líquido não bate com bruto − despesa − IR");
  }
  if (bruto > 0 && liquido <= 0) bloqueios.push("Valor líquido zerado ou negativo");

  if (!a.documento_valido) avisos.push("CNPJ/CPF com dígito verificador inválido ou não identificado");
  if (!a.data_creditamento) avisos.push("Data do creditamento não encontrada no PDF");
  const processo = (a.processo ?? "").trim();
  if (!processo) avisos.push("Número do processo não encontrado no PDF");
  else if (!PADRAO_CNJ.test(processo)) avisos.push("Número do processo fora do padrão CNJ — confira");
  if (!(a.numero_alvara ?? "").trim()) avisos.push("Número do alvará não encontrado");

  return { bloqueios, avisos };
}

// --- Orquestração ----------------------------------------------------------

export function enriquecer(e: AlvaraExtraido): AlvaraEnriquecido {
  const doc = resolverDocumento(e.beneficiario_doc);

  const bruto = parseValorParaCentavos(e.valor_alvara);
  const despesa = parseValorParaCentavos(e.despesa_bancaria);
  const ir = parseValorParaCentavos(e.imposto_renda);
  const liquido = bruto - despesa - ir;

  return {
    numero_alvara: (e.numero_alvara ?? "").trim(),
    processo: (e.processo ?? "").trim(),
    juizo: (e.juizo ?? "").trim(),
    prestador: limparNome(e.beneficiario_nome),
    documento: doc.documento,
    documento_tipo: doc.tipo,
    documento_valido: doc.valido,
    valor_bruto_centavos: bruto,
    despesa_bancaria_centavos: despesa,
    imposto_renda_centavos: ir,
    valor_liquido_creditado_centavos: liquido,
    valor_bruto_brl: formatarCentavosBRL(bruto),
    despesa_bancaria_brl: formatarCentavosBRL(despesa),
    imposto_renda_brl: formatarCentavosBRL(ir),
    valor_liquido_creditado_brl: formatarCentavosBRL(liquido),
    data_creditamento: dataBRparaISO(e.data_creditamento),
    // Extenso no rodapé (modelo clássico) ou DD/MM/AAAA ("Data Assinatura").
    data_expedicao: dataExtensoParaISO(e.data_expedicao) || dataBRparaISO(e.data_expedicao),
    banco: (e.banco ?? "").trim(),
    agencia: (e.agencia ?? "").trim(),
    conta: (e.conta ?? "").trim(),
  };
}
