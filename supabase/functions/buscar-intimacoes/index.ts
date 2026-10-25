// ============================================================
// FASE 1 (v11) — Edge Function: buscar-intimacoes
// Porta server-side da lógica COMPROVADA do monitor_intimacoes.py.
// v11: ALERTA "DIA ÚTIL SEM INTIMAÇÃO NOVA". A regra anterior olhava o
//      TOTAL da janela de 7 dias, que nunca zera — por isso não disparou em
//      06–08/10/2026, quando o índice da API Comunica devolvia sucesso com
//      dados incompletos. Agora: rodada do cron, em dia útil, sem erro e com
//      ZERO novas do DJEN (DEOAB não conta) → e-mail de alerta.
//      Corpo aceita {"teste_alerta_sem_novas":true} (só envia o e-mail).
// v10: FONTE DEOAB — busca no Diário Eletrônico da OAB (diario.oab.org.br)
//      pelos nomes/números do escritório (espelha o monitor local v6).
//      Categoria/tribunal próprios "DEOAB", destaque dourado no digest.
//      Guards: data inválida devolve corpo vazio HTTP 200 (indistinguível
//      de zero) — validar antes; corpo vazio = ERRO com retry; {} = zero.
//      Exigiu migração: CHECK de fonte_busca agora aceita 'deoab'.
// v9: REMETENTE_NOME — o From passa a exibir "Sistema MCS - Intimacoes"
//     em vez do endereço cru. ASCII pelo mesmo motivo do assunto.
// v8: assuntoASCII() — assunto do e-mail sai em ASCII puro. O denomailer
//     1.6.0 quebra a RFC 2047 ao Q-encodar cabeçalho (mantém espaço literal
//     dentro do encoded-word) e o cliente exibia o assunto cru. Ver comentário
//     em assuntoASCII(). A v7 tentou pré-codificar em Base64 e FALHOU: o
//     denomailer recodifica qualquer string que comece com "=?".
// v6: DIGEST DIÁRIO — e-mail HTML navy/dourado com as intimações NOVAS,
//     agrupadas por categoria, urgentes destacadas, badge "conferir"
//     para as capturadas só por nome. Corpo aceita {"sem_email":true}.
// v5: entidades HTML ampliadas + TLS conforme a porta + teste_email.
// v4: data ISO priorizada; alerta não tenta SMTP sem secrets.
//
// Secrets: OAB_NUMERO, OAB_UF, ADVOGADO_NOME (obrigatórios)
//          SMTP_HOST, SMTP_PORT(465), SMTP_USER, SMTP_PASS, ALERTA_EMAIL
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const COMUNICA_API = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";
const ITENS_POR_PAGINA = 100;
const DIAS_RETROATIVOS = 7;
const MAX_TENTATIVAS = 5;
const MAX_PAGINAS = 30;
const BACKOFF_INICIAL = 10_000;
const BACKOFF_TETO = 30_000;
const PAUSA = 3_000;

// ─────────── DEOAB (Diário Eletrônico da OAB) ───────────
// Espelha DEOAB_TERMOS do monitor_intimacoes.py v6 — MANTER EM SINCRONIA.
// Índice do DEOAB ignora acentos e pontuação (82728 acha 82.728).
// Busca numérica NACIONAL de propósito: caso real de fev/2026 veio da OAB/ES.
const DEOAB_URL = "https://diario.oab.org.br/api/v1/diario/pesquisa";
const DEOAB_MAX_PAGINAS = 10;
const DEOAB_TERMOS = [
  '"Felipe Müller Corrêa da Silva"',
  '"Felipe Muller Correa da Silva"',
  '"Janine Coelho Martins Corrêa da Silva"',
  '"Janine Coelho Martins Correa da Silva"',
  "82728",
  "69990",
];

// deno-lint-ignore no-explicit-any
type Pub = Record<string, any>;

const dataISO = (d: Date) => d.toISOString().slice(0, 10);

// A API traz DUAS datas: data_disponibilizacao = "2026-07-22" (ISO)
// e datadisponibilizacao = "22/07/2026" (BR). Preferir a ISO.
function normalizarData(pub: Pub, fallback: string): string {
  const iso = String(pub?.data_disponibilizacao ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const br = String(pub?.datadisponibilizacao ?? "");
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(br)) return br;
  return fallback;
}

const semAcentos = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────── Limpeza de texto (receita do monitor_intimacoes.py) ───────────

const ENTIDADES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  atilde: "ã", otilde: "õ", Atilde: "Ã", Otilde: "Õ",
  acirc: "â", ecirc: "ê", ocirc: "ô", Acirc: "Â", Ecirc: "Ê", Ocirc: "Ô",
  agrave: "à", Agrave: "À", ccedil: "ç", Ccedil: "Ç", uuml: "ü", Uuml: "Ü",
  ordm: "º", ordf: "ª", sect: "§", middot: "·", ndash: "–", mdash: "—",
  deg: "º", sup2: "²", sup3: "³", frac12: "½", times: "×", bull: "•",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: "…",
  trade: "™", reg: "®", copy: "©", eth: "º", laquo: "«", raquo: "»",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTIDADES[n] ?? m);
}

function limparTexto(t: string | null | undefined): string {
  let s = t ?? "";
  s = s.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/[#.]?[A-Za-z][\w-]*\s*\{[^{}]*\}/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

// ─────────── Classificação camada 1 (11 categorias, mesma precedência) ───────────

const CLASSIFICADORES: Array<[string, string, RegExp]> = [
  ["TUTELA_DEFERIDA", "Tutela/liminar DEFERIDA",
    /\b(defiro|deferida?|concedo|concedida?)\b[^.]{0,120}?\b(tutela|liminar|antecipa[çc][ãa]o)|\bantecipo\s+os\s+efeitos\s+da\s+tutela\b/i],
  ["TUTELA_INDEFERIDA", "Tutela/liminar INDEFERIDA",
    /\b(indefiro|indeferida?|n[ãa]o\s+conce[dp]\w*|nego)\b[^.]{0,120}?\b(tutela|liminar|antecipa[çc][ãa]o)/i],
  ["SENTENCA", "Sentença",
    /\bjulgo\s+(parcialmente\s+)?(procedente|improcedente)s?\b|\bjulgo\s+extinto\b|\bhomologo\b[^.]{0,80}\bacordo\b/i],
  ["ACORDAO", "Acórdão / decisão de recurso",
    /\b(negaram|deram|nega[rd]|dar|dou|nego)\s+(parcial\s+)?provimento\b|\brecurso\s+(des)?provido\b|\bapela[çc][ãa]o\s+(des)?provida\b/i],
  ["AUDIENCIA", "Audiência designada",
    /\b(designo|designada?|redesigno)\b[^.]{0,120}\baudi[êe]ncia\b|\baudi[êe]ncia\s+(de\s+(concilia[çc][ãa]o|instru[çc][ãa]o))?\s*designada\b/i],
  ["ALVARA", "Alvará / levantamento",
    /\b(expedi[çc][ãa]o|expedi[dr]\w*)\s+(de\s+)?alvar[áa]\b|\balvar[áa]\s+(eletr[ôo]nico|de\s+levantamento|expedid\w*)\b|\blevantamento\s+de\s+valores\b/i],
  ["PRAZO", "Prazo para manifestação",
    /\bprazo\s+de\s+\d{1,3}\s*\(?\w*\)?\s*dias?\b|\bintime[m]?-se\b[^.]{0,150}\b(manifest|impugna|contrarraz|r[ée]plica|especificar)|\bpara\s+(que\s+)?se\s+manifest\w+/i],
  ["PAUTA", "Incluído em pauta de julgamento",
    /\b(inclus[ãa]o|inclu[íi]d\w*|inser[çc][ãa]o)\s+(n\w+\s+)?pauta\b|\bpauta\s+de\s+julgamento\b|\bsess[ãa]o\s+(virtual|de\s+julgamento)\b/i],
  ["SIGILOSO", "Processo sigiloso (abrir nos autos)",
    /\bprocesso\s+sigiloso\b|\bconsulte\s+os\s+autos\s+digitais\b/i],
  ["DISTRIBUICAO", "Distribuição / relator",
    /\bdistribu[íi]d\w*\s+(para|a|ao)\b|\bredistribu[íi]d\w*\b/i],
];

const URGENCIA_ALTA = new Set(
  ["TUTELA_DEFERIDA", "TUTELA_INDEFERIDA", "SENTENCA", "ACORDAO"],
);
const URGENCIA_MEDIA = new Set(["AUDIENCIA", "ALVARA", "PRAZO", "PAUTA"]);

function classificar(texto: string): {
  classificacao: string; rotulo: string; trecho: string; urgencia: string;
} {
  for (const [codigo, rotulo, padrao] of CLASSIFICADORES) {
    const m = padrao.exec(texto);
    if (m && m.index !== undefined) {
      const ini = Math.max(0, m.index - 120);
      const fim = Math.min(texto.length, m.index + m[0].length + 260);
      const trecho = texto.slice(ini, fim).replace(/\s+/g, " ").trim();
      const urgencia = URGENCIA_ALTA.has(codigo)
        ? "alta"
        : URGENCIA_MEDIA.has(codigo)
        ? "media"
        : "baixa";
      return { classificacao: codigo, rotulo, trecho, urgencia };
    }
  }
  return {
    classificacao: "OUTROS",
    rotulo: "Sem classificação automática",
    trecho: texto.slice(0, 320).replace(/\s+/g, " ").trim(),
    urgencia: "baixa",
  };
}

// ─────────── Partes e hash ───────────

function extrairPartes(pub: Pub): string {
  const dest = Array.isArray(pub?.destinatarios) ? pub.destinatarios : [];
  const ativos: string[] = [];
  const passivos: string[] = [];
  const outros: string[] = [];
  for (const d of dest) {
    const nome = d?.nome;
    if (!nome) continue;
    const polo = String(d?.polo ?? "").toUpperCase();
    if (polo === "A") ativos.push(nome);
    else if (polo === "P") passivos.push(nome);
    else outros.push(nome);
  }
  const esq = ativos.join(", ");
  const dir = passivos.join(", ");
  if (esq && dir) return `${esq} × ${dir}`;
  return [esq, dir, outros.join(", ")].filter(Boolean).join(" × ");
}

async function hashPublicacao(pub: Pub): Promise<string> {
  const base = [
    String(pub?.id ?? pub?.hash ?? ""),
    String(pub?.numeroprocessocommascara ?? pub?.numero_processo ?? ""),
    String(pub?.data_disponibilizacao ?? pub?.datadisponibilizacao ?? ""),
    String(pub?.texto ?? "").slice(0, 200),
  ].join("|");
  return await sha256hex(base);
}

// ─────────── HTTP com retry ───────────

class FalhaDefinitiva extends Error {}

async function fetchComRetry(url: string): Promise<Response> {
  let ultimoErro: unknown;
  for (let t = 1; t <= MAX_TENTATIVAS; t++) {
    let esperaExtra = 0;
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.ok) return resp;
      if (resp.status === 429 || resp.status >= 500) {
        ultimoErro = new Error(`HTTP ${resp.status}`);
        const ra = Number(resp.headers.get("Retry-After"));
        if (Number.isFinite(ra) && ra > 0) esperaExtra = ra * 1000;
      } else {
        throw new FalhaDefinitiva(`HTTP ${resp.status}: ${await resp.text()}`);
      }
    } catch (e) {
      if (e instanceof FalhaDefinitiva) throw e;
      ultimoErro = e;
    }
    if (t < MAX_TENTATIVAS) {
      const backoff = Math.min(BACKOFF_TETO, BACKOFF_INICIAL * 2 ** (t - 1));
      await sleep(Math.min(BACKOFF_TETO, Math.max(esperaExtra, backoff)));
    }
  }
  throw ultimoErro;
}

async function buscarPaginado(
  params: Record<string, string>,
): Promise<{ itens: Pub[]; esperado: number | null }> {
  const resultados: Pub[] = [];
  let esperado: number | null = null;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const qs = new URLSearchParams({
      ...params,
      pagina: String(pagina),
      itensPorPagina: String(ITENS_POR_PAGINA),
    });
    const resp = await fetchComRetry(`${COMUNICA_API}?${qs}`);
    const json = await resp.json();
    if (esperado === null && Number.isFinite(Number(json?.count))) {
      esperado = Number(json.count);
    }
    const bruto = json?.items ?? json;
    const itens: Pub[] = Array.isArray(bruto) ? bruto : [];
    resultados.push(...itens);
    if (itens.length < ITENS_POR_PAGINA) break;
    if (esperado !== null && resultados.length >= esperado) break;
    await sleep(PAUSA);
  }
  return { itens: resultados, esperado };
}

// ─────────── Busca no DEOAB ───────────

// YYYY-MM-DD → dd/mm/aaaa, VALIDANDO. O endpoint do DEOAB devolve corpo
// vazio (HTTP 200) para data inválida — indistinguível de "sem resultado".
// O Date do JS "rola" datas inválidas (29/02/2026 vira 01/03), daí o
// round-trip dataISO(d) !== iso para pegar o caso.
function deoabDataBR(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`data nao-ISO: ${iso}`);
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime()) || dataISO(d) !== iso) {
    throw new Error(`data invalida: ${iso}`);
  }
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Uma página do DEOAB. Corpo vazio = ERRO com retry (nunca "zero resultados"
// — zero legítimo vem como "{}"). 4xx exceto 429 falha imediato.
async function deoabPagina(
  termo: string,
  iniBR: string,
  fimBR: string,
  pagina: number,
): Promise<Pub | null> {
  const qs = new URLSearchParams({
    pagina: String(pagina), termo, inicio: iniBR, fim: fimBR,
  });
  for (let t = 1; t <= MAX_TENTATIVAS; t++) {
    try {
      const resp = await fetch(`${DEOAB_URL}?${qs}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error(`HTTP ${resp.status}`);
      }
      if (!resp.ok) throw new FalhaDefinitiva(`HTTP ${resp.status}`);
      const corpo = (await resp.text()).trim();
      if (!corpo) throw new Error("corpo vazio (parametro invalido?)");
      return JSON.parse(corpo);
    } catch (e) {
      if (e instanceof FalhaDefinitiva) return null;
      if (t === MAX_TENTATIVAS) return null;
      await sleep(Math.min(BACKOFF_TETO, BACKOFF_INICIAL * 2 ** (t - 1)));
    }
  }
  return null;
}

// Busca todos os DEOAB_TERMOS no período. Falha isolada por termo (vai para
// erros[], não aborta); dedupe entre termos pelo hash com namespace "deoab|"
// (a mesma publicação costuma casar com nome E número). conteudo vem
// TRUNCADO (~250 chars) da API — o inteiro teor fica no link da edição.
// deno-lint-ignore no-explicit-any
async function coletarDeoab(
  iniISO: string,
  fimISO: string,
  erros: string[],
): Promise<any[]> {
  let iniBR: string;
  let fimBR: string;
  try {
    iniBR = deoabDataBR(iniISO);
    fimBR = deoabDataBR(fimISO);
  } catch (e) {
    erros.push(`DEOAB: ${e} — busca DEOAB abortada`);
    return [];
  }
  // deno-lint-ignore no-explicit-any
  const porHash = new Map<string, any>();
  for (const termo of DEOAB_TERMOS) {
    let total: number | null = null;
    let coletadas = 0;
    let falhou = false;
    for (let pagina = 1; pagina <= DEOAB_MAX_PAGINAS; pagina++) {
      const resp = await deoabPagina(termo, iniBR, fimBR, pagina);
      if (resp === null) {
        falhou = true;
        break;
      }
      const itens: Pub[] = Array.isArray(resp?.itens) ? resp.itens : [];
      if (total === null && Number.isFinite(Number(resp?.quantidade))) {
        total = Number(resp.quantidade);
      }
      for (const item of itens) {
        const conteudo = limparTexto(String(item?.conteudo ?? ""));
        const chave = await sha256hex(
          `deoab|${item?.id}|${item?.dataPublicacao}|${conteudo.slice(0, 200)}`,
        );
        if (porHash.has(chave)) continue;
        const edicao = item?.edicao;
        const pag = item?.pagina;
        const dataPub = String(item?.dataPublicacao ?? "");
        porHash.set(chave, {
          hash_comunicacao: chave,
          hash_origem: "proprio",
          numero_processo: "",
          tribunal: "DEOAB",
          nome_orgao: edicao ? `Ed. ${edicao}, pág. ${pag}` : null,
          tipo_comunicacao: null,
          tipo_documento: "Publicação DEOAB",
          meio: null,
          data_disponibilizacao: /^\d{4}-\d{2}-\d{2}$/.test(dataPub)
            ? dataPub
            : fimISO,
          texto: conteudo || null,
          link: edicao
            ? `https://diario.oab.org.br/pages/visualizacao/${edicao}?pagina=${pag}`
            : null,
          fonte_busca: "deoab",
          partes: null,
          classificacao: "DEOAB",
          rotulo: "DEOAB — Diário Eletrônico da OAB",
          trecho: conteudo.slice(0, 320) || null,
          urgencia: "alta",
        });
      }
      coletadas += itens.length;
      if (itens.length === 0 || (total !== null && coletadas >= total)) break;
      await sleep(PAUSA);
    }
    if (falhou) {
      erros.push(
        `⚠ DEOAB "${termo}": falha definitiva — captura pode estar incompleta`,
      );
    } else if (total !== null && coletadas < total) {
      erros.push(
        `⚠ DEOAB "${termo}": coletadas ${coletadas} de ${total} — possível perda`,
      );
    }
    await sleep(PAUSA);
  }
  return [...porHash.values()];
}

// ─────────── E-mail ───────────

// O denomailer 1.6.0 aplica Q-encoding ao assunto sempre que ele tem caractere
// nao-ASCII (ou comeca com "=?"), e nesse Q-encoding os codigos 32..126 passam
// intactos -- inclusive o ESPACO, que a RFC 2047 proibe dentro de um
// encoded-word. Resultado: o cliente exibe o cabecalho cru. Nao ha como
// contornar pre-codificando (a guarda `data.startsWith("=?")` recodifica por
// cima) nem trocando de versao (o bug segue no main do projeto).
// Solucao: entregar o assunto em ASCII puro -- nesse caso a funcao devolve a
// string sem tocar. Perdem-se os acentos SO NO ASSUNTO; o corpo HTML segue
// em UTF-8 normal.
// Nome exibido no remetente. TEM QUE SER ASCII: o denomailer passa o nome
// pela mesma quotedPrintableEncodeInline() do assunto (parseSingleEmail),
// entao acento aqui quebraria o cabecalho From do mesmo jeito.
const REMETENTE_NOME = "Sistema MCS - Intimacoes";

const SUBST_ASCII: Record<string, string> = {
  "\u2014": "-", "\u2013": "-", "\u00d7": "x", "\u00b7": "-", "\u2026": "...",
  "\u26a0": "[ALERTA]", "\u2705": "[OK]", "\u2696": "",
  "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'",
};

function assuntoASCII(s: string): string {
  let t = s;
  for (const [de, para] of Object.entries(SUBST_ASCII)) t = t.replaceAll(de, para);
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  t = t.replace(/[^\x20-\x7E]/g, "");
  return t.replace(/\s+/g, " ").trim();
}

async function enviarEmail(
  assunto: string,
  texto: string,
  html?: string,
): Promise<boolean> {
  const smtpOk = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "ALERTA_EMAIL"]
    .every((k) => Deno.env.get(k));
  if (!smtpOk) {
    console.warn(`[e-mail não enviado — SMTP não configurado] ${assunto}`);
    return false;
  }
  try {
    const porta = Number(Deno.env.get("SMTP_PORT") ?? 465);
    const client = new SMTPClient({
      connection: {
        hostname: Deno.env.get("SMTP_HOST")!,
        port: porta,
        // 465 = TLS implícito; 587 (STARTTLS) derruba o worker neste runtime
        tls: porta === 465,
        auth: {
          username: Deno.env.get("SMTP_USER")!,
          password: Deno.env.get("SMTP_PASS")!,
        },
      },
    });
    await client.send({
      from: `${REMETENTE_NOME} <${Deno.env.get("SMTP_USER")!}>`,
      to: Deno.env.get("ALERTA_EMAIL")!,
      subject: assuntoASCII(assunto),
      content: texto,
      ...(html ? { html } : {}),
    });
    await client.close();
    return true;
  } catch (e) {
    console.error("Falha ao enviar e-mail:", e);
    return false;
  }
}

const enviarAlerta = (assunto: string, corpo: string) =>
  enviarEmail(assunto, corpo);

// ─────────── Digest diário (HTML navy/dourado) ───────────

const ORDEM_CATEGORIAS = [
  "DEOAB",
  "TUTELA_DEFERIDA", "TUTELA_INDEFERIDA", "SENTENCA", "ACORDAO",
  "AUDIENCIA", "ALVARA", "PRAZO", "PAUTA",
  "SIGILOSO", "DISTRIBUICAO", "OUTROS",
];

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const dataBR = (iso: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? "");
};

// deno-lint-ignore no-explicit-any
function montarDigest(rows: any[]): { assunto: string; texto: string; html: string } {
  const hojeBR = dataBR(dataISO(new Date()));
  const urgentes = rows.filter((r) => r.urgencia === "alta").length;

  const deoabN = rows.filter((r) => r.classificacao === "DEOAB").length;
  const extraOab = deoabN > 0 ? ` — ${deoabN} da OAB` : "";
  const assunto = urgentes > 0
    ? `[Intimações] ${rows.length} nova(s) — ${urgentes} urgente(s)${extraOab} — ${hojeBR}`
    : `[Intimações] ${rows.length} nova(s)${extraOab} — ${hojeBR}`;

  const texto = rows.map((r) =>
    `[${r.rotulo ?? r.classificacao}] ${r.numero_processo} (${r.tribunal})\n` +
    `${r.partes ?? ""}\n${r.trecho ?? ""}\n`
  ).join("\n---\n");

  // deno-lint-ignore no-explicit-any
  const grupos = new Map<string, any[]>();
  for (const r of rows) {
    const k = String(r.classificacao ?? "OUTROS");
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(r);
  }

  const NAVY = "#1B2A4A";
  const GOLD = "#F5C518";

  let corpo = "";
  for (const cat of ORDEM_CATEGORIAS) {
    const itens = grupos.get(cat);
    if (!itens || itens.length === 0) continue;
    const urgente = itens[0].urgencia === "alta";
    const deoab = cat === "DEOAB";
    const rotulo = esc(itens[0].rotulo ?? cat);

    corpo += `<tr><td style="padding:22px 0 8px">
      <div style="font:700 13px/1.3 Helvetica,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${urgente && !deoab ? "#B00020" : NAVY}">
        ${deoab
          ? `<span style="display:inline-block;background:${GOLD};color:${NAVY};padding:4px 10px;border-radius:4px">${rotulo} · ${itens.length}</span>`
          : `${rotulo} · ${itens.length}`}
      </div>
      ${deoab ? "" : `<div style="height:2px;background:${urgente ? "#B00020" : GOLD};width:52px;margin-top:6px"></div>`}
    </td></tr>`;

    for (const r of itens) {
      const conferir = r.fonte_busca === "nome"
        ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#FFF3CD;color:#7A5B00;font:600 10px Helvetica,Arial,sans-serif">conferir</span>`
        : "";
      corpo += `<tr><td style="padding:0 0 12px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${deoab ? GOLD : urgente ? "#B00020" : "#D9DEE7"};background:${deoab ? "#FFFBEB" : "#FAFBFC"};border-radius:0 6px 6px 0">
          <tr><td style="padding:12px 14px">
            <div style="font:700 14px Helvetica,Arial,sans-serif;color:${NAVY}">
              ${esc(r.numero_processo || (deoab ? "Publicação da OAB" : "—"))}
              <span style="font-weight:400;color:#6B7280">· ${esc(r.tribunal)}</span>
              ${conferir}
            </div>
            ${r.partes ? `<div style="font:400 12px Helvetica,Arial,sans-serif;color:#374151;margin-top:3px">${esc(r.partes)}</div>` : ""}
            ${r.nome_orgao ? `<div style="font:400 11px Helvetica,Arial,sans-serif;color:#6B7280;margin-top:2px">${esc(r.nome_orgao)}</div>` : ""}
            ${r.trecho ? `<div style="font:400 12px/1.5 Helvetica,Arial,sans-serif;color:#111827;margin-top:8px">${esc(r.trecho)}</div>` : ""}
            <div style="font:400 11px Helvetica,Arial,sans-serif;color:#6B7280;margin-top:8px">
              Disponibilizado em ${esc(dataBR(r.data_disponibilizacao))}
              ${r.link ? ` · <a href="${esc(r.link)}" style="color:${NAVY}">abrir no ${deoab ? "DEOAB" : "DJEN"}</a>` : ""}
            </div>
          </td></tr>
        </table>
      </td></tr>`;
    }
  }

  const html = `<!doctype html><html><body style="margin:0;background:#F3F4F6">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px">
    <tr><td align="center">
      <table width="100%" style="max-width:640px" cellpadding="0" cellspacing="0">
        <tr><td style="background:${NAVY};border-radius:10px 10px 0 0;padding:20px 22px">
          <div style="font:700 17px Helvetica,Arial,sans-serif;color:#fff">Intimações do dia</div>
          <div style="font:400 12px Helvetica,Arial,sans-serif;color:${GOLD};margin-top:4px">
            ${rows.length} nova(s)${urgentes > 0 ? ` · ${urgentes} de urgência alta` : ""} · ${hojeBR}
          </div>
        </td></tr>
        <tr><td style="background:#fff;padding:4px 22px 22px">
          <table width="100%" cellpadding="0" cellspacing="0">${corpo}</table>
        </td></tr>
        <tr><td style="background:#fff;border-radius:0 0 10px 10px;padding:14px 22px;border-top:1px solid #E5E7EB">
          <div style="font:400 11px/1.5 Helvetica,Arial,sans-serif;color:#6B7280">
            Coleta automática do DJEN por OAB 82.728/RS e nome do advogado,
            e do DEOAB (Diário Eletrônico da OAB) por nomes e números do escritório
            — publicações do DEOAB aparecem destacadas em dourado; a busca por
            número pode trazer homônimos de outras seccionais, confira pelo link.
            Classificação automática por padrões de texto — <strong>confira sempre o inteiro teor</strong>
            antes de calcular prazo. Itens marcados "conferir" vieram apenas da busca por nome
            e podem ser homônimos.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  return { assunto, texto, html };
}

function diaUtilBRT(d: Date): boolean {
  const dia = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(d);
  return dia !== "Sat" && dia !== "Sun";
}

// v11 — decide o alerta de "dia útil sem intimação nova". Só a rodada do
// cron conta: busca manual roda depois do cron e sempre traria zero novas.
function deveAlertarSemNovas(p: {
  semErros: boolean;
  origem: string;
  buscaCustomizada: boolean;
  diaUtil: boolean;
  novasDjen: number;
}): boolean {
  return p.semErros && p.origem === "cron" && !p.buscaCustomizada &&
    p.diaUtil && p.novasDjen === 0;
}

function montarAlertaSemNovas(
  hojeISO: string,
  iniISO: string,
  fimISO: string,
  totalJanela: number,
): { assunto: string; texto: string } {
  const assunto = `⚠️ Nenhuma intimação nova hoje (dia útil) — ${dataBR(hojeISO)}`;
  const janela = totalJanela > 0
    ? `Na janela de 7 dias (${dataBR(iniISO)} a ${dataBR(fimISO)}) a busca encontrou ` +
      `${totalJanela} publicação(ões), todas já conhecidas.`
    : `Na janela de 7 dias (${dataBR(iniISO)} a ${dataBR(fimISO)}) a busca não ` +
      `encontrou NENHUMA publicação.`;
  const texto =
    `A coleta automática de ${dataBR(hojeISO)} rodou sem erro, mas não trouxe ` +
    `nenhuma intimação nova do DJEN.\n${janela}\n\n` +
    `Pode ser só um dia calmo ou feriado. Mas foi exatamente este o sinal da ` +
    `falha de 06 a 08/10/2026: o índice de busca da API do CNJ devolvia ` +
    `"sucesso" com dados incompletos, enquanto os cadernos oficiais estavam ` +
    `completos e os prazos corriam normalmente.\n\n` +
    `Confira hoje, SEM ABRIR as intimações (para não disparar a contagem de prazo):\n` +
    `- eproc (TJRS, TRF4, TJSC): painel do advogado\n` +
    `- e-SAJ (TJSP)\n` +
    `- PJe (TJDFT)\n` +
    `- demais tribunais (TRF1, TJMG, TJRJ, TJPR, TRT1): painéis próprios\n` +
    `- e-mail de intimações da OAB/RS (cobre só o RS)\n\n` +
    `Se faltar algo, peça ao Claude a conferência direta nos cadernos oficiais ` +
    `do DJEN (conferir_cadernos.py).`;
  return { assunto, texto };
}

// ─────────── HTTP ───────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respostaJSON = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const obrigatorios = ["OAB_NUMERO", "OAB_UF", "ADVOGADO_NOME"];
  const faltando = obrigatorios.filter((k) => !Deno.env.get(k));
  if (faltando.length > 0) {
    const msg = `Secrets não configurados: ${faltando.join(", ")}`;
    try {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await sb.from("execucoes_coleta").insert({
        finalizada_em: new Date().toISOString(),
        sucesso: false,
        erro: msg,
      });
    } catch (e) {
      console.error("Falha ao registrar erro de configuração:", e);
    }
    return respostaJSON({ ok: false, erro: msg }, 500);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let corpo: {
    data_inicio?: string;
    data_fim?: string;
    origem?: string;
    teste_email?: boolean;
    sem_email?: boolean;
    teste_alerta_sem_novas?: boolean;
  } = {};
  try { corpo = await req.json(); } catch { /* padrão */ }
  const origemExec = corpo.origem === "manual" ? "manual" : "cron";

  // Teste isolado do canal de e-mail (não coleta nada)
  if (corpo.teste_email) {
    const ok = await enviarEmail(
      "✅ Teste de alerta — coleta de intimações",
      "Este é um teste do canal de e-mail do sistema de intimações.\n" +
        "Se você recebeu esta mensagem, o SMTP está configurado corretamente.",
    );
    return respostaJSON({ ok, teste_email: true, enviado: ok });
  }

  // Teste do alerta de "dia útil sem intimação nova" (v11) — não coleta nada
  if (corpo.teste_alerta_sem_novas) {
    const fimT = new Date();
    const iniT = new Date(fimT);
    iniT.setDate(iniT.getDate() - DIAS_RETROATIVOS);
    const a = montarAlertaSemNovas(dataISO(fimT), dataISO(iniT), dataISO(fimT), 0);
    const ok = await enviarAlerta(`[TESTE] ${a.assunto}`, a.texto);
    return respostaJSON({ ok, teste_alerta_sem_novas: true, enviado: ok });
  }

  const reISO = /^\d{4}-\d{2}-\d{2}$/;
  const hoje = new Date();
  let dtFim = hoje;
  let dtInicio = new Date(hoje);
  dtInicio.setDate(dtInicio.getDate() - DIAS_RETROATIVOS);

  if (corpo.data_inicio && reISO.test(corpo.data_inicio)) {
    dtInicio = new Date(corpo.data_inicio + "T12:00:00Z");
  }
  if (corpo.data_fim && reISO.test(corpo.data_fim)) {
    dtFim = new Date(corpo.data_fim + "T12:00:00Z");
  }
  if (dtInicio > dtFim) [dtInicio, dtFim] = [dtFim, dtInicio];
  const diasJanela = (dtFim.getTime() - dtInicio.getTime()) / 86400000;
  if (diasJanela > 90) {
    return respostaJSON({ ok: false, erro: "Janela máxima: 90 dias" }, 400);
  }
  const buscaCustomizada = Boolean(corpo.data_inicio || corpo.data_fim);

  const periodo = {
    dataDisponibilizacaoInicio: dataISO(dtInicio),
    dataDisponibilizacaoFim: dataISO(dtFim),
  };

  const { data: exec } = await supabase
    .from("execucoes_coleta")
    .insert({
      janela_inicio: periodo.dataDisponibilizacaoInicio,
      janela_fim: periodo.dataDisponibilizacaoFim,
      origem: origemExec,
    })
    .select("id").single();
  const execId = exec?.id;

  const erros: string[] = [];
  let porOab: Pub[] = [];
  const porNome: Pub[] = [];

  try {
    const r = await buscarPaginado({
      ...periodo,
      numeroOab: Deno.env.get("OAB_NUMERO")!,
      ufOab: Deno.env.get("OAB_UF")!,
    });
    porOab = r.itens;
    if (r.esperado !== null && r.itens.length < r.esperado) {
      erros.push(
        `⚠ OAB: coletadas ${r.itens.length} de ${r.esperado} — possível perda`,
      );
    }
  } catch (e) {
    erros.push(`Busca por OAB falhou: ${e}`);
  }

  await sleep(PAUSA);

  const nome = Deno.env.get("ADVOGADO_NOME")!;
  const variantes = [...new Set([nome, semAcentos(nome)])];
  for (const v of variantes) {
    try {
      const r = await buscarPaginado({ ...periodo, nomeAdvogado: v });
      porNome.push(...r.itens);
      if (r.esperado !== null && r.itens.length < r.esperado) {
        erros.push(
          `⚠ Nome \"${v}\": coletadas ${r.itens.length} de ${r.esperado} — possível perda`,
        );
      }
    } catch (e) {
      erros.push(`Busca por nome (\"${v}\") falhou: ${e}`);
    }
    await sleep(PAUSA);
  }

  const mapa = new Map<string, { c: Pub; fonte: string }>();
  for (const c of porOab) {
    mapa.set(await hashPublicacao(c), { c, fonte: "oab" });
  }
  for (const c of porNome) {
    const chave = await hashPublicacao(c);
    const ex = mapa.get(chave);
    const fonte = ex && (ex.fonte === "oab" || ex.fonte === "ambas")
      ? "ambas"
      : "nome";
    mapa.set(chave, { c, fonte });
  }

  const linhas = [...mapa.entries()].map(([chave, { c, fonte }]) => {
    const textoLimpo = limparTexto(c.texto);
    const cls = classificar(textoLimpo);
    return {
      hash_comunicacao: chave,
      hash_origem: "proprio",
      numero_processo: c.numeroprocessocommascara ?? c.numero_processo ?? "",
      tribunal: c.siglaTribunal ?? "",
      nome_orgao: c.nomeOrgao ?? null,
      tipo_comunicacao: c.tipoComunicacao ?? null,
      tipo_documento: c.tipoDocumento ?? c.tipoComunicacao ?? null,
      meio: c.meio ?? null,
      data_disponibilizacao: normalizarData(c, dataISO(hoje)),
      texto: textoLimpo || null,
      link: c.link ?? null,
      fonte_busca: fonte,
      partes: extrairPartes(c) || null,
      classificacao: cls.classificacao,
      rotulo: cls.rotulo,
      trecho: cls.trecho || null,
      urgencia: cls.urgencia,
    };
  });

  // ─── DEOAB — roda depois do DJEN, falha isolada por termo ───
  const linhasDeoab = await coletarDeoab(
    periodo.dataDisponibilizacaoInicio,
    periodo.dataDisponibilizacaoFim,
    erros,
  );
  {
    const jaTem = new Set(linhas.map((l) => l.hash_comunicacao));
    for (const r of linhasDeoab) {
      // deno-lint-ignore no-explicit-any
      if (!jaTem.has(r.hash_comunicacao)) linhas.push(r as any);
    }
  }

  // Upsert em blocos. Com ignoreDuplicates (ON CONFLICT DO NOTHING),
  // o .select() devolve SOMENTE as linhas realmente inseridas — fonte do digest.
  const TAM_BLOCO = 200;
  let inseridas = 0;
  const novasRows: Record<string, unknown>[] = [];
  for (let i = 0; i < linhas.length; i += TAM_BLOCO) {
    const bloco = linhas.slice(i, i + TAM_BLOCO);
    const { data, error } = await supabase
      .from("intimacoes_oab")
      .upsert(bloco, {
        onConflict: "hash_comunicacao",
        ignoreDuplicates: true,
      })
      .select(
        "numero_processo,tribunal,nome_orgao,data_disponibilizacao,partes,classificacao,rotulo,trecho,urgencia,link,fonte_busca",
      );
    if (error) {
      erros.push(`Upsert bloco ${i / TAM_BLOCO + 1} falhou: ${error.message}`);
    } else if (data) {
      novasRows.push(...data);
      inseridas += data.length;
    }
  }

  // v11: zero NOVAS do DJEN (não o total da janela, que nunca zera)
  const novasDjen = novasRows.filter((r) => r.tribunal !== "DEOAB").length;
  const semNovasDiaUtil = deveAlertarSemNovas({
    semErros: erros.length === 0,
    origem: origemExec,
    buscaCustomizada,
    diaUtil: diaUtilBRT(hoje),
    novasDjen,
  });
  let alertaEnviado = false;
  let digestEnviado = false;

  // Digest das novidades
  if (novasRows.length > 0 && !corpo.sem_email) {
    const d = montarDigest(novasRows);
    digestEnviado = await enviarEmail(d.assunto, d.texto, d.html);
  }

  if (erros.length > 0) {
    alertaEnviado = await enviarAlerta(
      "⚠️ Falha na coleta de intimações",
      `Erros/avisos na execução de ${dataISO(hoje)}:\n\n${erros.join("\n")}` +
        `\n\nColetadas mesmo assim: ${linhas.length} (novas: ${inseridas}).` +
        `\nVerifique o painel e, se necessário, rode a coleta manualmente.`,
    );
  } else if (semNovasDiaUtil) {
    const a = montarAlertaSemNovas(
      dataISO(hoje),
      periodo.dataDisponibilizacaoInicio,
      periodo.dataDisponibilizacaoFim,
      mapa.size,
    );
    alertaEnviado = await enviarAlerta(a.assunto, a.texto);
  }

  const sucesso = erros.length === 0;
  if (execId) {
    await supabase.from("execucoes_coleta").update({
      finalizada_em: new Date().toISOString(),
      por_oab: porOab.length,
      por_nome: porNome.length,
      total_unicas: linhas.length,
      novas_inseridas: inseridas,
      sucesso,
      erro: erros.length ? erros.join(" | ") : null,
      alerta_enviado: alertaEnviado || digestEnviado,
    }).eq("id", execId);
  }

  return respostaJSON(
    {
      ok: sucesso,
      periodo,
      por_oab: porOab.length,
      por_nome: porNome.length,
      total_unicas: linhas.length,
      deoab_total: linhasDeoab.length,
      novas_inseridas: inseridas,
      novas_djen: novasDjen,
      digest_enviado: digestEnviado,
      alerta_enviado: alertaEnviado,
      erros: erros.length ? erros : undefined,
    },
    sucesso ? 200 : 500,
  );
});
