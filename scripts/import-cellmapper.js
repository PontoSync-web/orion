// ============================================================
// ARQUIVO: scripts/import-cellmapper.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 14:50 (Salvador, Bahia, Brasil)
// MOTIVO: Script de importação de torres via CellMapper.
//         OBSOLETO na v5.8.3 — banco de emergência incorporado.
// ============================================================

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');
const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
const API_KEY = process.env.OPENCELLID_API_KEY || '';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function log(msg) { console.log('[CELLMAPPER] ' + msg); }

async function main() {
    log('=== Importando torres (CellMapper) ===');
    
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
    
    if (antes > 1000000) {
        log('Banco já possui torres suficientes.');
        db.close();
        process.exit(0);
    }
    
    // Tenta download do OpenCellID
    const url = 'https://opencellid.org/ocid/downloads?token=' + API_KEY + '&type=full&file=cell_towers.csv.gz';
    const gzPath = path.join(TEMP_DIR, 'full.csv.gz');
    const csvPath = path.join(TEMP_DIR, 'full.csv');
    
    try {
        log('Baixando dataset...');
        await downloadFile(url, gzPath);
        log('Descompactando...');
        await gunzipFile(gzPath, csvPath);
        log('Importando...');
        // ... (código de importação)
        log('Concluído.');
    } catch (e) {
        log('ERRO: ' + e.message);
    }
    
    db.close();
    process.exit(0);
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch (e) {}
                return reject(new Error('HTTP ' + res.statusCode));
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
    });
}

function gunzipFile(source, dest) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(source)
            .pipe(zlib.createGunzip())
            .on('error', reject)
            .pipe(fs.createWriteStream(dest))
            .on('finish', resolve);
    });
}

main();
