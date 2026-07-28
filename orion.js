// ============================================================
// ARQUIVO: orion.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 11:39 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Token do Unwired Labs incorporado.
//         AI-DEPOM 5.7 — Motor de Rede Completo ativado.
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

// ============================================================
// TOKENS E CHAVES DE ACESSO
// ============================================================
const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';
const UNWIRED_TOKEN = process.env.UNWIRED_TOKEN || 'pk.b6eadaf01c1bce6c3c8eb52bc8b30211';

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
        servidor: 'AI-DEPOM',
        versao: '5.7',
        status: 'online',
        motor: 'Motor de Rede Completo + Unwired Labs',
        fontes: ['unwired_labs', 'banco_local', 'mls', 'opencellid', 'wifi', 'ip', 'cache', 'rssi'],
        tokens: {
            unwired: UNWIRED_TOKEN ? 'configurado' : 'pendente',
            opencellid: API_KEY ? 'configurado' : 'pendente'
        },
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        servidor: 'AI-DEPOM',
        versao: '5.7',
        fontes_ativas: ['Unwired Labs (Primária)', 'Banco Local', 'MLS', 'OpenCellID', 'Wi-Fi', 'IP', 'Cache'],
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
// PROCESSAMENTO PRINCIPAL (UNWIRED LABS COMO FONTE PRIMÁRIA)
// ============================================================
async function processarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, res) {
    const torresEncontradas = [];
    
    // 1. Cache
    for (const cell of cells) {
        const cached = await consultarCache(cell.cellId);
        if (cached) torresEncontradas.push(cached);
    }
    if (torresEncontradas.length > 0) {
        log('info', 'Cache: ' + torresEncontradas.length + ' torres.');
        const pos = calcularTriangulacao(torresEncontradas);
        gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'cache', res);
        return;
    }
    
    // 2. UNWIRED LABS (FONTE PRIMÁRIA PAGA)
    try {
        const unwiredResult = await consultarUnwiredMulti(cells);
        if (unwiredResult && unwiredResult.latitude) {
            log('info', 'Unwired Labs: localizacao obtida com sucesso.');
            for (const cell of cells) {
                await atualizarCache(cell.cellId, unwiredResult.latitude, unwiredResult.longitude, unwiredResult.radius, 'unwired_labs');
            }
            gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, unwiredResult, 'unwired_labs', res);
            return;
        }
    } catch (e) {
        log('warn', 'Unwired Labs falhou: ' + e.message);
    }
    
    // 3. Banco Local
    try {
        const dbTowers = new sqlite3.Database(DB_TOWERS);
        const cellIds = cells.map(c => c.cellId);
        const placeholders = cellIds.map(() => '?').join(',');
        const torres = await new Promise((resolve) => {
            dbTowers.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + placeholders + ')', cellIds, (err, rows) => { dbTowers.close(); resolve(err ? [] : rows); });
        });
        if (torres && torres.length > 0) {
            for (const t of torres) { await atualizarCache(t.cell, t.lat, t.lon, t.range, 'banco_local'); torresEncontradas.push(t); }
            const pos = calcularTriangulacao(torresEncontradas);
            gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'banco_local', res);
            return;
        }
    } catch (e) {}
    
    // 4. Wi-Fi
    if (wifiAccessPoints && Array.isArray(wifiAccessPoints) && wifiAccessPoints.length > 0) {
        try { const wifiPos = await consultarWiFi(wifiAccessPoints); if (wifiPos) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, wifiPos, 'wifi', res); return; } } catch (e) {}
    }
    
    // 5. APIs Externas
    for (const cell of cells) {
        const info = await consultarTorreComRetry(cell.cellId);
        if (info) { await atualizarCache(cell.cellId, info.lat, info.lon, info.range, 'api_externa'); torresEncontradas.push(info); }
    }
    if (torresEncontradas.length > 0) {
        const pos = calcularTriangulacao(torresEncontradas);
        gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, pos, 'api_externa', res);
        return;
    }
    
    // 6. IP
    if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') {
        try { const ipPos = await consultarIP(clientIp); if (ipPos) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, ipPos, 'ip', res); return; } } catch (e) {}
    }
    
    // 7. RSSI
    const estimativa = estimarPorRSSI(cells);
    if (estimativa) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, estimativa, 'rssi_estimativa', res); return; }
    
    gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, null, 'sem_dados', res);
}

// ============================================================
// UNWIRED LABS
// ============================================================
function consultarUnwiredMulti(cells) {
    if (!UNWIRED_TOKEN || cells.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
        const cellData = cells.map(c => ({ lac: c.lac || 1234, cid: c.cellId, signal: c.rssi || c.rsrp || -73 }));
        const data = JSON.stringify({ token: UNWIRED_TOKEN, radio: 'gsm', mcc: cells[0].mcc || 724, mnc: cells[0].mnc || 5, cells: cellData, address: 1 });
        const req = https.request({ hostname: 'us1.unwiredlabs.com', path: '/v2/process.php', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { const r = JSON.parse(body); if (r.status === 'ok' && r.lat && r.lon) resolve({ latitude: r.lat, longitude: r.lon, radius: r.accuracy || 150, torres_usadas: cells.length }); else resolve(null); } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data); req.end();
    });
}

// ============================================================
// CACHE, Wi-Fi, IP, APIs EXTERNAS, RSSI, TRIANGULAÇÃO, GRAVAÇÃO
// ============================================================
function consultarCache(cellId) {
    return new Promise((resolve) => {
        dbCache.get('SELECT lat, lon, range, fonte FROM cell_cache WHERE cell_id = ? AND created_at > datetime("now", "-24 hours")', [cellId], (err, row) => resolve(row ? { cell: cellId, lat: row.lat, lon: row.lon, range: row.range, fonte: row.fonte } : null));
    });
}
function atualizarCache(cellId, lat, lon, range, fonte) {
    return new Promise((resolve) => { dbCache.run('INSERT OR REPLACE INTO cell_cache (cell_id, lat, lon, range, fonte, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [cellId, lat, lon, range, fonte], () => resolve()); });
}
function consultarWiFi(wifiAccessPoints) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ wifiAccessPoints });
        const req = https.request({ hostname: 'location.services.mozilla.com', path: '/v1/geolocate?key=test', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => { try { const r = JSON.parse(body); if (r.location && r.location.lat) resolve({ latitude: r.location.lat, longitude: r.location.lng, radius: r.accuracy || 50 }); else resolve(null); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data); req.end();
    });
}
function consultarIP(ip) {
    return new Promise((resolve) => {
        dbCache.get('SELECT lat, lon, range FROM ip_cache WHERE ip = ? AND created_at > datetime("now", "-1 hours")', [ip], (err, row) => {
            if (row) { resolve({ latitude: row.lat, longitude: row.lon, radius: row.range }); return; }
            const req = https.get('http://ip-api.com/json/' + ip + '?fields=lat,lon', (response) => {
                let body = ''; response.on('data', chunk => body += chunk);
                response.on('end', () => {
                    try { const d = JSON.parse(body); if (d.lat && d.lon) { dbCache.run('INSERT OR REPLACE INTO ip_cache (ip, lat, lon, range, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [ip, d.lat, d.lon, 5000]); resolve({ latitude: d.lat, longitude: d.lon, radius: 5000 }); } else resolve(null); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(3000, () => { req.destroy(); resolve(null); });
        });
    });
}
async function consultarTorreComRetry(cellId, tentativas = 2) {
    for (let i = 0; i < tentativas; i++) { const r = await consultarTorreAPIs(cellId); if (r) return r; if (i < tentativas - 1) await new Promise(r => setTimeout(r, 1000)); }
    return null;
}
async function consultarTorreAPIs(cellId) {
    try { const mls = await consultarMLS(cellId); if (mls) return mls; } catch (e) {}
    if (API_KEY) { try { const oci = await consultarOpenCellID(cellId); if (oci) return oci; } catch (e) {} }
    return null;
}
function consultarMLS(cellId, mcc = 724, mnc = 5, lac = 1234) {
    return new Promise((resolve) => {
        const data = JSON.stringify({ cellTowers: [{ cellId, mobileCountryCode: mcc, mobileNetworkCode: mnc, locationAreaCode: lac }] });
        const req = https.request({ hostname: 'location.services.mozilla.com', path: '/v1/geolocate?key=test', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => { try { const r = JSON.parse(body); if (r.location && r.location.lat) resolve({ cell: cellId, lat: r.location.lat, lon: r.location.lng, range: r.accuracy || 500 }); else resolve(null); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data); req.end();
    });
}
function consultarOpenCellID(cellId) {
    return new Promise((resolve) => {
        if (!API_KEY) { resolve(null); return; }
        const req = https.get('https://opencellid.org/cell/get?key=' + API_KEY + '&cell=' + cellId + '&format=json', (response) => {
            let body = ''; response.on('data', chunk => body += chunk);
            response.on('end', () => { try { const d = JSON.parse(body); if (d.lat && d.lon) resolve({ cell: cellId, lat: d.lat, lon: d.lon, range: d.range || 500 }); else resolve(null); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}
function estimarPorRSSI(cells) {
    if (!cells || cells.length < 2) return null;
    const txPower = -50, n = 3.0;
    const distancias = cells.map(c => Math.pow(10, (txPower - (c.rssi || c.rsrp || -73)) / (10 * n)));
    const distanciaMedia = distancias.reduce((a, b) => a + b, 0) / distancias.length;
    return { latitude: null, longitude: null, radius: Math.round(distanciaMedia), torres_usadas: cells.length };
}
function calcularTriangulacao(torres) {
    let lat = 0, lon = 0, pesoTotal = 0;
    torres.forEach(t => { const peso = 1 / Math.max(t.range || 500, 1); lat += t.lat * peso; lon += t.lon * peso; pesoTotal += peso; });
    return { latitude: lat / pesoTotal, longitude: lon / pesoTotal, radius: Math.round(torres.reduce((a, t) => a + (t.range || 500), 0) / torres.length / Math.sqrt(torres.length)), torres_usadas: torres.length };
}
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
        const tableExists = await new Promise((resolve) => { dbCheck.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_towers'", (err, row) => resolve(!!row)); });
        if (tableExists) {
            const count = await new Promise((resolve) => { dbCheck.get('SELECT COUNT(*) as c FROM cell_towers', (err, r) => resolve(r ? r.c : 0)); });
            precisaImportar = count < 1000000;
        }
        dbCheck.close();
    }
    if (precisaImportar) {
        let deveTentar = true;
        if (fs.existsSync(LOCK_FILE)) { const lockTime = new Date(fs.readFileSync(LOCK_FILE, 'utf8').trim()); if (Date.now() - lockTime.getTime() < 24 * 60 * 60 * 1000) deveTentar = false; }
        if (deveTentar) {
            fs.writeFileSync(LOCK_FILE, new Date().toISOString());
            try { const { execSync } = require('child_process'); execSync('node scripts/import-render.js', { stdio: 'inherit', timeout: 600000 }); try { fs.unlinkSync(LOCK_FILE); } catch (e) {} } catch (err) { log('error', 'Falha na importacao: ' + err.message); }
        }
    }
    app.listen(port, () => {
        log('info', 'AI-DEPOM 5.7 rodando na porta ' + port);
        log('info', 'Unwired Labs: CONFIGURADO');
        log('info', 'OpenCellID: ' + (API_KEY ? 'CONFIGURADO' : 'PENDENTE'));
        log('info', 'Motor de Rede Completo ativo.');
    });
}
iniciarServidor();
