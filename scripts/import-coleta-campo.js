// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// VERSÃO: 3.0 (Stream + Lotes)
// DATA: 04/08/2026
// MOTIVO: Processa arquivo por arquivo via stream, sem 
//         carregar tudo em memória. Usa transações em lote.
//         Processa APENAS o arquivo alvo (coleta_campo - Copia-039.csv)
//         se existir, ou todos se nenhum alvo especificado.
// ============================================================

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');

// Arquivo alvo – pode ser definido por variável de ambiente
// ou nome fixo para priorizar o arquivo do investigador.
const TARGET_FILE = process.env.IMPORT_TARGET || 'coleta_campo - Copia-039.csv';

function log(msg) {
    console.log(`[COLETA-CAMPO] ${msg}`);
}

/**
 * Processa um único arquivo CSV usando stream e insere em lotes.
 * @param {sqlite3.Database} db - Conexão com o banco.
 * @param {string} filePath - Caminho do CSV.
 * @param {string} fileName - Nome do arquivo (para log).
 * @param {number} batchSize - Quantas linhas por transação.
 * @returns {Promise<{importadas: number, ignoradas: number}>}
 */
function processarArquivoStream(db, filePath, fileName, batchSize = 5000) {
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

        // Preparar statement
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO cell_towers 
            (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const flushBuffer = () => {
            if (linhasBuffer.length === 0) return;
            db.run('BEGIN TRANSACTION');
            for (const params of linhasBuffer) {
                stmt.run(params);
            }
            db.run('COMMIT');
            importadas += linhasBuffer.length;
            linhasBuffer = [];
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                ignoradas++;
                return;
            }

            // Detecta separador na primeira linha que não estiver vazia
            if (isHeader) {
                separator = trimmed.includes(';') ? ';' : ',';
                // Pula cabeçalho se contiver palavras-chave
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

            // Extrair cell, lat, lon (mesma lógica de detecção robusta)
            let cellId = null, lat = null, lon = null;

            // Primeiro tenta as três primeiras colunas
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
                // Se ainda faltar, pega os dois primeiros números restantes
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

            // Range
            let range = 1500;
            if (cols.length > 3) {
                const r = parseInt(cols[3]);
                if (!isNaN(r) && r > 0) range = r;
            }

            // MCC/MNC/LAC (opcional)
            let mcc = 724, mnc = 5, lac = 1234;
            for (let c of cols) {
                const num = parseInt(c);
                if (!isNaN(num)) {
                    if (num >= 100 && num <= 999 && mcc === 724) mcc = num;
                    else if (num >= 1 && num <= 99 && mnc === 5) mnc = num;
                    else if (num >= 1 && num <= 65535 && lac === 1234) lac = num;
                }
            }

            // Monta os parâmetros
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
            flushBuffer(); // último lote
            stmt.finalize();
            resolve({ importadas, ignoradas });
        });

        rl.on('error', (err) => {
            reject(err);
        });
    });
}

async function main() {
    log('=== IMPORTADOR DE DADOS (STREAM + LOTE) ===');
    log(`Arquivo alvo: ${TARGET_FILE}`);

    // Lista todos os arquivos que começam com 'coleta_campo'
    let allFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('coleta_campo'));
    log(`Encontrados ${allFiles.length} arquivos.`);

    // Se o arquivo alvo existir, processa apenas ele
    let filesToProcess = [];
    if (allFiles.includes(TARGET_FILE)) {
        filesToProcess = [TARGET_FILE];
        log(`Processando apenas o arquivo alvo: ${TARGET_FILE}`);
    } else {
        log(`Arquivo alvo não encontrado. Processando todos os ${allFiles.length} arquivos.`);
        filesToProcess = allFiles;
    }

    // Abre o banco de dados
    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA secure_delete=ON');
    // Cria a tabela se não existir
    db.run(`
        CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER
        )
    `);

    // Contagem antes
    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`Torres antes: ${antes}`);

    let totalImportadas = 0;
    let totalIgnoradas = 0;

    for (const file of filesToProcess) {
        const filePath = path.join(DATA_DIR, file);
        log(`Processando: ${file}...`);
        try {
            const result = await processarArquivoStream(db, filePath, file);
            log(`  -> ${result.importadas} importadas, ${result.ignoradas} ignoradas.`);
            totalImportadas += result.importadas;
            totalIgnoradas += result.ignoradas;
        } catch (err) {
            log(`  ERRO ao processar ${file}: ${err.message}`);
        }
    }

    // Depois
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
