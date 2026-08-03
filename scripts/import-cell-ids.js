// ============================================================
// ARQUIVO: scripts/import-cell-ids.js
// DATA: 03 de Agosto de 2026
// AUTOR: Eng Souza
// MOTIVO: Importar Cell IDs específicos via API individual do
//         OpenCellID. Ignora bloqueios de download massivo.
// ============================================================

const https = require('https');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

// Cell IDs fornecidos pelo investigador
const CELLS = [
    { cell: 181814277, mcc: 724, mnc: 5, lac: 40271 },
    { cell: 181765632, mcc: 724, mnc: 5, lac: 40271 },
    { cell: 181765633, mcc: 724, mnc: 5, lac: 40271 },
    { cell: 181767168, mcc: 724, mnc: 5, lac: 40271 }
];

function log(msg) { console.log('[IMPORT-CELL-IDS] ' + msg); }

function consultarCell(cellId) {
    return new Promise((resolve) => {
        const url = `https://opencellid.org/cell/get?key=${API_KEY}&cell=${cellId}&format=json`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.lat && json.lon) {
                        resolve({
                            radio: 'LTE',
                            mcc: 724,
                            mnc: 5,
                            lac: json.lac || 40271,
                            cell: cellId,
                            lat: json.lat,
                            lon: json.lon,
                            range: json.range || 3000
                        });
                    } else {
                        log(`Cell ${cellId}: sem coordenadas na API.`);
                        resolve(null);
                    }
                } catch (e) {
                    log(`Cell ${cellId}: erro ao processar resposta.`);
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            log(`Cell ${cellId}: erro de rede - ${e.message}`);
            resolve(null);
        });
    });
}

async function main() {
    log('=== IMPORTAÇÃO DE CELL IDs ESPECÍFICOS ===');
    log(`Total de células: ${CELLS.length}`);
    log('');

    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);

    const antes = await new Promise((resolve) => db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)));
    log(`Torres antes: ${antes.toLocaleString()}`);

    let importadas = 0;

    for (const c of CELLS) {
        log(`Consultando Cell ID ${c.cell}...`);
        const torre = await consultarCell(c.cell);
        if (torre) {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            stmt.run([torre.radio, torre.mcc, torre.mnc, torre.lac, torre.cell, 0, torre.lon, torre.lat, torre.range, 100, 1, 1609459200, 1609459200, -71]);
            stmt.finalize();
            db.run('COMMIT');
            importadas++;
            log(`Cell ${c.cell}: importado com sucesso (${torre.lat}, ${torre.lon}).`);
        }
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');

    const depois = await new Promise((resolve) => db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)));
    db.close();

    log('');
    log('=== IMPORTAÇÃO CONCLUÍDA ===');
    log(`Antes: ${antes.toLocaleString()}`);
    log(`Depois: ${depois.toLocaleString()}`);
    log(`Importadas: ${importadas}`);
    process.exit(0);
}

main();
