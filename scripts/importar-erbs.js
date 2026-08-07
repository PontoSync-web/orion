// scripts/importar-erbs.js
// ORION - Importador de ERBs a partir de arquivos CSV
// 
// Este script detecta automaticamente os arquivos disponíveis na pasta data/
// Prioridades: erb_consolidado_final.csv > coleta_campo - Copia-part*.csv
//
// Uso: node scripts/importar-erbs.js
// Opções: --force (recria a tabela antes de importar)

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

// Ordem de prioridade dos arquivos (do mais completo para o menos completo)
const ARQUIVOS_PRIORITARIOS = [
    'erb_consolidado_final.csv',
    'coleta_campo - Copia-part001.csv',
    'coleta_campo - Copia-part-002.csv',
    'coleta_campo - Copia-part-003.csv'
];

// Filtro de coordenadas válidas (Brasil continental)
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
// UTILITÁRIOS
// ============================================================

/**
 * Verifica se as coordenadas estão dentro do território brasileiro
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
 * Converte tecnologia (ex: "2G - 3G - 4G") para formato padronizado
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
 * Obtém MCC/MNC a partir do nome da operadora
 */
function mapearOperadora(operadora) {
    if (!operadora) return { mcc: 724, mnc: 99 };
    const key = operadora.toUpperCase().trim();
    return OPERADORA_MAP[key] || { mcc: 724, mnc: 99 };
}

/**
 * Detecta qual arquivo de ERBs está disponível
 */
function encontrarArquivo() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        logger.info(`📁 Pasta ${DATA_DIR} criada.`);
        return null;
    }

    for (const nome of ARQUIVOS_PRIORITARIOS) {
        const caminho = path.join(DATA_DIR, nome);
        if (fs.existsSync(caminho)) {
            logger.info(`📄 Arquivo encontrado: ${nome}`);
            return caminho;
        }
    }

    // Se nenhum arquivo for encontrado, listar os disponíveis
    const arquivosDisponiveis = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
    if (arquivosDisponiveis.length > 0) {
        logger.warn(`⚠️ Nenhum arquivo prioritário encontrado.`);
        logger.info(`📄 Arquivos CSV disponíveis: ${arquivosDisponiveis.join(', ')}`);
        logger.info(`💡 Use o primeiro da lista: ${arquivosDisponiveis[0]}`);
        return path.join(DATA_DIR, arquivosDisponiveis[0]);
    }

    return null;
}

// ============================================================
// PROCESSAMENTO DE DADOS
// ============================================================

/**
 * Processa um lote de registros e insere no banco
 */
async function processarLote(lote) {
    const erbsParaSalvar = [];
    let validos = 0;
    let invalidos = 0;

    for (const row of lote) {
        // 1. Extrair coordenadas
        const lat = parseFloat(row.latitude);
        const lon = parseFloat(row.longitude);
        if (!coordenadasValidas(lat, lon)) {
            invalidos++;
            continue;
        }

        // 2. Identificador da ERB (priorizar OpenCellID, depois id_estacao)
        let cellId = parseInt(row.opencellid_cell) || null;
        let lac = parseInt(row.opencellid_area) || null;
        let mcc = parseInt(row.opencellid_mcc) || 724;
        let mnc = parseInt(row.opencellid_net) || null;

        // Se não tem OpenCellID, usar dados da operadora
        if (!cellId) {
            cellId = parseInt(row.id_estacao) || null;
            if (!cellId) {
                invalidos++;
                continue;
            }
            // Tentar usar dados do CSV para LAC e MNC
            lac = parseInt(row.lac) || lac;
            const op = mapearOperadora(row.operadora);
            if (!mnc) mnc = op.mnc;
        }

        // 3. Montar objeto ERB
        const erb = {
            cellId: cellId,
            mcc: mcc,
            mnc: mnc,
            lac: lac,
            lat: lat,
            lon: lon,
            range: parseInt(row.opencellid_range) || null,
            radio: row.opencellid_radio || null,
            cidade: row.municipio || null,
            uf: row.uf || null,
            // Campos enriquecidos
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
            source: 'CSV_IMPORT'
        };

        erbsParaSalvar.push(erb);
        validos++;
    }

    // 4. Salvar no banco (com deduplicação)
    let salvos = 0;
    for (const erb of erbsParaSalvar) {
        try {
            const [instancia, created] = await ERBModel.findOrCreate({
                where: {
                    cellId: erb.cellId,
                    mcc: erb.mcc,
                    mnc: erb.mnc,
                    lac: erb.lac || 0
                },
                defaults: erb
            });
            if (created) salvos++;
        } catch (error) {
            // Se falhar por chave duplicada, tentar com dados mínimos
            try {
                const [instancia, created] = await ERBModel.findOrCreate({
                    where: {
                        cellId: erb.cellId,
                        mcc: erb.mcc,
                        mnc: erb.mnc
                    },
                    defaults: { ...erb, lac: erb.lac || 0 }
                });
                if (created) salvos++;
            } catch (e) {
                logger.warn(`⚠️ Erro ao salvar ERB ${erb.cellId}: ${e.message}`);
            }
        }
    }

    return { validos, invalidos, salvos };
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

async function importarERBs(opcoes = {}) {
    const { force = false } = opcoes;

    logger.info('📡 ===== IMPORTAÇÃO DE ERBs =====');
    logger.info(`📁 Pasta de dados: ${DATA_DIR}`);

    // 1. Encontrar arquivo
    const arquivo = encontrarArquivo();
    if (!arquivo) {
        logger.error('❌ Nenhum arquivo CSV de ERBs encontrado.');
        logger.info(`💡 Coloque os arquivos em: ${DATA_DIR}`);
        logger.info(`   Arquivos esperados: ${ARQUIVOS_PRIORITARIOS.join(', ')}`);
        return;
    }

    logger.info(`📄 Arquivo fonte: ${path.basename(arquivo)}`);

    // 2. Conectar ao banco
    await connectDatabase();
    await sequelize.sync();

    // 3. Se force=true, limpar tabela
    if (force) {
        await ERBModel.destroy({ where: {} });
        logger.info('🧹 Tabela ERBs limpa.');
    }

    // 4. Ler e processar CSV
    let totalProcessados = 0;
    let totalValidos = 0;
    let totalInvalidos = 0;
    let totalSalvos = 0;
    let loteAtual = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(arquivo, { encoding: 'utf8' })
            .pipe(csv({
                separator: ',',
                mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
            }))
            .on('data', (row) => {
                loteAtual.push(row);
                if (loteAtual.length >= BATCH_SIZE) {
                    const { validos, invalidos, salvos } = processarLote(loteAtual);
                    totalValidos += validos;
                    totalInvalidos += invalidos;
                    totalSalvos += salvos;
                    totalProcessados += loteAtual.length;
                    logger.info(`📊 Processados: ${totalProcessados} | Válidos: ${totalValidos} | Inválidos: ${totalInvalidos} | Salvos: ${totalSalvos}`);
                    loteAtual = [];
                }
            })
            .on('end', async () => {
                // Último lote
                if (loteAtual.length > 0) {
                    const { validos, invalidos, salvos } = await processarLote(loteAtual);
                    totalValidos += validos;
                    totalInvalidos += invalidos;
                    totalSalvos += salvos;
                    totalProcessados += loteAtual.length;
                }

                // Resumo
                logger.info('📊 ===== RESUMO DA IMPORTAÇÃO =====');
                logger.info(`📄 Total de registros processados: ${totalProcessados}`);
                logger.info(`✅ Registros válidos: ${totalValidos}`);
                logger.info(`❌ Registros inválidos (coordenadas fora do Brasil): ${totalInvalidos}`);
                logger.info(`💾 Registros salvos no banco: ${totalSalvos}`);

                // Estatísticas finais
                const totalNoBanco = await ERBModel.count();
                logger.info(`🏛️ Total de ERBs no banco: ${totalNoBanco}`);

                resolve({ totalProcessados, totalValidos, totalInvalidos, totalSalvos, totalNoBanco });
            })
            .on('error', (error) => {
                logger.error(`❌ Erro ao ler CSV: ${error.message}`);
                reject(error);
            });
    });
}

// ============================================================
// EXECUÇÃO VIA CLI
// ============================================================

if (require.main === module) {
    const args = process.argv.slice(2);
    const force = args.includes('--force');

    importarERBs({ force })
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
