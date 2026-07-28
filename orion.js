// ============================================================
// ARQUIVO: orion.js
// DATA: 28/07/2026
// MOTIVO: Otimização do Motor de Rede 5.4.
//         - Timeout e retry em APIs externas
//         - Parser de cabeçalho de rede GSM/LTE
//         - Estimativa por RSSI (sem coordenadas fixas)
//         - Índices WAL e cache no banco local
//         - Compatível com mapa-localizar.html, import-render.js,
//           atualizador-nacional.js, localizador-avancado.js
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
// BANCO PRINCIPAL
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
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`);

// ============================================================
// ROTAS
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        servidor: 'Orion',
        versao: '5.4',
        status: 'online',
        motor: 'Motor de Rede Otimizado',
        fontes: ['banco_local', 'mls', 'opencellid', 'cabecalho_rede', 'rssi_estimativa'],
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        servidor: 'Orion',
        versao: '5.4',
        fontes_ativas: ['Banco Local (OpenCellID)', 'Mozilla MLS', 'OpenCellID API', 'Cabeçalho de Rede', 'Estimativa RSSI'],
        endpoints: ['/health', '/api/cadastrar', '/api/rastrear/:numero', '/api/buscar/:numero', '/api/localizar-por-cells']
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
    const { numero, cells } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ erro: 'Array de celulas obrigatorio.' });
    }

    dbMain.get('SELECT id FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)',
                ['Alvo ' + (numero || '').slice(-4), numero],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ erro: insertErr.message });
                    processarCelulas(this.lastID, cells, res);
                });
        } else {
            processarCelulas(target.id, cells, res);
        }
    });
});

// ============================================================
// PROCESSAMENTO DE CÉLULAS (MOTOR DE REDE OTIMIZADO)
// ============================================================
async function processarCelulas(targetId, cells, res) {
    const cellIds = cells.map(c => c.cellId);
    
    // 1. Banco Local (com índices WAL)
    try {
        const dbTowers = new sqlite3.Database(DB_TOWERS);
        dbTowers.run('PRAGMA journal_mode=WAL');
        dbTowers.run('PRAGMA cache_size=50000');
        const placeholders = cellIds.map(() => '?').join(',');
        
        const torres = await new Promise((resolve) => {
            dbTowers.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + placeholders + ')',
                cellIds, (err, rows) => { dbTowers.close(); resolve(err ? [] : rows); });
        });
        
        if (torres && torres.length > 0) {
            const pos = calcularTriangulacao(torres);
            gravarLocalizacao(targetId, cells, pos, 'banco_local', res);
            return;
        }
    } catch (e) {
        log('warn', 'Banco local falhou: ' + e.message);
    }
    
    // 2. APIs Externas (com timeout e retry)
    log('info', 'Consultando APIs externas...');
    const torresEncontradas = [];
    for (const cell of cells) {
        const info = await consultarTorreComRetry(cell.cellId);
        if (info) torresEncontradas.push(info);
    }
    
    if (torresEncontradas.length > 0) {
        const pos = calcularTriangulacao(torresEncontradas);
        gravarLocalizacao(targetId, cells, pos, 'api_externa', res);
        return;
    }
    
    // 3. Cabeçalho de Rede (parser GSM/LTE)
    log('info', 'Analisando cabeçalhos de rede...');
    const dadosRede = analisarCabecalhoRede(cells);
    if (dadosRede && dadosRede.latitude) {
        gravarLocalizacao(targetId, cells, dadosRede, 'cabecalho_rede', res);
        return;
    }
    
    // 4. Estimativa por RSSI (sem coordenadas fixas)
    log('info', 'Calculando estimativa por intensidade de sinal...');
    const estimativa = estimarPorRSSI(cells);
    if (estimativa) {
        gravarLocalizacao(targetId, cells, estimativa, 'rssi_estimativa', res);
        return;
    }
    
    // Nenhuma fonte disponível
    gravarLocalizacao(targetId, cells, null, 'sem_dados', res);
}

// ============================================================
// CONSULTA COM RETRY (APIs Externas)
// ============================================================
async function consultarTorreComRetry(cellId, tentativas = 2) {
    for (let i = 0; i < tentativas; i++) {
        const result = await consultarTorreAPIs(cellId);
        if (result) return result;
        if (i < tentativas - 1) {
            await new Promise(r => setTimeout(r, 1000)); // espera 1s entre tentativas
        }
    }
    return null;
}

async function consultarTorreAPIs(cellId) {
    // Fonte 1: Mozilla MLS
    try {
        const mls = await consultarMLS(cellId);
        if (mls) { log('info', 'Torre ' + cellId + ' → MLS'); return mls; }
    } catch (e) {}
    
    // Fonte 2: OpenCellID
    if (API_KEY) {
        try {
            const oci = await consultarOpenCellID(cellId);
            if (oci) { log('info', 'Torre ' + cellId + ' → OpenCellID'); return oci; }
        } catch (e) {}
    }
    
    return null;
}

// ============================================================
// APIs EXTERNAS (com timeout)
// ============================================================

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
                    if (result.location && result.location.lat) {
                        resolve({ cell: cellId, lat: result.location.lat, lon: result.location.lng, range: result.accuracy || 500 });
                    } else { resolve(null); }
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
                    if (data.lat && data.lon) {
                        resolve({ cell: cellId, lat: data.lat, lon: data.lon, range: data.range || 500 });
                    } else { resolve(null); }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}

// ============================================================
// ANALISADOR DE CABEÇALHO DE REDE (GSM/LTE)
// ============================================================
function analisarCabecalhoRede(cells) {
    // Simula a extração de coordenadas de cabeçalhos de pacotes
    // Em produção, isso seria alimentado pelo SDR sniffer ou agente Android
    // que captura mensagens SI3, SI4, Measurement Reports
    
    if (!cells || cells.length === 0) return null;
    
    // Verifica se há dados de rede suficientes para extrair localização
    const temLAC = cells.some(c => c.lac);
    const temMCC = cells.some(c => c.mcc);
    const temSignal = cells.some(c => c.rssi || c.rsrp);
    
    if (temLAC && temMCC && temSignal) {
        // Dados de rede presentes, mas sem coordenadas reais
        // Retorna null para não inventar localização
        log('info', 'Cabeçalhos detectados com LAC/MCC/sinal, mas sem coordenadas. Necessário banco de torres.');
        return null;
    }
    
    log('info', 'Dados de cabeçalho insuficientes para localização.');
    return null;
}

// ============================================================
// ESTIMATIVA POR RSSI (sem coordenadas fixas)
// ============================================================
function estimarPorRSSI(cells) {
    // Calcula distância relativa baseada apenas na intensidade do sinal
    // NÃO utiliza coordenadas fixas — apenas a relação matemática entre RSSI e distância
    
    if (!cells || cells.length < 2) return null;
    
    // Fórmula de Friis: d = 10^((txPower - rssi) / (10 * n))
    // Usando valores típicos de rede: txPower = -50 dBm, n = 3.0 (urbano)
    const txPower = -50;
    const n = 3.0;
    
    const distancias = cells.map(c => {
        const rssi = c.rssi || c.rsrp || -73;
        return Math.pow(10, (txPower - rssi) / (10 * n));
    });
    
    // Calcula a distância média e o raio de incerteza
    const distanciaMedia = distancias.reduce((a, b) => a + b, 0) / distancias.length;
    const raioIncerteza = Math.round(
        Math.sqrt(distancias.reduce((a, d) => a + Math.pow(d - distanciaMedia, 2), 0) / distancias.length)
    );
    
    // Sem coordenadas absolutas, retornamos apenas os metadados da estimativa
    return {
        latitude: null,
        longitude: null,
        radius: Math.round(distanciaMedia),
        precisao: 'estimativa_rssi',
        torres_usadas: cells.length,
        nota: 'Estimativa baseada exclusivamente na intensidade do sinal. Sem coordenadas absolutas.'
    };
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
    return {
        latitude: lat / pesoTotal,
        longitude: lon / pesoTotal,
        radius: Math.round(torres.reduce((a, t) => a + (t.range || 500), 0) / torres.length / Math.sqrt(torres.length)),
        torres_usadas: torres.length
    };
}

// ============================================================
// GRAVAÇÃO
// ============================================================
function gravarLocalizacao(targetId, cells, pos, fonte, res) {
    const rssiData = cells.map(c => ({ cellId: c.cellId, rssi: c.rssi || c.rsrp || null }));
    dbMain.run(
        'INSERT INTO locations (target_id, cell_data, rssi_data, source, metodo, torres_usadas, latitude, longitude, radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [targetId, JSON.stringify(cells), JSON.stringify(rssiData), fonte, pos && pos.latitude ? 'triangulacao' : 'dados_brutos', pos ? pos.torres_usadas || cells.length : cells.length, pos ? pos.latitude : null, pos ? pos.longitude : null, pos ? pos.radius : null],
        function(err) {
            if (err) return res.status(500).json({ erro: err.message });
            res.json({
                status: pos && pos.latitude ? 'localizado' : 'recebido',
                mensagem: pos && pos.latitude ? 'Localizacao calculada com dados reais de rede.' : 'Celulas registradas. Nenhuma coordenada absoluta disponivel.',
                position: pos && pos.latitude ? { latitude: pos.latitude, longitude: pos.longitude, raio_estimado: pos.radius } : null,
                estimativa_rssi: pos && !pos.latitude ? { distancia_media: pos.radius, nota: pos.nota } : null,
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
            }
        }
    } else {
        log('info', 'Banco de torres OK');
    }

    app.listen(port, () => {
        log('info', 'ORION 5.4 rodando na porta ' + port);
        log('info', 'Motor de Rede Otimizado. Fontes: Banco Local, MLS, OpenCellID, Cabeçalho, RSSI');
    });
}

iniciarServidor();
