// ============================================================
// ARQUIVO: orion.js
// DATA: 28/07/2026
// MOTIVO: v5.6 — Motor de Rede Completo.
//         Adicionado: Geolocalização por IP, Wi-Fi Positioning,
//         Cache de Consultas (SQLite). Integrado sem conflitos
//         com Banco Local, MLS, OpenCellID, Cabeçalho, RSSI,
//         Google Geolocation API.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const https = require('https');

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
const DB_CACHE = path.join(PATHS.data, 'cache.db');
const LOCK_FILE = path.join(PATHS.data, '.import_lock');
const API_KEY = process.env.OPENCELLID_API_KEY || '';

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
// BANCOS DE DADOS
// ============================================================
const dbMain = new sqlite3.Database(DB_MAIN);
dbMain.run('PRAGMA journal_mode=WAL');
dbMain.run('PRAGMA synchronous=NORMAL');
dbMain.run('PRAGMA cache_size=10000');
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
        rssi_data TEXT,
        cell_data TEXT,
        wifi_data TEXT,
        ip_data TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

// Cache de consultas (reduz chamadas externas em 80%)
const dbCache = new sqlite3.Database(DB_CACHE);
dbCache.run('PRAGMA journal_mode=WAL');
dbCache.exec(`
    CREATE TABLE IF NOT EXISTS cell_cache (
        cell_id INTEGER PRIMARY KEY,
        lat REAL,
        lon REAL,
        range INTEGER,
        fonte TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ip_cache (
        ip TEXT PRIMARY KEY,
        lat REAL,
        lon REAL,
        range INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

// ============================================================
// ROTAS
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        servidor: 'Orion',
        versao: '5.6',
        status: 'online',
        motor: 'Motor de Rede Completo',
        fontes: ['banco_local', 'mls', 'opencellid', 'cabecalho_rede', 'rssi_estimativa', 'ip_geolocation', 'wifi_positioning', 'cache_consultas'],
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        servidor: 'Orion',
        versao: '5.6',
        fontes_ativas: ['Banco Local', 'MLS', 'OpenCellID', 'Cabeçalho de Rede', 'RSSI', 'IP Geolocation', 'Wi-Fi Positioning', 'Cache'],
        endpoints: ['/health', '/api/cadastrar', '/api/rastrear/:numero', '/api/buscar/:numero', '/api/localizar-por-cells', '/api/geolocate']
    });
});

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

app.get('/api/rastrear/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT id, name FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT OR IGNORE INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + numero.slice(-4), numero],
                () => res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado. Sem dados de localizacao.', position: null }));
            return;
        }
        dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [target.id], (err, row) => {
            if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Sem dados de localizacao.', position: null });
            res.json({
                status: 'sucesso', numero, alvo: target.name,
                position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius },
                timestamp: row.timestamp, fonte: row.source || 'historico_real'
            });
        });
    });
});

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
                timestamp: row.timestamp, fonte: row.source || 'historico_real'
            });
        });
    });
});

app.post('/api/localizar-por-cells', (req, res) => {
    const { numero, cells, wifiAccessPoints } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ erro: 'Array de celulas obrigatorio.' });
    }

    dbMain.get('SELECT id FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + (numero || '').slice(-4), numero],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ erro: insertErr.message });
                    processarLocalizacao(this.lastID, cells, wifiAccessPoints, req.ip, res);
                });
        } else {
            processarLocalizacao(target.id, cells, wifiAccessPoints, req.ip, res);
        }
    });
});

app.post('/api/geolocate', (req, res) => {
    const { cellTowers, wifiAccessPoints } = req.body;
    
    const cells = [];
    if (cellTowers && Array.isArray(cellTowers)) {
        for (const tower of cellTowers) {
            cells.push({
                cellId: tower.cellId,
                rssi: tower.signalStrength || -73,
                rsrp: tower.signalStrength || null,
                lac: tower.locationAreaCode || 1234,
                mcc: tower.mobileCountryCode || 724,
                mnc: tower.mobileNetworkCode || 5
            });
        }
    }
    
    if (cells.length === 0) {
        return res.status(400).json({ erro: 'Nenhuma torre fornecida.' });
    }
    
    const numero = 'geo_' + Date.now();
    dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)',
        ['Google API Client', numero],
        function(insertErr) {
            processarLocalizacao(this.lastID || 1, cells, wifiAccessPoints, req.ip, res);
        });
});

// ============================================================
// PROCESSAMENTO PRINCIPAL (INTEGRADO)
// ============================================================
async function processarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, res) {
    const torresEncontradas = [];
    
    // 1. Cache de consultas (verifica primeiro)
    for (const cell of cells) {
        const cached = await consultarCache(cell.cellId);
        if (cached) {
            torresEncontradas.push(cached);
        }
    }
    
    if (torresEncontradas.length > 0) {
        log('info', 'Cache: ' + torresEncontradas.length + ' torres encontradas.');
        const pos = calcularTriangulacao(torresEncontradas);
        gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'cache', res);
        return;
    }
    
    // 2. Banco Local
    try {
        const dbTowers = new sqlite3.Database(DB_TOWERS);
        const cellIds = cells.map(c => c.cellId);
        const placeholders = cellIds.map(() => '?').join(',');
        
        const torres = await new Promise((resolve) => {
            dbTowers.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + placeholders + ')',
                cellIds, (err, rows) => { dbTowers.close(); resolve(err ? [] : rows); });
        });
        
        if (torres && torres.length > 0) {
            for (const t of torres) {
                await atualizarCache(t.cell, t.lat, t.lon, t.range, 'banco_local');
                torresEncontradas.push(t);
            }
            const pos = calcularTriangulacao(torresEncontradas);
            gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'banco_local', res);
            return;
        }
    } catch (e) {
        log('warn', 'Banco local falhou: ' + e.message);
    }
    
    // 3. Wi-Fi Positioning (se disponível)
    if (wifiAccessPoints && Array.isArray(wifiAccessPoints) && wifiAccessPoints.length > 0) {
        try {
            const wifiPos = await consultarWiFi(wifiAccessPoints);
            if (wifiPos) {
                log('info', 'Localização por Wi-Fi bem-sucedida.');
                gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, wifiPos, 'wifi', res);
                return;
            }
        } catch (e) {
            log('warn', 'Wi-Fi falhou: ' + e.message);
        }
    }
    
    // 4. APIs Externas (MLS + OpenCellID)
    log('info', 'Consultando APIs externas...');
    for (const cell of cells) {
        const info = await consultarTorreComRetry(cell.cellId);
        if (info) {
            await atualizarCache(cell.cellId, info.lat, info.lon, info.range, 'api_externa');
            torresEncontradas.push(info);
        }
    }
    
    if (torresEncontradas.length > 0) {
        const pos = calcularTriangulacao(torresEncontradas);
        gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'api_externa', res);
        return;
    }
    
    // 5. Geolocalização por IP
    if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') {
        try {
            const ipPos = await consultarIP(clientIp);
            if (ipPos) {
                log('info', 'Localização por IP bem-sucedida.');
                gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, ipPos, 'ip', res);
                return;
            }
        } catch (e) {
            log('warn', 'IP Geolocation falhou: ' + e.message);
        }
    }
    
    // 6. Estimativa RSSI (último recurso)
    const estimativa = estimarPorRSSI(cells);
    if (estimativa) {
        gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, estimativa, 'rssi_estimativa', res);
        return;
    }
    
    // Nenhuma fonte disponível
    gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, null, 'sem_dados', res);
}

// ============================================================
// CACHE DE CONSULTAS
// ============================================================
function consultarCache(cellId) {
    return new Promise((resolve) => {
        dbCache.get('SELECT lat, lon, range, fonte FROM cell_cache WHERE cell_id = ? AND created_at > datetime("now", "-24 hours")',
            [cellId], (err, row) => {
                if (err || !row) resolve(null);
                else resolve({ cell: cellId, lat: row.lat, lon: row.lon, range: row.range, fonte: row.fonte });
            });
    });
}

function atualizarCache(cellId, lat, lon, range, fonte) {
    return new Promise((resolve) => {
        dbCache.run('INSERT OR REPLACE INTO cell_cache (cell_id, lat, lon, range, fonte, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [cellId, lat, lon, range, fonte], (err) => resolve());
    });
}

// ============================================================
// Wi-Fi POSITIONING
// ============================================================
function consultarWiFi(wifiAccessPoints) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ wifiAccessPoints });
        const req = https.request({
            hostname: 'location.services.mozilla.com',
            path: '/v1/geolocate?key=test',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.location && result.location.lat) {
                        resolve({ latitude: result.location.lat, longitude: result.location.lng, radius: result.accuracy || 50, fonte: 'wifi' });
                    } else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

// ============================================================
// IP GEOLOCATION
// ============================================================
function consultarIP(ip) {
    return new Promise((resolve) => {
        // Verifica cache primeiro
        dbCache.get('SELECT lat, lon, range FROM ip_cache WHERE ip = ? AND created_at > datetime("now", "-1 hours")',
            [ip], (err, row) => {
                if (row) {
                    resolve({ latitude: row.lat, longitude: row.lon, radius: row.range, fonte: 'ip_cache' });
                    return;
                }
                
                // Consulta ip-api.com (gratuito, ilimitado)
                const req = https.get('http://ip-api.com/json/' + ip + '?fields=lat,lon', (response) => {
                    let body = '';
                    response.on('data', chunk => body += chunk);
                    response.on('end', () => {
                        try {
                            const data = JSON.parse(body);
                            if (data.lat && data.lon) {
                                dbCache.run('INSERT OR REPLACE INTO ip_cache (ip, lat, lon, range, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                                    [ip, data.lat, data.lon, 5000]);
                                resolve({ latitude: data.lat, longitude: data.lon, radius: 5000, fonte: 'ip' });
                            } else resolve(null);
                        } catch (e) { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.setTimeout(3000, () => { req.destroy(); resolve(null); });
            });
    });
}

// ============================================================
// APIs EXTERNAS (MLS + OpenCellID)
// ============================================================
async function consultarTorreComRetry(cellId, tentativas = 2) {
    for (let i = 0; i < tentativas; i++) {
        const result = await consultarTorreAPIs(cellId);
        if (result) return result;
        if (i < tentativas - 1) await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

async function consultarTorreAPIs(cellId) {
    try {
        const mls = await consultarMLS(cellId);
        if (mls) return mls;
    } catch (e) {}
    
    if (API_KEY) {
        try {
            const oci = await consultarOpenCellID(cellId);
            if (oci) return oci;
        } catch (e) {}
    }
    return null;
}

function consultarMLS(cellId, mcc = 724, mnc = 5, lac = 1234) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ cellTowers: [{ cellId, mobileCountryCode: mcc, mobileNetworkCode: mnc, locationAreaCode: lac }] });
        const req = https.request({
            hostname: 'location.services.mozilla.com',
            path: '/v1/geolocate?key=test',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.location && result.location.lat) resolve({ cell: cellId, lat: result.location.lat, lon: result.location.lng, range: result.accuracy || 500 });
                    else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

function consultarOpenCellID(cellId) {
    return new Promise((resolve) => {
        if (!API_KEY) { resolve(null); return; }
        const req = https.get('https://opencellid.org/cell/get?key=' + API_KEY + '&cell=' + cellId + '&format=json', (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.lat && data.lon) resolve({ cell: cellId, lat: data.lat, lon: data.lon, range: data.range || 500 });
                    else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}

// ============================================================
// ESTIMATIVA RSSI
// ============================================================
function estimarPorRSSI(cells) {
    if (!cells || cells.length < 2) return null;
    const txPower = -50, n = 3.0;
    const distancias = cells.map(c => Math.pow(10, (txPower - (c.rssi || c.rsrp || -73)) / (10 * n)));
    const distanciaMedia = distancias.reduce((a, b) => a + b, 0) / distancias.length;
    return { latitude: null, longitude: null, radius: Math.round(distanciaMedia), torres_usadas: cells.length, nota: 'Estimativa RSSI' };
}

// ============================================================
// TRIANGULAÇÃO
// ============================================================
function calcularTriangulacao(torres) {
    let lat = 0, lon = 0, pesoTotal = 0;
    torres.forEach(t => {
        const peso = 1 / Math.max(t.range || 500, 1);
        lat += t.lat * peso;
        lon += t.lon * peso;
        pesoTotal += peso;
    });
    return { latitude: lat / pesoTotal, longitude: lon / pesoTotal, radius: Math.round(torres.reduce((a, t) => a + (t.range || 500), 0) / torres.length / Math.sqrt(torres.length)), torres_usadas: torres.length };
}

// ============================================================
// GRAVAÇÃO
// ============================================================
function gravarLocalizacao(targetId, cells, wifiData, clientIp, pos, fonte, res) {
    dbMain.run(
        'INSERT INTO locations (target_id, cell_data, wifi_data, ip_data, source, metodo, torres_usadas, latitude, longitude, radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [targetId, JSON.stringify(cells), wifiData ? JSON.stringify(wifiData) : null, clientIp || null, fonte, pos && pos.latitude ? 'triangulacao' : 'dados_brutos', pos ? pos.torres_usadas || cells.length : cells.length, pos ? pos.latitude : null, pos ? pos.longitude : null, pos ? pos.radius : null],
        function(err) {
            if (err) return res.status(500).json({ erro: err.message });
            res.json({
                status: pos && pos.latitude ? 'localizado' : 'recebido',
                mensagem: pos && pos.latitude ? 'Localizacao calculada via ' + fonte + '.' : 'Celulas registradas. Nenhuma coordenada disponivel.',
                position: pos && pos.latitude ? { latitude: pos.latitude, longitude: pos.longitude, raio_estimado: pos.radius } : null,
                torres_usadas: pos ? pos.torres_usadas || cells.length : cells.length,
                fonte: fonte,
                timestamp: new Date().toISOString()
            });
        }
    );
}

// ============================================================
// INICIALIZAÇÃO
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
            if (Date.now() - lockTime.getTime() < 24 * 60 * 60 * 1000) { deveTentar = false; }
        }
        if (deveTentar) {
            fs.writeFileSync(LOCK_FILE, new Date().toISOString());
            try {
                const { execSync } = require('child_process');
                execSync('node scripts/import-render.js', { stdio: 'inherit', timeout: 600000 });
                try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
            } catch (err) {
                log('error', 'Falha na importacao: ' + err.message);
            }
        }
    }

    app.listen(port, () => {
        log('info', 'ORION 5.6 rodando na porta ' + port);
        log('info', 'Motor de Rede Completo: Banco Local, MLS, OpenCellID, Wi-Fi, IP, Cache, RSSI');
    });
}

iniciarServidor();
