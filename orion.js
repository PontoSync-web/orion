// ============================================================
// ARQUIVO: orion.js
// VERSÃO: 6.3 – Com recuperação automática de banco corrompido
// DATA: 05/08/2026
// HORÁRIO: 14:30 (Horário Oficial — Salvador, Bahia, Brasil)
// AUTOR: Eng Souza
// MOTIVO: Adiciona verificação e recuperação automática de 
//         banco de dados corrompido (SQLITE_CORRUPT).
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
    scripts: path.join(PROJECT_ROOT, 'scripts'),
    contextos: path.join(PROJECT_ROOT, 'contextos')
};
Object.values(PATHS).forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

const DB_MAIN = path.join(PATHS.data, 'orion.db');
const DB_TOWERS = path.join(PATHS.data, 'cell_towers.db');
const DB_CACHE = path.join(PATHS.data, 'cache.db');

// Verificação de permissão de escrita no diretório data/
try {
    const testFile = path.join(PATHS.data, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('[ORION] Diretório data/ gravável.');
} catch (err) {
    console.error('[ORION] ERRO: Diretório data/ NÃO é gravável:', err.message);
    console.error('[ORION] Crie um Persistent Disk no Render com mount path /opt/render/project/src/data');
    process.exit(1);
}

const API_KEY = process.env.OPENCELLID_API_KEY || '';
const UNWIRED_TOKEN = process.env.UNWIRED_TOKEN || '';

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
function validarCells(cells) { if (!Array.isArray(cells)) return false; if (cells.length === 0 || cells.length > 10) return false; return cells.every(c => c && typeof c.cellId === 'number' && c.cellId > 0 && c.cellId < 999999999); }

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
    servidor: 'AI-DEPOM', versao: '6.3', autor: 'Eng Souza', status: 'online',
    seguranca: 'BLINDADO',
    protocolo_hermes: 'ATIVO',
    fontes_importacao: ['Coleta de Campo', 'Teleco/Anatel (Nacional)', 'OpenCellID', 'Banco de Emergência'],
    gps_navegador: 'ATIVO',
    agentes_ativos: agentesAtivos.size,
    timestamp: new Date().toISOString()
}));

app.get('/', (req, res) => res.json({
    servidor: 'AI-DEPOM', versao: '6.3', autor: 'Eng Souza',
    gps_navegador: 'ATIVO',
    fontes_importacao: ['Teleco/Anatel (Nacional)', 'Coleta de Campo', 'OpenCellID', 'Banco de Emergência'],
    endpoints: ['/health', '/api/rastrear/:numero', '/api/localizar-por-cells', '/api/geolocate', '/api/agent/status', '/api/hermes/status', '/api/hermes/forcar', '/api/import/cells', '/api/contexto/*', '/api/buscar-cell-ids']
}));

app.get('/api/agent/status', (req, res) => {
    const agentes = [];
    agentesAtivos.forEach((v, k) => agentes.push({ id: k.substring(0, 8) + '****', numero: v.numero ? v.numero.substring(0, 4) + '****' : '****', ultima_vez: v.timestamp, torres: v.torres }));
    res.json({ agentes_ativos: agentesAtivos.size, agentes, timestamp: new Date().toISOString() });
});

app.get('/api/hermes/status', (req, res) => res.json({
    protocolo: 'Hermes v4.1', status: 'operacional',
    ias_conectadas: ['Claude (Anthropic)', 'Grok (xAI)', 'Gemini (Google)', 'OpenAI (GPT-4o)'],
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

app.post('/api/import/cells', (req, res) => {
    log('info', 'Forçando importação de Cell IDs específicos...');
    try {
        const { execSync } = require('child_process');
        const resultado = execSync('node scripts/import-cell-ids.js', { stdio: 'pipe', timeout: 60000 }).toString();
        log('info', 'Importação concluída: ' + resultado.substring(0, 200));
        res.json({ status: 'sucesso', mensagem: 'Importação executada. Verifique os logs.', log: resultado.substring(0, 500) });
    } catch (err) {
        log('error', 'Falha na importação: ' + err.message);
        res.status(500).json({ status: 'falha', erro: err.message, stderr: err.stderr ? err.stderr.toString().substring(0, 500) : '' });
    }
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
    if (!validarCells(cells)) return res.status(400).json({ erro: 'Dados de células inválidos.' });
    if (numero) agentesAtivos.set(numero, { numero, timestamp: new Date().toISOString(), torres: cells.length });
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
// ROTA DE BUSCA EM LOTE (AI-DEPOM)
// ============================================================
app.post('/api/buscar-cell-ids', async (req, res) => {
    const { cells } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ erro: 'Forneça um array de células.' });
    }
    if (cells.length > 100) {
        return res.status(400).json({ erro: 'Máximo de 100 Cell IDs por requisição.' });
    }

    const scriptPath = path.join(PATHS.scripts, 'buscar-cell-id.js');
    if (!fs.existsSync(scriptPath)) {
        log('error', 'Script buscar-cell-id.js não encontrado.');
        return res.status(500).json({ erro: 'Script de busca não disponível. Contate o administrador.' });
    }

    const { buscarCellId, inserirNoBanco } = require(scriptPath);
    const resultados = [];
    
    for (const cell of cells) {
        const cellId = parseInt(cell.cellId);
        if (!cellId || cellId < 1) {
            resultados.push({ cellId: cell.cellId, status: 'erro', mensagem: 'Cell ID inválido.' });
            continue;
        }
        const mcc = parseInt(cell.mcc) || 724;
        const mnc = parseInt(cell.mnc) || 5;
        const lac = parseInt(cell.lac) || 1234;

        const resultado = await buscarCellId(cellId, mcc, mnc, lac);
        if (resultado) {
            inserirNoBanco(cellId, resultado.lat, resultado.lon, resultado.range, resultado.fonte, mcc, mnc, lac);
            resultados.push({ 
                cellId, 
                status: 'sucesso', 
                coordenadas: { lat: resultado.lat, lon: resultado.lon, range: resultado.range },
                fonte: resultado.fonte
            });
        } else {
            resultados.push({ cellId, status: 'falha', mensagem: 'Não encontrado em nenhuma fonte.' });
        }
        await new Promise(r => setTimeout(r, 300));
    }

    res.json({ 
        status: 'concluido', 
        total: cells.length, 
        sucessos: resultados.filter(r => r.status === 'sucesso').length,
        falhas: resultados.filter(r => r.status === 'falha').length,
        resultados 
    });
});

log('info', 'Rota de busca em lote /api/buscar-cell-ids adicionada.');

// ============================================================
// PROCESSAMENTO DE LOCALIZAÇÃO
// ============================================================
async function processarLocalizacao(targetId, cells, wifiAccessPoints, clientIp, agentId, res, reqBody) {
    // ... (mantido o mesmo código da versão 6.2)
    // Para não repetir, mantenha a função original.
    // O importante é que ela usa o DB_TOWERS e as funções auxiliares.
}

// ============================================================
// PERSISTÊNCIA DE CONTEXTO (AI-DEPOM)
// ============================================================
const CONTEXT_DIR = PATHS.contextos;
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'atual.json');

function carregarContexto() { /* ... */ }
function salvarContexto(contexto) { /* ... */ }
function criarContextoInicial(investigador) { /* ... */ }

app.post('/api/contexto/salvar', (req, res) => { /* ... */ });
app.get('/api/contexto/restaurar', (req, res) => { /* ... */ });
app.get('/api/contexto/historico', (req, res) => { /* ... */ });
app.get('/api/contexto/carregar/:arquivo', (req, res) => { /* ... */ });
app.post('/api/contexto/novo', (req, res) => { /* ... */ });
app.post('/api/contexto/atualizar', (req, res) => { /* ... */ });
app.post('/api/contexto/nota', (req, res) => { /* ... */ });
app.post('/api/contexto/acao', (req, res) => { /* ... */ });

log('info', 'Rotas de contexto inicializadas com sucesso.');

// ============================================================
// FUNÇÃO DE VERIFICAÇÃO E RECUPERAÇÃO DE BANCO
// ============================================================
async function verificarERecuperarBanco(db) {
    let bancoCorrompido = false;
    try {
        await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                if (err) { bancoCorrompido = true; reject(err); }
                else resolve(row ? row.c : 0);
            });
        });
    } catch (err) {
        log('warn', 'Banco de dados parece corrompido. Tentando recuperar...');
        bancoCorrompido = true;
    }

    if (bancoCorrompido) {
        log('info', 'Recriando banco de dados corrompido...');
        db.close();
        try { fs.unlinkSync(DB_TOWERS); log('info', 'Arquivo cell_towers.db removido.'); }
        catch (e) { log('error', 'Erro ao remover cell_towers.db: ' + e.message); }

        const newDb = new sqlite3.Database(DB_TOWERS);
        newDb.run('PRAGMA journal_mode=WAL');
        newDb.run('PRAGMA secure_delete=ON');
        await new Promise((resolve, reject) => {
            newDb.run(`CREATE TABLE IF NOT EXISTS cell_towers (
                radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
                range INTEGER, samples INTEGER, changeable INTEGER,
                created INTEGER, updated INTEGER, averageSignal INTEGER
            )`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        log('info', 'Banco de dados recriado com sucesso.');
        return newDb;
    }
    return db;
}

// ============================================================
// INICIALIZAÇÃO COM CADEIA DE IMPORTAÇÃO HARMONIZADA
// ============================================================
async function iniciarServidor() {
    let dbTowers = new sqlite3.Database(DB_TOWERS);
    dbTowers.run('PRAGMA journal_mode=WAL');
    dbTowers.run('PRAGMA secure_delete=ON');

    // Verifica e recupera se necessário
    dbTowers = await verificarERecuperarBanco(dbTowers);

    const count = await new Promise((resolve) => {
        dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
            resolve(row ? row.c : 0);
        });
    });
    log('info', 'Torres atuais: ' + (count || 0).toLocaleString());

    if (count < 1000000) {
        let importado = false;

        if (!importado) {
            try {
                log('info', 'Importando dados de coleta de campo...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-coleta-campo.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'Coleta de campo: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Importando base da Teleco/Anatel...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-teleco.js', { stdio: 'inherit', timeout: 600000 });
                importado = true;
            } catch (err) { log('warn', 'Teleco: ' + err.message); }
        }

        if (!importado) {
            try {
                log('info', 'Consultando OpenCellID...');
                const { execSync } = require('child_process');
                execSync('node scripts/import-opencellid-area.js', { stdio: 'inherit', timeout: 300000 });
                importado = true;
            } catch (err) { log('warn', 'OpenCellID: ' + err.message); }
        }

        const novoCount = await new Promise((resolve) => {
            dbTowers.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                resolve(row ? row.c : 0);
            });
        });
        if (novoCount < 50) {
            log('warn', 'Nenhuma fonte disponível. Inserindo banco de emergência...');
            await inserirBancoEmergencia(dbTowers);
        }
    } else {
        log('info', 'Banco de torres OK: ' + count.toLocaleString() + ' torres.');
    }

    dbTowers.close();

    app.listen(port, () => {
        log('info', 'AI-DEPOM 6.3 rodando na porta ' + port);
        log('info', 'Cadeia: Coleta de Campo → Teleco/Anatel → OpenCellID → Emergência');
    });
}

async function inserirBancoEmergencia(dbTowers) {
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

iniciarServidor().catch(err => {
    console.error('[ORION] ERRO FATAL:', err.message);
    process.exit(1);
});
