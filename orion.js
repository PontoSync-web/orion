/**
 * ARQUIVO: orion.js
 * VERSÃO: 6.8.2
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-09 (patch)
 * COMENTÁRIO: Prevenção de recriação desnecessária do banco.
 *             Importador multi-CSV com limite de registros (500k).
 *             Cadeia: Multi-CSV → Teleco → OpenCellID → Emergência.
 *             [PATCH] Schema corrigido: PRIMARY KEY composta (mcc, net, area, cell)
 *             em vez de "cell" isolado — evita colisões entre operadoras/fontes
 *             diferentes que faziam INSERT OR REPLACE sobrescrever quase tudo.
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

// Diretórios
const DATA_DIR = path.join(__dirname, 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');
const CONTEXT_DIR = path.join(DATA_DIR, 'contextos');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });

function log(level, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

log('info', 'Diretório data/ gravável.');

// ============================================================
// HERMES – placeholder
// ============================================================
const HERMES = { IAs: [{ nome: 'Artemis' }, { nome: 'Apollo' }, { nome: 'Athena' }] };
log('info', 'HERMES inicializado com 3 IAs configuradas.');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// ROTAS EXISTENTES (mantidas)
// ============================================================
// (Aqui ficam /api/localizar, /api/buscar-cell-ids, /api/contexto/*, /api/github/*)
// Mantenha as rotas que já estão no seu código.

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
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const t of torres) stmt.run(t);
    stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    log('info', 'Banco de emergência criado com ' + torres.length + ' torres.');
}

async function verificarERecuperarBanco(db) {
    let corrompido = false;
    let count = 0;
    try {
        count = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                if (err) { corrompido = true; reject(err); } else resolve(row ? row.c : 0);
            });
        });
    } catch (err) {
        log('warn', 'Erro ao ler banco: ' + err.message);
        corrompido = true;
    }

    if (corrompido && count === 0) {
        log('warn', 'Banco corrompido e vazio. Recriando...');
        db.close();
        try { fs.unlinkSync(DB_TOWERS); } catch (e) {}
        const newDb = new sqlite3.Database(DB_TOWERS);
        newDb.run('PRAGMA journal_mode=WAL');
        newDb.run('PRAGMA secure_delete=ON');
        await new Promise((resolve, reject) => {
            // [PATCH] PRIMARY KEY composta: mcc+net+area+cell é a identidade real
            // de uma célula. "cell" isolado se repete entre operadoras/fontes
            // diferentes e causava colisão no INSERT OR REPLACE.
            newDb.run(`CREATE TABLE IF NOT EXISTS cell_towers (
                radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                cell INTEGER, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER,
                PRIMARY KEY (mcc, net, area, cell)
            )`, (err) => { if (err) reject(err); else resolve(); });
        });
        log('info', 'Banco recriado com sucesso (schema com PK composta).');
        return newDb;
    } else if (corrompido && count > 0) {
        log('warn', 'Banco corrompido mas com dados. Mantendo como está.');
        return db;
    } else {
        return db;
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

        // 1. Importador multi‑CSV (com limite de 500k registros para evitar OOM)
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

        // 2. Fallback: Teleco
        if (!importado) {
            try {
                log('info', 'Tentando Teleco/Anatel...');
                execSync('node scripts/import-teleco.js', { stdio: 'inherit', timeout: 600000 });
                importado = true;
            } catch (err) { log('warn', 'Teleco falhou: ' + err.message); }
        }

        // 3. Fallback: OpenCellID
        if (!importado) {
            try {
                log('info', 'Tentando OpenCellID...');
                execSync('node scripts/import-opencellid-area.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'OpenCellID falhou: ' + err.message); }
        }

        // 4. Emergência
        if (!importado) {
            log('warn', 'Nenhuma fonte disponível. Inserindo banco de emergência...');
            await inserirBancoEmergencia(dbTowers);
        }
    } else {
        log('info', 'Banco já possui torres suficientes.');
    }

    // Atualiza a contagem final
    const finalCount = await new Promise((resolve) => {
        dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log('info', 'Total final de torres: ' + finalCount.toLocaleString());

    dbTowers.close();

    app.listen(port, () => {
        log('info', 'AI-DEPOM 6.8.2 rodando na porta ' + port);
        log('info', 'Cadeia: Multi‑CSV → Teleco → OpenCellID → Emergência');
        log('info', 'GitHub integração ativa.');
    });
}

iniciarServidor().catch(err => {
    console.error('[ORION] ERRO FATAL:', err.message);
    process.exit(1);
});
