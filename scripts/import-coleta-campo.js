/**
 * ARQUIVO: scripts/import-coleta-campo.js
 * VERSÃO: 2.1.2
 * ÚLTIMA ATUALIZAÇÃO: 2026-08-09 (patch)
 * COMENTÁRIO: Padrão de reconhecimento ampliado para erb_consolidado_final*
 *             (permite partes com sufixo). Mapeamento estendido para coleta_campo.
 *             Limite de registros e ignora arquivos > 100 MB.
 *             [PATCH 1] Schema com PRIMARY KEY composta (mcc, net, area, cell) —
 *             evita colisão/sobrescrita entre operadoras e fontes diferentes.
 *             [PATCH 2] Arquivos coleta_campo* não têm linha de cabeçalho — antes,
 *             a 1ª linha de dados era lida como header, zerando o mapeamento.
 *             Agora esses arquivos usam headers explícitos na ordem do schema.
 * AUTOR: Equipe ORION
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');

// [PATCH 2] Ordem de colunas dos arquivos coleta_campo (sem cabeçalho no arquivo)
const COLETA_CAMPO_HEADERS = [
    'radio', 'mcc', 'net', 'area', 'cell', 'unit', 'lon', 'lat',
    'range', 'samples', 'changeable', 'created', 'updated', 'averageSignal'
];

// Mapeamento de sinônimos (ampliado)
const COLUMN_MAP = {
    radio: ['radio', 'RADIO', 'tecnologias', 'Tecnologias', 'sistemas'],
    mcc: ['mcc', 'MCC', 'opencellid_mcc', 'codigo_operadora', 'Código da UF', 'cod_uf'],
    net: ['net', 'NET', 'mnc', 'MNC', 'opencellid_net', 'operadora', 'Operadora'],
    area: ['area', 'AREA', 'lac', 'LAC', 'opencellid_area', 'codigo_municipio_ibge', 'Código do Município', 'cod_municipio'],
    cell: ['cell', 'CELL', 'ci', 'CI', 'opencellid_cell', 'id_estacao', 'Número da Estação', 'CellID', 'cell_id', 'estacao'],
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
 * Importa todos os CSVs compatíveis, com limite de registros e ignorando arquivos grandes.
 * @param {sqlite3.Database} db - Conexão com o banco (opcional)
 * @param {Object} options - { maxRegistros: número máximo de registros a inserir }
 * @returns {Promise<number>} - Total inserido
 */
async function importarTodosCSVs(db = null, options = { maxRegistros: 500000 }) {
    const closeDb = !db;
    if (!db) {
        db = new sqlite3.Database(DB_PATH);
        db.run('PRAGMA journal_mode=WAL');
    }

    await new Promise((resolve, reject) => {
        // [PATCH 1] PRIMARY KEY composta — ver comentário no topo do arquivo.
        db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
            radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
            cell INTEGER, unit INTEGER, lon REAL, lat REAL,
            range INTEGER, samples INTEGER, changeable INTEGER,
            created INTEGER, updated INTEGER, averageSignal INTEGER,
            PRIMARY KEY (mcc, net, area, cell)
        )`, (err) => { if (err) reject(err); else resolve(); });
    });

    // Padrões de arquivos (modificado para aceitar erb_consolidado_final*)
    const patterns = [
        /^coleta_campo.*\.csv$/i,
        /^Estacoes_Licenciadas_SMP.*\.csv$/i,
        /^anatel_smp_nacional.*\.csv$/i,
        /^erb_consolidado_final.*\.csv$/i   // <- aceita partes com sufixo
    ];

    // Filtra e ignora arquivos > 100 MB
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => patterns.some(p => p.test(f)))
        .filter(f => {
            const size = fs.statSync(path.join(DATA_DIR, f)).size;
            if (size > 100 * 1024 * 1024) {
                console.log(`[IMPORT-UNIVERSAL] Ignorando ${f} (tamanho ${(size/1024/1024).toFixed(1)} MB > 100 MB)`);
                return false;
            }
            return true;
        });

    if (files.length === 0) {
        console.log('[IMPORT-UNIVERSAL] Nenhum arquivo CSV compatível encontrado.');
        if (closeDb) db.close();
        return 0;
    }

    console.log(`[IMPORT-UNIVERSAL] Processando ${files.length} arquivos:`, files);

    let totalInseridos = 0;
    const stmt = db.prepare(`INSERT OR REPLACE INTO cell_towers 
        (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const file of files) {
        if (totalInseridos >= options.maxRegistros) {
            console.log(`[IMPORT-UNIVERSAL] Limite de ${options.maxRegistros} registros atingido. Parando.`);
            break;
        }

        const filePath = path.join(DATA_DIR, file);
        console.log(`[IMPORT-UNIVERSAL] Processando ${file}...`);

        // [PATCH 2] coleta_campo* não tem linha de cabeçalho no arquivo.
        // Passar "headers" explícito diz ao csv-parser pra NÃO consumir a
        // primeira linha como nome de coluna, e usar esses nomes fixos —
        // que já batem direto com o COLUMN_MAP (radio, mcc, net, area, cell...).
        const isColetaCampo = /^coleta_campo/i.test(file);

        let count = 0;
        let headers = null;
        let columnCache = {};

        await new Promise((resolve, reject) => {
            const csvOptions = isColetaCampo
                ? {
                    separator: ',',
                    headers: COLETA_CAMPO_HEADERS,
                    mapHeaders: ({ header }) => header.trim()
                }
                : {
                    separator: ',',
                    mapHeaders: ({ header }) => header.trim()
                };

            const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
                .pipe(csv(csvOptions))
                .on('headers', (headerList) => {
                    headers = headerList;
                    for (const [field, synonyms] of Object.entries(COLUMN_MAP)) {
                        const col = findColumn(headers, synonyms);
                        if (col) columnCache[field] = col;
                    }
                    console.log(`[IMPORT-UNIVERSAL] Mapeamento para ${file}:`, columnCache);
                })
                .on('data', (row) => {
                    if (totalInseridos >= options.maxRegistros) return;
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
                    resolve();
                });
        });
    }

    stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');

    if (closeDb) db.close();
    return totalInseridos;
}

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
