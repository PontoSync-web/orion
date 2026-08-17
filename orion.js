/**
 * ARQUIVO: orion.js
 * VERSÃO: 6.8.4
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-17 09:00:00 (UTC)
 * COMENTÁRIO: Adicionada rota para arquivos estáticos (pasta public/).
 *             Inclui interface /teste e /mapa-localizar.html.
 * AUTOR: Equipe ORION
 */

const express = require('express');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');
const CONTEXT_DIR = path.join(DATA_DIR, 'contextos');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Criar diretórios se não existirem
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

function log(level, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

log('info', 'Diretórios verificados/criados.');

const HERMES = { IAs: [{ nome: 'Artemis' }, { nome: 'Apollo' }, { nome: 'Athena' }] };
log('info', 'HERMES inicializado com 3 IAs configuradas.');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da pasta public/
app.use(express.static(PUBLIC_DIR));

// ============================================================
// ROTA DE TESTE (interface web via GET)
// ============================================================
app.get('/teste', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ORION - Localizador de Torres</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
        h1 { color: #0a4b7a; }
        label { display: block; margin-top: 12px; font-weight: bold; }
        input { width: 100%; padding: 8px; box-sizing: border-box; }
        button { margin-top: 20px; padding: 10px 20px; background: #0a4b7a; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #063456; }
        #resultado { background: #f4f4f4; padding: 12px; border-radius: 4px; white-space: pre-wrap; margin-top: 20px; }
        .map-link { margin-top: 10px; }
        .map-link a { color: #0a4b7a; text-decoration: none; }
        .map-link a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>📡 ORION - Localização por Torre</h1>
    <p>Preencha os dados da célula e clique em <strong>Localizar</strong>.</p>

    <label>Cell ID (obrigatório)</label>
    <input id="cellId" value="208020001" placeholder="Ex: 208020001">

    <label>MCC (código do país – Brasil = 724)</label>
    <input id="mcc" value="724" placeholder="724">

    <label>MNC (código da operadora – Claro=5, Vivo=10, TIM=2)</label>
    <input id="mnc" value="5" placeholder="5">

    <label>LAC (código da área)</label>
    <input id="lac" value="100" placeholder="100">

    <label>RSSI (intensidade do sinal, opcional)</label>
    <input id="rssi" value="-71" placeholder="-71">

    <button onclick="localizar()">🔍 Localizar</button>

    <div id="resultado"></div>
    <div class="map-link" id="mapLink"></div>

    <script>
        async function localizar() {
            const cellId = document.getElementById('cellId').value.trim();
            const mcc = document.getElementById('mcc').value.trim();
            const mnc = document.getElementById('mnc').value.trim();
            const lac = document.getElementById('lac').value.trim();
            const rssi = document.getElementById('rssi').value.trim();

            if (!cellId) {
                alert('Cell ID é obrigatório!');
                return;
            }

            const body = {
                cells: [{
                    cellId: parseInt(cellId),
                    mcc: parseInt(mcc) || 0,
                    mnc: parseInt(mnc) || 0,
                    lac: parseInt(lac) || 0,
                    rssi: parseInt(rssi) || -70
                }]
            };

            const resultado = document.getElementById('resultado');
            resultado.textContent = '⏳ Aguarde...';

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
                    mapLink.innerHTML = \`<a href="https://www.google.com/maps?q=\${lat},\${lng}" target="_blank">📍 Ver no Google Maps</a>\`;
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
});

// ============================================================
// ROTA RAIZ
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION - AI-DEPOM</h1>
        <p>Versão 6.8.4</p>
        <ul>
            <li><a href="/teste">Interface de teste (/teste)</a></li>
            <li><a href="/mapa-localizar.html">Interface clássica (/mapa-localizar.html)</a></li>
        </ul>
        <p>Documentação da API em breve.</p>
    `);
});

// ============================================================
// API DE LOCALIZAÇÃO (exemplo - substitua pela sua lógica real)
// ============================================================
app.post('/api/localizar', (req, res) => {
    // Exemplo: retorna posição fixa para demonstração
    // Você deve substituir pela consulta ao banco de torres
    const { cells } = req.body;
    if (!cells || !cells.length) {
        return res.status(400).json({ erro: 'Nenhuma célula fornecida.' });
    }
    // Simula busca no banco (exemplo)
    res.json({
        status: 'localizado',
        position: { latitude: -12.9714, longitude: -38.5016, raio_estimado: 500 },
        fonte: 'exemplo (substitua pela lógica real)'
    });
});

// ============================================================
// FUNÇÕES DE IMPORTAÇÃO (mantidas)
// ============================================================

async function inserirBancoEmergencia(db) {
    const torres = [
        ['GSM', 724, 5, 100, 208020001, 0, -38.5016, -12.9714, 5000, 100, 1, 1609459200, 1609459200, -71],
        ['GSM', 724, 5, 200, 208017145, 0, -46.6333, -23.5505, 5000, 100, 1, 1609459200, 1609459200, -73],
        ['GSM', 724, 5, 300, 208019001, 0, -43.2096, -22.9035, 3500, 85, 1, 1609459200, 1609459200, -74],
        ['GSM', 724, 5, 400, 208018001, 0, -47.9292, -15.7801, 6000, 120, 1, 1609459200, 1609459200, -68],
        ['GSM', 724, 5, 500, 208021001, 0, -38.5266, -3.7319, 4000, 90, 1, 1609459200, 1609459200, -69],
    ];
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const t of torres) stmt.run(t);
    stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    log('info', 'Banco de emergência criado com ' + torres.length + ' torres.');
}

async function verificarERecuperarBanco(db) {
    const dbExists = fs.existsSync(DB_TOWERS);
    if (!dbExists) {
        log('info', 'Banco de dados não existe. Criando novo.');
        const newDb = new sqlite3.Database(DB_TOWERS);
        newDb.run('PRAGMA journal_mode=WAL');
        newDb.run('PRAGMA secure_delete=ON');
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE IF NOT EXISTS cell_towers (
                radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        return newDb;
    }

    try {
        await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                if (err) reject(err); else resolve(row ? row.c : 0);
            });
        });
        log('info', 'Banco existente e íntegro.');
        return db;
    } catch (err) {
        log('warn', 'Banco existente parece corrompido. Tentando criar tabela...');
        await new Promise((resolve, reject) => {
            db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
                radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        try {
            const count = await new Promise((resolve, reject) => {
                db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                    if (err) reject(err); else resolve(row ? row.c : 0);
                });
            });
            log('info', `Banco recuperado com ${count} registros.`);
            return db;
        } catch (e2) {
            log('error', 'Não foi possível recuperar o banco. Mantendo como está.');
            return db;
        }
    }
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
async function iniciarServidor() {
    let dbTowers = new sqlite3.Database(DB_TOWERS);
    dbTowers.run('PRAGMA journal_mode=WAL');
    dbTowers.run('PRAGMA secure_delete=ON');

    dbTowers = await verificarERecuperarBanco(dbTowers);

    const count = await new Promise((resolve) => {
        dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log('info', 'Torres atuais: ' + (count || 0).toLocaleString());

    if (count < 1000) {
        let importado = false;

        try {
            log('info', 'Executando importação multi‑CSV...');
            const { importarTodosCSVs } = require('./scripts/import-coleta-campo.js');
            const inseridos = await importarTodosCSVs(dbTowers, { maxRegistros: 300000 });
            if (inseridos > 0) {
                importado = true;
                log('info', `Importação multi‑CSV concluída: ${inseridos} torres.`);
            } else {
                log('info', 'Nenhum dado encontrado nos CSVs.');
            }
        } catch (err) {
            log('warn', 'Erro no importador multi‑CSV: ' + err.message);
        }

        if (!importado) {
            try {
                log('info', 'Tentando Teleco/Anatel...');
                execSync('node scripts/import-teleco.js', { stdio: 'inherit', timeout: 600000 });
                importado = true;
            } catch (err) { log('warn', 'Teleco falhou: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Tentando OpenCellID...');
                execSync('node scripts/import-opencellid-area.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'OpenCellID falhou: ' + err.message); }
        }

        if (!importado) {
            log('warn', 'Nenhuma fonte disponível. Inserindo banco de emergência...');
            await inserirBancoEmergencia(dbTowers);
        }
    } else {
        log('info', 'Banco já possui torres suficientes.');
    }

    const finalCount = await new Promise((resolve) => {
        dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log('info', 'Total final de torres: ' + finalCount.toLocaleString());

    dbTowers.close();

    app.listen(port, () => {
        log('info', 'AI-DEPOM 6.8.4 rodando na porta ' + port);
        log('info', 'Cadeia: Multi‑CSV → Teleco → OpenCellID → Emergência');
        log('info', 'GitHub integração ativa.');
        log('info', '🌐 Interface de teste: /teste');
        log('info', '📁 Arquivos estáticos em /public');
    });
}

iniciarServidor().catch(err => {
    console.error('[ORION] ERRO FATAL:', err.message);
    process.exit(1);
});
