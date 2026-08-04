// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// VERSÃO: 2.1 (Corrigida – sem filtro de asterisco)
// DATA: 04/08/2026
// MOTIVO: Removeu a lógica que descartava linhas com "*".
//         Agora descarta apenas cabeçalhos e linhas vazias.
//         Detecta separador automaticamente (; ou ,).
// ============================================================

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');

function log(msg) {
    console.log(`[COLETA-CAMPO] ${msg}`);
}

/**
 * Processa um único arquivo CSV e insere as torres no banco de dados.
 * @param {sqlite3.Database} db - Conexão com o banco cell_towers.db
 * @param {string} filePath - Caminho completo do arquivo CSV
 * @returns {Promise<{importadas: number, ignoradas: number}>}
 */
function processarArquivo(db, filePath) {
    return new Promise((resolve) => {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        let importadas = 0;
        let ignoradas = 0;

        if (lines.length === 0) {
            resolve({ importadas, ignoradas });
            return;
        }

        // Detecta o separador: se a primeira linha tiver ';' usa ponto-e-vírgula, senão vírgula
        const firstLine = lines[0] || '';
        const separator = firstLine.includes(';') ? ';' : ',';

        // Pula cabeçalho se a primeira linha parecer cabeçalho (contém 'cell', 'lat', etc.)
        let startIndex = 0;
        const lower = firstLine.toLowerCase();
        if (lower.includes('cell') || lower.includes('lat') || lower.includes('lon') || lower.includes('longitude')) {
            startIndex = 1;
            log(`  (cabeçalho identificado, pulando linha 1)`);
        }

        // Prepara a instrução SQL
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO cell_towers 
            (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                ignoradas++;
                continue;
            }

            const cols = line.split(separator);
            if (cols.length < 3) {
                ignoradas++;
                continue;
            }

            // Tenta extrair cellId, lat, lon
            // Estratégia: procurar números em cada coluna
            let cellId = null;
            let lat = null;
            let lon = null;

            // Primeiro, tenta interpretar as três primeiras colunas como [cell, lat, lon]
            const testCell = parseInt(cols[0]);
            const testLat = parseFloat(cols[1]);
            const testLon = parseFloat(cols[2]);

            if (!isNaN(testCell) && testCell > 0 && !isNaN(testLat) && !isNaN(testLon)) {
                cellId = testCell;
                lat = testLat;
                lon = testLon;
            } else {
                // Se falhar, varre todas as colunas para encontrar um número que possa ser cell, lat, lon
                // Identifica cell: número inteiro > 0
                // Identifica lat: número entre -90 e 90
                // Identifica lon: número entre -180 e 180
                let candidates = cols.map((v, idx) => ({ val: v.trim(), idx }));
                for (let c of candidates) {
                    const num = parseFloat(c.val);
                    if (!isNaN(num)) {
                        if (Number.isInteger(num) && num > 0 && cellId === null) {
                            // Pode ser cellId
                            // Verifica se não é um código de área (lac) ou mcc
                            if (num < 1000000000) {
                                cellId = num;
                            }
                        } else if (num >= -90 && num <= 90 && lat === null) {
                            lat = num;
                        } else if (num >= -180 && num <= 180 && lon === null) {
                            lon = num;
                        }
                    }
                }
                // Se ainda não encontrou lat/lon, tenta as duas primeiras colunas numéricas (fora cell)
                if (lat === null || lon === null) {
                    let nums = [];
                    for (let c of candidates) {
                        const num = parseFloat(c.val);
                        if (!isNaN(num)) nums.push({ num, idx: c.idx });
                    }
                    // Ordena por índice
                    nums.sort((a, b) => a.idx - b.idx);
                    // Pega os dois primeiros que não sejam cellId
                    for (let n of nums) {
                        if (n.num !== cellId) {
                            if (lat === null && n.num >= -90 && n.num <= 90) lat = n.num;
                            else if (lon === null && n.num >= -180 && n.num <= 180) lon = n.num;
                        }
                    }
                }
            }

            // Se ainda não temos todos os dados, ignora
            if (cellId === null || lat === null || lon === null) {
                ignoradas++;
                continue;
            }

            // Extrai range (opcional) – tenta a quarta coluna
            let range = 1500;
            if (cols.length > 3) {
                const r = parseInt(cols[3]);
                if (!isNaN(r) && r > 0) range = r;
            }

            // MCC e MNC padrão (724/5) – podem ser extraídos de outras colunas se existirem
            let mcc = 724;
            let mnc = 5;
            let lac = 1234;
            // Tenta encontrar mcc, mnc, lac entre as colunas
            for (let c of cols) {
                const num = parseInt(c);
                if (!isNaN(num)) {
                    if (num >= 100 && num <= 999 && mcc === 724) mcc = num;
                    else if (num >= 1 && num <= 99 && mnc === 5) mnc = num;
                    else if (num >= 1 && num <= 65535 && lac === 1234) lac = num;
                }
            }

            // Insere no banco
            stmt.run(
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
            );
            importadas++;
        }

        stmt.finalize();
        resolve({ importadas, ignoradas });
    });
}

/**
 * Função principal
 */
async function main() {
    log('=== IMPORTADOR DE DADOS (CORRIGIDO – SEM FILTRO DE *) ===');
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('coleta_campo'));
    log(`Encontrados ${files.length} arquivos.`);

    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA secure_delete=ON');

    // Contagem antes
    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log(`Torres antes: ${antes}`);

    let totalImportadas = 0;
    let totalIgnoradas = 0;

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        log(`Processando: ${file}...`);
        const result = await processarArquivo(db, filePath);
        log(`  -> ${result.importadas} importadas, ${result.ignoradas} ignoradas.`);
        totalImportadas += result.importadas;
        totalIgnoradas += result.ignoradas;
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
    console.error('[COLETA-CAMPO] ERRO:', err.message);
    process.exit(1);
});
