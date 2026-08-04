// ============================================================
// ARQUIVO: scripts/import-teleco.js
// VERSÃO: 1.0
// DATA: 04/08/2026
// MOTIVO: Importar base nacional de ERBs da Teleco/Anatel
// ============================================================

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');

// Nome padrão do arquivo – pode ser alterado via variável de ambiente
const FILE_NAME = process.env.TELECO_FILE || 'erbs_brasil.csv';

function log(msg) {
    console.log(`[IMPORT-TELECO] ${msg}`);
}

async function importarArquivo(db, filePath, batchSize = 1000) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath, { encoding: 'utf8' }),
            crlfDelay: Infinity
        });

        let importadas = 0;
        let ignoradas = 0;
        let isHeader = true;
        let linhasBuffer = [];
        let separator = ';';

        const flushBuffer = () => {
            if (linhasBuffer.length === 0) return;
            const values = linhasBuffer.map(p =>
                `('${p[0]}', ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, ${p[6]}, ${p[7]}, ${p[8]}, ${p[9]}, ${p[10]}, ${p[11]}, ${p[12]}, ${p[13]})`
            ).join(',');
            const query = `INSERT OR REPLACE INTO cell_towers (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal) VALUES ${values};`;
            try {
                db.exec('BEGIN TRANSACTION;');
                db.exec(query);
                db.exec('COMMIT;');
                importadas += linhasBuffer.length;
                linhasBuffer = [];
            } catch (err) {
                try { db.exec('ROLLBACK;'); } catch (e) {}
                log(`  ERRO no lote: ${err.message}`);
                ignoradas += linhasBuffer.length;
                linhasBuffer = [];
            }
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            if (isHeader) {
                if (trimmed.includes(';')) separator = ';';
                else if (trimmed.includes(',')) separator = ',';
                const lower = trimmed.toLowerCase();
                if (lower.includes('cell') || lower.includes('lat') || lower.includes('lon') || lower.includes('latitude') || lower.includes('erbid')) {
                    isHeader = false;
                    return;
                }
                isHeader = false;
            }

            const cols = trimmed.split(separator);
            let cellId = parseInt(cols[0]);
            let lat = parseFloat(cols[1]);
            let lon = parseFloat(cols[2]);

            if (isNaN(cellId) || isNaN(lat) || isNaN(lon)) {
                let nums = [];
                for (let i = 0; i < cols.length; i++) {
                    const num = parseFloat(cols[i]);
                    if (!isNaN(num)) nums.push({ val: num, idx: i });
                }
                nums.sort((a, b) => a.idx - b.idx);
                for (let n of nums) {
                    if (Number.isInteger(n.val) && n.val > 0 && n.val < 1000000000) {
                        cellId = n.val;
                        break;
                    }
                }
                let latCandidates = nums.filter(n => n.val >= -90 && n.val <= 90);
                let lonCandidates = nums.filter(n => n.val >= -180 && n.val <= 180);
                if (latCandidates.length >= 1 && lonCandidates.length >= 1) {
                    lat = latCandidates[0].val;
                    lon = lonCandidates[0].val;
                }
            }

            if (isNaN(cellId) || isNaN(lat) || isNaN(lon)) {
                ignoradas++;
                return;
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

            let range = 1500;
            for (let c of cols) {
                const r = parseInt(c);
                if (!isNaN(r) && r > 0 && r < 50000) range = r;
            }

            const params = [
                'LTE',
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
            flushBuffer();
            resolve({ importadas, ignoradas });
        });

        rl.on('error', (err) => {
            reject(err);
        });
    });
}

async function main() {
    log('=== IMPORTADOR DE ERBs (TELECO/ANATEL) ===');
    const files = fs.readdirSync(DATA_DIR).filter(f => f === FILE_NAME);
    if (files.length === 0) {
        log(`Arquivo "${FILE_NAME}" não encontrado em ${DATA_DIR}.`);
        log('Baixe o arquivo da Teleco e coloque-o com esse nome.');
        process.exit(1);
    }

    const filePath = path.join(DATA_DIR, files[0]);
    log(`Processando: ${files[0]}`);

    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA secure_delete=ON');

    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
        range INTEGER, samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`, (err) => {
        if (err) {
            log('Erro ao criar tabela: ' + err.message);
            db.close();
            process.exit(1);
        }
    });

    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`Torres antes: ${antes}`);

    const result = await importarArquivo(db, filePath);

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`=== IMPORTAÇÃO CONCLUÍDA ===`);
    log(`Antes: ${antes}`);
    log(`Depois: ${depois}`);
    log(`Importadas: ${result.importadas}`);
    log(`Ignoradas: ${result.ignoradas}`);

    db.close();
}

main().catch(err => {
    console.error('[IMPORT-TELECO] ERRO:', err.message);
    process.exit(1);
});
