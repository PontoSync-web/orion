// orion.js
// ORION - Servidor Principal (Atualizado para múltiplos arquivos de ERBs)

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const { sequelize, ERBModel } = require('./src/models');
const { connectDatabase } = require('./src/config/database');
const { initRedis } = require('./src/config/redis');
const { importarERBs } = require('./scripts/importar-erbs');
const logger = require('./src/utils/logger');

const app = express();
const server = http.createServer(app);

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// ROTAS PÚBLICAS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'ORION',
        version: '2.0.0',
        status: 'online',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', async (req, res) => {
    try {
        const erbCount = await ERBModel.count();
        res.json({
            status: 'online',
            version: '2.0.0',
            erbs: erbCount,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ============================================================
// ROTAS DE ERBs
// ============================================================

app.get('/api/erbs', async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        const erbs = await ERBModel.findAll({
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['uf', 'ASC'], ['cidade', 'ASC']]
        });
        res.json({ success: true, count: erbs.length, data: erbs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/erbs/nearby', async (req, res) => {
    try {
        const { lat, lon, raio = 10 } = req.query;
        if (!lat || !lon) {
            return res.status(400).json({ error: 'lat e lon são obrigatórios' });
        }

        const query = `
            SELECT *, 
                   (6371 * acos(cos(radians(:lat)) * cos(radians(lat)) *
                    cos(radians(lon) - radians(:lon)) + sin(radians(:lat)) *
                    sin(radians(lat)))) AS distance
            FROM erbs
            WHERE (6371 * acos(cos(radians(:lat)) * cos(radians(lat)) *
                  cos(radians(lon) - radians(:lon)) + sin(radians(:lat)) *
                  sin(radians(lat)))) < :raio
            ORDER BY distance
            LIMIT 50;
        `;

        const results = await sequelize.query(query, {
            replacements: { lat: parseFloat(lat), lon: parseFloat(lon), raio: parseFloat(raio) },
            type: sequelize.QueryTypes.SELECT
        });

        res.json({ success: true, count: results.length, data: results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/erbs/uf/:uf', async (req, res) => {
    try {
        const { uf } = req.params;
        const erbs = await ERBModel.findAll({
            where: { uf: uf.toUpperCase() },
            limit: 1000
        });
        res.json({ success: true, count: erbs.length, data: erbs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/erbs/cidade/:cidade', async (req, res) => {
    try {
        const { cidade } = req.params;
        const erbs = await ERBModel.findAll({
            where: { cidade: cidade },
            limit: 1000
        });
        res.json({ success: true, count: erbs.length, data: erbs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ROTA DE IMPORTAÇÃO (via API)
// ============================================================

app.post('/api/admin/import-erbs', async (req, res) => {
    try {
        const result = await importarERBs();
        res.json({ success: true, message: 'Importação concluída', result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

async function startOrion() {
    try {
        logger.info('🌌 Iniciando ORION v2.0...');

        // 1. Conectar ao banco de dados
        await connectDatabase();
        await sequelize.sync();
        logger.info('✅ Banco de dados conectado');

        // 2. Conectar ao Redis
        await initRedis();
        logger.info('✅ Redis conectado');

        // 3. Verificar se há ERBs no banco
        const erbCount = await ERBModel.count();
        if (erbCount === 0) {
            logger.info('📡 Nenhuma ERB encontrada. Iniciando importação automática...');
            await importarERBs();
            const newCount = await ERBModel.count();
            logger.info(`✅ ${newCount} ERBs importadas`);
        } else {
            logger.info(`📡 ${erbCount} ERBs já disponíveis no banco`);
        }

        // 4. Iniciar servidor
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, '0.0.0.0', () => {
            logger.info(`🚀 ORION rodando na porta ${PORT}`);
            logger.info(`📡 ERBs no banco: ${erbCount || 'carregando...'}`);
        });

    } catch (error) {
        logger.error('❌ Falha na inicialização:', error);
        process.exit(1);
    }
}

startOrion();
