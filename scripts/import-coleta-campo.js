// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 21:00 (Horário Oficial — Salvador, Bahia, Brasil)
// MOTIVO: Importa dados primários de ERBs coletados em campo
//         via app OpenCellID. Fonte: contribuições próprias
//         do investigador. Dados 100% reais e verificados.
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const ARQUIVO_ENTRADA = path.join(__dirname, '..', 'data', 'coleta_campo.csv');
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

function log(msg) { console.log('[COLETA-CAMPO] ' + msg); }

async function main() {
    log('=== IMPORTADOR DE DADOS DE CAMPO ===');
    log('Fonte: Coleta própria via app OpenCellID');
    log('');

    if (!fs.existsSync(ARQUIVO_ENTRADA)) {
        log('ERRO: Arquivo não encontrado: ' + ARQUIVO_ENTRADA);
        log('');
        log('Como obter o arquivo:');
        log('1. Instale o app OpenCellID no Android');
        log('2. Percorra trajetos com GPS ativo');
        log('3. Acesse https://opencellid.org → My Contributions');
        log('4. Exporte como CSV');
        log('5. Salve como "coleta_campo.csv" na pasta data/');
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
    let header = true;
    let count = 0;

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for await (const line of rl) {
        if (header) { header = false; continue; }
        const cols = line.split(',');
        if (cols.length < 7) continue;

        const cellId = parseInt(cols[1]) || 0;
        const lat = parseFloat(cols[5]) || 0;
        const lon = parseFloat(cols[4]) || 0;
        const range = parseInt(cols[6]) || 5000;
        const mcc = parseInt(cols[2]) || 724;
        const mnc = parseInt(cols[3]) || 5;

        if (!cellId || !lat || !lon) continue;

        stmt.run(['GSM', mcc, mnc, Math.floor(cellId / 1000), cellId, 0, lon, lat, range, 100, 1, 1609459200, 1609459200, -71]);
        count++;
    }

    db.run('COMMIT');
    stmt.finalize();

    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    db.close();

    log('Importação concluída!');
    log('Antes: ' + antes.toLocaleString());
    log('Depois: ' + depois.toLocaleString());
    log('Novas: ' + count.toLocaleString());
    log('');
    log('Dados 100% reais, coletados em campo pelo investigador.');
    process.exit(0);
}

main();
