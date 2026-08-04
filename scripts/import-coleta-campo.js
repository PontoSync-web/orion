// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// VERSÃO: 3.2 (Processa todos os arquivos, stream + lote)
// DATA: 04/08/2026
// MOTIVO: Remove dependência de arquivo específico.
//         Processa todos os coleta_campo*.csv.
//         Sem filtro de asterisco.
// ============================================================

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');

function log(msg) {
    console.log(`[COLETA-CAMPO] ${msg}`);
}

function processarArquivoStream(db, filePath, batchSize = 5000) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath),
            crlfDelay: Infinity
        });

        let importadas = 0;
        let ignoradas = 0;
        let isHeader = true;
        let linhasBuffer = [];
        let separator = ',';

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO cell_towers 
            (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let inTransaction = false;

        const flushBuffer = () => {
            if (linhasBuffer.length === 0) return;
            try {
                if (!inTransaction) {
                    db.run('BEGIN TRANSACTION');
                    inTransaction = true;
                }
                for (const params of linhasBuffer) {
                    stmt.run(params);
                }
                db.run('COMMIT');
                inTransaction = false;
                importadas += linhasBuffer.length;
                linhasBuffer = [];
            } catch (err) {
                if (inTransaction) {
                    db.run('ROLLBACK');
                    inTransaction = false;
                }
                throw err;
            }
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                ignoradas++;
                return;
            }

            if (isHeader) {
                separator = trimmed.includes(';') ? ';' : ',';
                const lower = trimmed.toLowerCase();
                if (lower.includes('cell') || lower.includes('lat') || lower.includes('lon')) {
                    isHeader = false;
                    return;
                }
                isHeader = false;
            }

            const cols = trimmed.split(separator);
            if (cols.length < 3) {
                ignoradas++;
                return;
            }

            let cellId = null, lat = null, lon = null;

            // Tenta as três primeiras colunas
            const testCell = parseInt(cols[0]);
            const testLat = parseFloat(cols[1]);
            const testLon = parseFloat(cols[2]);
            if (!isNaN(testCell) && testCell > 0 && !isNaN(testLat) && !isNaN(testLon)) {
                cellId = testCell;
                lat = testLat;
                lon = testLon;
            } else {
                // Varre todas as colunas
                let candidates = cols.map((v, idx) => ({ val: v.trim(), idx }));
                for (let c of candidates) {
                    const num = parseFloat(c.val);
                    if (!isNaN(num)) {
                        if (Number.isInteger(num) && num > 0 && cellId === null && num < 1000000000) {
                            cellId = num;
                        } else if (num >= -90 && num <= 90 && lat === null) {
                            lat = num;
                        } else if (num >= -180 && num <= 180 && lon === null) {
                            lon = num;
                        }
                    }
                }
                if (lat === null || lon === null) {
                    let nums = [];
                    for (let c of candidates) {
                        const num = parseFloat(c.val);
                        if (!isNaN(num)) nums.push({ num, idx: c.idx });
                    }
                    nums.sort((a, b) => a.idx - b.idx);
                    for (let n of nums) {
                        if (n.num !== cellId) {
                            if (lat === null && n.num >= -90 && n.num <= 90) lat = n.num;
                            else if (lon === null && n.num >= -180 && n.num <= 180) lon = n.num;
                        }
                    }
                }
            }

            if (cellId === null || lat === null || lon === null) {
                ignoradas++;
                return;
            }

            let range = 1500;
            if (cols.length > 3) {
                const r = parseInt(cols[3]);
                if (!isNaN(r) && r > 0) range = r;
            }

            let mcc = 724, mnc = 5, lac = 1234;
            for (let c of cols) {
                const num = parseInt(c);
                if (!isNaN(num)) {
                    if (num >= 100 && num <= 999 && mcc === 724) mcc = num;
                    else if (num >= 1 && num <= 99 && mnc === 5) mnc = num;
                    else if (num >= 1 && num <= 65535 && lac === 1234) lac = num;
                }
            }

            const params = [
                'GSM',
                mcc,
                mnc,
                lac,
                cellId,
                0,
                lon,
                lat,
                range,
                100,
                1,
                Math.floor(Date.now() / 1000),
                Math.floor(Date.now() / 1000),
                -71
            ];

            linhasBuffer.push(params);
            if (linhasBuffer.length >= batchSize) {
                flushBuffer();
            }
        });

        rl.on('close', () => {
            try {
                flushBuffer();
                stmt.finalize();
                resolve({ importadas, ignoradas });
            } catch (err) {
                reject(err);
            }
        });

        rl.on('error', (err) => {
            if (inTransaction) db.run('ROLLBACK');
            reject(err);
        });
    });
}

async function main() {
    log('=== IMPORTADOR DE DADOS (STREAM + LOTE) ===');
    log('Processando TODOS os arquivos coleta_campo*.csv');

    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('coleta_campo'));
    log(`Encontrados ${files.length} arquivos.`);

    if (files.length === 0) {
        log('Nenhum arquivo encontrado. Abortando.');
        process.exit(0);
    }

    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA secure_delete=ON');
    db.run(`
        CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER
        )
    `);

    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`Torres antes: ${antes}`);

    let totalImportadas = 0;
    let totalIgnoradas = 0;

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        log(`Processando: ${file}...`);
        try {
            const result = await processarArquivoStream(db, filePath);
            log(`  -> ${result.importadas} importadas, ${result.ignoradas} ignoradas.`);
            totalImportadas += result.importadas;
            totalIgnoradas += result.ignoradas;
        } catch (err) {
            log(`  ERRO: ${err.message}`);
        }
    }

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`=== IMPORTAÇÃO CONCLUÍDA ===`);
    log(`Antes: ${antes}`);
    log(`Depois: ${depois}`);
    log(`Total importadas: ${totalImportadas}`);
    log(`Total ignoradas: ${totalIgnoradas}`);

    db.close();
}

main().catch(err => {
    console.error('[COLETA-CAMPO] ERRO FATAL:', err.message);
    process.exit(1);
});
