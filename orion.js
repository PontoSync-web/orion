/**
 * ARQUIVO: orion.js
 * VERSÃO: 7.0.0
 * DATA: 2026-08-24 14:00:00 (UTC)
 * COMENTÁRIO: Implementação da estrutura de dados automatizada para localização por número.
 *             Adicionada tabela pacotes_headers, rota POST /api/pacotes,
 *             algoritmo de aprendizado automático para associar números a cellIds,
 *             rota GET /api/localizar-avancado com algoritmo híbrido.
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

log('✅ ORION 7.0.0 iniciando...');

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
// CONEXÃO GLOBAL COM O BANCO
// ============================================================
let db;

// ============================================================
// ROTAS
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION AI - DEPOM</h1>
        <p>Versão 7.0.0</p>
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
    <div class="footer">ORION v7.0.0</div>
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
// API: LOCALIZAR POR NÚMERO (USANDO TARGETS)
// ============================================================
app.get('/api/rastrear/:numero', (req, res) => {
    const numero = sanitizarNumero(req.params.numero);
    if (!numero || numero.length < 10) {
        return res.status(400).json({ erro: 'Número inválido.' });
    }

    db.get(
        `SELECT cellId, mcc, mnc, lac FROM targets WHERE numero = ?`,
        [numero],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ erro: 'Número não encontrado na base de dados.' });
            }

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
                    torres_usadas: validos.length
                });
            }).catch(err => {
                res.status(500).json({ erro: err.message });
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
// NOVA ROTA: RECEBER PACOTES (HEADERS DE RÁDIO)
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
// ALGORITMO DE APRENDIZADO AUTOMÁTICO (ATUALIZA TARGETS)
// ============================================================
function aprenderAssociacoes() {
    log('🧠 Iniciando aprendizado automático...');

    // 1. Para cada número, encontrar o cellId mais frequente com melhor qualidade
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

        // 2. Para cada número, escolher a melhor associação (primeira linha do grupo)
        const melhores = {};
        for (const row of rows) {
            if (!melhores[row.numero]) {
                melhores[row.numero] = row;
            }
        }

        // 3. Atualizar (ou inserir) na tabela targets
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

    // Buscar os últimos 10 pacotes do número
    db.all(
        `SELECT * FROM pacotes_headers WHERE numero = ? ORDER BY timestamp DESC LIMIT 10`,
        [numero],
        (err, pacotes) => {
            if (err || pacotes.length === 0) {
                return res.status(404).json({ erro: 'Nenhum pacote encontrado para este número.' });
            }

            // Filtrar pacotes com qualidade mínima
            const filtrados = pacotes.filter(p => p.rsrp > -120 && p.sinr > 0);

            if (filtrados.length === 0) {
                return res.json({ status: 'nao_encontrado', mensagem: 'Pacotes com qualidade insuficiente.' });
            }

            // Para cada pacote, obter a ERB e calcular a distância
            let lat = 0, lon = 0, pesoTotal = 0;
            let confianca = 0;
            const detalhes = [];

            for (const p of filtrados) {
                // Buscar coordenadas da ERB
                db.get(
                    `SELECT lat, lon FROM cell_towers WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                    [p.cellId, p.mcc, p.mnc, p.lac],
                    (err, erb) => {
                        if (err || !erb) return;

                        let distancia = 0;
                        if (p.rtt > 0) {
                            distancia = (p.rtt * 3e8) / 2; // RTT em metros
                        } else if (p.ta > 0) {
                            distancia = p.ta * 78; // TA em metros
                        } else {
                            return; // sem distância, pula
                        }

                        const peso = ((p.rsrp + 120) / 120) * 0.5 + ((p.sinr + 10) / 40) * 0.5;
                        lat += erb.lat * peso;
                        lon += erb.lon * peso;
                        pesoTotal += peso;
                        confianca += peso;

                        detalhes.push({
                            cellId: p.cellId,
                            distancia: Math.round(distancia),
                            rsrp: p.rsrp,
                            sinr: p.sinr,
                            peso: peso.toFixed(2)
                        });
                    }
                );
            }

            // Como as consultas são assíncronas, precisamos de um pequeno atraso para garantir que todas terminaram
            setTimeout(() => {
                if (pesoTotal === 0) {
                    return res.json({ status: 'nao_encontrado', mensagem: 'Não foi possível calcular a posição.' });
                }

                const posicao = {
                    latitude: lat / pesoTotal,
                    longitude: lon / pesoTotal,
                    raio_estimado: 150,
                    confianca: Math.min(100, Math.round((confianca / filtrados.length) * 100))
                };

                res.json({
                    status: 'localizado',
                    numero: numero,
                    position: posicao,
                    torres_usadas: detalhes.length,
                    detalhes: {
                        metodo: 'híbrido (TA/RTT + RSRP/SINR)',
                        pacotes_processados: filtrados.length,
                        erbs_usadas: detalhes.length,
                        timestamp_ultimo_pacote: filtrados[0].timestamp
                    }
                });
            }, 100);
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
            (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const t of torres) stmt.run(t);
        stmt.finalize();
        db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
        log('✅ Banco de emergência criado com ' + torres.length + ' torres.');
        resolve();
    });
}

async function initDatabase() {
    if (fs.existsSync(DB_TOWERS)) {
        log('⚠️ Removendo banco existente para recriação limpa...');
        fs.unlinkSync(DB_TOWERS);
    }

    const newDb = new sqlite3.Database(DB_TOWERS);
    newDb.run('PRAGMA journal_mode=WAL');
    newDb.run('PRAGMA secure_delete=ON');
    newDb.run('PRAGMA busy_timeout = 10000');

    log('🔧 Criando tabelas...');

    try {
        // Tabela cell_towers
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE cell_towers (
                radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                cell INTEGER, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER,
                PRIMARY KEY (mcc, net, area, cell)
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        log('✅ Tabela cell_towers criada');

        // Tabela targets
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE targets (
                numero TEXT PRIMARY KEY,
                cellId INTEGER,
                mcc INTEGER,
                mnc INTEGER,
                lac INTEGER,
                ultima_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        log('✅ Tabela targets criada');

        // Tabela locations (histórico)
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                numero TEXT,
                lat REAL,
                lon REAL,
                raio INTEGER,
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (numero) REFERENCES targets(numero)
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        log('✅ Tabela locations criada');

        // NOVA TABELA: pacotes_headers
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE pacotes_headers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                numero TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                cellId INTEGER,
                mcc INTEGER,
                mnc INTEGER,
                lac INTEGER,
                ta INTEGER,
                rtt INTEGER,
                rsrp INTEGER,
                rsrq INTEGER,
                sinr REAL,
                cqi INTEGER,
                aoa REAL,
                power_headroom INTEGER,
                handover_from INTEGER,
                drx_cycle INTEGER,
                confidence INTEGER DEFAULT 0
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        log('✅ Tabela pacotes_headers criada');

        // Índices
        newDb.run('CREATE INDEX IF NOT EXISTS idx_pacotes_numero ON pacotes_headers(numero)');
        newDb.run('CREATE INDEX IF NOT EXISTS idx_pacotes_timestamp ON pacotes_headers(timestamp)');
        log('✅ Índices criados');

        db = newDb;

        // Insere banco de emergência
        await criarBancoEmergencia();

        // Verificação final
        await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                if (err) reject(err);
                else {
                    log(`✅ Banco verificado: ${row.c} torres disponíveis.`);
                    resolve();
                }
            });
        });

        return db;
    } catch (err) {
        log('❌ Erro na criação do banco: ' + err.message);
        if (newDb) newDb.close();
        throw err;
    }
}

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================
async function start() {
    try {
        await initDatabase();

        // Agendar aprendizado automático a cada 5 minutos
        setInterval(aprenderAssociacoes, 5 * 60 * 1000);
        log('⏰ Aprendizado automático agendado a cada 5 minutos.');

        // Executar uma primeira rodada de aprendizado após 10 segundos
        setTimeout(aprenderAssociacoes, 10000);

        app.listen(port, '0.0.0.0', () => {
            log(`🚀 ORION 7.0.0 rodando em http://0.0.0.0:${port}`);
            log(`🌐 Interface: /mapa-localizar.html`);
            log(`📱 Rota: GET /api/rastrear/:numero`);
            log(`📶 Rota: POST /api/localizar`);
            log(`📡 Rota: POST /api/pacotes (NOVA)`);
            log(`🧠 Aprendizado automático ativo (a cada 5 min)`);
            log(`✅ Conexão com banco de dados estabelecida e mantida.`);
        });
    } catch (err) {
        log('❌ ERRO FATAL: ' + err.message);
        process.exit(1);
    }
}

start();
