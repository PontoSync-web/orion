// ============================================================
// ARQUIVO: orion.js
// DATA: 28/07/2026
// MOTIVO: Reescrita completa com todas as rotas, segurança CSP,
//         cadastro automático, triangulação real, e lock de
//         importação para evitar loop em falhas consecutivas.
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

// ============================================================
// DIRETÓRIOS
// ============================================================
const PROJECT_ROOT = __dirname;
const PATHS = {
    data: path.join(PROJECT_ROOT, 'data'),
    logs: path.join(PROJECT_ROOT, 'logs'),
    public: path.join(PROJECT_ROOT, 'public'),
    src: path.join(PROJECT_ROOT, 'src'),
    scripts: path.join(PROJECT_ROOT, 'scripts')
};

Object.values(PATHS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const DB_MAIN = path.join(PATHS.data, 'orion.db');
const DB_TOWERS = path.join(PATHS.data, 'cell_towers.db');
const LOCK_FILE = path.join(PATHS.data, '.import_lock');

// ============================================================
// SEGURANÇA
// ============================================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org"],
            connectSrc: ["'self'", "https://*.tile.openstreetmap.org"]
        }
    }
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PATHS.public));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ============================================================
// LOGGER
// ============================================================
const log = (level, msg) => {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
};

// ============================================================
// BANCO PRINCIPAL
// ============================================================
const dbMain = new sqlite3.Database(DB_MAIN);
dbMain.exec(`
    CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT UNIQUE,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER,
        latitude REAL,
        longitude REAL,
        radius INTEGER,
        source TEXT,
        metodo TEXT,
        torres_usadas INTEGER,
        cell_data TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

// ============================================================
// ROTAS
// ============================================================

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
        endpoints: [
            '/health',
            '/api/cadastrar',
            '/api/rastrear/:numero',
            '/api/buscar/:numero',
            '/api/localizar-por-cells',
            '/api/cellular/status',
            '/api/ticket/:id'
        ]
    });
});

// Cadastro
app.post('/api/cadastrar', (req, res) => {
    const { numero, nome } = req.body;
    if (!numero) return res.status(400).json({ erro: 'Numero obrigatorio' });
    dbMain.run('INSERT OR IGNORE INTO targets (name, phone) VALUES (?, ?)',
        [nome || 'Alvo', numero],
        function(err) {
            if (err) return res.status(500).json({ erro: err.message });
            res.json({ status: 'sucesso', id: this.lastID, mensagem: 'Alvo cadastrado' });
        });
});

// Rastreamento (mapa)
app.get('/api/rastrear/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT id, name FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT OR IGNORE INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + numero.slice(-4), numero],
                () => {
                    return res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado. Sem dados de localizacao.', position: null });
                });
            return;
        }
        dbMain.get('SELECT latitude, longitude, radius, timestamp FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1',
            [target.id], (err, row) => {
                if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Sem dados de localizacao.', position: null });
                res.json({
                    status: 'sucesso', numero, alvo: target.name,
                    position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius || 500 },
                    timestamp: row.timestamp, fonte: 'historico_real'
                });
            });
    });
});

// Busca ativa
app.get('/api/buscar/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT id, name FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT OR IGNORE INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + numero.slice(-4), numero],
                () => res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado. Sem dados de localizacao.' }));
            return;
        }
        dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [target.id], (err, row) => {
            if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Sem dados de localizacao.' });
            res.json({
                status: 'sucesso', numero, alvo: target.name,
                position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius },
                timestamp: row.timestamp, fonte: 'historico_real'
            });
        });
    });
});

// Localização por células
app.post('/api/localizar-por-cells', (req, res) => {
    const { numero, cells } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) return res.status(400).json({ erro: 'Array de celulas obrigatorio.' });

    dbMain.get('SELECT id FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + (numero || '').slice(-4), numero],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ erro: insertErr.message });
                    salvarCelulas(this.lastID, cells, res);
                });
        } else {
            salvarCelulas(target.id, cells, res);
        }
    });
});

function salvarCelulas(targetId, cells, res) {
    const dbTowers = new sqlite3.Database(DB_TOWERS);
    const cellIds = cells.map(c => c.cellId);
    const placeholders = cellIds.map(() => '?').join(',');
    dbTowers.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + placeholders + ')',
        cellIds, (err, torres) => {
            dbTowers.close();
            let lat = null, lon = null, radius = null;
            if (torres && torres.length > 0) {
                let pesoTotal = 0;
                torres.forEach(t => {
                    const peso = 1 / Math.max(t.range || 500, 1);
                    lat = (lat || 0) + t.lat * peso;
                    lon = (lon || 0) + t.lon * peso;
                    pesoTotal += peso;
                });
                lat /= pesoTotal;
                lon /= pesoTotal;
                radius = Math.round(torres.reduce((a, t) => a + (t.range || 500), 0) / torres.length / Math.sqrt(torres.length));
            }
            dbMain.run(
                'INSERT INTO locations (target_id, cell_data, source, metodo, torres_usadas, latitude, longitude, radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [targetId, JSON.stringify(cells), 'api', lat ? 'triangulacao' : 'dados_brutos', cells.length, lat, lon, radius],
                function(err) {
                    if (err) return res.status(500).json({ erro: err.message });
                    res.json({
                        status: lat ? 'localizado' : 'recebido',
                        mensagem: lat ? 'Localizacao calculada com sucesso.' : 'Celulas registradas. Banco de torres indisponivel para triangulacao.',
                        position: lat ? { latitude: lat, longitude: lon, raio_estimado: radius } : null,
                        timestamp: new Date().toISOString()
                    });
                }
            );
        });
}

// Monitor celular
app.get('/api/cellular/status', (req, res) => res.json({ status: 'monitorando', timestamp: new Date().toISOString() }));
app.post('/api/cellular/registro', (req, res) => res.json({ status: 'ok', tipo: 'registro', dados: req.body }));
app.post('/api/cellular/broadcast', (req, res) => res.json({ status: 'ok', tipo: 'broadcast', dados: req.body }));
app.post('/api/cellular/paging', (req, res) => res.json({ status: 'ok', tipo: 'paging', dados: req.body }));
app.get('/api/ticket/:id', (req, res) => res.json({ ticket_id: parseInt(req.params.id), status: 'monitorando' }));

// ============================================================
// INICIALIZAÇÃO COM IMPORTAÇÃO INTELIGENTE
// ============================================================
async function iniciarServidor() {
    let precisaImportar = true;

    if (fs.existsSync(DB_TOWERS)) {
        const dbCheck = new sqlite3.Database(DB_TOWERS);
        const tableExists = await new Promise((resolve) => {
            dbCheck.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_towers'", (err, row) => resolve(!!row));
        });
        if (tableExists) {
            const count = await new Promise((resolve) => {
                dbCheck.get('SELECT COUNT(*) as c FROM cell_towers', (err, r) => resolve(r ? r.c : 0));
            });
            precisaImportar = count < 1000000;
        }
        dbCheck.close();
    }

    if (precisaImportar) {
        let deveTentar = true;
        if (fs.existsSync(LOCK_FILE)) {
            const lockTime = new Date(fs.readFileSync(LOCK_FILE, 'utf8').trim());
            if (Date.now() - lockTime.getTime() < 24 * 60 * 60 * 1000) {
                log('info', 'Importacao ja tentada nas ultimas 24h. Pulando.');
                deveTentar = false;
            }
        }
        if (deveTentar) {
            fs.writeFileSync(LOCK_FILE, new Date().toISOString());
            log('info', 'Iniciando importacao do banco de torres...');
            try {
                const { execSync } = require('child_process');
                execSync('node scripts/import-render.js', { stdio: 'inherit', timeout: 600000 });
                log('info', 'Importacao concluida!');
                try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
            } catch (err) {
                log('error', 'Falha na importacao: ' + err.message);
                log('warn', 'Servidor iniciara sem banco de torres.');
            }
        }
    } else {
        log('info', 'Banco de torres OK');
    }

    app.listen(port, () => {
        log('info', 'ORION 5.1 rodando na porta ' + port);
        log('info', 'Banco de torres: ' + (fs.existsSync(DB_TOWERS) ? 'OK' : 'PENDENTE'));
    });
}

iniciarServidor();
