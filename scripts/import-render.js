// ORION - Pipeline de Importacao Otimizado (Render)
// Data: 28/07/2026 - v3 (reescrita completa)

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');
const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
const API_KEY = process.env.OPENCELLID_API_KEY || '';

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function log(msg) {
    console.log('[IMPORT] ' + msg);
}

async function main() {
    log('=== Iniciando importacao do banco de torres (v3) ===');

    if (!API_KEY) {
        log('ERRO: Token OpenCellID nao configurado.');
        process.exit(1);
    }

    // Remove banco antigo para garantir ambiente limpo
    if (fs.existsSync(DB_PATH)) {
        log('Removendo banco de torres antigo...');
        fs.unlinkSync(DB_PATH);
    }

    // Cria banco novo
    const db = new sqlite3.Database(DB_PATH);
    log('Banco criado.');

    // Cria tabela
    db.run(`CREATE TABLE cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);
    log('Tabela criada.');

    // Verifica se a tabela existe
    const tableCheck = await new Promise((resolve) => {
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_towers'", (err, row) => {
            resolve(row);
        });
    });
    if (!tableCheck) {
        log('ERRO FATAL: Tabela nao foi criada.');
        db.close();
        process.exit(1);
    }
    log('Tabela verificada com sucesso.');

    // Modo performance
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=OFF');
    db.run('PRAGMA cache_size=100000');

    // Download
    const url = 'https://opencellid.org/ocid/downloads?token=' + API_KEY + '&type=full&file=cell_towers.csv.gz';
    const gzPath = path.join(TEMP_DIR, 'full.csv.gz');
    const csvPath = path.join(TEMP_DIR, 'full.csv');

    log('Baixando dataset...');
    await downloadFile(url, gzPath);
    log('Download concluido.');

    // Descompacta
    log('Descompactando...');
    await gunzipFile(gzPath, csvPath);
    log('Descompactacao concluida.');

    // Importa em lote
    log('Importando torres...');
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
    let header = true;

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for await (const line of rl) {
        if (header) { header = false; continue; }
        const cols = line.split(',');
        if (cols.length < 14) continue;
        stmt.run([cols[0], +cols[1], +cols[2], +cols[3], +cols[4], +cols[5], +cols[6], +cols[7], +cols[8], +cols[9], +cols[10], +cols[11], +cols[12], +cols[13]]);
        count++;
        if (count % 100000 === 0) {
            db.run('COMMIT');
            db.run('BEGIN TRANSACTION');
            log(count.toLocaleString() + ' torres processadas...');
        }
    }

    db.run('COMMIT');
    stmt.finalize();
    log('Total importado: ' + count.toLocaleString() + ' torres.');

    // Indices
    log('Criando indices...');
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
    db.run('ANALYZE cell_towers');
    log('Indices criados.');

    db.close();

    // Limpa temp
    fs.unlinkSync(gzPath);
    fs.unlinkSync(csvPath);

    log('Importacao concluida com sucesso!');
    process.exit(0);
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, function(res) {
            if (res.statusCode === 302 || res.statusCode === 301) {
                https.get(res.headers.location, function(r) {
                    r.pipe(file);
                    file.on('finish', resolve);
                });
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            res.pipe(file);
            file.on('finish', resolve);
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

main();
