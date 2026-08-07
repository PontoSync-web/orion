/**
 * ARQUIVO: scripts/import-coleta-campo.js
 * VERSÃO: 2.0.0
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-07 21:30:00 (UTC)
 * COMENTÁRIO: Importador universal que processa todos os CSVs relevantes no diretório data/.
 *             Suporta Anatel (Estacoes_Licenciadas_SMP*, anatel_smp_nacional*),
 *             OpenCellID (coleta_campo*), consolidado (erb_consolidado_final.csv),
 *             e qualquer outro que contenha colunas de torres.
 * AUTOR: Equipe ORION
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');

// Mapeamento de sinônimos para cada campo do banco
const COLUMN_MAP = {
    radio: ['radio', 'RADIO', 'tecnologias', 'Tecnologias'],
    mcc: ['mcc', 'MCC', 'opencellid_mcc', 'codigo_operadora', 'Código da UF'],
    net: ['net', 'NET', 'mnc', 'MNC', 'opencellid_net', 'operadora', 'Operadora'],
    area: ['area', 'AREA', 'lac', 'LAC', 'opencellid_area', 'codigo_municipio_ibge', 'Código do Município'],
    cell: ['cell', 'CELL', 'ci', 'CI', 'opencellid_cell', 'id_estacao', 'Número da Estação'],
    unit: ['unit', 'UNIT'],
    lon: ['lon', 'LON', 'longitude', 'LONGITUDE', 'Longitude'],
    lat: ['lat', 'LAT', 'latitude', 'LATITUDE', 'Latitude'],
    range: ['range', 'RANGE', 'opencellid_range'],
    samples: ['samples', 'SAMPLES', 'opencellid_samples'],
    changeable: ['changeable', 'CHANGEABLE'],
    created: ['created', 'CREATED'],
    updated: ['updated', 'UPDATED'],
    averageSignal: ['averageSignal', 'AVERAGESIGNAL', 'opencellid_averagesignal']
};

function findColumn(headers, synonyms) {
    for (const syn of synonyms) {
        const found = headers.find(h => h.trim().toLowerCase() === syn.toLowerCase());
        if (found) return found;
    }
    return null;
}

/**
 * Importa todos os arquivos CSV que correspondem a padrões conhecidos.
 * @param {sqlite3.Database} db - Conexão com o banco (opcional)
 * @returns {Promise<number>} - Total de registros inseridos
 */
async function importarTodosCSVs(db = null) {
    const closeDb = !db;
    if (!db) {
        db = new sqlite3.Database(DB_PATH);
        db.run('PRAGMA journal_mode=WAL');
    }

    // Cria tabela se não existir
    await new Promise((resolve, reject) => {
        db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER
        )`, (err) => { if (err) reject(err); else resolve(); });
    });

    // Padrões de arquivos a considerar
    const patterns = [
        /^coleta_campo.*\.csv$/i,
        /^Estacoes_Licenciadas_SMP.*\.csv$/i,
        /^anatel_smp_nacional.*\.csv$/i,
        /^erb_consolidado_final\.csv$/i
    ];

    const files = fs.readdirSync(DATA_DIR)
        .filter(f => patterns.some(p => p.test(f)));

    if (files.length === 0) {
        console.log('[IMPORT-UNIVERSAL] Nenhum arquivo CSV compatível encontrado.');
        if (closeDb) db.close();
        return 0;
    }

    console.log(`[IMPORT-UNIVERSAL] Encontrados ${files.length} arquivos:`, files);

    let totalInseridos = 0;
    const stmt = db.prepare(`INSERT OR REPLACE INTO cell_towers 
        (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        console.log(`[IMPORT-UNIVERSAL] Processando ${file}...`);

        let count = 0;
        let headers = null;
        let columnCache = {};

        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
                .pipe(csv({
                    separator: ',',
                    mapHeaders: ({ header }) => header.trim()
                }))
                .on('headers', (headerList) => {
                    headers = headerList;
                    for (const [field, synonyms] of Object.entries(COLUMN_MAP)) {
                        const col = findColumn(headers, synonyms);
                        if (col) columnCache[field] = col;
                    }
                    console.log(`[IMPORT-UNIVERSAL] Mapeamento para ${file}:`, columnCache);
                })
                .on('data', (row) => {
                    const get = (field) => {
                        const col = columnCache[field];
                        return col ? row[col] : undefined;
                    };

                    const campos = {
                        radio: get('radio') || '',
                        mcc: parseInt(get('mcc') || 0),
                        net: parseInt(get('net') || 0),
                        area: parseInt(get('area') || 0),
                        cell: parseInt(get('cell') || 0),
                        unit: parseInt(get('unit') || 0),
                        lon: parseFloat(get('lon') || 0),
                        lat: parseFloat(get('lat') || 0),
                        range: parseInt(get('range') || 500),
                        samples: parseInt(get('samples') || 1),
                        changeable: parseInt(get('changeable') || 1),
                        created: parseInt(get('created') || Math.floor(Date.now()/1000)),
                        updated: parseInt(get('updated') || Math.floor(Date.now()/1000)),
                        averageSignal: parseInt(get('averageSignal') || -70)
                    };

                    // Validação mínima
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
                    console.log(`[IMPORT-UNIVERSAL] ${file} → ${count} registros.`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`[IMPORT-UNIVERSAL] Erro em ${file}:`, err.message);
                    resolve(); // continua com o próximo
                });
        });
    }

    stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');

    if (closeDb) db.close();
    return totalInseridos;
}

// Execução direta
if (require.main === module) {
    importarTodosCSVs()
        .then(total => {
            console.log(`[IMPORT-UNIVERSAL] Importação concluída. Total: ${total} registros.`);
            process.exit(0);
        })
        .catch(err => {
            console.error('[IMPORT-UNIVERSAL] Erro fatal:', err);
            process.exit(1);
        });
}

module.exports = { importarTodosCSVs };
