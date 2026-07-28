// ============================================================
// ORION — Pipeline de Importação Otimizado (Render)
// Data: 28/07/2026 — v2 (corrigida)
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

function log(msg) {
    console.log(`[IMPORT] ${msg}`);
}

async function main() {
    log('=== Iniciando importacao do banco de torres ===');
    
    if (!API_KEY) {
        log('ERRO: Token OpenCellID nao configurado.');
        process.exit(1);
    }
    // Remove banco antigo/corrompido para garantir um ambiente limpo
if (fs.existsSync(DB_PATH)) {
    log('Removendo banco de torres antigo...');
    try { fs.unlinkSync(DB_PATH); } catch(e) {
        log('Aviso: Nao foi possivel remover banco antigo. ' + e.message);
    }
}
    const db = new sqlite3.Database(DB_PATH);
    og('Banco de dados criado/aberto com sucesso.');
    // Cria tabela se nao existir
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);
    
    // Verifica se ja tem dados suficientes
    const row = await new Promise((rs, rj) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (e, r) => e ? rj(e) : rs(r));
    });
    
    const totalExistente = row ? row.c : 0;
    log(`Torres existentes no banco: ${totalExistente.toLocaleString()}`);
    
    if (totalExistente > 1000000) {
        log('Banco ja possui mais de 1 milhao de torres. Importacao desnecessaria.');
        db.close();
        process.exit(0);
    }
    
    // Ativa modo WAL para performance
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=OFF');
    db.run('PRAGMA cache_size=100000');
    
    const url = `https://opencellid.org/ocid/downloads?token=${API_KEY}&type=full&file=cell_towers.csv.gz`;
    const gzPath = path.join(TEMP_DIR, 'full.csv.gz');
    const csvPath = path.join(TEMP_DIR, 'full.csv');
    
    // Download com stream
    log('Baixando dataset...');
    await downloadFile(url, gzPath);
    log('Download concluido.');
    
    // Descompacta
    log('Descompactando...');
    await gunzipFile(gzPath, csvPath);
    log('Descompactacao concluida.');
    
    // Importa em lote
    log('Importando torres (isso pode levar varios minutos)...');
    let importadas = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath) });
    let header = false;
    
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    
    for await (const line of rl) {
        if (!header) { header = true; continue; }
        const cols = line.split(',');
        if (cols.length < 14) continue;
        stmt.run([cols[0], +cols[1], +cols[2], +cols[3], +cols[4], +cols[5], +cols[6], +cols[7], +cols[8], +cols[9], +cols[10], +cols[11], +cols[12], +cols[13]]);
        importadas++;
        if (importadas % 100000 === 0) {
            db.run('COMMIT');
            db.run('BEGIN TRANSACTION');
            log(`${importadas.toLocaleString()} torres processadas...`);
        }
    }
    
    db.run('COMMIT');
    stmt.finalize();
    
    // Cria índices
    log('Criando indices...');
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
    db.run('ANALYZE cell_towers');
    
    db.close();
    
    // Limpa arquivos temporarios
    try { fs.unlinkSync(gzPath); } catch (e) {}
    try { fs.unlinkSync(csvPath); } catch (e) {}
    
    log(`Importacao concluida! Total importado: ${importadas.toLocaleString()} torres.`);
    process.exit(0);
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, res => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                return https.get(res.headers.location, r => {
                    r.pipe(file);
                    file.on('finish', resolve);
                });
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch (e) {}
                return reject(new Error(`HTTP ${res.statusCode}`));
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
