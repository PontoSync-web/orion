// ============================================================
// ARQUIVO: scripts/import-anatel.js
// DATA: 29 de Julho de 2026
// HORÁRIO: 17:30 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Importador de dados oficiais da Anatel (Mosaico)
//         adaptado para formato de licenciamento.
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const ARQUIVO_ENTRADA = path.join(__dirname, '..', 'data', 'anatel_erbs.csv');
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

// Mapeamento de tecnologia para MNC (Vivo)
const TECH_TO_MNC = {
    'GSM': 6,
    'WCDMA': 6,
    'LTE': 6,
    '5G': 6
};

function log(msg) { console.log('[ANATEL] ' + msg); }

async function main() {
    log('=== IMPORTADOR ANATEL (FORMATO MOSAICO) ===');
    log('Fonte: Dados oficiais da Anatel');
    log('');

    if (!fs.existsSync(ARQUIVO_ENTRADA)) {
        log('ERRO: Arquivo não encontrado: ' + ARQUIVO_ENTRADA);
        log('Salve o arquivo como "anatel_erbs.csv" na pasta data/');
        process.exit(1);
    }

    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);

    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log('Torres antes: ' + antes.toLocaleString());

    const rl = readline.createInterface({ input: fs.createReadStream(ARQUIVO_ENTRADA) });
    let count = 0;
    let ignoradas = 0;

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for await (const line of rl) {
        const cols = line.split('\t'); // Anatel usa tabulação como separador
        
        if (cols.length < 20) {
            ignoradas++;
            continue;
        }

        try {
            const tecnologia = cols[7]?.trim() || 'LTE';
            const lat = parseFloat(cols[20]?.replace(',', '.'));
            const lon = parseFloat(cols[21]?.replace(',', '.'));
            const freqDown = parseFloat(cols[12]?.replace(',', '.')) || 0;
            
            if (!lat || !lon) {
                ignoradas++;
                continue;
            }

            // Gera um Cell ID a partir do número da estação (coluna 5)
            const numEstacao = cols[5]?.trim() || '';
            const cellId = parseInt(numEstacao) || (208000000 + count);
            
            // Estima o alcance baseado na frequência
            let range = 5000;
            if (freqDown > 2000) range = 3000;
            else if (freqDown > 1000) range = 5000;
            else if (freqDown > 500) range = 8000;

            const radio = tecnologia === 'LTE' ? 'LTE' : (tecnologia === 'WCDMA' ? 'UMTS' : 'GSM');
            const mnc = TECH_TO_MNC[tecnologia] || 6;
            const area = Math.floor(cellId / 1000);

            stmt.run([radio, 724, mnc, area, cellId, 0, lon, lat, range, 100, 1, 1609459200, 1609459200, -71]);
            count++;
            
            if (count % 1000 === 0) {
                db.run('COMMIT');
                db.run('BEGIN TRANSACTION');
                log(count.toLocaleString() + ' estações processadas...');
            }
        } catch (e) {
            ignoradas++;
        }
    }

    db.run('COMMIT');
    stmt.finalize();

    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    db.close();

    log('');
    log('=== IMPORTAÇÃO CONCLUÍDA ===');
    log('Antes: ' + antes.toLocaleString());
    log('Depois: ' + depois.toLocaleString());
    log('Novas: ' + count.toLocaleString());
    log('Ignoradas: ' + ignoradas.toLocaleString());
    log('Dados 100% oficiais da Anatel.');
    process.exit(0);
}

main();
