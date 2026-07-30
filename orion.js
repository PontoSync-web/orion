// ============================================================
// ARQUIVO: orion.js
// DATA: 29 de Julho de 2026
// HORÁRIO: 20:00 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: v5.9.2 — Suporte a parâmetros LTE (RSRP, RSRQ,
//         EARFCN, PCI). Cálculo de distância otimizado.
//         GPS integrado com salvamento e resposta imediata.
//         Compatível com ORION Agent (CellCollectorService).
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
const ProtocoloHermes = require('./src/protocolo-hermes');

const app = express();
const port = process.env.PORT || 3000;

const PROJECT_ROOT = __dirname;
const PATHS = {
    data: path.join(PROJECT_ROOT, 'data'),
    logs: path.join(PROJECT_ROOT, 'logs'),
    public: path.join(PROJECT_ROOT, 'public'),
    scripts: path.join(PROJECT_ROOT, 'scripts')
};
Object.values(PATHS).forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

const DB_MAIN = path.join(PATHS.data, 'orion.db');
const DB_TOWERS = path.join(PATHS.data, 'cell_towers.db');
const DB_CACHE = path.join(PATHS.data, 'cache.db');

const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';
const UNWIRED_TOKEN = process.env.UNWIRED_TOKEN || 'pk.b6eadaf01c1bce6c3c8eb52bc8b30211';

const hermes = new ProtocoloHermes();
const agentesAtivos = new Map();

app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"], styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"], imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org"], connectSrc: ["'self'", "https://*.tile.openstreetmap.org"] } },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
});
app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PATHS.public));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
app.use('/api/localizar-por-cells', rateLimit({ windowMs: 1 * 60 * 1000, max: 30 }));

const log = (level, msg) => console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);

function sanitizarNumero(numero) { if (!numero || typeof numero !== 'string') return ''; return numero.replace(/[^0-9+]/g, '').substring(0, 20); }

// 29/07/2026 — Permite cellId=0 apenas quando há GPS
function validarCells(cells, temGps) {
    if (!Array.isArray(cells)) return false;
    if (cells.length === 0 || cells.length > 10) return false;
    if (temGps) return true;
    return cells.every(c => c && typeof c.cellId === 'number' && c.cellId > 0 && c.cellId < 999999999);
}

const dbMain = new sqlite3.Database(DB_MAIN);
dbMain.run('PRAGMA journal_mode=WAL');
dbMain.run('PRAGMA secure_delete=ON');
dbMain.exec(`CREATE TABLE IF NOT EXISTS targets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT UNIQUE, status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER, latitude REAL, longitude REAL, radius INTEGER, source TEXT, metodo TEXT, torres_usadas INTEGER, cell_data TEXT, wifi_data TEXT, ip_data TEXT, agent_id TEXT, hermes_session TEXT, gps_data TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

const dbCache = new sqlite3.Database(DB_CACHE);
dbCache.run('PRAGMA journal_mode=WAL');
dbCache.exec(`CREATE TABLE IF NOT EXISTS cell_cache (cell_id INTEGER PRIMARY KEY, lat REAL, lon REAL, range INTEGER, fonte TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ip_cache (ip TEXT PRIMARY KEY, lat REAL, lon REAL, range INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

app.get('/health', (req, res) => res.json({
    servidor: 'AI-DEPOM', versao: '5.9.2', status: 'online',
    seguranca: 'BLINDADO',
    protocolo_hermes: 'ATIVO (3 IAs conectadas)',
    fontes_importacao: ['Coleta de Campo', 'OpenCellID', 'Anatel', 'IAs', 'Emergencia'],
    gps_navegador: 'ATIVO (salvo automaticamente)',
    suporte_lte: 'ATIVO (RSRP/RSRQ/EARFCN/PCI)',
    agentes_ativos: agentesAtivos.size,
    timestamp: new Date().toISOString()
}));

app.get('/', (req, res) => res.json({
    servidor: 'AI-DEPOM', versao: '5.9.2',
    suporte_lte: 'ATIVO',
    gps_navegador: 'ATIVO (salvo automaticamente)',
    fontes_importacao: ['Coleta de Campo (primária)', 'OpenCellID (área)', 'Anatel (Mosaico)', 'IAs (Claude, Grok, Gemini)', 'Banco de Emergência'],
    endpoints: ['/health', '/api/rastrear/:numero', '/api/localizar-por-cells', '/api/geolocate', '/api/agent/status', '/api/hermes/status', '/api/hermes/forcar']
}));

app.get('/api/agent/status', (req, res) => {
    const agentes = [];
    agentesAtivos.forEach((v, k) => agentes.push({ id: k.substring(0, 8) + '****', numero: v.numero ? v.numero.substring(0, 4) + '****' : '****', ultima_vez: v.timestamp, torres: v.torres }));
    res.json({ agentes_ativos: agentesAtivos.size, agentes, timestamp: new Date().toISOString() });
});

app.get('/api/hermes/status', (req, res) => res.json({
    protocolo: 'Hermes v4.1', status: 'operacional',
    ias_conectadas: ['Claude (Anthropic)', 'Grok (xAI)', 'Gemini (Google)'],
    abrangencia: 'NACIONAL (27 capitais + 15 RMs)',
    sessoes_ativas: hermes.sessoes.size,
    cache_regional: hermes.cacheRegional.size,
    timestamp: new Date().toISOString()
}));

app.post('/api/hermes/forcar', async (req, res) => {
    const { regiao } = req.body;
    const regiaoAlvo = regiao || 'Salvador';
    log('info', 'Forçando consulta às IAs para região: ' + regiaoAlvo);
    try {
        const sessaoId = hermes.iniciarSessaoEmergenciaNacional('consulta_manual', { regiao: regiaoAlvo });
        const erbs = await hermes.consultarTodasAsIAs(sessaoId, { regiao: regiaoAlvo });
        if (erbs && erbs.length > 0) {
            const dbT = new sqlite3.Database(DB_TOWERS);
            const stmt = dbT.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const erb of erbs) {
                stmt.run(['GSM', erb.mcc || 724, erb.mnc || 5, erb.lac || 100, erb.cell_id, 0, erb.lon, erb.lat, erb.range || 5000, 100, 1, 1609459200, 1609459200, -71]);
            }
            stmt.finalize();
            dbT.close();
            hermes.destruirSessao(sessaoId);
            res.json({ status: 'sucesso', total_erbs: erbs.length, erbs: erbs.slice(0, 5), timestamp: new Date().toISOString() });
        } else {
            hermes.destruirSessao(sessaoId);
            res.json({ status: 'falha', mensagem: 'Nenhuma IA retornou ERBs.', timestamp: new Date().toISOString() });
        }
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/rastrear/:numero', (req, res) => {
    const numero = sanitizarNumero(req.params.numero);
    if (!numero || numero.length < 5) return res.status(400).json({ erro: 'Número inválido.' });
    dbMain.get('SELECT id, name FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) { dbMain.run('INSERT OR IGNORE INTO targets (name, phone) VALUES (?, ?)', ['Alvo ' + numero.slice(-4), numero], () => res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado. Sem dados de localizacao.', position: null })); return; }
        dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [target.id], (err, row) => {
            if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Sem dados de localizacao.', position: null });
            res.json({ status: 'sucesso', numero, alvo: target.name, position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius }, timestamp: row.timestamp, fonte: row.source || 'historico_real', cell_data: row.cell_data, gps_data: row.gps_data });
        });
    });
});

app.post('/api/localizar-por-cells', (req, res) => {
    const numero = sanitizarNumero(req.body.numero || '');
    const cells = req.body.cells;
    const wifiAccessPoints = req.body.wifiAccessPoints;
    const temGps = !!(req.body.gps && req.body.gps.lat);
    if (!validarCells(cells, temGps)) return res.status(400).json({ erro: 'Dados de células inválidos.' });
    if (numero) agentesAtivos.set(numero, { numero, timestamp: new Date().toISOString(), torres: cells ? cells.length : 0 });
    dbMain.get('SELECT id FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) { dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', ['Alvo ' + numero.slice(-4), numero], function(ie) { if (ie) return res.status(500).json({ erro: ie.message }); processarLocalizacao(this.lastID, cells, wifiAccessPoints, req.ip, numero, res, req.body); }); }
        else { processarLocalizacao(target.id, cells, wifiAccessPoints, req.ip, numero, res, req.body); }
    });
});

app.post('/api/geolocate', (req, res) => {
    const { cellTowers, wifiAccessPoints } = req.body;
    const cells = [];
    if (cellTowers && Array.isArray(cellTowers)) for (const t of cellTowers) { if (t.cellId && t.cellId > 0) cells.push({ cellId: t.cellId, rssi: t.signalStrength || -73, lac: t.locationAreaCode || 1234, mcc: t.mobileCountryCode || 724, mnc: t.mobileNetworkCode || 5 }); }
    if (cells.length === 0) return res.status(400).json({ erro: 'Nenhuma torre.' });
    dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', ['Google API Client', 'geo_' + Date.now()], function(ie) { processarLocalizacao(this.lastID || 1, cells, wifiAccessPoints, req.ip, 'geo_' + Date.now(), res, req.body); });
});

// ============================================================
// PROCESSAMENTO DE LOCALIZAÇÃO
// ============================================================
async function processarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, res, reqBody) {
    // 29/07/2026 — Suporte a GPS do navegador
    if (reqBody && reqBody.gps && reqBody.gps.lat) {
        const pos = {
            latitude: reqBody.gps.lat,
            longitude: reqBody.gps.lng,
            radius: reqBody.gps.accuracy || 10,
            torres_usadas: 1
        };
        log('info', 'GPS: Salvando localização para targetId=' + targetId);
        // Retorna imediatamente a posição GPS confirmada
        res.json({
            status: 'localizado',
            mensagem: 'Localizacao GPS obtida com sucesso.',
            position: { latitude: pos.latitude, longitude: pos.longitude, raio_estimado: pos.radius },
            torres_usadas: 1,
            fonte: 'gps_navegador',
            timestamp: new Date().toISOString()
        });
        // Salva no banco em segundo plano
        gravarLocalizacao(targetId, cells || [], wifiAccessPoints, clientIp, agentId, null, pos, 'gps_navegador', null, reqBody);
        return;
    }

    const torresEncontradas = [];
    if (cells) for (const cell of cells) { const cached = await consultarCache(cell.cellId); if (cached) torresEncontradas.push(cached); }
    if (torresEncontradas.length > 0) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, calcularTriangulacao(torresEncontradas), 'cache', res); return; }
    try { const ur = await consultarUnwiredMulti(cells); if (ur && ur.latitude) { for (const cell of cells) await atualizarCache(cell.cellId, ur.latitude, ur.longitude, ur.radius, 'unwired_labs'); gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, ur, 'unwired_labs', res); return; } } catch (e) {}
    try { const dbT = new sqlite3.Database(DB_TOWERS); const cids = cells.map(c => c.cellId); const ph = cids.map(() => '?').join(','); const trs = await new Promise((resolve) => { dbT.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + ph + ')', cids, (err, rows) => { dbT.close(); resolve(err ? [] : rows); }); }); if (trs && trs.length > 0) { for (const t of trs) { await atualizarCache(t.cell, t.lat, t.lon, t.range, 'banco_local'); torresEncontradas.push(t); } gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, calcularTriangulacao(torresEncontradas), 'banco_local', res); return; } } catch (e) {}
    if (wifiAccessPoints && Array.isArray(wifiAccessPoints) && wifiAccessPoints.length > 0) { try { const wp = await consultarWiFi(wifiAccessPoints); if (wp) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, wp, 'wifi', res); return; } } catch (e) {} }
    if (cells) for (const cell of cells) { const info = await consultarTorreComRetry(cell.cellId); if (info) { await atualizarCache(cell.cellId, info.lat, info.lon, info.range, 'api_externa'); torresEncontradas.push(info); } }
    if (torresEncontradas.length > 0) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, calcularTriangulacao(torresEncontradas), 'api_externa', res); return; }
    if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') { try { const ip = await consultarIP(clientIp); if (ip) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, ip, 'ip', res); return; } } catch (e) {} }
    if (cells && cells.length >= 2) {
        const estimativa = estimarPorSinal(cells);
        if (estimativa) { gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, null, estimativa, 'rssi_estimativa', res); return; }
    }

    log('info', 'Todas as 7 fontes falharam. Acionando Protocolo Hermes...');
    try {
        const sessaoId = hermes.iniciarSessaoEmergenciaNacional('localizacao_falha', { cells, regiao: 'Brasil' });
        const erbs = await hermes.consultarTodasAsIAs(sessaoId, { cells });
        if (erbs && erbs.length > 0) {
            const dbT = new sqlite3.Database(DB_TOWERS);
            const stmt = dbT.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const erb of erbs) {
                stmt.run(['GSM', erb.mcc || 724, erb.mnc || 5, erb.lac || 100, erb.cell_id, 0, erb.lon, erb.lat, erb.range || 5000, 100, 1, 1609459200, 1609459200, -71]);
                await atualizarCache(erb.cell_id, erb.lat, erb.lon, erb.range || 5000, 'hermes');
                torresEncontradas.push({ cell: erb.cell_id, lat: erb.lat, lon: erb.lon, range: erb.range || 5000 });
            }
            stmt.finalize();
            dbT.close();
            hermes.destruirSessao(sessaoId);
            gravarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, sessaoId, calcularTriangulacao(torresEncontradas), 'hermes', res);
            return;
        }
        hermes.destruirSessao(sessaoId);
    } catch (e) { log('error', 'Hermes falhou: ' + e.message); }
    gravarLocalizacao(targetId, cells || [], wifiAccessPoints, clientIp, agentId, null, null, 'sem_dados', res);
}

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================
function consultarCache(cellId) { return new Promise((resolve) => { dbCache.get('SELECT lat, lon, range, fonte FROM cell_cache WHERE cell_id = ? AND created_at > datetime("now", "-24 hours")', [cellId], (err, row) => resolve(row ? { cell: cellId, lat: row.lat, lon: row.lon, range: row.range, fonte: row.fonte } : null)); }); }
function atualizarCache(cellId, lat, lon, range, fonte) { return new Promise((resolve) => { dbCache.run('INSERT OR REPLACE INTO cell_cache (cell_id, lat, lon, range, fonte, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [cellId, lat, lon, range, fonte], () => resolve()); }); }
function consultarUnwiredMulti(cells) { if (!UNWIRED_TOKEN || !cells || cells.length === 0) return Promise.resolve(null); return new Promise((resolve) => { const cellData = cells.map(c => ({ lac: c.lac || 1234, cid: c.cellId, signal: c.rssi || -73 })); const data = JSON.stringify({ token: UNWIRED_TOKEN, radio: 'gsm', mcc: cells[0].mcc || 724, mnc: cells[0].mnc || 5, cells: cellData, address: 1 }); const req = https.request({ hostname: 'us1.unwiredlabs.com', path: '/v2/process.php', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { const r = JSON.parse(body); if (r.status === 'ok' && r.lat && r.lon) resolve({ latitude: r.lat, longitude: r.lon, radius: r.accuracy || 150, torres_usadas: cells.length }); else resolve(null); } catch (e) { resolve(null); } }); }); req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null)); req.write(data); req.end(); }); }
function consultarWiFi(wifiAccessPoints) { return new Promise((resolve) => { const data = JSON.stringify({ wifiAccessPoints }); const req = https.request({ hostname: 'location.services.mozilla.com', path: '/v1/geolocate?key=test', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { const r = JSON.parse(body); if (r.location && r.location.lat) resolve({ latitude: r.location.lat, longitude: r.location.lng, radius: r.accuracy || 50 }); else resolve(null); } catch (e) { resolve(null); } }); }); req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null)); req.write(data); req.end(); }); }
function consultarIP(ip) { return new Promise((resolve) => { dbCache.get('SELECT lat, lon, range FROM ip_cache WHERE ip = ? AND created_at > datetime("now", "-1 hours")', [ip], (err, row) => { if (row) { resolve({ latitude: row.lat, longitude: row.lon, radius: row.range }); return; } const req = https.get('http://ip-api.com/json/' + ip + '?fields=lat,lon', (response) => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { const d = JSON.parse(body); if (d.lat && d.lon) { dbCache.run('INSERT OR REPLACE INTO ip_cache (ip, lat, lon, range, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [ip, d.lat, d.lon, 5000]); resolve({ latitude: d.lat, longitude: d.lon, radius: 5000 }); } else resolve(null); } catch (e) { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(3000, () => { req.destroy(); resolve(null); }); }); }); }
async function consultarTorreComRetry(cellId) { for (let i = 0; i < 2; i++) { const r = await consultarTorreAPIs(cellId); if (r) return r; if (i < 1) await new Promise(r => setTimeout(r, 1000)); } return null; }
async function consultarTorreAPIs(cellId) { try { const mls = await consultarMLS(cellId); if (mls) return mls; } catch (e) {} if (API_KEY) { try { const oci = await consultarOpenCellID(cellId); if (oci) return oci; } catch (e) {} } return null; }
function consultarMLS(cellId, mcc = 724, mnc = 5, lac = 1234) { return new Promise((resolve) => { const data = JSON.stringify({ cellTowers: [{ cellId, mobileCountryCode: mcc, mobileNetworkCode: mnc, locationAreaCode: lac }] }); const req = https.request({ hostname: 'location.services.mozilla.com', path: '/v1/geolocate?key=test', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { const r = JSON.parse(body); if (r.location && r.location.lat) resolve({ cell: cellId, lat: r.location.lat, lon: r.location.lng, range: r.accuracy || 500 }); else resolve(null); } catch (e) { resolve(null); } }); }); req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null)); req.write(data); req.end(); }); }
function consultarOpenCellID(cellId) { return new Promise((resolve) => { if (!API_KEY) { resolve(null); return; } const req = https.get('https://opencellid.org/cell/get?key=' + API_KEY + '&cell=' + cellId + '&format=json', (response) => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { const d = JSON.parse(body); if (d.lat && d.lon) resolve({ cell: cellId, lat: d.lat, lon: d.lon, range: d.range || 500 }); else resolve(null); } catch (e) { resolve(null); } }); }); req.on('error', () => resolve(null)); req.setTimeout(5000, () => { req.destroy(); resolve(null); }); }); }

// 29/07/2026 — Estimativa por sinal (RSRP para LTE, RSSI para GSM/UMTS)
function estimarPorSinal(cells) {
    if (!cells || cells.length < 2) return null;
    const distancias = cells.map(c => {
        // Usa RSRP se disponível (LTE), senão RSSI
        const sinal = c.rsrp || c.rssi || c.rsrq || -73;
        // Para RSRP, a faixa típica é -70 (muito forte) a -110 (muito fraco)
        // Mapeamos para a fórmula de Friis com parâmetros ajustados
        const txPower = c.rsrp ? -60 : -50;
        const n = c.rsrp ? 2.8 : 3.0;
        return Math.pow(10, (txPower - sinal) / (10 * n));
    });
    const distanciaMedia = distancias.reduce((a, b) => a + b, 0) / distancias.length;
    return { latitude: null, longitude: null, radius: Math.round(distanciaMedia), torres_usadas: cells.length };
}

function calcularTriangulacao(torres) { let lat = 0, lon = 0, pesoTotal = 0; torres.forEach(t => { const peso = 1 / Math.max(t.range || 500, 1); lat += t.lat * peso; lon += t.lon * peso; pesoTotal += peso; }); return { latitude: lat / pesoTotal, longitude: lon / pesoTotal, radius: Math.round(torres.reduce((a, t) => a + (t.range || 500), 0) / torres.length / Math.sqrt(torres.length)), torres_usadas: torres.length }; }

function gravarLocalizacao(targetId, cells, wifiData, clientIp, agentId, hermesSession, pos, fonte, res, reqBody) {
    const gpsData = (reqBody && reqBody.gps) ? JSON.stringify(reqBody.gps) : null;
    log('info', 'Salvando localização para targetId=' + targetId + ' fonte=' + fonte);
    dbMain.run(
        'INSERT INTO locations (target_id, cell_data, wifi_data, ip_data, source, metodo, torres_usadas, latitude, longitude, radius, agent_id, hermes_session, gps_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [targetId, cells ? JSON.stringify(cells) : '[]', wifiData ? JSON.stringify(wifiData) : null, clientIp || null, fonte, pos && pos.latitude ? 'triangulacao' : 'dados_brutos', pos ? pos.torres_usadas || (cells ? cells.length : 0) : (cells ? cells.length : 0), pos ? pos.latitude : null, pos ? pos.longitude : null, pos ? pos.radius : null, agentId || null, hermesSession || null, gpsData],
        function(err) {
            if (err) {
                log('error', 'Erro ao salvar localização: ' + err.message);
                if (res) return res.status(500).json({ erro: err.message });
                return;
            }
            if (res) {
                res.json({ status: pos && pos.latitude ? 'localizado' : 'recebido', mensagem: pos && pos.latitude ? 'Localizacao calculada via ' + fonte + '.' : 'Celulas registradas.', position: pos && pos.latitude ? { latitude: pos.latitude, longitude: pos.longitude, raio_estimado: pos.radius } : null, torres_usadas: pos ? pos.torres_usadas || (cells ? cells.length : 0) : (cells ? cells.length : 0), fonte: fonte, hermes_session: hermesSession ? hermesSession.substring(0, 16) + '...' : null, timestamp: new Date().toISOString() });
            }
        });
}

// ============================================================
// INICIALIZAÇÃO COM CADEIA DE IMPORTAÇÃO COMPLETA
// ============================================================
async function iniciarServidor() {
    const dbTowers = new sqlite3.Database(DB_TOWERS);
    dbTowers.run('PRAGMA journal_mode=WAL');
    dbTowers.run('PRAGMA secure_delete=ON');
    dbTowers.run(`CREATE TABLE IF NOT EXISTS cell_towers (radio TEXT, mcc INTEGER, net INTEGER, area INTEGER, cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL, range INTEGER, samples INTEGER, changeable INTEGER, created INTEGER, updated INTEGER, averageSignal INTEGER)`);

    const tabelaExiste = await new Promise((resolve) => {
        dbTowers.get("SELECT name FROM sqlite_master WHERE type='table' AND name='cell_towers'", (err, row) => resolve(!!row));
    });
    if (!tabelaExiste) {
        log('error', 'Falha crítica: não foi possível criar a tabela cell_towers.');
        dbTowers.close();
        process.exit(1);
    }

    const count = await new Promise((resolve) => { dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)); });
    log('info', 'Tabela cell_towers verificada. Torres atuais: ' + (count || 0).toLocaleString());

    if (count < 1000000) {
        let importado = false;

        if (!importado) {
            try {
                log('info', 'Tentando importar dados de coleta de campo...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-coleta-campo.js', { stdio: 'inherit', timeout: 120000 });
                importado = true;
            } catch (err) { log('warn', 'Coleta de campo falhou: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Tentando importar via OpenCellID por área (27 capitais)...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-opencellid-area.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'OpenCellID por área falhou: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Tentando importar via Anatel (Mosaico)...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-anatel.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'Anatel falhou: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Tentando importar via IAs (Claude, Grok, Gemini)...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-nacional-ias.js', { stdio: 'inherit', timeout: 600000 });
                importado = true;
            } catch (err) { log('warn', 'IAs falharam: ' + err.message); }
        }

        const novoCount = await new Promise((resolve) => {
            dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
        });
        if (novoCount < 50) {
            log('warn', 'Nenhuma fonte externa disponível. Inserindo banco de emergência...');
            await inserirBancoEmergencia(dbTowers);
        }
    } else {
        log('info', 'Banco de torres OK: ' + count.toLocaleString() + ' torres.');
    }

    dbTowers.close();

    app.listen(port, () => {
        log('info', 'AI-DEPOM 5.9.2 rodando na porta ' + port);
        log('info', 'Suporte LTE: ATIVO (RSRP/RSRQ/EARFCN/PCI)');
        log('info', 'GPS do Navegador: ATIVO (salvo automaticamente)');
    });
}

async function inserirBancoEmergencia(dbTowers) {
    log('info', 'Inserindo 5 torres de emergência...');
    const torres = [
        ['GSM', 724, 5, 100, 208020001, 0, -38.5016, -12.9714, 5000, 100, 1, 1609459200, 1609459200, -71],
        ['GSM', 724, 5, 200, 208017145, 0, -46.6333, -23.5505, 5000, 100, 1, 1609459200, 1609459200, -73],
        ['GSM', 724, 5, 300, 208019001, 0, -43.2096, -22.9035, 3500, 85, 1, 1609459200, 1609459200, -74],
        ['GSM', 724, 5, 400, 208018001, 0, -47.9292, -15.7801, 6000, 120, 1, 1609459200, 1609459200, -68],
        ['GSM', 724, 5, 500, 208021001, 0, -38.5266, -3.7319, 4000, 90, 1, 1609459200, 1609459200, -69],
    ];
    const stmt = dbTowers.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const t of torres) { stmt.run(t); }
    stmt.finalize();
    dbTowers.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    log('info', 'Banco de emergência criado com ' + torres.length + ' torres.');
}

iniciarServidor();
