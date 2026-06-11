# Passo 0 — Setup de segredos (roteiro clique-a-clique)

> ⚠️ **Regra de ouro nº 2:** nenhum destes valores entra no Git. Eles vão para um
> cofre de senhas + Supabase secrets + um `.env` local (que está no `.gitignore`).
> Eu (Claude) **não** consigo abrir o console da Anthropic nem clicar por você —
> este roteiro é a parte manual sua. Quando terminar, me avise que sigo.

---

## 1. Anthropic — crédito, limite de gasto e API key

1. Acesse **https://console.anthropic.com** e faça login.
2. **Settings → Billing**:
   - Clique em **Add payment method** e cadastre o cartão.
   - Clique em **Buy credits** e compre **US$ 5** (suficiente para muitos alvarás —
     a extração com `claude-haiku-4-5` custa fração de centavo por PDF).
3. Ainda em Billing, defina um teto de gasto baixo:
   - Procure **Usage limits / Spend limit** e configure **US$ 10/mês**.
4. **Settings → API Keys → Create Key**:
   - Nome sugerido: `alvara-notifier`.
   - **Copie a chave AGORA** (ela só aparece uma vez) e guarde no seu cofre de
     senhas (1Password / Bitwarden / etc.). Ela começa com `sk-ant-...`.

## 2. Locaweb — senha do e-mail institucional

- A senha da caixa **`contato@martinscorreadasilva.com.br`** já existe; você não
  precisa criar nada. Apenas tenha-a à mão (do cofre) para o Passo 6 (envio SMTP).
- Dados fixos do SMTP (já documentados no `CLAUDE.md`): host `email-ssl.com.br`,
  porta `465` SSL (ou `587` STARTTLS), usuário = o e-mail completo.

## 3. Guardar os segredos nos lugares certos

### a) `.env` local (para testar a extração na sua máquina)

Copie o template e preencha (o `.env` está blindado no `.gitignore`):

```bash
cp .env.example .env
# edite .env e cole a ANTHROPIC_API_KEY (e depois a LOCAWEB_SMTP_PASS)
```

### b) Supabase secrets (para a Edge Function em produção)

Com a [Supabase CLI](https://supabase.com/docs/guides/local-development) instalada
e logada (`supabase login`), no diretório do projeto:

```bash
# vincular ao projeto existente MCS-Prazos (uma vez)
supabase link --project-ref frprebgyfnbeetuwmrzd

# gravar os segredos (eles NÃO vão para o Git)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...           # a chave do passo 1
supabase secrets set LOCAWEB_SMTP_PASS=...                  # a senha da caixa (Passo 6)

# conferir (mostra só os nomes, nunca os valores)
supabase secrets list
```

> Alternativa pelo painel: **Supabase → Project Settings → Edge Functions → Secrets**.

---

## Checklist do Passo 0

- [ ] Cartão cadastrado na Anthropic
- [ ] US$ 5 de crédito comprados
- [ ] Limite de gasto ~US$ 10/mês configurado
- [ ] API key criada e guardada no cofre
- [ ] `ANTHROPIC_API_KEY` no `.env` local
- [ ] `ANTHROPIC_API_KEY` nos Supabase secrets
- [ ] (Passo 6) `LOCAWEB_SMTP_PASS` guardada — gravamos no secret quando chegarmos lá

Quando os itens da API key estiverem ✅, me avise: testamos a extração (Passo 1)
contra um PDF de alvará real.
