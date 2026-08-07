/**
 * ARQUIVO: orion.js
 * VERSÃO: 6.7.0
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-07 14:30:00 (UTC)
 * COMENTÁRIO: Prioridade absoluta para coleta de campo (CSVs) como fonte primária.
 *             Cadeia de fallback: Coleta de Campo → Teleco/Anatel → OpenCellID → Emergência.
 *             Limiar de importação reduzido para 1000 torres.
 *             Versão atualizada para 6.7.
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

// Garantir diretórios
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });

// Logging
function log(level, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

log('info', 'Diretório data/ gravável.');

// ============================================================
// HERMES – IAs configuradas (placeholder)
// ============================================================
const HERMES = {
    IAs: [
        { nome: 'Artemis', ativa: true },
        { nome: 'Apollo', ativa: true },
        { nome: 'Athena', ativa: true }
    ]
};
log('info', 'HERMES inicializado com 3 IAs configuradas.');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// ROTAS DE GEOLOCALIZAÇÃO (existentes)
// ============================================================
// (Aqui você mantém suas rotas atuais: /api/localizar, /api/buscar-cell-ids, etc.)

// ============================================================
// ROTAS DE CONTEXTO (existentes)
// ============================================================
// Mantenha suas rotas de contexto /api/contexto/*

// ============================================================
// ROTAS DE GITHUB (existentes)
// ============================================================
// Mantenha /api/github/*

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
    for (const t of torres) { stmt.run(t); }
    stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    log('info', 'Banco de emergência criado com ' + torres.length + ' torres.');
}

async function verificarERecuperarBanco(db) {
    let bancoCorrompido = false;
    try {
        await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                if (err) { bancoCorrompido = true; reject(err); }
                else resolve(row ? row.c : 0);
            });
        });
    } catch (err) {
        log('warn', 'Banco de dados parece corrompido. Tentando recuperar...');
        bancoCorrompido = true;
    }
    if (bancoCorrompido) {
        log('info', 'Recriando banco de dados corrompido...');
        db.close();
        try { fs.unlinkSync(DB_TOWERS); log('info', 'Arquivo cell_towers.db removido.'); }
        catch (e) { log('error', 'Erro ao remover cell_towers.db: ' + e.message); }
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
        log('info', 'Banco de dados recriado com sucesso.');
        return newDb;
    }
    return db;
}

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================
async function iniciarServidor() {
    let dbTowers = new sqlite3.Database(DB_TOWERS);
    dbTowers.run('PRAGMA journal_mode=WAL');
    dbTowers.run('PRAGMA secure_delete=ON');

    dbTowers = await verificarERecuperarBanco(dbTowers);

    const count = await new Promise((resolve) => {
        dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
            resolve(row ? row.c : 0);
        });
    });
    log('info', 'Torres atuais: ' + (count || 0).toLocaleString());

    if (count < 1000) {
        let importado = false;

        // 1. PRIORIDADE: Coleta de Campo (arquivos CSV)
        try {
            log('info', 'Verificando arquivos de coleta de campo...');
            const { processarArquivosColeta } = require('./scripts/import-coleta-campo.js');
            const inseridos = await processarArquivosColeta(dbTowers);
            if (inseridos > 0) {
                importado = true;
                log('info', `Coleta de campo importada: ${inseridos} torres.`);
            } else {
                log('info', 'Nenhum dado de coleta de campo encontrado.');
            }
        } catch (err) {
            log('warn', 'Erro na importação de coleta de campo: ' + err.message);
        }

        // 2. Teleco/Anatel (se não importado)
        if (!importado) {
            try {
                log('info', 'Importando base da Teleco/Anatel...');
                execSync('node scripts/import-teleco.js', { stdio: 'inherit', timeout: 600000 });
                importado = true;
            } catch (err) { log('warn', 'Teleco: ' + err.message); }
        }

        // 3. OpenCellID (fallback)
        if (!importado) {
            try {
                log('info', 'Consultando OpenCellID...');
                execSync('node scripts/import-opencellid-area.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'OpenCellID: ' + err.message); }
        }

        // 4. Banco de emergência (último recurso)
        if (!importado) {
            log('warn', 'Nenhuma fonte disponível. Inserindo banco de emergência...');
            await inserirBancoEmergencia(dbTowers);
        }
    } else {
        log('info', 'Banco de torres OK: ' + count.toLocaleString() + ' torres.');
    }

    dbTowers.close();

    app.listen(port, () => {
        log('info', 'AI-DEPOM 6.7 rodando na porta ' + port);
        log('info', 'Cadeia: Coleta de Campo → Teleco/Anatel → OpenCellID → Emergência');
        log('info', 'GitHub integração: LEITURA + ESCRITA ativas.');
    });
}

iniciarServidor().catch(err => {
    console.error('[ORION] ERRO FATAL:', err.message);
    process.exit(1);
});
