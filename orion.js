/**
 * ARQUIVO: orion.js
 * VERSÃO: 6.9.0
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-17 21:00:00 (UTC)
 * COMENTÁRIO: Servidor inicia imediatamente, sem importação automática.
 *             Banco de emergência para funcionamento imediato.
 *             Rota /api/importar para importação sob demanda.
 *             Título corrigido para "ORION AI - DEPOM".
 * AUTOR: Equipe ORION
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

log('✅ ORION 6.9.0 iniciando...');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ============================================================
// ROTAS
// ============================================================

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION AI - DEPOM</h1>
        <p>Versão 6.9.0</p>
        <ul>
            <li><a href="/mapa-localizar.html">🔍 Localizar</a></li>
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
        // Fallback com título corrigido
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
    </style>
</head>
<body>
<div class="container">
    <h1>📡 ORION AI - DEPOM <small>Localizador de Torres</small></h1>
    <p>Insira os dados da célula para obter a localização aproximada.</p>
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
    <button onclick="localizar()">🔍 Localizar</button>
    <div id="resultado">Aguardando consulta...</div>
    <div class="map-link" id="mapLink"></div>
    <div class="footer">ORION v6.9.0</div>
</div>
<script>
    async function localizar() {
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

        try {
            const res = await fetch('/api/localizar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            resultado.textContent = JSON.stringify(data, null, 2);
            const mapLink = document.getElementById('mapLink');
            if (data.position && data.position.latitude && data.position.longitude) {
                const lat = data.position.latitude;
                const lng = data.position.longitude;
                mapLink.innerHTML = \`<a href="https://www.google.com/maps?q=\${lat},\${lng}" target="_blank">📍 Ver no mapa</a>\`;
            } else {
                mapLink.innerHTML = '';
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
// API DE LOCALIZAÇÃO
// ============================================================
app.post('/api/localizar', (req, res) => {
    const { cells } = req.body;
    if (!cells || !cells.length) {
        return res.status(400).json({ erro: 'Nenhuma célula fornecida.' });
    }

    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA busy_timeout = 5000');

    const promises = cells.map(cell => {
        return new Promise((resolve) => {
            const { cellId, mcc, mnc, lac } = cell;
            db.get(
                `SELECT lat, lon, range FROM cell_towers 
                 WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                [cellId, mcc || 0, mnc || 0, lac || 0],
                (err, row) => {
                    if (err || !row) resolve(null);
                    else resolve(row);
                }
            );
        });
    });

    Promise.all(promises).then(results => {
        db.close();
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
        db.close();
        res.status(500).json({ erro: err.message });
    });
});

// ============================================================
// ROTA PARA IMPORTAR DADOS SOB DEMANDA (opcional)
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
// FUNÇÕES DE BANCO DE DADOS (emergência)
// ============================================================
function criarBancoEmergencia(db) {
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
}

function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_TOWERS);
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA secure_delete=ON');
        db.run('PRAGMA busy_timeout = 10000');

        db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER,
            PRIMARY KEY (mcc, net, area, cell)
        )`, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR (SEMPRE RÁPIDA)
// ============================================================
async function start() {
    try {
        const db = await initDatabase();
        const count = await new Promise((resolve) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
        });

        if (count === 0) {
            log('⚠️ Banco vazio. Criando banco de emergência...');
            criarBancoEmergencia(db);
        } else {
            log(`✅ Banco com ${count} torres.`);
        }
        db.close();

        // Inicia o servidor IMEDIATAMENTE
        app.listen(port, '0.0.0.0', () => {
            log(`🚀 ORION 6.9.0 rodando em http://0.0.0.0:${port}`);
            log(`🌐 Interface: /mapa-localizar.html`);
            log(`📥 Para importar CSVs, use POST /api/importar ou execute manualmente scripts/import-coleta-campo.js`);
        });
    } catch (err) {
        log('❌ ERRO FATAL: ' + err.message);
        process.exit(1);
    }
}

start();
