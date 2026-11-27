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

## 2. Zoho Mail — senha de aplicativo do e-mail institucional

O e-mail do escritório saiu da Locaweb e foi para o Zoho Mail (27/11/2026).

1. Entre em **https://accounts.zoho.com** com `contato@martinscorreadasilva.com.br`.
2. **Segurança → Senhas específicas de aplicativo → Gerar nova senha**
   (nome sugerido: `mcs-prazos-supabase`). Copie e guarde no cofre.
   - Se o 2FA estiver desligado, a senha normal da caixa também funciona, mas a de
     aplicativo é melhor: pode ser revogada sem trocar a senha da caixa.
3. Confira o servidor em **Zoho Mail → Configurações → Contas de e-mail → SMTP**.
   O padrão do código é `smtppro.zoho.com`, porta `465` (SSL). Se aparecer outro
   (ex.: `smtppro.zoho.eu`), grave-o no secret `ALVARA_SMTP_HOST`.
4. **Acesso SMTP ligado:** em Configurações → Contas de e-mail, confirme que
   "Acesso IMAP/POP/SMTP" está habilitado para a conta.
5. **DNS do domínio (SPF/DKIM):** o painel de administração do Zoho mostra os registros
   SPF (`include:zoho.com`) e DKIM a cadastrar. Sem eles, os avisos tendem a cair no spam.

## 3. Guardar os segredos nos lugares certos

### a) `.env` local (para testar a extração na sua máquina)

Copie o template e preencha (o `.env` está blindado no `.gitignore`):

```bash
cp .env.example .env
# edite .env e cole a ANTHROPIC_API_KEY (e depois a ZOHO_SMTP_PASS)
```

### b) Supabase secrets (para a Edge Function em produção)

Com a [Supabase CLI](https://supabase.com/docs/guides/local-development) instalada
e logada (`supabase login`), no diretório do projeto:

```bash
# vincular ao projeto existente MCS-Prazos (uma vez)
supabase link --project-ref frprebgyfnbeetuwmrzd

# gravar os segredos (eles NÃO vão para o Git)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...           # a chave do passo 1
supabase secrets set ZOHO_SMTP_PASS=...                     # senha de aplicativo do Zoho (Passo 6)
# opcional — só se o Zoho mostrar outro servidor SMTP que não smtppro.zoho.com
# supabase secrets set ALVARA_SMTP_HOST=smtppro.zoho.eu
supabase secrets set EMAILS_AUTORIZADOS=seu-login@exemplo    # e-mail(s) de login autorizados a processar/enviar alvarás
# opcional — cópia oculta dos avisos (padrão: contato@correadasilvamartins.com.br; "-" desliga)
# supabase secrets set ALVARA_EMAIL_BCC=contato@correadasilvamartins.com.br

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
- [ ] (Passo 6) `ZOHO_SMTP_PASS` (senha de aplicativo do Zoho) nos Supabase secrets

Quando os itens da API key estiverem ✅, me avise: testamos a extração (Passo 1)
contra um PDF de alvará real.
