/**
 * ARQUIVO: orion.js
 * VERSÃO: 7.2.0
 * DATA: 2026-08-27 10:30:00 (UTC)
 * COMENTÁRIO: Adicionada rota proxy /api/consultar-operadora/:numero para
 *             consultar a operadora de um número via ABR Telecom.
 *             Integração preparada para preencher campo automaticamente no front-end.
 * AUTOR: Engenheiro de Computação Souza, CREA/SP xxxxx
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

log('✅ ORION 7.2.0 iniciando...');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================
function sanitizarNumero(numero) {
    return numero.replace(/\D/g, '');
}

function validarCells(cells) {
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return { valido: false, erro: 'Nenhuma célula fornecida.' };
    }
    for (const cell of cells) {
        if (!cell.cellId || !cell.mcc || !cell.mnc || !cell.lac) {
            return { valido: false, erro: 'Campos obrigatórios: cellId, mcc, mnc, lac.' };
        }
    }
    return { valido: true };
}

// ============================================================
// 2026-08-27 10:30 — FUNÇÃO DE LOCALIZAÇÃO POR ERB (OpenCelliD - FALLBACK)
// ============================================================
async function obterLocalizacaoPorERB(telefone) {
    const openCellIdKey = process.env.OPENCELLID_KEY;
    if (!openCellIdKey) {
        log('⚠️ Chave OpenCelliD não configurada. Configure OPENCELLID_KEY no ambiente.');
        return null;
    }

    const lat = -12.9714;
    const lng = -38.5014;
    const radius = 5000;

    const url = `https://opencellid.org/cell/getInArea?key=${openCellIdKey}&lat=${lat}&lng=${lng}&radius=${radius}&format=json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            log(`⚠️ OpenCelliD respondeu com status: ${response.status}`);
            return null;
        }

        const data = await response.json();
        if (data && data.cells && data.cells.length > 0) {
            const torre = data.cells[0];
            return {
                lat: parseFloat(torre.lat),
                lng: parseFloat(torre.lon),
                precision: torre.range || 500,
                cellId: torre.cellId,
                mcc: torre.mcc,
                mnc: torre.net,
                lac: torre.area,
                fonte: 'opencellid'
            };
        }
        log('📭 Nenhuma torre encontrada pela OpenCelliD.');
    } catch (err) {
        log('❌ Erro ao consultar OpenCelliD: ' + err.message);
    }

    return null;
}

// ============================================================
// 2026-08-27 10:30 — PROXY PARA CONSULTAR OPERADORA (ABR TELECOM)
// ============================================================
app.get('/api/consultar-operadora/:numero', async (req, res) => {
    const numero = sanitizarNumero(req.params.numero);
    if (!numero || numero.length < 10) {
        return res.status(400).json({ erro: 'Número inválido. Use pelo menos 10 dígitos.' });
    }

    try {
        const url = `https://consultanumero.abrtelecom.com.br/consultanumero/consulta/consultaSituacaoAtualCtg?numero=${numero}`;
        log(`🔍 Consultando operadora para ${numero}...`);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://consultanumero.abrtelecom.com.br/'
            }
        });

        if (!response.ok) {
            log(`⚠️ ABR Telecom respondeu com status: ${response.status}`);
            return res.status(502).json({ erro: 'Falha ao consultar operadora. Tente novamente.' });
        }

        const data = await response.json();
        log(`✅ Operadora consultada com sucesso para ${numero}.`);

        // A estrutura exata da resposta pode variar. Ajustaremos após testes.
        // Exemplo esperado: { status: "success", operadora: "Claro", ... }
        res.json({
            status: 'success',
            numero: numero,
            operadora: data.operadora || data.operadora_nome || data.nome_operadora || 'Não identificada',
            dados_completos: data
        });
    } catch (err) {
        log(`❌ Erro ao consultar operadora: ${err.message}`);
        res.status(500).json({ erro: 'Erro interno ao consultar operadora.' });
    }
});

// ============================================================
// IMPORTAÇÃO UNIVERSAL DE ERBs (A PARTIR DA PASTA /data)
// ============================================================
async function importarERBsAuto() {
    log('🔍 Verificando arquivos de ERB na pasta /data...');

    const arquivos = fs.readdirSync(DATA_DIR);
    const arquivosERB = arquivos.filter(f =>
        f.endsWith('.csv') || f.endsWith('.json') || f.endsWith('.txt')
    );

    if (arquivosERB.length === 0) {
        log('📭 Nenhum arquivo de ERB encontrado na pasta /data.');
        return 0;
    }

    log(`📁 Encontrados ${arquivosERB.length} arquivos: ${arquivosERB.join(', ')}`);

    let totalImportados = 0;

    for (const arquivo of arquivosERB) {
        const caminho = path.join(DATA_DIR, arquivo);
        log(`📥 Processando ${arquivo}...`);

        try {
            if (arquivo.endsWith('.csv')) {
                const count = await importarCSV(caminho);
                totalImportados += count;
            } else if (arquivo.endsWith('.json')) {
                const count = await importarJSON(caminho);
                totalImportados += count;
            } else if (arquivo.endsWith('.txt')) {
                log(`ℹ️ Arquivo .txt ignorado (formato não suportado automaticamente): ${arquivo}`);
            }
        } catch (err) {
            log(`❌ Erro ao importar ${arquivo}: ${err.message}`);
        }
    }

    log(`✅ Importação concluída: ${totalImportados} torres adicionadas.`);
    return totalImportados;
}

async function importarCSV(caminho) {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(caminho, { encoding: 'utf8' })
            .pipe(csv({
                separator: ',',
                mapHeaders: ({ header }) => header.trim()
            }))
            .on('data', (row) => rows.push(row))
            .on('end', () => {
                if (rows.length === 0) {
                    log(`⚠️ ${path.basename(caminho)}: Arquivo vazio ou sem dados.`);
                    resolve(0);
                    return;
                }

                const headers = Object.keys(rows[0]);
                const mapeamento = {
                    cell: headers.find(h => /cell|ci|id_estacao|cell_id|numero_estacao/i.test(h)),
                    lat: headers.find(h => /lat|latitude/i.test(h)),
                    lon: headers.find(h => /lon|longitude/i.test(h)),
                    mcc: headers.find(h => /mcc|codigo_pais|uf|uf_codigo/i.test(h)),
                    net: headers.find(h => /net|mnc|operadora/i.test(h)),
                    area: headers.find(h => /area|lac|tac|tracking|codigo_municipio/i.test(h)),
                    range: headers.find(h => /range|raio|alcance|precision/i.test(h)),
                };

                if (!mapeamento.cell || !mapeamento.lat || !mapeamento.lon) {
                    log(`⚠️ ${path.basename(caminho)}: Colunas essenciais (cell, lat, lon) não encontradas.`);
                    log(`   Colunas disponíveis: ${headers.join(', ')}`);
                    resolve(0);
                    return;
                }

                log(`✅ Mapeamento para ${path.basename(caminho)}:`, mapeamento);

                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO cell_towers 
                    (cell, mcc, net, area, lat, lon, range) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);

                let count = 0;
                for (const row of rows) {
                    const cell = parseInt(row[mapeamento.cell]);
                    const lat = parseFloat(row[mapeamento.lat]);
                    const lon = parseFloat(row[mapeamento.lon]);
                    if (!cell || isNaN(lat) || isNaN(lon)) continue;

                    stmt.run(
                        cell,
                        parseInt(row[mapeamento.mcc] || 724),
                        parseInt(row[mapeamento.net] || 0),
                        parseInt(row[mapeamento.area] || 0),
                        lat,
                        lon,
                        parseInt(row[mapeamento.range] || 500)
                    );
                    count++;
                }
                stmt.finalize();

                log(`✅ ${path.basename(caminho)}: ${count} torres importadas.`);
                resolve(count);
            })
            .on('error', (err) => {
                log(`❌ Erro ao ler CSV: ${err.message}`);
                resolve(0);
            });
    });
}

async function importarJSON(caminho) {
    return new Promise((resolve, reject) => {
        try {
            const data = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            const rows = Array.isArray(data) ? data : (data.data || data.records || data.cells || data.towers || []);
            if (!rows || rows.length === 0) {
                log(`⚠️ ${path.basename(caminho)}: JSON vazio ou formato não reconhecido.`);
                resolve(0);
                return;
            }

            const headers = Object.keys(rows[0]);
            const mapeamento = {
                cell: headers.find(h => /cell|ci|id_estacao|cell_id|id/i.test(h)),
                lat: headers.find(h => /lat|latitude/i.test(h)),
                lon: headers.find(h => /lon|longitude/i.test(h)),
                mcc: headers.find(h => /mcc|codigo_pais|uf/i.test(h)),
                net: headers.find(h => /net|mnc|operadora/i.test(h)),
                area: headers.find(h => /area|lac|tac|codigo_municipio/i.test(h)),
                range: headers.find(h => /range|raio|precision/i.test(h)),
            };

            if (!mapeamento.cell || !mapeamento.lat || !mapeamento.lon) {
                log(`⚠️ ${path.basename(caminho)}: Colunas essenciais (cell, lat, lon) não encontradas.`);
                log(`   Colunas disponíveis: ${headers.join(', ')}`);
                resolve(0);
                return;
            }

            const stmt = db.prepare(`
                INSERT OR REPLACE INTO cell_towers 
                (cell, mcc, net, area, lat, lon, range) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            let count = 0;
            for (const row of rows) {
                const cell = parseInt(row[mapeamento.cell]);
                const lat = parseFloat(row[mapeamento.lat]);
                const lon = parseFloat(row[mapeamento.lon]);
                if (!cell || isNaN(lat) || isNaN(lon)) continue;

                stmt.run(
                    cell,
                    parseInt(row[mapeamento.mcc] || 724),
                    parseInt(row[mapeamento.net] || 0),
                    parseInt(row[mapeamento.area] || 0),
                    lat,
                    lon,
                    parseInt(row[mapeamento.range] || 500)
                );
                count++;
            }
            stmt.finalize();

            log(`✅ ${path.basename(caminho)}: ${count} torres importadas.`);
            resolve(count);
        } catch (err) {
            log(`❌ Erro ao importar JSON: ${err.message}`);
            resolve(0);
        }
    });
}

// ============================================================
// CONEXÃO GLOBAL COM O BANCO
// ============================================================
let db;

// ============================================================
// ROTAS
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION AI - DEPOM</h1>
        <p>Versão 7.2.0</p>
        <ul>
            <li><a href="/mapa-localizar.html">🔍 Localizar por número</a></li>
            <li><a href="/teste">🧪 Teste</a></li>
        </ul>
        <p>Status: <strong>Operacional</strong></p>
    `);
});

app.get('/teste', (req, res) => res.redirect('/mapa-localizar.html'));

app.get('/mapa-localizar.html', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, 'mapa-localizar.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ORION AI - DEPOM - Localizador</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 650px; margin: 30px auto; padding: 20px; background: #f0f4f8; }
        .container { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        h1 { color: #0a4b7a; }
        label { display: block; margin-top: 14px; font-weight: 600; }
        input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; margin-top: 4px; }
        .row { display: flex; gap: 12px; }
        .row > div { flex: 1; }
        button { margin-top: 22px; padding: 12px; background: #0a4b7a; color: white; border: none; border-radius: 6px; font-size: 1.1em; cursor: pointer; width: 100%; }
        button:hover { background: #063456; }
        #resultado { background: #f4f7fb; padding: 14px; border-radius: 6px; margin-top: 20px; white-space: pre-wrap; font-family: monospace; border: 1px solid #e0e4e8; min-height: 60px; }
        .map-link { margin-top: 12px; text-align: center; }
        .map-link a { color: #0a4b7a; font-weight: bold; padding: 6px 14px; border: 1px solid #0a4b7a; border-radius: 6px; display: inline-block; text-decoration: none; }
        .map-link a:hover { background: #0a4b7a; color: white; }
        .footer { margin-top: 20px; font-size: 0.8em; color: #888; text-align: center; }
        .aba { display: flex; gap: 10px; margin-bottom: 20px; }
        .aba button { padding: 10px 20px; background: #e0e4e8; border: none; border-radius: 6px; cursor: pointer; }
        .aba button.ativo { background: #0a4b7a; color: white; }
        .painel { display: none; }
        .painel.ativo { display: block; }
    </style>
</head>
<body>
<div class="container">
    <h1>📡 ORION AI - DEPOM <small>Localizador</small></h1>
    <div class="aba">
        <button class="ativo" onclick="mostrarPainel('numero')">📱 Por Número</button>
        <button onclick="mostrarPainel('celula')">📶 Por Dados de Célula</button>
    </div>

    <div id="painelNumero" class="painel ativo">
        <label>Número de celular *</label>
        <input id="numero" placeholder="Ex: 71988979724">
        <button onclick="localizarPorNumero()">🔍 Localizar por número</button>
        <hr style="margin: 20px 0;">
        <h3>📝 Cadastrar novo número</h3>
        <div class="row">
            <div><label>Cell ID</label><input id="novoCellId" placeholder="208020001"></div>
            <div><label>MCC</label><input id="novoMcc" value="724"></div>
        </div>
        <div class="row">
            <div><label>MNC</label><input id="novoMnc" value="5"></div>
            <div><label>LAC</label><input id="novoLac" value="100"></div>
        </div>
        <button onclick="cadastrarNumero()">➕ Cadastrar número</button>
    </div>

    <div id="painelCelula" class="painel">
        <div class="row">
            <div><label>Cell ID *</label><input id="cellId" value="208020001"></div>
            <div><label>MCC</label><input id="mcc" value="724"></div>
        </div>
        <div class="row">
            <div><label>MNC</label><input id="mnc" value="5"></div>
            <div><label>LAC</label><input id="lac" value="100"></div>
        </div>
        <label>RSSI (opcional)</label>
        <input id="rssi" value="-71">
        <button onclick="localizarPorCelula()">🔍 Localizar por célula</button>
    </div>

    <div id="resultado">Aguardando consulta...</div>
    <div class="map-link" id="mapLink"></div>
    <div class="footer">ORION v7.2.0</div>
</div>

<script>
    function mostrarPainel(tipo) {
        document.querySelectorAll('.painel').forEach(p => p.classList.remove('ativo'));
        document.querySelectorAll('.aba button').forEach(b => b.classList.remove('ativo'));
        if (tipo === 'numero') {
            document.getElementById('painelNumero').classList.add('ativo');
            document.querySelector('.aba button:first-child').classList.add('ativo');
        } else {
            document.getElementById('painelCelula').classList.add('ativo');
            document.querySelector('.aba button:last-child').classList.add('ativo');
        }
    }

    async function localizarPorNumero() {
        const numero = document.getElementById('numero').value.trim();
        if (!numero) { alert('Número é obrigatório!'); return; }

        const resultado = document.getElementById('resultado');
        resultado.textContent = '⏳ Buscando...';
        document.getElementById('mapLink').innerHTML = '';

        try {
            const res = await fetch('/api/rastrear/' + encodeURIComponent(numero));
            const data = await res.json();
            resultado.textContent = JSON.stringify(data, null, 2);
            if (data.position && data.position.latitude && data.position.longitude) {
                const lat = data.position.latitude;
                const lng = data.position.longitude;
                document.getElementById('mapLink').innerHTML = '<a href="https://www.google.com/maps?q=' + lat + ',' + lng + '" target="_blank">📍 Ver no mapa</a>';
            }
        } catch (err) {
            resultado.textContent = '❌ Erro: ' + err.message;
        }
    }

    async function cadastrarNumero() {
        const numero = document.getElementById('numero').value.trim();
        const cellId = document.getElementById('novoCellId').value.trim();
        const mcc = document.getElementById('novoMcc').value.trim();
        const mnc = document.getElementById('novoMnc').value.trim();
        const lac = document.getElementById('novoLac').value.trim();

        if (!numero) { alert('Número é obrigatório!'); return; }
        if (!cellId) { alert('Cell ID é obrigatório!'); return; }

        const resultado = document.getElementById('resultado');
        resultado.textContent = '⏳ Cadastrando...';

        try {
            const res = await fetch('/api/cadastrar-numero', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    numero: numero,
                    cellId: parseInt(cellId),
                    mcc: parseInt(mcc) || 724,
                    mnc: parseInt(mnc) || 0,
                    lac: parseInt(lac) || 0
                })
            });
            const data = await res.json();
            resultado.textContent = JSON.stringify(data, null, 2);
            if (data.status === 'cadastrado') {
                alert('✅ Número cadastrado com sucesso!');
            }
        } catch (err) {
            resultado.textContent = '❌ Erro: ' + err.message;
        }
    }

    async function localizarPorCelula() {
        const cellId = document.getElementById('cellId').value.trim();
        const mcc = document.getElementById('mcc').value.trim();
        const mnc = document.getElementById('mnc').value.trim();
        const lac = document.getElementById('lac').value.trim();

        if (!cellId) { alert('Cell ID é obrigatório!'); return; }

        const body = {
            cells: [{
                cellId: parseInt(cellId),
                mcc: parseInt(mcc) || 0,
                mnc: parseInt(mnc) || 0,
                lac: parseInt(lac) || 0
            }]
        };

        const resultado = document.getElementById('resultado');
        resultado.textContent = '⏳ Processando...';
        document.getElementById('mapLink').innerHTML = '';

        try {
            const res = await fetch('/api/localizar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            resultado.textContent = JSON.stringify(data, null, 2);
            if (data.position && data.position.latitude && data.position.longitude) {
                const lat = data.position.latitude;
                const lng = data.position.longitude;
                document.getElementById('mapLink').innerHTML = '<a href="https://www.google.com/maps?q=' + lat + ',' + lng + '" target="_blank">📍 Ver no mapa</a>';
            }
        } catch (err) {
            resultado.textContent = '❌ Erro: ' + err.message;
        }
    }
</script>
</body>
</html>
        `);
    }
});

// ============================================================
// API: CADASTRAR NÚMERO (MANUAL)
// ============================================================
app.post('/api/cadastrar-numero', (req, res) => {
    const { numero, cellId, mcc, mnc, lac } = req.body;
    const numeroLimpo = sanitizarNumero(numero);
    if (!numeroLimpo || numeroLimpo.length < 10) {
        return res.status(400).json({ erro: 'Número inválido.' });
    }
    if (!cellId) {
        return res.status(400).json({ erro: 'Cell ID é obrigatório.' });
    }

    db.run(
        `INSERT OR REPLACE INTO targets (numero, cellId, mcc, mnc, lac, ultima_atualizacao)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [numeroLimpo, cellId, mcc || 0, mnc || 0, lac || 0],
        function(err) {
            if (err) {
                return res.status(500).json({ erro: 'Erro ao cadastrar: ' + err.message });
            }
            res.json({ status: 'cadastrado', mensagem: `Número ${numeroLimpo} cadastrado com sucesso.` });
        }
    );
});

// ============================================================
// API: LOCALIZAR POR NÚMERO (COM FALLBACK PARA OPENCELLID)
// ============================================================
app.get('/api/rastrear/:numero', async (req, res) => {
    const numero = sanitizarNumero(req.params.numero);
    if (!numero || numero.length < 10) {
        return res.status(400).json({ erro: 'Número inválido.' });
    }

    db.get(
        `SELECT cellId, mcc, mnc, lac FROM targets WHERE numero = ?`,
        [numero],
        async (err, row) => {
            if (err) {
                log('❌ Erro ao consultar targets: ' + err.message);
                return res.status(500).json({ erro: 'Erro interno ao consultar banco.' });
            }

            if (row) {
                const cells = [{
                    cellId: row.cellId,
                    mcc: row.mcc,
                    mnc: row.mnc,
                    lac: row.lac
                }];

                const promises = cells.map(cell => {
                    return new Promise((resolve) => {
                        db.get(
                            `SELECT lat, lon, range FROM cell_towers 
                             WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                            [cell.cellId, cell.mcc || 0, cell.mnc || 0, cell.lac || 0],
                            (err, row) => {
                                if (err || !row) resolve(null);
                                else resolve(row);
                            }
                        );
                    });
                });

                Promise.all(promises).then(results => {
                    const validos = results.filter(r => r !== null);
                    if (validos.length === 0) {
                        return res.json({ status: 'nao_encontrado', mensagem: 'Nenhuma torre encontrada para este número.' });
                    }

                    let lat = 0, lon = 0, pesoTotal = 0;
                    validos.forEach(r => {
                        const peso = 1 / Math.max(r.range || 500, 1);
                        lat += r.lat * peso;
                        lon += r.lon * peso;
                        pesoTotal += peso;
                    });

                    const pos = {
                        latitude: lat / pesoTotal,
                        longitude: lon / pesoTotal,
                        raio_estimado: Math.round(validos.reduce((a, r) => a + (r.range || 500), 0) / validos.length / Math.sqrt(validos.length))
                    };

                    const stmt = db.prepare(
                        `INSERT INTO locations (numero, lat, lon, raio, data_hora) VALUES (?, ?, ?, ?, ?)`
                    );
                    stmt.run(numero, pos.latitude, pos.longitude, pos.raio_estimado, new Date().toISOString());
                    stmt.finalize();

                    res.json({
                        status: 'localizado',
                        numero: numero,
                        position: pos,
                        torres_usadas: validos.length,
                        fonte: 'local'
                    });
                }).catch(err => {
                    res.status(500).json({ erro: err.message });
                });
                return;
            }

            log(`🔍 Número ${numero} não encontrado localmente. Consultando OpenCelliD...`);
            const localizacao = await obterLocalizacaoPorERB(numero);

            if (localizacao) {
                const stmt = db.prepare(
                    `INSERT INTO locations (numero, lat, lon, raio, data_hora) VALUES (?, ?, ?, ?, ?)`
                );
                stmt.run(numero, localizacao.lat, localizacao.lng, localizacao.precision || 500, new Date().toISOString());
                stmt.finalize();

                if (localizacao.cellId && localizacao.mcc && localizacao.mnc && localizacao.lac) {
                    db.run(
                        `INSERT OR REPLACE INTO targets (numero, cellId, mcc, mnc, lac, ultima_atualizacao)
                         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [numero, localizacao.cellId, localizacao.mcc, localizacao.mnc, localizacao.lac]
                    );
                }

                return res.json({
                    status: 'localizado',
                    numero: numero,
                    position: {
                        latitude: localizacao.lat,
                        longitude: localizacao.lng,
                        raio_estimado: localizacao.precision || 500
                    },
                    fonte: 'opencellid'
                });
            }

            return res.status(404).json({
                erro: 'Número não encontrado. Tente cadastrar manualmente ou aguarde o aprendizado automático.'
            });
        }
    );
});

// ============================================================
// API: LOCALIZAR POR DADOS DE CÉLULA
// ============================================================
app.post('/api/localizar', (req, res) => {
    const { cells } = req.body;
    const validacao = validarCells(cells);
    if (!validacao.valido) {
        return res.status(400).json({ erro: validacao.erro });
    }

    const promises = cells.map(cell => {
        return new Promise((resolve) => {
            db.get(
                `SELECT lat, lon, range FROM cell_towers 
                 WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                [cell.cellId, cell.mcc || 0, cell.mnc || 0, cell.lac || 0],
                (err, row) => {
                    if (err || !row) resolve(null);
                    else resolve(row);
                }
            );
        });
    });

    Promise.all(promises).then(results => {
        const validos = results.filter(r => r !== null);
        if (validos.length === 0) {
            return res.json({ status: 'nao_encontrado', mensagem: 'Nenhuma torre encontrada.' });
        }

        let lat = 0, lon = 0, pesoTotal = 0;
        validos.forEach(r => {
            const peso = 1 / Math.max(r.range || 500, 1);
            lat += r.lat * peso;
            lon += r.lon * peso;
            pesoTotal += peso;
        });

        res.json({
            status: 'localizado',
            position: {
                latitude: lat / pesoTotal,
                longitude: lon / pesoTotal,
                raio_estimado: Math.round(validos.reduce((a, r) => a + (r.range || 500), 0) / validos.length / Math.sqrt(validos.length))
            },
            torres_usadas: validos.length
        });
    }).catch(err => {
        res.status(500).json({ erro: err.message });
    });
});

// ============================================================
// API: RECEBER PACOTES (HEADERS DE RÁDIO)
// ============================================================
app.post('/api/pacotes', (req, res) => {
    const { numero, cellId, mcc, mnc, lac, ta, rtt, rsrp, rsrq, sinr, cqi, aoa, power_headroom, handover_from, drx_cycle } = req.body;

    if (!numero || !cellId) {
        return res.status(400).json({ erro: 'Número e cellId são obrigatórios.' });
    }

    const numeroLimpo = sanitizarNumero(numero);
    if (numeroLimpo.length < 10) {
        return res.status(400).json({ erro: 'Número inválido.' });
    }

    const stmt = db.prepare(`
        INSERT INTO pacotes_headers 
        (numero, cellId, mcc, mnc, lac, ta, rtt, rsrp, rsrq, sinr, cqi, aoa, power_headroom, handover_from, drx_cycle, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(numeroLimpo, cellId, mcc || 0, mnc || 0, lac || 0, ta || 0, rtt || 0, rsrp || 0, rsrq || 0, sinr || 0, cqi || 0, aoa || 0, power_headroom || 0, handover_from || 0, drx_cycle || 0, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ erro: 'Erro ao armazenar pacote: ' + err.message });
        }
        res.json({ status: 'recebido', mensagem: 'Pacote processado com sucesso.' });
    });
});

// ============================================================
// ALGORITMO DE APRENDIZADO AUTOMÁTICO
// ============================================================
function aprenderAssociacoes() {
    log('🧠 Iniciando aprendizado automático...');

    db.all(`
        SELECT 
            numero,
            cellId,
            mcc,
            mnc,
            lac,
            COUNT(*) as freq,
            AVG(rsrp) as avg_rsrp,
            AVG(sinr) as avg_sinr
        FROM pacotes_headers
        WHERE rsrp > -120 AND sinr > 0
        GROUP BY numero, cellId, mcc, mnc, lac
        ORDER BY freq DESC, avg_rsrp DESC, avg_s
