// Servidor MCP de imagem generativa — Cloudflare Workers + Workers AI (cota gratuita)
// Transporte: Streamable HTTP, modo stateless (respostas JSON), JSON-RPC 2.0 sem dependências.
//
// Rotas (todas protegidas por um segredo no caminho):
//   /<SECRET>/        -> página de upload (redimensiona a foto e permite pintar máscara)
//   /<SECRET>/upload  -> POST com os bytes da imagem; devolve { id }
//   /<SECRET>/img/<id>-> baixa uma imagem armazenada (entrada ou resultado)
//   /<SECRET>/mcp     -> endpoint MCP (é esta URL que vai no conector do Claude)

// Confira os nomes com `npx wrangler ai models list` — a Cloudflare aposenta modelos.
const MODELOS = {
  gerar: "@cf/black-forest-labs/flux-2-klein-4b", // texto -> imagem, até 4 MP
  editar: "@cf/black-forest-labs/flux-2-klein-4b", // edição por instrução, imagens de entrada até 512 px
  inpaint: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
};

const VERSOES_MCP = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TTL_SEGUNDOS = 60 * 60 * 24; // imagens expiram em 24 h
const MAX_BYTES_ENTRADA = 2 * 1024 * 1024;
const MAX_BYTES_INLINE = 4 * 1024 * 1024;
const MAX_PIXELS = 3_900_000; // FLUX.2 aceita até 4 MP de saída
const FORMATOS = { quadrado: 1, vertical: 3 / 4, horizontal: 4 / 3, retrato: 9 / 16, paisagem: 16 / 9 };

const FERRAMENTAS = [
  {
    name: "gerar_imagem",
    description:
      "Gera uma imagem nova a partir de texto (FLUX.2 klein), na maior resolução possível (~3,9 MP, até 2048 px no lado maior). Escreva o prompt em inglês para melhores resultados.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Descrição da imagem, de preferência em inglês." },
        formato: {
          type: "string",
          enum: Object.keys(FORMATOS),
          description: "Proporção da imagem (padrão quadrado). vertical=3:4, horizontal=4:3, retrato=9:16, paisagem=16:9.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "editar_imagem",
    description:
      "Edita uma imagem por instrução em texto (FLUX.2 klein): remover ou trocar objetos, mudar clima, estilo, cores. Ex.: 'remove the phone and the shoe, keep everything else'. Entrada de até 512 px; saída na maior resolução possível mantendo a proporção da foto. image_id vem da página de upload, de um resultado anterior, ou repo:arquivo.jpg da pasta /entradas do repositório.",
    inputSchema: {
      type: "object",
      properties: {
        image_id: { type: "string" },
        prompt: { type: "string", description: "Instrução de edição, de preferência em inglês." },
      },
      required: ["image_id", "prompt"],
    },
  },
  {
    name: "substituir_area",
    description:
      "Remove ou substitui só a área pintada na máscara (inpainting). Exige image_id e mask_id (da página de upload ou repo:arquivo.png da pasta /entradas; máscara branca = área a trocar, mesmo tamanho da imagem). O prompt descreve o que deve aparecer no lugar (ex.: 'cobblestone pavement').",
    inputSchema: {
      type: "object",
      properties: {
        image_id: { type: "string" },
        mask_id: { type: "string" },
        prompt: { type: "string" },
        negative_prompt: { type: "string" },
      },
      required: ["image_id", "mask_id", "prompt"],
    },
  },
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const partes = url.pathname.split("/").filter(Boolean);
    if (!env.SECRET || partes[0] !== env.SECRET) return new Response("Not found", { status: 404 });

    const rota = partes.slice(1).join("/");
    const base = `${url.origin}/${env.SECRET}`;

    try {
      if (rota === "mcp") return await rotaMcp(req, env, base);
      if (rota === "upload") return await rotaUpload(req, env);
      if (rota.startsWith("img/")) return await rotaImagem(env, rota.slice(4));
      if (rota === "") return new Response(PAGINA_UPLOAD, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(`Erro: ${e.message}`, { status: 500 });
    }
  },
};

// ---------------- MCP (JSON-RPC 2.0) ----------------

async function rotaMcp(req, env, base) {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let corpo;
  try {
    corpo = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  const lote = Array.isArray(corpo) ? corpo : [corpo];
  const respostas = [];
  for (const msg of lote) {
    if (msg.id === undefined || msg.id === null) continue; // notificações não têm resposta
    respostas.push(await despachar(msg, env, base));
  }
  if (respostas.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(corpo) ? respostas : respostas[0]);
}

async function despachar(msg, env, base) {
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const pedida = msg.params?.protocolVersion;
      return ok({
        protocolVersion: VERSOES_MCP.includes(pedida) ? pedida : VERSOES_MCP[0],
        capabilities: { tools: {} },
        serverInfo: { name: "imagem-generativa", version: "0.1.0" },
        instructions:
          `Para editar uma foto, o usuário precisa enviá-la em ${base}/ e colar aqui o image_id (e o mask_id, se pintou uma máscara). ` +
          "Os resultados são links válidos por 24 h; o id de um resultado pode ser reeditado.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: FERRAMENTAS });
    case "tools/call":
      try {
        const content = await executarFerramenta(msg.params?.name, msg.params?.arguments ?? {}, env, base);
        return ok({ content });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Falha: ${e.message}` }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Método não suportado: ${msg.method}` } };
  }
}

async function executarFerramenta(nome, args, env, base) {
  let saida;

  if (nome === "gerar_imagem") {
    exigir(args.prompt, "prompt");
    const { w, h } = tamanhoAlvo(FORMATOS[args.formato] ?? 1);
    saida = await rodarFlux2(env, MODELOS.gerar, args.prompt, [], w, h);
  } else if (nome === "editar_imagem") {
    exigir(args.image_id, "image_id");
    exigir(args.prompt, "prompt");
    const buf = await lerBytes(env, args.image_id);
    const dim = dimensoes(new Uint8Array(buf));
    const { w, h } = tamanhoAlvo(dim ? dim.w / dim.h : 1);
    saida = await rodarFlux2(env, MODELOS.editar, args.prompt, [buf], w, h);
  } else if (nome === "substituir_area") {
    exigir(args.image_id, "image_id");
    exigir(args.mask_id, "mask_id");
    exigir(args.prompt, "prompt");
    const [img, mask] = await Promise.all([lerEntrada(env, args.image_id), lerEntrada(env, args.mask_id)]);
    const r = await env.AI.run(MODELOS.inpaint, {
      prompt: args.prompt,
      negative_prompt: args.negative_prompt ?? "",
      image: img,
      mask,
      num_steps: 20,
    });
    saida = await normalizarSaida(r);
  } else {
    throw new Error(`Ferramenta desconhecida: ${nome}`);
  }

  const id = crypto.randomUUID();
  await env.IMAGENS.put(`img:${id}`, saida.bytes, {
    expirationTtl: TTL_SEGUNDOS,
    metadata: { type: saida.tipo },
  });
  const texto = `Imagem pronta (${saida.tipo}, válida por 24 h).\nLink: ${base}/img/${id}\nimage_id para nova edição: ${id}`;
  const content = [{ type: "text", text: texto }];
  // Devolve a imagem embutida para aparecer direto no chat (limite p/ não estourar a resposta).
  const bytes = new Uint8Array(saida.bytes);
  if (bytes.byteLength <= MAX_BYTES_INLINE) {
    content.push({ type: "image", data: paraBase64(bytes), mimeType: saida.tipo });
  }
  return content;
}

function paraBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// FLUX.2 no Workers AI recebe multipart: prompt, width, height e input_image_0..3.
async function rodarFlux2(env, modelo, prompt, imagens, w, h) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(w));
  form.append("height", String(h));
  imagens.forEach((buf, i) => {
    form.append(`input_image_${i}`, new Blob([buf], { type: detectarTipo(new Uint8Array(buf)) }));
  });
  const corpo = new Response(form);
  const r = await env.AI.run(modelo, {
    multipart: { body: corpo.body, contentType: corpo.headers.get("content-type") },
  });
  return normalizarSaida(r);
}

// Maior tamanho com a proporção pedida, dentro de MAX_PIXELS, lados múltiplos de 16 e <= 2048.
function tamanhoAlvo(proporcao) {
  const r = Math.min(4, Math.max(0.25, proporcao || 1));
  let h = Math.sqrt(MAX_PIXELS / r);
  let w = h * r;
  const k = Math.min(1, 2048 / Math.max(w, h));
  w = Math.floor((w * k) / 16) * 16;
  h = Math.floor((h * k) / 16) * 16;
  return { w, h };
}

// Lê largura/altura do cabeçalho JPEG ou PNG.
function dimensoes(b) {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const v = new DataView(b.buffer, b.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Os modelos devolvem formatos diferentes: FLUX -> { image: base64 }, SD -> stream binário PNG.
async function normalizarSaida(r) {
  if (r instanceof ReadableStream) {
    return { bytes: await new Response(r).arrayBuffer(), tipo: "image/png" };
  }
  if (r instanceof ArrayBuffer || r instanceof Uint8Array) {
    return { bytes: r, tipo: "image/png" };
  }
  if (r && typeof r.image === "string") {
    const bin = atob(r.image);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, tipo: detectarTipo(bytes) };
  }
  throw new Error("Formato de resposta do modelo não reconhecido.");
}

async function lerEntrada(env, id) {
  // Os modelos SD do Workers AI recebem a imagem como array de inteiros (bytes).
  return Array.from(new Uint8Array(await lerBytes(env, id)));
}

async function lerBytes(env, id) {
  let buf;
  if (id.startsWith("repo:")) {
    // Imagens versionadas em /entradas no GitHub, publicadas como assets do Worker.
    const nome = id.slice(5);
    if (!/^[\w.-]+$/.test(nome)) throw new Error("Nome de arquivo inválido.");
    if (!env.ASSETS) throw new Error("Assets não configurados no Worker.");
    const r = await env.ASSETS.fetch(new Request(`https://assets.local/${nome}`));
    if (!r.ok) throw new Error(`Arquivo ${nome} não está em /entradas (o deploy já terminou?).`);
    buf = await r.arrayBuffer();
  } else {
    buf = await env.IMAGENS.get(`img:${id}`, "arrayBuffer");
  }
  if (!buf) throw new Error(`Imagem ${id} não encontrada ou expirada. Envie de novo pela página de upload.`);
  return buf;
}

// ---------------- Upload e download ----------------

async function rotaUpload(req, env) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const tipo = req.headers.get("content-type") || "";
  if (!tipo.startsWith("image/")) return json({ erro: "Envie os bytes da imagem com content-type image/*" }, 400);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES_ENTRADA) return json({ erro: "Imagem maior que 2 MB; reduza a resolução." }, 413);

  const id = crypto.randomUUID();
  await env.IMAGENS.put(`img:${id}`, bytes, { expirationTtl: TTL_SEGUNDOS, metadata: { type: tipo } });
  return json({ id });
}

async function rotaImagem(env, id) {
  const { value, metadata } = await env.IMAGENS.getWithMetadata(`img:${id}`, "arrayBuffer");
  if (!value) return new Response("Imagem não encontrada ou expirada", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": metadata?.type || "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}

// ---------------- Utilitários ----------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function exigir(v, nome) {
  if (v === undefined || v === null || v === "") throw new Error(`Parâmetro obrigatório ausente: ${nome}`);
}
function limitar(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
function detectarTipo(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  return "application/octet-stream";
}

// ---------------- Página de upload (redimensiona e pinta máscara no navegador) ----------------

const PAGINA_UPLOAD = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload de imagem</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
 .wrap{max-width:640px;margin:auto}
 canvas{width:100%;height:auto;touch-action:none;border-radius:8px;display:block}
 #pilha{position:relative}#pinta{position:absolute;inset:0}
 button,input,label{font-size:16px}button{padding:10px 14px;margin:6px 6px 0 0;border-radius:8px;border:0;background:#3b82f6;color:#fff}
 button.sec{background:#444} .ids{background:#222;padding:12px;border-radius:8px;margin-top:12px;word-break:break-all;white-space:pre-wrap}
 small{color:#aaa}
</style></head><body><div class="wrap">
<h2>Enviar imagem</h2>
<p><input type="file" id="arq" accept="image/*"></p>
<p><small>A foto é reduzida para no máx. 512 px antes do envio. Para trocar/remover uma área, pinte por cima dela com o dedo.</small></p>
<div id="pilha" hidden><canvas id="foto"></canvas><canvas id="pinta"></canvas></div>
<p id="ctl" hidden>
 <label>Pincel <input type="range" id="pincel" min="8" max="80" value="28"></label><br>
 <button class="sec" id="limpar">Limpar máscara</button>
 <button id="enviar">Enviar só a imagem</button>
 <button id="enviarM">Enviar imagem + máscara</button>
</p>
<div class="ids" id="saida" hidden></div>
</div>
<script>
const MAX=512, foto=document.getElementById('foto'), pinta=document.getElementById('pinta');
const fx=foto.getContext('2d'), px=pinta.getContext('2d'); const mascara=document.createElement('canvas'); const mx=mascara.getContext('2d');
let pintando=false, pintou=false;
document.getElementById('arq').onchange=async e=>{
 const f=e.target.files[0]; if(!f) return; const bmp=await createImageBitmap(f);
 let w=bmp.width,h=bmp.height,k=Math.min(1,MAX/Math.max(w,h)); w=Math.round(w*k/8)*8; h=Math.round(h*k/8)*8;
 for(const c of [foto,pinta,mascara]){c.width=w;c.height=h}
 fx.drawImage(bmp,0,0,w,h); limpar();
 document.getElementById('pilha').hidden=false; document.getElementById('ctl').hidden=false;
};
function limpar(){px.clearRect(0,0,pinta.width,pinta.height); mx.fillStyle='#000'; mx.fillRect(0,0,mascara.width,mascara.height); pintou=false}
document.getElementById('limpar').onclick=limpar;
function ponto(e){const r=pinta.getBoundingClientRect(); return [(e.clientX-r.left)*pinta.width/r.width,(e.clientY-r.top)*pinta.height/r.height]}
function tinta(e){ if(!pintando) return; const [x,y]=ponto(e), raio=+document.getElementById('pincel').value*pinta.width/pinta.getBoundingClientRect().width/2;
 px.fillStyle='rgba(255,0,80,.45)'; px.beginPath(); px.arc(x,y,raio,0,7); px.fill();
 mx.fillStyle='#fff'; mx.beginPath(); mx.arc(x,y,raio,0,7); mx.fill(); pintou=true }
pinta.onpointerdown=e=>{pintando=true; pinta.setPointerCapture(e.pointerId); tinta(e)};
pinta.onpointermove=tinta; pinta.onpointerup=pinta.onpointercancel=()=>pintando=false;
const blob=(c,t,q)=>new Promise(r=>c.toBlob(r,t,q));
async function subir(b){const r=await fetch('upload',{method:'POST',headers:{'content-type':b.type},body:b}); const j=await r.json(); if(!r.ok) throw new Error(j.erro||r.status); return j.id}
async function enviar(comMascara){
 const s=document.getElementById('saida'); s.hidden=false; s.textContent='Enviando...';
 try{
  if(comMascara && !pintou) throw new Error('Pinte a área que deve ser substituída.');
  const img=await subir(await blob(foto,'image/jpeg',0.9)); let txt='image_id: '+img;
  if(comMascara){ const m=await subir(await blob(mascara,'image/png')); txt+='\\nmask_id: '+m }
  s.textContent=txt+'\\n\\nCole isto no Claude junto com o que você quer mudar.';
 }catch(err){ s.textContent='Erro: '+err.message }
}
document.getElementById('enviar').onclick=()=>enviar(false);
document.getElementById('enviarM').onclick=()=>enviar(true);
// A rota relativa 'upload' exige que a página seja aberta com barra final: /SEGREDO/
if(!location.pathname.endsWith('/')) location.replace(location.pathname+'/');
</script></body></html>`;
