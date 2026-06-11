# Fixtures de teste

Coloque aqui **um alvará judicial real em PDF** para testar a extração do Passo 1
e o enriquecimento do Passo 2.

```
supabase/tests/fixtures/alvara-excelencia.pdf
```

> ⚠️ Estes PDFs são **dado sensível** (contêm CNPJ, valores, conta bancária) e
> estão no `.gitignore` (`supabase/tests/fixtures/*.pdf`) — não são versionados.
> Compartilhe-os fora do Git.

O alvará de referência usado no fixture do Passo 2 deve produzir:

- prestador: `EXCELENCIA ASSISTENCIA EM SAUDE EIRELI`
- documento: `19.009.309/0001-70` (CNPJ válido)
- processo: `5141986-86.2023.8.21.0001`
- valor líquido creditado: `R$ 19.142,00`
