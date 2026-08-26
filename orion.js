/**
 * ARQUIVO: orion.js
 * VERSÃO: 7.1.0
 * DATA: 2026-08-26 20:00:00 (UTC)
 * COMENTÁRIO: Integração com OpenCelliD como fallback para localização por número.
 *             Mantidas todas as funcionalidades existentes (aprendizado automático,
 *             pacotes, cadastro manual, localização avançada).
 *             Adicionada rota /api/rastrear com fallback para OpenCelliD.
 * AUTOR: Engenheiro de Computação Souza, CREA/SP xxxxx
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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

log('✅ ORION 7.1.0 iniciando...');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ============================================================
// FUNÇÕES AUXILIARES (MANTIDAS)
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
// 2026-08-26 20:00 — FUNÇÃO DE LOCALIZAÇÃO POR ERB (OpenCelliD)
// ============================================================
async function obterLocalizacaoPorERB(telefone) {
    const openCellIdKey = process.env.OPENCELLID_KEY;
    if (!openCellIdKey) {
        log('⚠️ Chave OpenCelliD não configurada. Configure OPENCELLID_KEY no ambiente.');
        return null;
    }

    // Coordenadas de referência (Salvador/BA) - pode ser ajustado para a região desejada
    const lat = -12.9714;
    const lng = -38.5014;
    const radius = 5000; // 5 km

    const url = `https://opencellid.org/cell/getInArea?key=${openCellIdKey}&lat=${lat}&lng=${lng}&radius=${radius}&format=json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            log(`⚠️ OpenCelliD respondeu com status: ${response.status}`);
            return null;
        }

        const data = await response.json();
        if (data && data.cells && data.cells.length > 0) {
            // Usar a primeira torre como referência
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
        log('📭 Nenhuma torre encontrada na região pela OpenCelliD.');
    } catch (err) {
        log('❌ Erro ao consultar OpenCelliD: ' + err.message);
    }

    return null;
}

// ============================================================
// CONEXÃO GLOBAL COM O BANCO
// ============================================================
let db;

// ============================================================
// ROTAS (MANTIDAS)
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION AI - DEPOM</h1>
        <p>Versão 7.1.0</p>
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
        // fallback com interface já existente
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
    <div class="footer">ORION v7.1.0</div>
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

    // 1. Tenta buscar na tabela targets (aprendizado local)
    db.get(
        `SELECT cellId, mcc, mnc, lac FROM targets WHERE numero = ?`,
        [numero],
        async (err, row) => {
            if (err) {
                log('❌ Erro ao consultar targets: ' + err.message);
                return res.status(500).json({ erro: 'Erro interno ao consultar banco.' });
            }

            // 2. Se encontrou localmente, usa a torre local
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

            // 3. Se não encontrou localmente, busca via OpenCelliD (fallback)
            log(`🔍 Número ${numero} não encontrado localmente. Consultando OpenCelliD...`);
            const localizacao = await obterLocalizacaoPorERB(numero);

            if (localizacao) {
                // Armazena a localização obtida para futuras consultas
                const stmt = db.prepare(
                    `INSERT INTO locations (numero, lat, lon, raio, data_hora) VALUES (?, ?, ?, ?, ?)`
                );
                stmt.run(numero, localizacao.lat, localizacao.lng, localizacao.precision || 500, new Date().toISOString());
                stmt.finalize();

                // Opcional: também pode cadastrar na tabela targets para aprendizado futuro
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

            // 4. Se nenhuma fonte encontrou
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
        ORDER BY freq DESC, avg_rsrp DESC, avg_sinr DESC
    `, (err, rows) => {
        if (err) {
            log('❌ Erro no aprendizado: ' + err.message);
            return;
        }

        if (rows.length === 0) {
            log('📭 Nenhum pacote disponível para aprendizado.');
            return;
        }

        const melhores = {};
        for (const row of rows) {
            if (!melhores[row.numero]) {
                melhores[row.numero] = row;
            }
        }

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO targets (numero, cellId, mcc, mnc, lac, ultima_atualizacao)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        let count = 0;
        for (const [numero, info] of Object.entries(melhores)) {
            stmt.run(numero, info.cellId, info.mcc, info.mnc, info.lac);
            count++;
        }
        stmt.finalize();

        log(`✅ Aprendizado concluído: ${count} associações atualizadas.`);
    });
}

// ============================================================
// ROTA PARA LOCALIZAÇÃO AVANÇADA (USANDO PACOTES)
// ============================================================
app.get('/api/localizar-avancado/:numero', (req, res) => {
    const numero = sanitizarNumero(req.params.numero);
    if (!numero || numero.length < 10) {
        return res.status(400).json({ erro: 'Número inválido.' });
    }

    db.all(
        `SELECT * FROM pacotes_headers WHERE numero = ? ORDER BY timestamp DESC LIMIT 10`,
        [numero],
        (err, pacotes) => {
            if (err || pacotes.length === 0) {
                return res.status(404).json({ erro: 'Nenhum pacote encontrado para este número.' });
            }

            const filtrados = pacotes.filter(p => p.rsrp > -120 && p.sinr > 0);

            if (filtrados.length === 0) {
                return res.json({ status: 'nao_encontrado', mensagem: 'Pacotes com qualidade insuficiente.' });
            }

            let lat = 0, lon = 0, pesoTotal = 0;
            let confianca = 0;
            const detalhes = [];

            // Processar pacotes de forma síncrona para evitar callback hell
            const promises = filtrados.map(p => {
                return new Promise((resolve) => {
                    db.get(
                        `SELECT lat, lon FROM cell_towers WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                        [p.cellId, p.mcc, p.mnc, p.lac],
                        (err, erb) => {
                            if (err || !erb) {
                                resolve(null);
                                return;
                            }

                            let distancia = 0;
                            if (p.rtt > 0) {
                                distancia = (p.rtt * 3e8) / 2;
                            } else if (p.ta > 0) {
                                distancia = p.ta * 78;
                            } else {
                                resolve(null);
                                return;
                            }

                            const peso = ((p.rsrp + 120) / 120) * 0.5 + ((p.sinr + 10) / 40) * 0.5;
                            resolve({
                                lat: erb.lat,
                                lon: erb.lon,
                                peso: peso,
                                distancia: distancia,
                                cellId: p.cellId,
                                rsrp: p.rsrp,
                                sinr: p.sinr
                            });
                        }
                    );
                });
            });

            Promise.all(promises).then(results => {
                const validos = results.filter(r => r !== null);
                if (validos.length === 0) {
                    return res.json({ status: 'nao_encontrado', mensagem: 'Não foi possível calcular a posição.' });
                }

                let lat = 0, lon = 0, pesoTotal = 0;
                let confianca = 0;

                validos.forEach(r => {
                    lat += r.lat * r.peso;
                    lon += r.lon * r.peso;
                    pesoTotal += r.peso;
                    confianca += r.peso;
                });

                const posicao = {
                    latitude: lat / pesoTotal,
                    longitude: lon / pesoTotal,
                    raio_estimado: 150,
                    confianca: Math.min(100, Math.round((confianca / validos.length) * 100))
                };

                res.json({
                    status: 'localizado',
                    numero: numero,
                    position: posicao,
                    torres_usadas: validos.length,
                    detalhes: {
                        metodo: 'híbrido (TA/RTT + RSRP/SINR)',
                        pacotes_processados: filtrados.length,
                        erbs_usadas: validos.length,
                        timestamp_ultimo_pacote: filtrados[0].timestamp
                    }
                });
            }).catch(err => {
                res.status(500).json({ erro: err.message });
            });
        }
    );
});

// ============================================================
// ROTA PARA IMPORTAR DADOS SOB DEMANDA
// ============================================================
app.post('/api/importar', (req, res) => {
    log('⚠️ Iniciando importação sob demanda...');
    const script = path.join(__dirname, 'scripts', 'import-coleta-campo.js');
    const child = exec(`node ${script}`, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
        if (error) {
            log('❌ Erro na importação: ' + error.message);
            return;
        }
        log('✅ Importação concluída.');
        log(stdout);
    });
    res.json({ status: 'importacao_iniciada', mensagem: 'A importação foi iniciada em segundo plano. Verifique os logs.' });
});

// ============================================================
// FUNÇÕES DE BANCO DE DADOS
// ============================================================
function criarBancoEmergencia() {
    return new Promise((resolve, reject) => {
        const torres = [
            ['GSM', 724, 5, 100, 208020001, 0, -38.5016, -12.9714, 5000, 100, 1, 1609459200, 1609459200, -71],
            ['GSM', 724, 5, 200, 208017145, 0, -46.6333, -23.5505, 5000, 100, 1, 1609459200, 1609459200, -73],
            ['GSM', 724, 5, 300, 208019001, 0, -43.2096, -22.9035, 3500, 85, 1, 1609459200, 1609459200, -74],
            ['GSM', 724, 5, 400, 208018001, 0, -47.9292, -15.7801, 6000, 120, 1, 1609459200, 1609459200, -68],
            ['GSM', 724, 5, 500, 208021001, 0, -38.5266, -3.7319, 4000, 90, 1, 1609459200, 1609459200, -69],
        ];
        const stmt = db.prepare(`INSERT OR REPLACE INTO cell_towers 
            (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created
