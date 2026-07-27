// ============================================================
// ORION — Servidor Principal v5.1
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

const PROJECT_ROOT = __dirname;
const PATHS = {
    data: path.join(PROJECT_ROOT, 'data'),
    logs: path.join(PROJECT_ROOT, 'logs'),
    public: path.join(PROJECT_ROOT, 'public'),
    src: path.join(PROJECT_ROOT, 'src'),
};

Object.values(PATHS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const DB_MAIN = path.join(PATHS.data, 'orion.db');
const DB_TOWERS = path.join(PATHS.data, 'cell_towers.db');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PATHS.public));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

const log = (level, msg) => console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);

const dbMain = new sqlite3.Database(DB_MAIN);
dbMain.exec(`CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER, latitude REAL, longitude REAL,
    radius INTEGER, source TEXT, metodo TEXT,
    torres_usadas INTEGER, cell_data TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`);

app.get('/health', (req, res) => {
    res.json({
        servidor: 'Orion',
        versao: '5.1',
        status: 'online',
        banco_torres: fs.existsSync(DB_TOWERS) ? 'ok' : 'pendente',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        servidor: 'Orion',
        status: 'online',
        endpoints: ['/health', '/api/localizar-por-cells', '/api/rastrear/:numero', '/api/cellular/status']
    });
});

app.post('/api/localizar-por-cells', async (req, res) => {
    const { numero, cells } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ erro: 'Array de cells obrigatorio' });
    }
    try {
        const db = new sqlite3.Database(DB_TOWERS);
        const placeholders = cells.map(() => '?').join(',');
        const cellIds = cells.map(c => c.cellId);
        
        db.all(`SELECT cell, lat, lon, range, averageSignal FROM cell_towers WHERE cell IN (${placeholders})`, cellIds, (err, rows) => {
            db.close();
            if (err) return res.status(500).json({ erro: err.message });
            if (!rows || rows.length === 0) return res.status(404).json({ erro: 'Nenhuma torre encontrada' });

            let lat = 0, lon = 0, pesoTotal = 0;
            rows.forEach(t => {
                const peso = 1 / Math.max(t.range || 500, 1);
                lat += t.lat * peso;
                lon += t.lon * peso;
                pesoTotal += peso;
            });

            const raio = Math.round(rows.reduce((a, t) => a + (t.range || 500), 0) / rows.length / Math.sqrt(rows.length));

            if (numero) {
                dbMain.run('INSERT INTO locations (target_id, latitude, longitude, radius, source, metodo, torres_usadas, cell_data) VALUES ((SELECT id FROM targets WHERE phone = ?), ?, ?, ?, ?, ?, ?, ?)',
                    [numero, lat / pesoTotal, lon / pesoTotal, raio, 'api', 'triangulacao', rows.length, JSON.stringify(cells)]);
            }

            res.json({
                status: 'sucesso',
                position: {
                    latitude: lat / pesoTotal,
                    longitude: lon / pesoTotal,
                    raio_estimado: raio,
                    precisao: rows.length >= 3 ? 'media' : 'baixa'
                },
                torres_usadas: rows.length,
                timestamp: new Date().toISOString()
            });
        });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

app.get('/api/rastrear/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT * FROM locations WHERE target_id = (SELECT id FROM targets WHERE phone = ?) ORDER BY timestamp DESC LIMIT 1', [numero], (err, row) => {
        if (err || !row) return res.status(404).json({ erro: 'Alvo nao encontrado ou sem localizacao' });
        res.json({
            status: 'sucesso',
            numero,
            position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius },
            timestamp: row.timestamp
        });
    });
});

app.get('/api/cellular/status', (req, res) => {
    res.json({ status: 'monitorando', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
    log('info', `ORION 5.1 rodando na porta ${port}`);
});
