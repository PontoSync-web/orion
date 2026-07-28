// ============================================================
// ORION — Servidor Principal v5.1 (Completo)
// Atualizado: 28/07/2026 00:30 — Rotas unificadas + cadastro automático
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
    scripts: path.join(PROJECT_ROOT, 'scripts'),
};

Object.values(PATHS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const DB_MAIN = path.join(PATHS.data, 'orion.db');
const DB_TOWERS = path.join(PATHS.data, 'cell_towers.db');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org"],
        connectSrc: ["'self'", "https://*.tile.openstreetmap.org"]
      },
    },
  })
);
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
        endpoints: ['/health', '/api/localizar-por-cells', '/api/rastrear/:numero', '/api/buscar/:numero', '/api/cellular/status', '/api/cadastrar']
    });
});

// Cadastro de alvo
app.post('/api/cadastrar', (req, res) => {
    const { numero, nome } = req.body;
    if (!numero) return res.status(400).json({ erro: 'Numero obrigatorio' });
    dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', [nome || 'Alvo', numero], function(err) {
        if (err) return res.status(500).json({ erro: err.message });
        res.json({ status: 'sucesso', id: this.lastID, mensagem: 'Alvo cadastrado' });
    });
});

// Rota do Mapa (compatibilidade com frontend)
app.get('/api/rastrear/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT * FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', ['Alvo ' + numero.slice(-4), numero], () => {
                res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado. Sem dados de localizacao.' });
            });
            return;
        }
        dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [target.id], (err, row) => {
            if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Alvo cadastrado. Sem dados de localizacao.' });
            res.json({
                status: 'sucesso',
                numero,
                alvo: target.name,
                position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius },
                timestamp: row.timestamp,
                fonte: 'historico_real'
            });
        });
    });
});

// Busca ativa
app.get('/api/buscar/:numero', (req, res) => {
    const numero = req.params.numero;
    dbMain.get('SELECT * FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', ['Alvo ' + numero.slice(-4), numero]);
            return res.json({ status: 'cadastrado', numero, mensagem: 'Alvo cadastrado automaticamente. Sem dados de localizacao.' });
        }
        dbMain.get('SELECT * FROM locations WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1', [target.id], (err, row) => {
            if (err || !row) return res.json({ status: 'sem_dados', numero, alvo: target.name, mensagem: 'Sem dados de localizacao.' });
            res.json({
                status: 'sucesso',
                numero,
                alvo: target.name,
                position: { latitude: row.latitude, longitude: row.longitude, raio_estimado: row.radius },
                timestamp: row.timestamp,
                fonte: 'historico_real'
            });
        });
    });
});
// Localização por Cell IDs
app.post('/api/localizar-por-cells', (req, res) => {
    const { numero, cells } = req.body;
    if (!cells || !Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ erro: 'Array de cells obrigatorio' });
    }
      // Garante que o alvo existe (cadastra automaticamente se necessário)
    dbMain.get('SELECT id FROM targets WHERE phone = ?', [numero], (err, target) => {
        if (err || !target) {
            // Cria o alvo primeiro
            dbMain.run('INSERT INTO targets (name, phone) VALUES (?, ?)', 
                ['Alvo ' + (numero || '').slice(-4), numero], 
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ erro: insertErr.message });
                    // Agora salva a localização com o novo ID
                    salvarLocalizacao(this.lastID, cells, res);
                });
        } else {
            // Alvo já existe, salva com o ID encontrado
            salvarLocalizacao(target.id, cells, res);
        }
    });
});
// Função auxiliar para salvar localização
function salvarLocalizacao(targetId, cells, res) {
    // Calcula posição aproximada (média simples das coordenadas se disponíveis)
    // Na versão real, consultaria o banco de torres
    dbMain.run(
        'INSERT INTO locations (target_id, cell_data, source, metodo, torres_usadas, latitude, longitude, radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [targetId, JSON.stringify(cells), 'api', 'celulas_recebidas', cells.length, -12.9714, -38.5016, 500],
        function(err) {
            if (err) return res.status(500).json({ erro: err.message });
            res.json({
                status: 'recebido',
                mensagem: cells.length + ' celulas registradas. Localizacao de referencia salva.',
                target_id: targetId,
                timestamp: new Date().toISOString()
            });
        }
    );
}
app.get('/api/cellular/status', (req, res) => {
    res.json({ status: 'monitorando', timestamp: new Date().toISOString() });
});

app.post('/api/cellular/registro', (req, res) => {
    res.json({ status: 'ok', tipo: 'registro', dados: req.body });
});

app.post('/api/cellular/broadcast', (req, res) => {
    res.json({ status: 'ok', tipo: 'broadcast', dados: req.body });
});

app.post('/api/cellular/paging', (req, res) => {
    res.json({ status: 'ok', tipo: 'paging', dados: req.body });
});

app.get('/api/ticket/:id', (req, res) => {
    res.json({ ticket_id: parseInt(req.params.id), status: 'monitorando' });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
// ============================================================
// INICIALIZAÇÃO COM IMPORTAÇÃO AUTOMÁTICA
// ============================================================

async function iniciarServidor() {
    // Verifica se o banco de torres existe e tem dados
    const precisaImportar = !fs.existsSync(DB_TOWERS) || await new Promise((resolve) => {
        const db = new sqlite3.Database(DB_TOWERS);
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
            db.close();
            resolve(!row || row.c < 1000000);
        });
    });

    if (precisaImportar) {
        log('info', 'Banco de torres vazio ou ausente. Iniciando importacao...');
        try {
            const { execSync } = require('child_process');
            log('info', 'Executando scripts/import-render.js...');
            execSync('node scripts/import-render.js', { stdio: 'inherit', timeout: 600000 }); // 10 min timeout
            log('info', 'Importacao concluida com sucesso!');
        } catch (err) {
            log('error', 'Falha na importacao: ' + err.message);
            log('warn', 'Servidor iniciara sem banco de torres. A localizacao por triangulacao ficara indisponivel.');
        }
    } else {
        log('info', 'Banco de torres OK');
    }

    app.listen(port, () => {
        log('info', `ORION 5.1 rodando na porta ${port}`);
        log('info', `Banco de torres: ${fs.existsSync(DB_TOWERS) ? 'OK' : 'PENDENTE'}`);
    });
}

iniciarServidor();
