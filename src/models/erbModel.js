// src/models/erbModel.js
// ORION - Modelo de ERBs (Estações Rádio Base)

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ERBModel = sequelize.define('ERB', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    cellId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Cell ID da ERB'
    },
    mcc: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: 'Mobile Country Code (724 = Brasil)'
    },
    mnc: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: 'Mobile Network Code (operadora)'
    },
    lac: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Location Area Code'
    },
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
    radio: {
        type: DataTypes.STRING(10),
        allowNull: true,
        comment: 'Tecnologia (GSM, UMTS, LTE, NR)'
    },
    cidade: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Cidade onde a ERB está localizada'
    },
    uf: {
        type: DataTypes.STRING(2),
        allowNull: true,
        comment: 'Estado'
    },
    // Campos adicionais do CSV
    operadora: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Nome da operadora'
    },
    bairro: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Bairro da ERB'
    },
    endereco: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Endereço completo'
    },
    tecnologias: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Tecnologias suportadas (GSM, UMTS, LTE, NR)'
    },
    frequencias: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'Frequências em MHz'
    },
    samples: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Número de amostras OpenCellID'
    },
    averagesignal: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Sinal médio'
    },
    correspondencia: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'Corresponde ao OpenCellID?'
    },
    anatel_tipo: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Tipo de estação pela Anatel'
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
        comment: 'Tipo de emissão'
    },
    source: {
        type: DataTypes.STRING(50),
        defaultValue: 'OPENCELLID',
        comment: 'Fonte dos dados'
    }
}, {
    tableName: 'erbs',
    timestamps: true,
    indexes: [
        { fields: ['cellId', 'lac'] },
        { fields: ['mcc', 'mnc'] },
        { fields: ['lat', 'lon'] },
        { fields: ['operadora'] },
        { fields: ['uf'] },
        { fields: ['cidade'] }
    ]
});

module.exports = ERBModel;
