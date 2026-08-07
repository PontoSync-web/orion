// src/models/erbModel.js
// ORION - Modelo de ERBs (Estações Rádio Base)
// Compatível com: Anatel SMP, OpenCellID, coleta de campo e consolidado final

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ERBModel = sequelize.define('ERB', {
    // ============================================================
    // IDENTIFICAÇÃO PRIMÁRIA
    // ============================================================
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },

    // ============================================================
    // DADOS DA ERB (OpenCellID + Anatel)
    // ============================================================
    cellId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Cell ID da ERB (OpenCellID ou Anatel)'
    },
    mcc: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 724,
        comment: 'Mobile Country Code (724 = Brasil)'
    },
    mnc: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: 'Mobile Network Code (operadora)'
    },
    lac: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        comment: 'Location Area Code'
    },

    // ============================================================
    // COORDENADAS
    // ============================================================
    lat: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        comment: 'Latitude da ERB'
    },
    lon: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: false,
        comment: 'Longitude da ERB'
    },
    range: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Raio de cobertura em metros'
    },

    // ============================================================
    // TECNOLOGIA E FREQUÊNCIAS
    // ============================================================
    radio: {
        type: DataTypes.STRING(10),
        allowNull: true,
        comment: 'Tecnologia (GSM, UMTS, LTE, NR)'
    },
    tecnologias: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Tecnologias suportadas (ex: GSM, UMTS, LTE, NR)'
    },
    frequencias: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: 'Frequências em MHz (ex: 700, 1800, 2100)'
    },

    // ============================================================
    // LOCALIZAÇÃO GEOGRÁFICA
    // ============================================================
    cidade: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Município'
    },
    uf: {
        type: DataTypes.STRING(2),
        allowNull: true,
        comment: 'Estado (UF)'
    },
    bairro: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Bairro'
    },
    endereco: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Endereço completo'
    },
    codigo_municipio_ibge: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Código IBGE do município'
    },

    // ============================================================
    // OPERADORA E INSTALAÇÃO
    // ============================================================
    operadora: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Nome da operadora (VIVO, TIM, CLARO, OI, etc.)'
    },
    tipo_instalacao: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Tipo de instalação (Greenfield, Rooftop, Indoor, etc.)'
    },

    // ============================================================
    // DADOS DO OPENCELLID
    // ============================================================
    samples: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Número de amostras no OpenCellID'
    },
    averagesignal: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Sinal médio (dBm)'
    },
    correspondencia: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'Corresponde ao OpenCellID?'
    },

    // ============================================================
    // DADOS DA ANATEL (SMP - Serviço Móvel Pessoal)
    // ============================================================
    anatel_tipo: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Tipo de estação pela Anatel (FB, etc.)'
    },
    anatel_freq_inicial: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
        comment: 'Frequência inicial (MHz)'
    },
    anatel_freq_final: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
        comment: 'Frequência final (MHz)'
    },
    anatel_emissao: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Tipo de emissão (ex: 200KG7W)'
    },
    anatel_distancia_m: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Distância da referência Anatel (metros)'
    },
    anatel_correspondencia: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'Corresponde à base da Anatel?'
    },

    // ============================================================
    // METADADOS
    // ============================================================
    source: {
        type: DataTypes.STRING(50),
        defaultValue: 'CSV_IMPORT',
        comment: 'Fonte dos dados (CSV_IMPORT, OPENCELLID, ANATEL, etc.)'
    },
    arquivo_origem: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Nome do arquivo CSV de origem'
    },
    data_importacao: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'Data de importação'
    }
}, {
    tableName: 'erbs',
    timestamps: true,
    indexes: [
        // Índices para buscas rápidas
        { fields: ['cellId', 'mcc', 'mnc'] },
        { fields: ['cellId', 'lac'] },
        { fields: ['mcc', 'mnc'] },
        { fields: ['uf'] },
        { fields: ['cidade'] },
        { fields: ['operadora'] },
        { fields: ['lat', 'lon'] },  // Para consultas geoespaciais
        { fields: ['source'] }
    ]
});

module.exports = ERBModel;
