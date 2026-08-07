/**
 * ARQUIVO: scripts/import-coleta-campo.js
 * VERSÃO: 1.1.0
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-07 14:30:00 (UTC)
 * COMENTÁRIO: Exporta função 'processarArquivosColeta' para ser chamada pelo orion.js.
 *             Aceita conexão de banco existente (reutilizável).
 *             Mapeamento flexível de colunas (aceita variações de nomes).
 *             Processa todos os arquivos coleta_campo*.csv do diretório data/.
 * AUTOR: Equipe ORION
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');

/**
 * Processa todos os arquivos CSV com padrão "coleta_campo*.csv"
 * e insere os dados no banco de torres.
 * @param {sqlite3.Database} db - Conexão com o banco (opcional, se não fornecido, abre internamente)
 * @returns {Promise<number>} - Número total de registros inseridos
 */
async function processarArquivosColeta(db = null) {
    const closeDb = !db;
    if (!db) {
        db = new sqlite3.Database(DB_PATH);
        db.run('PRAGMA journal_mode=WAL');
    }

    // Garantir que a tabela existe
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER
        )`, (err) => { if (err) reject(err); else resolve(); });
    });

    // Listar arquivos
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('coleta_campo') && f.endsWith('.csv'));

    if (files.length === 0) {
        console.log('[IMPORT-CAMP] Nenhum arquivo de coleta de campo encontrado.');
        if (closeDb) db.close();
        return 0;
    }

    console.log(`[IMPORT-CAMP] Encontrados ${files.length} arquivos:`, files);

    let totalInseridos = 0;
    const stmt = db.prepare(`INSERT OR REPLACE INTO cell_towers 
        (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    // Processar cada arquivo sequencialmente
    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        console.log(`[IMPORT-CAMP] Processando ${file}...`);

        let count = 0;
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath)
                .pipe(csv({
                    separator: ',',
                    mapHeaders: ({ header }) => header.trim()
                }))
                .on('data', (row) => {
                    // Mapeamento flexível de colunas
                    const campos = {
                        radio: row.radio || row.RADIO || '',
                        mcc: parseInt(row.mcc || row.MCC || 0),
                        net: parseInt(row.net || row.NET || row.mnc || row.MNC || 0),
                        area: parseInt(row.area || row.AREA || row.lac || row.LAC || 0),
                        cell: parseInt(row.cell || row.CELL || row.ci || row.CI || 0),
                        unit: parseInt(row.unit || row.UNIT || 0),
                        lon: parseFloat(row.lon || row.LON || row.longitude || row.LONGITUDE || 0),
                        lat: parseFloat(row.lat || row.LAT || row.latitude || row.LATITUDE || 0),
                        range: parseInt(row.range || row.RANGE || 500),
                        samples: parseInt(row.samples || row.SAMPLES || 1),
                        changeable: parseInt(row.changeable || row.CHANGEABLE || 1),
                        created: parseInt(row.created || row.CREATED || Math.floor(Date.now()/1000)),
                        updated: parseInt(row.updated || row.UPDATED || Math.floor(Date.now()/1000)),
                        averageSignal: parseInt(row.averageSignal || row.AVERAGESIGNAL || -70)
                    };

                    if (campos.cell && campos.lat && campos.lon) {
                        stmt.run(
                            campos.radio, campos.mcc, campos.net, campos.area,
                            campos.cell, campos.unit, campos.lon, campos.lat,
                            campos.range, campos.samples, campos.changeable,
                            campos.created, campos.updated, campos.averageSignal
                        );
                        count++;
                        totalInseridos++;
                    }
                })
                .on('end', () => {
                    console.log(`[IMPORT-CAMP] ${file} → ${count} registros.`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`[IMPORT-CAMP] Erro no arquivo ${file}:`, err.message);
                    resolve(); // continua com o próximo
                });
        });
    }

    stmt.finalize();
    // Criar índice
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');

    if (closeDb) db.close();
    return totalInseridos;
}

// Execução direta (se chamado como script)
if (require.main === module) {
    processarArquivosColeta()
        .then(total => {
            console.log(`[IMPORT-CAMP] Importação concluída. Total: ${total} registros.`);
            process.exit(0);
        })
        .catch(err => {
            console.error('[IMPORT-CAMP] Erro fatal:', err);
            process.exit(1);
        });
}

module.exports = { processarArquivosColeta };
