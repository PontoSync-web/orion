/**
 * ARQUIVO: scripts/teste-localizacao.js
 * OBJETIVO: Testar de ponta a ponta a localização de um número no ORION e
 *           dizer EXATAMENTE em qual etapa a falha acontece.
 *
 * USO:
 *   node scripts/teste-localizacao.js 71988979724
 *   node scripts/teste-localizacao.js 71988979724 --url https://orion.onrender.com
 *   node scripts/teste-localizacao.js 71988979724 --cell 208020001 --mcc 724 --mnc 5 --lac 100
 *
 * Sem --url o script sobe o próprio orion.js numa porta local, testa e encerra.
 * Gera um mapa HTML com o resultado em data/mapa-teste-<numero>.html
 */

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { URL } = require('url');

// ------------------------------------------------------------------
// Argumentos
// ------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(nome, padrao) {
  const i = argv.indexOf('--' + nome);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : padrao;
}

const numero = (argv[0] && !argv[0].startsWith('--') ? argv[0] : arg('numero', '')).replace(/\D/g, '');
const baseUrlExterna = arg('url', '');
const portaLocal = parseInt(arg('port', '3010'), 10);
const celula = {
  cellId: parseInt(arg('cell', '208020001'), 10),
  mcc: parseInt(arg('mcc', '724'), 10),
  mnc: parseInt(arg('mnc', '5'), 10),
  lac: parseInt(arg('lac', '100'), 10)
};
const semCadastro = argv.includes('--sem-cadastro');

if (!numero || numero.length < 10) {
  console.error('Uso: node scripts/teste-localizacao.js <numero> [--url http://host] [--cell N --mcc N --mnc N --lac N]');
  process.exit(2);
}

// ------------------------------------------------------------------
// Utilidades de saída
// ------------------------------------------------------------------
const resultados = [];
const C = { ok: '\x1b[32m', erro: '\x1b[31m', aviso: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m' };

function titulo(t) {
  console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));
}

function registrar(etapa, ok, detalhe) {
  resultados.push({ etapa, ok, detalhe });
  const cor = ok === true ? C.ok : ok === null ? C.aviso : C.erro;
  const marca = ok === true ? 'PASSOU' : ok === null ? 'ATENÇÃO' : 'FALHOU';
  console.log(`${cor}[${marca}]${C.off} ${etapa}`);
  if (detalhe) console.log(`${C.dim}         ${detalhe}${C.off}`);
}

// ------------------------------------------------------------------
// Cliente HTTP simples (sem dependências externas)
// ------------------------------------------------------------------
function pedir(metodo, urlStr, corpo) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return resolve({ erroRede: 'URL inválida: ' + urlStr });
    }
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: metodo,
        timeout: 20000,
        headers: dados
          ? { 'Content-Type': 'application/json', 'Content-Length': dados.length }
          : { Accept: 'application/json' }
      },
      (res) => {
        let bruto = '';
        res.on('data', (c) => (bruto += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(bruto);
          } catch (e) {
            /* resposta não-JSON */
          }
          resolve({ status: res.statusCode, json, texto: bruto.slice(0, 400) });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ erroRede: 'timeout após 20s' });
    });
    req.on('error', (e) => resolve({ erroRede: e.message }));
    if (dados) req.write(dados);
    req.end();
  });
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function aguardarServidor(base, tentativas) {
  for (let i = 0; i < tentativas; i++) {
    const r = await pedir('GET', base + '/');
    if (!r.erroRede) return true;
    await esperar(1000);
  }
  return false;
}

// ------------------------------------------------------------------
// Mapa HTML do resultado
// ------------------------------------------------------------------
function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gerarMapa(destino, info) {
  const temPos = info.position && isFinite(info.position.latitude) && isFinite(info.position.longitude);
  const lat = temPos ? info.position.latitude : -14.235;
  const lon = temPos ? info.position.longitude : -51.925;
  const raio = temPos ? info.position.raio_estimado || 500 : 0;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORION - Teste de localização ${escapar(info.numero)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  body{margin:0;font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#e8eaed}
  header{padding:14px 18px;background:#171a21;border-bottom:1px solid #262b36}
  h1{margin:0;font-size:17px}
  .sub{color:#9aa4b2;font-size:13px;margin-top:4px}
  #mapa{height:60vh;width:100%}
  .painel{padding:14px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
  .card{background:#171a21;border:1px solid #262b36;border-radius:8px;padding:10px 12px}
  .rot{color:#9aa4b2;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .val{font-size:15px;margin-top:4px;word-break:break-word}
  .aviso{margin:0 18px 18px;padding:12px 14px;border-radius:8px;background:#2a2113;border:1px solid #5c4a17;color:#f0d089;font-size:13px;line-height:1.5}
</style>
</head>
<body>
<header>
  <h1>ORION &mdash; teste de localização</h1>
  <div class="sub">Número ${escapar(info.numero)} &middot; ${escapar(info.status)} &middot; ${escapar(info.geradoEm)}</div>
</header>
<div id="mapa"></div>
<div class="painel">
  <div class="card"><div class="rot">Latitude</div><div class="val">${temPos ? escapar(lat.toFixed(6)) : '&mdash;'}</div></div>
  <div class="card"><div class="rot">Longitude</div><div class="val">${temPos ? escapar(lon.toFixed(6)) : '&mdash;'}</div></div>
  <div class="card"><div class="rot">Raio estimado</div><div class="val">${temPos ? escapar(raio) + ' m' : '&mdash;'}</div></div>
  <div class="card"><div class="rot">Torres usadas</div><div class="val">${escapar(info.torres_usadas != null ? info.torres_usadas : 0)}</div></div>
  <div class="card"><div class="rot">Célula consultada</div><div class="val">cell ${escapar(info.celula.cellId)} / mcc ${escapar(info.celula.mcc)} / mnc ${escapar(info.celula.mnc)} / lac ${escapar(info.celula.lac)}</div></div>
  <div class="card"><div class="rot">Origem do dado</div><div class="val">${escapar(info.origem)}</div></div>
</div>
<div class="aviso">${escapar(info.observacao)}</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script>
  var temPos = ${temPos ? 'true' : 'false'};
  var lat = ${lat}, lon = ${lon}, raio = ${raio};
  var mapa = L.map('mapa').setView([lat, lon], temPos ? 13 : 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(mapa);
  if (temPos) {
    L.marker([lat, lon]).addTo(mapa).bindPopup(${JSON.stringify('Posição estimada de ' + numero)}).openPopup();
    L.circle([lat, lon], { radius: raio, color: '#ff9f1c', fillColor: '#ff9f1c', fillOpacity: 0.15 }).addTo(mapa);
  }
<\/script>
</body>
</html>`;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, html, 'utf8');
}

// ------------------------------------------------------------------
// Execução
// ------------------------------------------------------------------
(async () => {
  titulo('ORION — TESTE DE LOCALIZAÇÃO POR NÚMERO');
  console.log('Número.....: ' + numero);
  console.log('Célula alvo.: cell=' + celula.cellId + ' mcc=' + celula.mcc + ' mnc=' + celula.mnc + ' lac=' + celula.lac);

  let filho = null;
  let base = baseUrlExterna.replace(/\/$/, '');

  if (!base) {
    base = 'http://127.0.0.1:' + portaLocal;
    console.log('Servidor....: subindo localmente na porta ' + portaLocal);
    filho = fork(path.join(__dirname, '..', 'orion.js'), [], {
      env: Object.assign({}, process.env, { PORT: String(portaLocal) }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let logServidor = '';
    filho.stdout.on('data', (d) => (logServidor += d));
    filho.stderr.on('data', (d) => (logServidor += d));

    const subiu = await aguardarServidor(base, 20);
    registrar('Servidor ORION responde em ' + base, subiu, subiu ? null : 'log do servidor:\n' + logServidor.slice(-600));
    if (!subiu) {
      filho.kill();
      process.exit(1);
    }
    // guarda o log do boot para análise
    global.__logServidor = () => logServidor;
  } else {
    console.log('Servidor....: ' + base + ' (remoto)');
    const vivo = await aguardarServidor(base, 5);
    registrar('Servidor ORION responde em ' + base, vivo, vivo ? null : 'sem resposta — verifique se o deploy está no ar');
    if (!vivo) process.exit(1);
  }

  const encerrar = (codigo) => {
    if (filho) filho.kill();
    process.exit(codigo);
  };

  // ETAPA 1 - a base de torres tem dados?
  titulo('ETAPA 1 — Base de torres (cell_towers)');
  const st = await pedir('GET', base + '/api/status');
  if (st.erroRede) {
    registrar('GET /api/status', false, st.erroRede);
  } else if (st.status === 404) {
    registrar('GET /api/status', null, 'rota inexistente nesta versão — seguindo sem contagem de torres');
  } else {
    const torres = st.json && (st.json.torres || st.json.total || st.json.cell_towers);
    registrar('GET /api/status', st.status === 200 && !!torres, 'resposta: ' + (st.json ? JSON.stringify(st.json) : st.texto));
    if (torres === 0) {
      registrar('Base de torres populada', false, 'A base tem 0 torres. Sem torre cadastrada NENHUMA localização é possível.');
    }
  }

  // ETAPA 2 - o número está vinculado a alguma célula?
  titulo('ETAPA 2 — Consulta do número ANTES de cadastrar');
  const antes = await pedir('GET', base + '/api/rastrear/' + numero);
  if (antes.erroRede) {
    registrar('GET /api/rastrear/' + numero, false, antes.erroRede);
    encerrar(1);
  }
  const jaExistia = antes.status === 200 && antes.json && antes.json.status === 'localizado';
  if (jaExistia) {
    registrar('Número já vinculado a uma célula', true, JSON.stringify(antes.json));
  } else if (antes.status === 404) {
    registrar('Número vinculado a uma célula', false,
      'HTTP 404 — "' + ((antes.json && antes.json.erro) || antes.texto) + '". ' +
      'ESTA É A FALHA DO TESTE: o ORION só localiza números previamente cadastrados na tabela targets. ' +
      'Não existe consulta à operadora, então um número "cru" nunca retorna posição.');
  } else {
    registrar('Número vinculado a uma célula', false, 'HTTP ' + antes.status + ' — ' + (antes.json ? JSON.stringify(antes.json) : antes.texto));
  }

  // ETAPA 3 - cadastrar vínculo número -> célula
  let dadosFinais = jaExistia ? antes.json : null;
  let origem = jaExistia ? 'vínculo já existente na tabela targets' : '';

  if (!jaExistia && !semCadastro) {
    titulo('ETAPA 3 — Cadastro do vínculo número → célula');
    const cad = await pedir('POST', base + '/api/cadastrar-numero', {
      numero: numero,
      cellId: celula.cellId,
      mcc: celula.mcc,
      mnc: celula.mnc,
      lac: celula.lac
    });
    if (cad.erroRede) {
      registrar('POST /api/cadastrar-numero', false, cad.erroRede);
      encerrar(1);
    }
    registrar('POST /api/cadastrar-numero', cad.status === 200,
      'HTTP ' + cad.status + ' — ' + (cad.json ? JSON.stringify(cad.json) : cad.texto));

    // ETAPA 4 - rastrear de novo
    titulo('ETAPA 4 — Consulta do número DEPOIS de cadastrar');
    const depois = await pedir('GET', base + '/api/rastrear/' + numero);
    if (depois.erroRede) {
      registrar('GET /api/rastrear/' + numero + ' (2ª vez)', false, depois.erroRede);
      encerrar(1);
    }
    const j = depois.json || {};
    if (depois.status === 200 && j.status === 'localizado') {
      registrar('Localização calculada', true,
        'lat=' + j.position.latitude.toFixed(6) + ' lon=' + j.position.longitude.toFixed(6) +
        ' raio=' + j.position.raio_estimado + 'm torres=' + j.torres_usadas);
      dadosFinais = j;
      origem = 'célula cadastrada manualmente + coordenada da torre na base local';
    } else if (depois.status === 200 && j.status === 'nao_encontrado') {
      registrar('Localização calculada', false,
        'O número foi encontrado em targets, mas a célula (cell=' + celula.cellId + ', mcc=' + celula.mcc +
        ', net=' + celula.mnc + ', area=' + celula.lac + ') NÃO existe em cell_towers. ' +
        'A busca exige casamento exato dos 4 campos.');
    } else {
      registrar('Localização calculada', false, 'HTTP ' + depois.status + ' — ' + (depois.json ? JSON.stringify(depois.json) : depois.texto));
    }
  }

  // ETAPA 5 - integração com operadora
  titulo('ETAPA 5 — Integração com a operadora');
  registrar('API de telefonia configurada', false,
    'Nenhuma credencial/rota de operadora existe no projeto (sem HLR/SS7/MAP, sem SMPP, sem API de carrier). ' +
    'A célula onde o telefone está registrado precisa vir de fora — hoje ela só entra por cadastro manual ou POST /api/pacotes.');

  // ------------------------------------------------------------------
  // Mapa + resumo
  // ------------------------------------------------------------------
  const arquivoMapa = path.join(__dirname, '..', 'data', 'mapa-teste-' + numero + '.html');
  gerarMapa(arquivoMapa, {
    numero: numero,
    status: dadosFinais ? 'posição estimada obtida' : 'sem posição — teste falhou',
    position: dadosFinais ? dadosFinais.position : null,
    torres_usadas: dadosFinais ? dadosFinais.torres_usadas : 0,
    celula: celula,
    origem: origem || 'nenhuma — não houve dado de célula válido',
    geradoEm: new Date().toISOString(),
    observacao: dadosFinais
      ? 'Esta posição é a coordenada da TORRE vinculada ao número na base local, não uma medição do aparelho. ' +
        'Ela só corresponde à realidade se a célula informada for de fato a célula em que o telefone está registrado agora. ' +
        'Localizar um número de terceiro exige consentimento do titular ou ordem judicial.'
      : 'Nenhuma posição foi obtida. O ORION não consulta a operadora: ele apenas traduz um par (célula → coordenada) ' +
        'usando dados que alguém precisa alimentar antes. Veja o resumo no terminal para a etapa exata da falha.'
  });

  titulo('RESUMO');
  const falhas = resultados.filter((r) => r.ok === false);
  resultados.forEach((r) => {
    const marca = r.ok === true ? 'OK   ' : r.ok === null ? 'AVISO' : 'FALHA';
    console.log(marca + ' | ' + r.etapa);
  });
  console.log('\nMapa gerado em: ' + arquivoMapa);
  console.log('Etapas com falha: ' + falhas.length + ' de ' + resultados.length);

  encerrar(falhas.length ? 1 : 0);
})();
