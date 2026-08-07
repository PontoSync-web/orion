// scripts/importar-erbs.js
// ORION - Importador de ERBs a partir de arquivo CSV
// Arquivo fonte: ERBs de operadoras brasileiras

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { sequelize, ERBModel } = require('../src/models');
const { connectDatabase } = require('../src/config/database');
const logger = require('../src/utils/logger');

// Configurações
const ARQUIVO_CSV = process.env.ERBS_CSV_PATH || './erbs_brasil.csv';
const BATCH_SIZE = 100; // Registros por lote

// Filtro de coordenadas válidas (Brasil)
const LAT_MIN = -33.75;
const LAT_MAX = 5.27;
const LNG_MIN = -73.99;
const LNG_MAX = -34.79;

/**
 * Verifica se as coordenadas são válidas para o Brasil
 */
function coordenadasValidas(lat, lon) {
    if (lat == null || lon == null) return false;
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lonNum)) return false;
    return latNum >= LAT_MIN && latNum <= LAT_MAX &&
           lonNum >= LNG_MIN && lonNum <= LNG_MAX;
}

/**
 * Mapeia a tecnologia para o formato do ORION
 */
function mapearTecnologia(tecnologias) {
    if (!tecnologias) return null;
    const techs = tecnologias.split(' - ').map(t => t.trim());
    const mapping = {
        '2G': 'GSM',
        '3G': 'UMTS',
        '4G': 'LTE',
        '5G': 'NR'
    };
    return techs.map(t => mapping[t] || t).join(', ');
}

/**
 * Mapeia a operadora para MCC/MNC
 */
function mapearOperadora(operadora) {
    const map = {
        'VIVO': { mcc: 724, mnc: 6 },
        'TIM': { mcc: 724, mnc: 2 },
        'CLARO': { mcc: 724, mnc: 3 },
        'OI': { mcc: 724, mnc: 4 },
        'ALGAR': { mcc: 724, mnc: 5 },
        'SERCOMTEL': { mcc: 724, mnc: 15 },
        'NEXTEL': { mcc: 724, mnc: 25 }
    };
    return map[operadora.toUpperCase()] || { mcc: 724, mnc: 99 };
}

/**
 * Processa um lote de registros e insere no banco
 */
async function processarLote(lote) {
    const erbsParaSalvar = [];
    let validos = 0;
    let invalidos = 0;

    for (const row of lote) {
        // Verificar coordenadas
        const lat = parseFloat(row.latitude);
        const lon = parseFloat(row.longitude);
        if (!coordenadasValidas(lat, lon)) {
            invalidos++;
            continue;
        }

        // Verificar se já existe (pelo cellId)
        const cellId = parseInt(row.opencellid_cell) || null;
        const lac = parseInt(row.opencellid_area) || null;
        const mcc = parseInt(row.opencellid_mcc) || 724;
        const mnc = parseInt(row.opencellid_net) || null;

        // Se não tem cellId, tentar usar outro identificador
        if (!cellId) {
            invalidos++;
            continue;
        }

        // Montar objeto ERB
        const erb = {
            cellId: cellId,
            mcc: mcc,
            mnc: mnc || mapearOperadora(row.operadora).mnc,
            lac: lac || null,
            lat: lat,
            lon: lon,
            range: parseInt(row.opencellid_range) || null,
            radio: row.opencellid_radio || null,
            cidade: row.municipio || null,
            uf: row.uf || null,
            // Dados adicionais (para enriquecimento)
            operadora: row.operadora || null,
            bairro: row.bairro || null,
            endereco: row.endereco || null,
            tecnologias: mapearTecnologia(row.tecnologias) || null,
            frequencias: row.frequencias || null,
            samples: parseInt(row.opencellid_samples) || null,
            averagesignal: parseInt(row.opencellid_averagesignal) || null,
            correspondencia: row.opencellid_correspondencia === 'sim' || false,
            anatel_tipo: row['anatel_tipo_da_estação'] || null,
            anatel_freq_inicial: parseFloat(row['anatel_frequência_inicial_(mhz)']) || null,
            anatel_freq_final: parseFloat(row['anatel_frequência_final_(mhz)']) || null,
            anatel_emissao: row['anatel_emissão'] || null,
            source: 'ERBS_CSV_IMPORT'
        };

        erbsParaSalvar.push(erb);
        validos++;
    }

    // Salvar em lote
    let salvos = 0;
    for (const erb of erbsParaSalvar) {
        try {
            await ERBModel.findOrCreate({
                where: {
                    cellId: erb.cellId,
                    mcc: erb.mcc,
                    mnc: erb.mnc,
                    lac: erb.lac
                },
                defaults: erb
            });
            salvos++;
        } catch (error) {
            logger.warn(`Erro ao salvar ERB ${erb.cellId}: ${error.message}`);
        }
    }

    return { validos, invalidos, salvos };
}

/**
 * Função principal de importação
 */
async function importarERBs() {
    logger.info('📡 Iniciando importação de ERBs...');
    logger.info(`📁 Arquivo: ${ARQUIVO_CSV}`);

    // Verificar se o arquivo existe
    if (!fs.existsSync(ARQUIVO_CSV)) {
        logger.error(`❌ Arquivo não encontrado: ${ARQUIVO_CSV}`);
        process.exit(1);
    }

    // Conectar ao banco
    await connectDatabase();
    await sequelize.sync();
    logger.info('✅ Banco de dados conectado');

    // Ler o CSV
    const results = [];
    let totalProcessados = 0;
    let totalValidos = 0;
    let totalInvalidos = 0;
    let totalSalvos = 0;
    let loteAtual = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(ARQUIVO_CSV)
            .pipe(csv({
                separator: ',',
                mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
            }))
            .on('data', (row) => {
                loteAtual.push(row);
                if (loteAtual.length >= BATCH_SIZE) {
                    // Processar lote
                    const { validos, invalidos, salvos } = processarLote(loteAtual);
                    totalValidos += validos;
                    totalInvalidos += invalidos;
                    totalSalvos += salvos;
                    totalProcessados += loteAtual.length;
                    logger.info(`📊 Processados: ${totalProcessados} | Válidos: ${totalValidos} | Inválidos: ${totalInvalidos} | Salvos: ${totalSalvos}`);
                    loteAtual = [];
                }
            })
            .on('end', () => {
                // Processar último lote
                if (loteAtual.length > 0) {
                    const { validos, invalidos, salvos } = processarLote(loteAtual);
                    totalValidos += validos;
                    totalInvalidos += invalidos;
                    totalSalvos += salvos;
                    totalProcessados += loteAtual.length;
                }

                logger.info('📊 ===== RESUMO DA IMPORTAÇÃO =====');
                logger.info(`📄 Total de registros processados: ${totalProcessados}`);
                logger.info(`✅ Registros válidos: ${totalValidos}`);
                logger.info(`❌ Registros inválidos (coordenadas fora do Brasil): ${totalInvalidos}`);
                logger.info(`💾 Registros salvos no banco: ${totalSalvos}`);

                resolve({ totalProcessados, totalValidos, totalInvalidos, totalSalvos });
            })
            .on('error', (error) => {
                logger.error(`❌ Erro ao ler CSV: ${error.message}`);
                reject(error);
            });
    });
}

// Executar importação
if (require.main === module) {
    importarERBs()
        .then(() => {
            logger.info('✅ Importação concluída!');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('❌ Falha na importação:', error);
            process.exit(1);
        });
}

module.exports = { importarERBs };
