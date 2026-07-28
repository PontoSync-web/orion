// ============================================================
// ARQUIVO: scripts/import-render.js
// DATA: 28/07/2026
// MOTIVO: Pipeline robusto com verificação de integridade,
//         tratamento de erros HTTP, e fallback para teste.
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

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function log(msg) {
    console.log('[IMPORT] ' + msg);
}

// ============================================================
// VERIFICA SE O ARQUIVO BAIXADO É UM GZIP VÁLIDO
// ============================================================
function isGzipFile(filePath) {
    try {
        const buffer = Buffer.alloc(2);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 2, 0);
        fs.closeSync(fd);
        // Magic number do GZIP: 0x1F 0x8B
        return buffer[0] === 0x1F && buffer[1] === 0x8B;
    } catch (e) {
        return false;
    }
}

// ============================================================
// DOWNLOAD COM VERIFICAÇÃO DE CONTENT-TYPE
// ============================================================
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            // Segue redirecionamentos
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch (e) {}
                return reject(new Error('HTTP ' + res.statusCode + ' - Limite diario excedido ou token invalido'));
            }

            const contentType = res.headers['content-type'] || '';
            log('Content-Type recebido: ' + contentType);

            // Se for JSON, provavelmente é uma mensagem de erro da API
            if (contentType.includes('application/json')) {
                file.close();
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { fs.unlinkSync(dest); } catch (e) {}
                    reject(new Error('API retornou JSON em vez de CSV: ' + body.substring(0, 200)));
                });
                return;
            }

            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', (e) => {
                try { fs.unlinkSync(dest); } catch (e) {}
                reject(e);
            });
        }).on('error', (e) => {
            try { fs.unlinkSync(dest); } catch (e) {}
            reject(e);
        });
    });
}

// ============================================================
// DESCOMPACTAÇÃO COM VERIFICAÇÃO DE INTEGRIDADE
// ============================================================
function gunzipFile(source, dest) {
    return new Promise((resolve, reject) => {
        if (!isGzipFile(source)) {
            return reject(new Error('Arquivo baixado nao e um GZIP valido. Verifique o token e o limite diario.'));
        }
        fs.createReadStream(source)
            .pipe(zlib.createGunzip())
            .on('error', (e) => reject(new Error('Erro ao descompactar: ' + e.message)))
            .pipe(fs.createWriteStream(dest))
            .on('finish', resolve)
            .on('error', reject);
    });
}

// ============================================================
// PIPELINE PRINCIPAL
// ============================================================
async function main() {
    log('=== PIPELINE DE IMPORTACAO (v4 ROBUSTA) ===');
    log('Data: ' + new Date().toISOString());

    if (!API_KEY) {
        log('ERRO: Token OpenCellID nao configurado. Abortando.');
        process.exit(1);
    }

    // Remove banco antigo
    if (fs.existsSync(DB_PATH)) {
        log('Removendo banco antigo...');
        try { fs.unlinkSync(DB_PATH); } catch (e) {
            log('ERRO ao remover banco antigo: ' + e.message);
            process.exit(1);
        }
    }

    // Cria banco e tabela
    const db = new sqlite3.Database(DB_PATH);
    db.run(`CREATE TABLE cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);
    log('Banco e tabela criados.');

    // Verifica se a tabela existe
    const tableOk = await new Promise((resolve) => {
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_towers'", (err, row) => resolve(!!row));
    });
    if (!tableOk) {
        log('ERRO FATAL: Tabela nao foi criada.');
        db.close();
        process.exit(1);
    }

    // Performance
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=OFF');

    const url = 'https://opencellid.org/ocid/downloads?token=' + API_KEY + '&type=full&file=cell_towers.csv.gz';
    const gzPath = path.join(TEMP_DIR, 'full.csv.gz');
    const csvPath = path.join(TEMP_DIR, 'full.csv');

    try {
        // Download
        log('Baixando dataset...');
        await downloadFile(url, gzPath);
        log('Download concluido. Tamanho: ' + (fs.statSync(gzPath).size / 1024 / 1024).toFixed(1) + ' MB');

        // Descompacta
        log('Descompactando...');
        await gunzipFile(gzPath, csvPath);
        log('Descompactacao concluida.');

        // Importa
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

        // Índices
        log('Criando indices...');
        db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
        db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
        db.run('ANALYZE cell_towers');
        log('Indices criados.');

        // Limpa temp
        try { fs.unlinkSync(gzPath); } catch (e) {}
        try { fs.unlinkSync(csvPath); } catch (e) {}

        log('✅ Importacao concluida com sucesso!');
        db.close();
        process.exit(0);

    } catch (err) {
        log('❌ ERRO: ' + err.message);
        log('Possiveis causas:');
        log('  1. Token OpenCellID invalido ou limite diario excedido.');
        log('  2. Sem conectividade com opencellid.org.');
        log('  3. Arquivo corrompido durante o download.');
        log('O servidor iniciara sem banco de torres.');
        log('Tente novamente em 24 horas ou verifique o token.');

        // Limpa arquivos temporarios
        try { fs.unlinkSync(gzPath); } catch (e) {}
        try { fs.unlinkSync(csvPath); } catch (e) {}

        db.close();
        process.exit(1);
    }
}

main();
