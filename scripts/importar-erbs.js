// scripts/importar-erbs.js
// ORION - Importador inteligente de ERBs
// Detecta automaticamente os arquivos disponíveis na pasta data/

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { sequelize, ERBModel } = require('../src/models');
const { connectDatabase } = require('../src/config/database');
const logger = require('../src/utils/logger');

// ============================================================
// CONFIGURAÇÕES
// ============================================================

// Onde o ORION espera os arquivos de dados
const DATA_DIR = path.join(process.cwd(), 'data');

// Ordem de prioridade dos arquivos (o primeiro que existir será usado)
const ARQUIVOS_PRIORITARIOS = [
    'erb_consolidado_final.csv',
    'coleta_campo - Copia-part001.csv',
    'coleta_campo - Copia-part-002.csv',
    'coleta_campo - Copia-part-003.csv'
];

// Limites geográficos do Brasil (para validar coordenadas)
const LAT_MIN = -33.75;
const LAT_MAX = 5.27;
const LNG_MIN = -73.99;
const LNG_MAX = -34.79;

// Mapeamento de operadoras para MCC/MNC
const OPERADORA_MAP = {
    'VIVO':   { mcc: 724, mnc: 6 },
    'TIM':    { mcc: 724, mnc: 2 },
    'CLARO':  { mcc: 724, mnc: 3 },
    'OI':     { mcc: 724, mnc: 4 },
    'ALGAR':  { mcc: 724, mnc: 5 },
    'SERCOMTEL': { mcc: 724, mnc: 15 },
    'NEXTEL': { mcc: 724, mnc: 25 }
};

// ============================================================
// FUNÇÕES AUXILIARES
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

function encontrarArquivo() {
    // Garantir que a pasta data existe
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        logger.info(`📁 Pasta ${DATA_DIR} criada.`);
        return null;
    }

    // Procurar pelos arquivos prioritários
    for (const nome of ARQUIVOS_PRIORITARIOS) {
        const caminho = path.join(DATA_DIR, nome);
        if (fs.existsSync(caminho)) {
            logger.info(`📄 Arquivo encontrado: ${nome}`);
            return caminho;
        }
    }

    // Se nenhum for encontrado, listar os CSV disponíveis
    const csvs = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
    if (csvs.length > 0) {
        logger.warn(`⚠️ Nenhum arquivo prioritário encontrado.`);
        logger.info(`📄 CSV disponíveis: ${csvs.join(', ')}`);
        return path.join(DATA_DIR, csvs[0]);
    }

    return null;
}

// ============================================================
// PROCESSAMENTO
// ============================================================

async function processarLote(lote) {
    const erbs = [];
    let validos = 0, invalidos = 0;

    for (const row of lote) {
        const lat = parseFloat(row.latitude);
        const lon = parseFloat(row.longitude);
        if (!coordenadasValidas(lat, lon)) {
            invalidos++;
            continue;
        }

        // Tentar extrair cellId (prioridade: OpenCellID > id_estacao)
        let cellId = parseInt(row.opencellid_cell) || parseInt(row.id_estacao) || null;
        if (!cellId) {
            invalidos++;
            continue;
        }

        const lac = parseInt(row.opencellid_area) || null;
        const mcc = parseInt(row.opencellid_mcc) || 724;
        let mnc = parseInt(row.opencellid_net) || null;
        if (!mnc) {
            const op = mapearOperadora(row.operadora);
            mnc = op.mnc;
        }

        erbs.push({
            cellId,
            mcc,
            mnc,
            lac,
            lat,
            lon,
            range: parseInt(row.opencellid_range) || null,
            radio: row.opencellid_radio || null,
            cidade: row.municipio || null,
            uf: row.uf || null,
            operadora: row.operadora || null,
            bairro: row.bairro || null,
            endereco: row.endereco || null,
            tecnologias: mapearTecnologia(row.tecnologias) || null,
            frequencias: row.frequencias || null,
            source: 'CSV_IMPORT'
        });

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
            logger.warn(`⚠️ Erro ao salvar ${erb.cellId}: ${e.message}`);
        }
    }

    return { validos, invalidos, salvos };
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

async function importarERBs() {
    logger.info('📡 ===== IMPORTAÇÃO DE ERBs =====');
    logger.info(`📁 Pasta de dados: ${DATA_DIR}`);

    const arquivo = encontrarArquivo();
    if (!arquivo) {
        logger.error('❌ Nenhum arquivo CSV encontrado.');
        logger.info(`💡 Coloque os arquivos em: ${DATA_DIR}`);
        return;
    }

    logger.info(`📄 Importando: ${path.basename(arquivo)}`);

    await connectDatabase();
    await sequelize.sync();

    let total = 0, validos = 0, invalidos = 0, salvos = 0;
    let lote = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(arquivo, { encoding: 'utf8' })
            .pipe(csv({
                separator: ',',
                mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
            }))
            .on('data', (row) => {
                lote.push(row);
                if (lote.length >= 100) {
                    const res = processarLote(lote);
                    validos += res.validos;
                    invalidos += res.invalidos;
                    salvos += res.salvos;
                    total += lote.length;
                    logger.info(`📊 Processados: ${total} | Válidos: ${validos} | Salvos: ${salvos}`);
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

                logger.info('📊 ===== RESUMO =====');
                logger.info(`📄 Total: ${total}`);
                logger.info(`✅ Válidos: ${validos}`);
                logger.info(`❌ Inválidos: ${invalidos}`);
                logger.info(`💾 Salvos: ${salvos}`);
                logger.info(`🏛️ Total no banco: ${await ERBModel.count()}`);
                resolve({ total, validos, invalidos, salvos });
            })
            .on('error', reject);
    });
}

if (require.main === module) {
    importarERBs()
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { importarERBs };
