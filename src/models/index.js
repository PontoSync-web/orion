// src/models/index.js
// ORION - Exportação centralizada de modelos

const ERBModel = require('./erbModel');

module.exports = {
    ERBModel,
    sequelize: require('../config/database').sequelize
};
