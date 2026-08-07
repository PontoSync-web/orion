// scripts/importar-todas-erbs.js
// ORION - Importador Múltiplo de ERBs
// Processa todos os arquivos CSV da pasta data/ e consolida em um único banco

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { sequelize, ERBModel } = require('../src/models');
const { connectDatabase } = require('../src/config/database');
const logger = require('../src/utils/logger');

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const DATA_DIR = path.join(process.cwd(), 'data');
const BATCH_SIZE = 100;

// Limites geográficos do Brasil
const LAT_MIN = -33.75;
const LAT_MAX = 5.27;
const LNG_MIN = -73.99;
const LNG_MAX = -34.79;

// Mapeamento de operadoras para MCC/MNC
const OPERADORA_MAP = {
    'VIVO': { mcc: 724, mnc: 6 },
    'TIM': { mcc: 724, mnc: 2 },
    'CLARO': { mcc: 724, mnc: 3 },
    'OI': { mcc: 724, mnc: 4 },
    'ALGAR': { mcc: 724, mnc: 5 },
    'SERCOMTEL': { mcc: 724, mnc: 15 },
    'NEXTEL': { mcc: 724, mnc: 25 }
};

// ============================================================
// UTILITÁRIOS
// ============================================================

function coordenadasValidas(lat, lon) {
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lonNum)) return false;
    return latNum >= LAT_MIN && latNum <= LAT_MAX &&
        lonNum >= LNG_MIN && lonNum <= LNG_MAX;
}

function mapearTecnologia(tecnologias) {
    if (!tecnologias) return null;
    const techs = tecnologias.split(' - ').map(t => t.trim());
    const mapping = { '2G': 'GSM', '3G': 'UMTS', '4G': 'LTE', '5G': 'NR' };
    return techs.map(t => mapping[t] || t).join(', ');
}

function mapearOperadora(operadora) {
    if (!operadora) return { mcc: 724, mnc: 99 };
    const key = operadora.toUpperCase().trim();
    return OPERADORA_MAP[key] || { mcc: 724, mnc: 99 };
}

function extrairCellId(row) {
    // Prioridade: opencellid_cell > id_estacao > cell_id > cellid
    return parseInt(row.opencellid_cell) ||
        parseInt(row.id_estacao) ||
        parseInt(row.cell_id) ||
        parseInt(row.cellid) ||
        null;
}

function extrairLac(row) {
    return parseInt(row.opencellid_area) ||
        parseInt(row.lac) ||
        null;
}

function extrairMcc(row) {
    return parseInt(row.opencellid_mcc) ||
        parseInt(row.mcc) ||
        724;
}

function extrairMnc(row) {
    return parseInt(row.opencellid_net) ||
        parseInt(row.mnc) ||
        null;
}

// ============================================================
// DETECÇÃO DE ARQUIVOS
// ============================================================

function listarArquivosCSV() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        logger.info(`📁 Pasta ${DATA_DIR} criada.`);
        return [];
    }

    const arquivos = fs.readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.csv'))
        .map(f => path.join(DATA_DIR, f));

    if (arquivos.length === 0) {
        logger.warn('⚠️ Nenhum arquivo CSV encontrado em', DATA_DIR);
    }

    return arquivos;
}

// ============================================================
// PROCESSAMENTO DE UM ARQUIVO
// ============================================================

async function processarArquivo(caminho) {
    const nome = path.basename(caminho);
    logger.info(`📄 Processando: ${nome}`);

    let total = 0,
        validos = 0,
        invalidos = 0,
        salvos = 0;
    let lote = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(caminho, { encoding: 'utf8' })
            .pipe(csv({
                separator: ',',
                mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
            }))
            .on('data', (row) => {
                lote.push(row);
                if (lote.length >= BATCH_SIZE) {
                    const res = processarLote(lote);
                    validos += res.validos;
                    invalidos += res.invalidos;
                    salvos += res.salvos;
                    total += lote.length;
                    logger.info(`   📊 ${nome}: ${total} lidos, ${salvos} salvos`);
                    lote = [];
                }
            })
            .on('end', async () => {
                if (lote.length > 0) {
                    const res = await processarLote(lote);
                    validos += res.validos;
                    invalidos += res.invalidos;
                    salvos += res.salvos;
                    total += lote.length;
                }
                resolve({ nome, total, validos, invalidos, salvos });
            })
            .on('error', reject);
    });
}

async function processarLote(lote) {
    const erbs = [];
    let validos = 0,
        invalidos = 0;

    for (const row of lote) {
        const lat = parseFloat(row.latitude);
        const lon = parseFloat(row.longitude);
        if (!coordenadasValidas(lat, lon)) {
            invalidos++;
            continue;
        }

        const cellId = extrairCellId(row);
        if (!cellId) {
            invalidos++;
            continue;
        }

        const lac = extrairLac(row);
        const mcc = extrairMcc(row);
        let mnc = extrairMnc(row);
        if (!mnc) {
            const op = mapearOperadora(row.operadora);
            mnc = op.mnc;
        }

        const erb = {
            cellId,
            mcc,
            mnc,
            lac,
            lat,
            lon,
            range: parseInt(row.opencellid_range) || parseInt(row.range) || null,
            radio: row.opencellid_radio || row.radio || null,
            cidade: row.municipio || row.cidade || null,
            uf: row.uf || row.estado || null,
            operadora: row.operadora || null,
            bairro: row.bairro || null,
            endereco: row.endereco || null,
            tecnologias: mapearTecnologia(row.tecnologias || row.tecnologia) || null,
            frequencias: row.frequencias || row.frequencia || null,
            source: `CSV_${path.basename(caminho)}` // será sobrescrito depois
        };

        erbs.push(erb);
        validos++;
    }

    let salvos = 0;
    for (const erb of erbs) {
        try {
            const [_, created] = await ERBModel.findOrCreate({
                where: { cellId: erb.cellId, mcc: erb.mcc, mnc: erb.mnc },
                defaults: { ...erb, lac: erb.lac || 0 }
            });
            if (created) salvos++;
        } catch (e) {
            // Se falhar, tentar sem a restrição de lac
            try {
                const [_, created] = await ERBModel.findOrCreate({
                    where: { cellId: erb.cellId, mcc: erb.mcc, mnc: erb.mnc },
                    defaults: { ...erb, lac: 0 }
                });
                if (created) salvos++;
            } catch (e2) {
                logger.warn(`⚠️ Erro ao salvar ${erb.cellId}: ${e2.message}`);
            }
        }
    }

    return { validos, invalidos, salvos };
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

async function importarTodasERBs() {
    logger.info('📡 ===== IMPORTAÇÃO MÚLTIPLA DE ERBs =====');
    logger.info(`📁 Pasta de dados: ${DATA_DIR}`);

    const arquivos = listarArquivosCSV();
    if (arquivos.length === 0) {
        logger.error('❌ Nenhum arquivo CSV encontrado.');
        logger.info(`💡 Coloque os arquivos em: ${DATA_DIR}`);
        return;
    }

    logger.info(`📄 Total de arquivos encontrados: ${arquivos.length}`);

    await connectDatabase();
    await sequelize.sync();

    let totalGeral = 0,
        validosGeral = 0,
        invalidosGeral = 0,
        salvosGeral = 0;

    for (const caminho of arquivos) {
        const resultado = await processarArquivo(caminho);
        totalGeral += resultado.total;
        validosGeral += resultado.validos;
        invalidosGeral += resultado.invalidos;
        salvosGeral += resultado.salvos;
        logger.info(`✅ ${resultado.nome}: ${resultado.salvos} salvos`);
    }

    const totalNoBanco = await ERBModel.count();

    logger.info('📊 ===== RESUMO FINAL =====');
    logger.info(`📄 Total de registros processados: ${totalGeral}`);
    logger.info(`✅ Registros válidos: ${validosGeral}`);
    logger.info(`❌ Registros inválidos: ${invalidosGeral}`);
    logger.info(`💾 Registros salvos no banco: ${salvosGeral}`);
    logger.info(`🏛️ Total de ERBs no banco: ${totalNoBanco}`);
}

// ============================================================
// EXECUÇÃO
// ============================================================

if (require.main === module) {
    importarTodasERBs()
        .then(() => {
            logger.info('✅ Importação concluída!');
            process.exit(0);
        })
        .catch(err => {
            logger.error('❌ Falha na importação:', err);
            process.exit(1);
        });
}

module.exports = { importarTodasERBs };
