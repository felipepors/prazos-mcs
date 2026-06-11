# CLAUDE.md — alvara-notifier

Sistema do escritório **Martins, Corrêa da Silva Advogados** para processar alvarás
judiciais (PDF), calcular o valor líquido creditado, identificar o prestador
beneficiário e preparar um e-mail de aviso **pronto para aprovação manual**.

Este sistema vive dentro do repositório do dashboard **MCS Prazos** (`felipepors/prazos-mcs`)
e reutiliza a infraestrutura que **já está no ar**.

---

## ⚖️ Regras de ouro (inegociáveis)

1. **Rascunho nunca dispara sozinho.** O e-mail só é enviado quando o Felipe clica
   "Enviar" na tela de aprovação do dashboard. **Não existe envio automático.**
2. **Segredos só em variáveis de ambiente / Supabase secrets, NUNCA no Git.** Vale para
   `ANTHROPIC_API_KEY` e `LOCAWEB_SMTP_PASS`. O `.gitignore` blinda `.env`, `*.db`, credenciais.
3. **Branch antes de `main`.** Toda mudança vai em branch e só sobe pra `main` após revisão
   do Felipe (via PR). Nada é mergeado sem aprovação.
4. **O valor NUNCA é calculado pelo modelo de IA.** O LLM só *transcreve* os números do PDF.
   Todo cálculo e validação roda em código TypeScript determinístico.
5. **A tabela `prestadores` (CNPJ + e-mail) exige Row Level Security ativado.**

---

## Arquitetura (infra que JÁ existe — não criar projeto novo)

- **Supabase — projeto `MCS-Prazos`** (`frprebgyfnbeetuwmrzd`, região `sa-east-1`).
  Mesmo projeto onde o monitor DJEN sincroniza e o dashboard lê. Roda todo dia, então
  não corre risco de pausar no plano gratuito.
  - **Storage:** bucket para os PDFs de alvará.
  - **Edge Functions (Deno/TypeScript):** orquestram extração → enriquecimento → gravam o
    alvará com status `aguardando_aprovacao`.
  - **Postgres:** tabelas `prestadores` (CNPJ → e-mail, com RLS) e `alvaras` (registro + status).
- **Dashboard — MCS Prazos** (React/Vite/JSX na Vercel, este repo): aba "Alvarás" com upload
  de PDF, lista e tela de revisão com botão **Enviar**.
- **Envio — SMTP da Locaweb** (só na aprovação).

> Tabelas existentes no projeto (não mexer): `estado_usuario`, `publicacoes_djen`,
> `movimentacoes_djen`. Os nomes `prestadores` e `alvaras` estão livres.

---

## Dados técnicos

### Anthropic (extração)
- Modelo: **`claude-haiku-4-5`** (barato, ótimo para extração).
- API key via env **`ANTHROPIC_API_KEY`**.

### Locaweb (envio SMTP)
- Host: `email-ssl.com.br`
- Porta: `465` SSL/TLS (alternativa: `587` STARTTLS)
- Usuário: **`contato@martinscorreadasilva.com.br`** (e-mail completo)
- Senha: env **`LOCAWEB_SMTP_PASS`** (nunca no Git)
- ⚠️ A conta autenticada no SMTP deve ser **a mesma** usada como remetente, senão a Locaweb
  rejeita o envio. Remetente = `contato@martinscorreadasilva.com.br`.

---

## Schema do JSON que a extração (Claude) deve devolver

O modelo **apenas transcreve** — não calcula, não converte datas, não valida dígito.

```json
{
  "numero_alvara": "string",
  "processo": "string",
  "juizo": "string",
  "beneficiario_nome": "string",
  "beneficiario_doc": "string (CPF ou CNPJ como vier no PDF)",
  "valor_alvara": "string (ex: 19.150,00)",
  "despesa_bancaria": "string (ex: 8,00)",
  "imposto_renda": "string (ex: 0,00)",
  "data_creditamento": "string (DD/MM/AAAA)",
  "data_expedicao": "string (por extenso)",
  "banco": "string",
  "agencia": "string",
  "conta": "string"
}
```

---

## Lógica determinística (Passo 2 — TypeScript)

- `valor_liquido_creditado = valor_bruto − despesa_bancaria − imposto_renda`
- Documento pode vir rotulado "CPF" mas ser CNPJ → inferir pelo nº de dígitos (14 = CNPJ),
  validar dígito verificador, corrigir o rótulo.
- Limpar sufixos de status do nome: `(INTIMADO)`, `(CITADO)`, `(INTIMADA)`.
- `data_creditamento` ← campo "Creditado em DD/MM/AAAA"; `data_expedicao` ← data por extenso
  no rodapé. Gravar datas em **ISO** no banco.
- Formatar valores em **BRL** (R$ 1.234,56) na exibição.

### Fixture de teste (alvará real) — o enriquecimento DEVE produzir exatamente:
- prestador: `EXCELENCIA ASSISTENCIA EM SAUDE EIRELI` (sem `(INTIMADO)`)
- documento: `19.009.309/0001-70`, tipo `CNPJ`, válido = `true`
- processo: `5141986-86.2023.8.21.0001`
- numero_alvara: `001.26/500190264`
- valor_bruto: `R$ 19.150,00`
- despesa_bancaria: `R$ 8,00`
- valor_liquido_creditado: `R$ 19.142,00`
- data_creditamento: `2026-04-08`
- data_expedicao: `2026-04-07`

---

## Ordem de construção (cada Passo = um commit revisável; nada na `main` sem aprovação)

- **Passo 0** — Setup e segredos (CLAUDE.md, .gitignore, .env.example, docs/setup-segredos.md). ✅
- **Passo 1** — Extração: chamada `claude-haiku-4-5` PDF → JSON do schema.
- **Passo 2** — Enriquecimento determinístico em TypeScript (bater o fixture).
- **Passo 3** — Banco: tabelas `prestadores` (RLS) e `alvaras` + cadastro CNPJ→e-mail.
- **Passo 4** — Edge Function orquestradora (extração + enriquecimento + matching + gravar).
- **Passo 5** — Storage: bucket + gatilho que aciona a Edge Function.
- **Passo 6** — Envio SMTP Locaweb (separado, só na aprovação).
- **Passo 7** — Dashboard: aba "Alvarás" (upload, lista, revisão, botão Enviar).

---

## Convenções

- **Branch de trabalho:** desenvolvimento em branch; `main` só por PR aprovado pelo Felipe.
- **Edge Functions:** Deno + TypeScript em `supabase/functions/`.
- **Dashboard:** JavaScript/JSX (o repo não usa TypeScript no front).
- **Segredos:** nunca commitados; use `.env` local (gitignored) e Supabase secrets.
