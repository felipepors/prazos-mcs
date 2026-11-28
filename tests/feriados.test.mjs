// Testes da contagem de prazos: feriados, recesso forense e vencimento.
// Rodar: npm run test:feriados   (ou: node tests/feriados.test.mjs)
//
// Lê as funções DIRETO de src/App.jsx (nada é copiado à mão), então qualquer
// mudança na regra de feriados/prazos é conferida contra as datas abaixo, que
// foram calculadas à mão, dia a dia. Um feriado a mais empurra o vencimento
// para DEPOIS — é o erro que faz perder prazo; por isso cada caso importa.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const trecho = (ini, fim) => {
  const a = src.indexOf(ini), b = src.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error("Trecho não encontrado em App.jsx: " + ini);
  return src.slice(a, b);
};
const F = new Function(
  trecho("// ─── Feriados global", "function calcStatus") +
  trecho("// v47 — feriados gerados POR ANO", "// ═════════════════════════════════════════════════════════════════════════════\n// COMPONENTES UI") +
  "; return { isoLocal, setFeriadosGlobal, calcularDataFinal, diasUteisRestantes, _pascoa, _feriadosDoAno, _diasEntre, _agruparFeriados, FERIADOS_SEED, FERIADOS_NOMES_SEED, NOME_RECESSO };",
)();

let falhas = 0;
const ok = (cond, msg) => { if (!cond) { falhas++; console.log("  ✗ " + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg}: esperado ${b}, veio ${a}`);
const dow = (s) => new Date(s + "T00:00:00").getDay();

console.log("Páscoa (datas oficiais 2024–2035)");
const pascoas = { 2024:"03-31", 2025:"04-20", 2026:"04-05", 2027:"03-28", 2028:"04-16", 2029:"04-01",
  2030:"04-21", 2031:"04-13", 2032:"03-28", 2033:"04-17", 2034:"04-09", 2035:"03-25" };
for (const [a, md] of Object.entries(pascoas)) eq(F.isoLocal(F._pascoa(+a)), `${a}-${md}`, `Páscoa ${a}`);

console.log("Feriados móveis no dia da semana certo e Dia da Justiça (2020–2035)");
for (let a = 2020; a <= 2035; a++) {
  const f = F._feriadosDoAno(a);
  const por = (nome) => Object.keys(f).filter((d) => f[d] === nome);
  const c = por("Carnaval");
  ok(c.length === 2 && dow(c[0]) === 1 && dow(c[1]) === 2, `Carnaval ${a} seg/ter (${c})`);
  ok(dow(por("Sexta-feira Santa")[0]) === 5, `Sexta-feira Santa ${a}`);
  ok(dow(por("Corpus Christi")[0]) === 4, `Corpus Christi ${a} quinta`);
  eq(f[`${a}-12-08`], "Dia da Justiça", `Dia da Justiça ${a}`);
}

console.log("Recesso 20/12 a 20/01 (CPC 220): 32 dias em todos os anos gerados");
const ano = new Date().getFullYear();
for (let a = ano - 1; a <= ano + 2; a++) {
  const dias = F._diasEntre(`${a}-12-20`, `${a + 1}-01-20`);
  eq(dias.length, 32, `recesso ${a}/${a + 1}`);
  dias.forEach((d) => ok(F.FERIADOS_SEED.includes(d), `recesso ${a}: ${d}`));
  eq(F.FERIADOS_NOMES_SEED[`${a}-12-19`], undefined, `19/12/${a} não é feriado`);
  eq(F.FERIADOS_NOMES_SEED[`${a + 1}-01-21`], undefined, `21/01/${a + 1} não é feriado`);
  eq(F.FERIADOS_NOMES_SEED[`${a}-12-25`], "Natal", `25/12/${a} se chama Natal`);
  eq(F.FERIADOS_NOMES_SEED[`${a + 1}-01-01`], "Ano Novo", `01/01/${a + 1} se chama Ano Novo`);
}

console.log("Vencimentos (contados à mão)");
F.setFeriadosGlobal(F.FERIADOS_SEED);
for (const [ini, du, esperado, desc] of [
  ["2026-12-01", 15, "2027-01-22", "atravessa Dia da Justiça e recesso"],
  ["2026-11-16", 5, "2026-11-23", "Consciência Negra 20/11"],
  ["2027-03-22", 5, "2027-03-29", "Sexta-feira Santa 26/03/2027"],
  ["2027-02-05", 3, "2027-02-11", "Carnaval 08–09/02/2027"],
  ["2026-12-22", 1, "2027-01-21", "início dentro do recesso"],
  ["2026-12-07", 2, "2026-12-09", "pula 08/12"],
  ["2026-12-18", 2, "2027-01-21", "sexta 18/12 + recesso"],
  ["2027-05-26", 2, "2027-05-28", "Corpus Christi 27/05/2027"],
  ["2026-06-10", 2, "2026-06-11", "11/06/2026 não é feriado"],
  ["2026-06-03", 2, "2026-06-05", "Corpus Christi 2026 é 04/06"],
]) eq(F.calcularDataFinal(ini, du), esperado, `${ini} + ${du} d.u. (${desc})`);

console.log("Dias úteis restantes (selo \"vence hoje\" / \"1 dia útil\")");
// [hoje, vencimento, esperado, descrição] — 0 = vence hoje, 1 = próximo dia útil
for (const [hoje, venc, esperado, desc] of [
  ["2026-11-28", "2026-11-30", 1, "sábado → segunda é o próximo dia útil, não \"vence hoje\""],
  ["2026-11-29", "2026-11-30", 1, "domingo → segunda"],
  ["2026-11-28", "2026-12-01", 2, "sábado → terça"],
  ["2026-11-28", "2026-11-27", -1, "sábado → sexta já venceu"],
  ["2026-11-29", "2026-11-27", -1, "domingo → sexta já venceu"],
  ["2026-11-28", "2026-11-28", 1, "vencimento no sábado, visto no sábado: prorroga p/ segunda"],
  ["2026-11-29", "2026-11-28", 1, "vencimento no sábado, visto no domingo: prorroga p/ segunda"],
  ["2026-11-30", "2026-11-28", 0, "vencimento no sábado, visto na segunda: vence hoje"],
  ["2026-11-30", "2026-11-30", 0, "segunda → segunda: vence hoje"],
  ["2026-11-30", "2026-12-01", 1, "segunda → terça"],
  ["2026-11-30", "2026-11-27", -1, "segunda → sexta anterior"],
  ["2026-11-27", "2026-11-30", 1, "sexta → segunda"],
  ["2026-11-27", "2026-11-27", 0, "sexta → sexta: vence hoje"],
  ["2026-11-27", "2026-11-28", 1, "sexta → sábado (prorroga p/ segunda)"],
  ["2026-12-08", "2026-12-09", 1, "feriado (Dia da Justiça) → dia seguinte"],
  ["2026-12-08", "2026-12-07", -1, "feriado → véspera já venceu"],
  ["2026-12-07", "2026-12-09", 1, "segunda → quarta, pulando o feriado de 08/12"],
]) eq(F.diasUteisRestantes(venc, new Date(hoje + "T12:00:00")), esperado, `hoje ${hoje}, vence ${venc} (${desc})`);

console.log("Período De/Até do modal de feriados");
eq(F._diasEntre("2026-12-01", "2026-12-02").join(","), "2026-12-01,2026-12-02", "01 a 02/12");
eq(F._diasEntre("2026-12-05").join(","), "2026-12-05", "um dia");
eq(F._diasEntre("2026-12-31", "2027-01-01").join(","), "2026-12-31,2027-01-01", "virada de ano");
eq(F._diasEntre("2028-02-28", "2028-03-01").length, 3, "ano bissexto");
eq(F._diasEntre("2026-12-02", "2026-12-01"), null, "final antes do inicial");
eq(F._diasEntre("2026-01-01", "2026-03-04"), null, "mais de 62 dias");

console.log("Agrupamento da lista");
const g = F._agruparFeriados(F._diasEntre("2026-12-20", "2027-01-20"), F.FERIADOS_NOMES_SEED);
ok(g.length === 1 && g[0].dias.length === 32 && g[0].nome === F.NOME_RECESSO, "recesso em 1 linha de 32 dias");
eq(g[0].inclui.join("|"), "Natal|Ano Novo", "recesso inclui Natal e Ano Novo");

console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTodos os testes de feriados passaram.");
process.exit(falhas ? 1 : 0);
