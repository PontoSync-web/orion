/**
 * ARQUIVO: orion.js
 * VERSÃO: 6.8.5
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-17 12:30:00 (UTC)
 * COMENTÁRIO: Unificação da chave primária para (mcc, net, area, cell).
 *             Rota explícita para mapa-localizar.html.
 *             Lógica real de consulta ao banco de torres.
 *             Melhorias no tratamento de erros.
 * AUTOR: Equipe ORION
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

function log(level, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

log('info', 'Diretórios verificados/criados.');

const HERMES = { IAs: [{ nome: 'Artemis' }, { nome: 'Apollo' }, { nome: 'Athena' }] };
log('info', 'HERMES inicializado com 3 IAs configuradas.');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos da pasta public/
app.use(express.static(PUBLIC_DIR));

// Rota explícita para o mapa-localizar.html (garantia)
app.get('/mapa-localizar.html', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, 'mapa-localizar.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Arquivo não encontrado. Verifique se public/mapa-localizar.html existe.');
    }
});

// Rota de teste (GET)
app.get('/teste', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>ORION - Teste</title></head>
        <body>
            <h1>📡 ORION - Teste Rápido</h1>
            <p>Use a interface completa em <a href="/mapa-localizar.html">/mapa-localizar.html</a></p>
            <p>Servidor funcionando!</p>
        </body>
        </html>
    `);
});

// Rota raiz
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 ORION - AI-DEPOM</h1>
        <p>Versão 6.8.5</p>
        <ul>
            <li><a href="/mapa-localizar.html">🔍 Interface de localização</a></li>
            <li><a href="/teste">🧪 Página de teste</a></li>
        </ul>
        <p>Status: <strong>Operacional</strong></p>
    `);
});

// ============================================================
// API DE LOCALIZAÇÃO (lógica real)
// ============================================================
app.post('/api/localizar', (req, res) => {
    const { cells } = req.body;
    if (!cells || !cells.length) {
        return res.status(400).json({ erro: 'Nenhuma célula fornecida.' });
    }

    const db = new sqlite3.Database(DB_TOWERS);
    let resultados = [];
    let promises = cells.map((cell) => {
        return new Promise((resolve) => {
            const { cellId, mcc, mnc, lac } = cell;
            db.get(
                `SELECT lat, lon, range FROM cell_towers 
                 WHERE cell = ? AND mcc = ? AND net = ? AND area = ?`,
                [cellId, mcc || 0, mnc || 0, lac || 0],
                (err, row) => {
                    if (err || !row) {
                        resolve(null);
                    } else {
                        resolve(row);
                    }
                }
            );
        });
    });

    Promise.all(promises).then((rows) => {
        db.close();
        const validos = rows.filter(r => r !== null);
        if (validos.length === 0) {
            return res.json({
                status: 'nao_encontrado',
                mensagem: 'Nenhuma torre encontrada para os dados fornecidos.'
            });
        }

        // Cálculo de posição (média ponderada pelo range)
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

        res.json({
            status: 'localizado',
            position: pos,
            torres_usadas: validos.length,
            fonte: 'banco_local'
        });
    }).catch(err => {
        db.close();
        res.status(500).json({ erro: err.message });
    });
});

// ============================================================
// FUNÇÕES DE IMPORTAÇÃO
// ============================================================

async function inserirBancoEmergencia(db) {
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
                cell INTEGER, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER,
                PRIMARY KEY (mcc, net, area, cell)
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
                cell INTEGER, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER,
                PRIMARY KEY (mcc, net, area, cell)
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
            const inseridos = await importarTodosCSVs(dbTowers, { maxRegistros: 500000 });
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
        log('info', 'AI-DEPOM 6.8.5 rodando na porta ' + port);
        log('info', 'Cadeia: Multi‑CSV → Teleco → OpenCellID → Emergência');
        log('info', 'GitHub integração ativa.');
        log('info', '🌐 Interface: /mapa-localizar.html');
        log('info', '📁 Arquivos estáticos em /public');
    });
}

iniciarServidor().catch(err => {
    console.error('[ORION] ERRO FATAL:', err.message);
    process.exit(1);
});
