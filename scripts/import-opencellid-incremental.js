// ============================================================
// ARQUIVO: scripts/import-opencellid-incremental.js
// DATA: 30 de Julho de 2026
// HORÁRIO: 18:30 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Download incremental de torres do OpenCellID.
//         Baixa apenas torres novas/modificadas desde a
//         última atualização. Evita bloqueios de limite.
// ============================================================

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');
const LAST_UPDATE_FILE = path.join(DATA_DIR, '.opencellid_last_update');
const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';

function log(msg) { console.log('[OPENCELLID-INC] ' + msg); }

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                try { fs.unlinkSync(dest); } catch (e) {}
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch (e) {}
                return reject(new Error('HTTP ' + res.statusCode));
            }
            res.pipe(file);
            file.on('finish', () => resolve());
            file.on('error', reject);
        }).on('error', reject);
    });
}

function gunzipFile(source, dest) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(source)
            .pipe(zlib.createGunzip())
            .on('error', reject)
            .pipe(fs.createWriteStream(dest))
            .on('finish', resolve)
            .on('error', reject);
    });
}

async function importarCSV(db, csvPath, stmt) {
    return new Promise((resolve) => {
        let count = 0;
        let header = true;
        const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
        rl.on('line', (line) => {
            if (header) { header = false; return; }
            const cols = line.split(',');
            if (cols.length < 14) return;
            try {
                stmt.run([
                    cols[0], parseInt(cols[1]), parseInt(cols[2]), parseInt(cols[3]),
                    parseInt(cols[4]), parseInt(cols[5]), parseFloat(cols[6]), parseFloat(cols[7]),
                    parseInt(cols[8]), parseInt(cols[9]), parseInt(cols[10]), parseInt(cols[11]),
                    parseInt(cols[12]), parseInt(cols[13])
                ]);
                count++;
            } catch (e) {}
        });
        rl.on('close', () => resolve(count));
    });
}

async function main() {
    log('=== ATUALIZAÇÃO INCREMENTAL OPENCELLID ===');
    
    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);
    
    // Obtém a data da última atualização
    let lastUpdate = 0;
    if (fs.existsSync(LAST_UPDATE_FILE)) {
        lastUpdate = parseInt(fs.readFileSync(LAST_UPDATE_FILE, 'utf8').trim());
    }
    log(`Última atualização: ${lastUpdate > 0 ? new Date(lastUpdate * 1000).toISOString() : 'Nunca (download completo)'}`);
    
    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`Torres antes: ${antes.toLocaleString()}`);
    
    // Se o banco tem menos de 1000 torres, faz download completo
    const precisaCompleto = antes < 1000;
    
    const url = precisaCompleto
        ? `https://opencellid.org/ocid/downloads?token=${API_KEY}&type=full&file=cell_towers.csv.gz`
        : `https://opencellid.org/ocid/downloads?token=${API_KEY}&type=diff&file=cell_towers.csv.gz&since=${lastUpdate}`;
    
    const gzPath = path.join(DATA_DIR, 'opencellid_temp.csv.gz');
    const csvPath = path.join(DATA_DIR, 'opencellid_temp.csv');
    
    try {
        log(`Baixando dados (${precisaCompleto ? 'completo' : 'incremental'})...`);
        await downloadFile(url, gzPath);
        log('Download concluído. Descompactando...');
        await gunzipFile(gzPath, csvPath);
        
        log('Importando torres...');
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const count = await importarCSV(db, csvPath, stmt);
        db.run('COMMIT');
        stmt.finalize();
        
        // Atualiza timestamp
        const now = Math.floor(Date.now() / 1000);
        fs.writeFileSync(LAST_UPDATE_FILE, now.toString());
        
        // Limpeza
        try { fs.unlinkSync(gzPath); } catch (e) {}
        try { fs.unlinkSync(csvPath); } catch (e) {}
        
        const depois = await new Promise((resolve) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
        });
        
        db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
        db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
        db.close();
        
        log('');
        log('=== ATUALIZAÇÃO CONCLUÍDA ===');
        log(`Antes: ${antes.toLocaleString()}`);
        log(`Depois: ${depois.toLocaleString()}`);
        log(`Novas: ${count.toLocaleString()}`);
        log(`Próxima atualização: a partir de ${new Date(now * 1000).toISOString()}`);
        process.exit(0);
        
    } catch (err) {
        log(`ERRO: ${err.message}`);
        try { fs.unlinkSync(gzPath); } catch (e) {}
        try { fs.unlinkSync(csvPath); } catch (e) {}
        db.close();
        process.exit(1);
    }
}

main();
