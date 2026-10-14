# imagem-mcp — conector MCP gratuito de imagem generativa

Servidor MCP que roda no **Cloudflare Workers** (plano grátis) e usa o **Workers AI** (10.000 neurons/dia grátis) para:

| Ferramenta | Modelo | Uso |
|---|---|---|
| `gerar_imagem` | FLUX.1 schnell | Imagem nova a partir de texto |
| `editar_imagem` | SD 1.5 img2img | Muda a imagem inteira (estilo, clima, cores) |
| `substituir_area` | SD 1.5 inpainting | Remove/troca só a área pintada na máscara |

Custo: R$ 0 dentro da cota diária (algumas dezenas de imagens/dia). Sem dependências npm no código.

## Implantação pelo navegador (GitHub Actions, sem computador)

O workflow `.github/workflows/deploy.yml` cria o KV, publica o Worker e grava o segredo a cada push na `main`.

1. **Cloudflare** (conta grátis, sem cartão) — em *My Profile → API Tokens → Create Token*, use o modelo **Edit Cloudflare Workers**. Copie o token. Copie também o **Account ID** (aparece na página *Workers & Pages* ou na URL do painel).
2. **GitHub** — no repositório: *Settings → Secrets and variables → Actions → New repository secret*, crie:
   - `CLOUDFLARE_API_TOKEN` = o token
   - `CLOUDFLARE_ACCOUNT_ID` = o Account ID
   - `MCP_SECRET` = um texto aleatório com 24+ caracteres, só letras/números (anote: ele faz parte da URL)
3. **Rodar** — aba *Actions → Deploy no Cloudflare → Run workflow*. O resumo da execução mostra a URL base.
4. **Conectar** — no Claude, adicione o conector personalizado com `https://imagem-mcp.SEU-USUARIO.workers.dev/MCP_SECRET/mcp`.

Se o deploy falhar por permissão, edite o token na Cloudflare e adicione *Account → Workers AI → Edit*.

## Implantação pelo terminal (alternativa, ≈10 min, Node.js 18+)

```bash
cd imagem-mcp
npx wrangler login                                  # abre o navegador
npx wrangler ai models list | grep -i -E "flux|diffusion"   # confira se os 3 modelos ainda existem
npx wrangler kv namespace create IMAGENS            # copie o id para wrangler.jsonc
npx wrangler secret put SECRET                      # digite um segredo longo e aleatório
npx wrangler deploy
```

Para gerar um segredo: `openssl rand -hex 24`.

O deploy mostra a URL, ex.: `https://imagem-mcp.SEU-USUARIO.workers.dev`. As rotas ficam:

- Página de upload: `https://imagem-mcp.SEU-USUARIO.workers.dev/SEGREDO/`
- Endpoint MCP: `https://imagem-mcp.SEU-USUARIO.workers.dev/SEGREDO/mcp`

## Conectar ao Claude
Configurações → Conectores → **Adicionar conector personalizado** → cole a URL do endpoint MCP. Depois ative o conector no chat.

## Uso
- **Gerar:** "Gere uma imagem de uma moto trail numa rua de paralelepípedo ao pôr do sol."
- **Editar a foto inteira:** abra a página de upload, envie a foto, cole o `image_id` no chat e diga o que mudar.
- **Remover/trocar um objeto:** na página de upload, pinte a área (ex.: o celular), toque em *Enviar imagem + máscara*, cole `image_id` e `mask_id` no chat e diga o que deve aparecer no lugar.

Os resultados chegam como link (válido por 24 h). O id do resultado pode ser editado de novo.

## Teste rápido sem o Claude
```bash
URL=https://imagem-mcp.SEU-USUARIO.workers.dev/SEGREDO/mcp
curl -s $URL -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s $URL -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gerar_imagem","arguments":{"prompt":"red trail motorcycle, cobblestone street, sunset"}}}'
```

## Limitações conhecidas
- **Qualidade de edição:** SD 1.5 trabalha em ~512–768 px; o resultado é inferior a Photoshop/Gemini. Geração com FLUX é boa.
- **Formato:** FLUX costuma devolver JPEG; os modelos SD devolvem PNG. Para JPEG garantido, converta no download ou peça ao Claude.
- **Modelos mudam:** a Cloudflare aposenta modelos. Se der erro de modelo, troque o nome em `MODELOS` no topo de `src/index.js`.
- **Segurança:** a proteção é o segredo na URL. Não compartilhe a URL; para trocar, rode `wrangler secret put SECRET` de novo.
- **KV grátis:** 1.000 gravações/dia — sobra para uso pessoal.
- **Privacidade:** as fotos passam pela Cloudflare. Não envie imagens com dados confidenciais (ex.: de trabalho) ou desfoque antes.
