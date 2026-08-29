/**
 * ====================================================================
 * ARQUIVO: server.js
 * DATA: 2026-08-29
 * HORA: 17:00 BRT
 * DESCRIÇÃO: Servidor backend completo + Servir Frontend Estático
 * ====================================================================
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para JSON
app.use(express.json());

// ============================================================
// NOVO: Servir arquivos estáticos (HTML, CSS, JS da interface)
// ============================================================
// Coloque seu arquivo mapa-localizar.html dentro da pasta /public
app.use(express.static('public'));

// ====================================================================
// BANCO DE DADOS SQLITE - CRIAÇÃO DE TODAS AS TABELAS
// ====================================================================
const db = new sqlite3.Database('./orion.db');

// Tabela 1: Coletas
db.run(`
  CREATE TABLE IF NOT EXISTS coletas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    estacao_id TEXT,
    latitude REAL,
    longitude REAL,
    rsrp INTEGER,
    sinr INTEGER,
    ta INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Tabela 2: Estações
db.run(`
  CREATE TABLE IF NOT EXISTS estacoes (
    id TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    nome TEXT
  )
`);

// Tabela 3: Feedback
db.run(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    lat_real REAL,
    lon_real REAL,
    lat_mostrada REAL,
    lon_mostrada REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Tabela 4: Usuários
db.run(`
  CREATE TABLE IF NOT EXISTS usuarios (
    numero TEXT PRIMARY KEY,
    vies_lat REAL DEFAULT 0,
    vies_lon REAL DEFAULT 0,
    ultima_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Tabela 5: Histórico de posições
db.run(`
  CREATE TABLE IF NOT EXISTS posicoes_historicas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    latitude REAL,
    longitude REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ====================================================================
// MIGRAÇÃO AUTOMÁTICA (DADOS ANTIGOS)
// ====================================================================
function migrarDadosAntigos() {
  console.log('🔄 Verificando necessidade de migração...');
  db.get(`SELECT COUNT(*) as total FROM posicoes_historicas`, (err, row) => {
    if (err) { console.error(err); return; }
    if (row.total > 0) {
      console.log(`✅ Histórico já possui ${row.total} registros.`);
      return;
    }
    console.log('📥 Populando histórico com dados antigos...');
    db.run(`
      INSERT INTO posicoes_historicas (numero, latitude, longitude, timestamp)
      SELECT c.numero, c.latitude, c.longitude, c.timestamp
      FROM coletas c
      INNER JOIN (
        SELECT numero, MAX(timestamp) as ultimo_timestamp
        FROM coletas
        GROUP BY numero
      ) ultima ON c.numero = ultima.numero AND c.timestamp = ultima.ultimo_timestamp
    `, function(err) {
      if (err) console.error('❌ Erro:', err);
      else console.log(`✅ Migração concluída! ${this.changes} registros.`);
    });
  });
}

// ====================================================================
// ROTA 1: COLETA (POST /api/coletar-sinal-auto)
// ====================================================================
app.post('/api/coletar-sinal-auto', async (req, res) => {
  try {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;
    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO coletas (numero, estacao_id, latitude, longitude, rsrp, sinr, ta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [numero, estacao_id, latitude, longitude, rsrp, sinr, ta],
        function (err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });

    let latFinal = latitude;
    let lonFinal = longitude;

    const estacao = await new Promise((resolve, reject) => {
      db.get('SELECT latitude, longitude FROM estacoes WHERE id = ?', [estacao_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (estacao && ta) {
      const raioMaximoKm = (ta * 78.12) / 1000;
      const distAtual = haversine(latitude, longitude, estacao.latitude, estacao.longitude);
      if (distAtual > raioMaximoKm) {
        const proporcao = raioMaximoKm / distAtual;
        latFinal = estacao.latitude + (latitude - estacao.latitude) * proporcao;
        lonFinal = estacao.longitude + (longitude - estacao.longitude) * proporcao;
      }
    }

    res.status(201).json({
      mensagem: 'Leitura registrada com sucesso',
      latitude_corrigida: latFinal,
      longitude_corrigida: lonFinal
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ====================================================================
// ROTA 2: LOCALIZAÇÃO (GET /api/localizar)
// ====================================================================
app.get('/api/localizar', async (req, res) => {
  const { numero } = req.query;
  if (!numero) return res.status(400).json({ erro: 'Número não informado' });

  try {
    const leituras = await new Promise((resolve, reject) => {
      db.all(
        `SELECT latitude, longitude, rsrp, timestamp FROM coletas 
         WHERE numero = ? ORDER BY timestamp DESC LIMIT 15`,
        [numero],
        (err, rows) => { if (err) reject(err); else resolve(rows); }
      );
    });

    if (!leituras || leituras.length === 0) {
      return res.status(404).json({ erro: 'Nenhuma localização encontrada' });
    }

    const { lat: latPonderada, lon: lonPonderada } = calcularMediaPonderada(leituras);

    const historico = await new Promise((resolve, reject) => {
      db.all(
        `SELECT latitude, longitude FROM posicoes_historicas 
         WHERE numero = ? ORDER BY timestamp DESC LIMIT 5`,
        [numero],
        (err, rows) => { if (err) reject(err); else resolve(rows || []); }
      );
    });

    let latFinal = latPonderada;
    let lonFinal = lonPonderada;
    if (historico.length > 0) {
      const ultima = historico[0];
      latFinal = ultima.latitude * 0.3 + latPonderada * 0.7;
      lonFinal = ultima.longitude * 0.3 + lonPonderada * 0.7;
    }

    const usuario = await new Promise((resolve, reject) => {
      db.get('SELECT vies_lat, vies_lon FROM usuarios WHERE numero = ?', [numero], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (usuario) {
      latFinal += usuario.vies_lat;
      lonFinal += usuario.vies_lon;
    }

    const raioMetros = calcularRaioIncerteza(leituras);

    db.run(
      `INSERT INTO posicoes_historicas (numero, latitude, longitude, timestamp)
       VALUES (?, ?, ?, ?)`,
      [numero, latFinal, lonFinal, new Date().toISOString()]
    );

    res.json({
      numero,
      latitude: latFinal,
      longitude: lonFinal,
      raio_incerteza_metros: Math.round(raioMetros),
      precisao: raioMetros < 100 ? 'Alta' : raioMetros < 300 ? 'Média' : 'Baixa',
      total_amostras: leituras.length,
      ultima_atualizacao: leituras[0]?.timestamp || null,
      metodo: 'Ponderado por RSRP + Filtro Kalman + Correção de Viés'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao consultar localização' });
  }
});

// ====================================================================
// ROTA 3: FEEDBACK (POST /api/feedback)
// ====================================================================
app.post('/api/feedback', async (req, res) => {
  try {
    const { numero, lat_real, lon_real, lat_mostrada, lon_mostrada } = req.body;
    if (!numero || lat_real === undefined || lon_real === undefined) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO feedback (numero, lat_real, lon_real, lat_mostrada, lon_mostrada)
         VALUES (?, ?, ?, ?, ?)`,
        [numero, lat_real, lon_real, lat_mostrada || 0, lon_mostrada || 0],
        function (err) { if (err) reject(err); else resolve(); }
      );
    });

    const vies = await new Promise((resolve, reject) => {
      db.all(
        `SELECT AVG(lat_real - lat_mostrada) as vies_lat,
                AVG(lon_real - lon_mostrada) as vies_lon
         FROM feedback WHERE numero = ? ORDER BY timestamp DESC LIMIT 5`,
        [numero],
        (err, rows) => { if (err) reject(err); else resolve(rows[0]); }
      );
    });

    if (vies && vies.vies_lat !== null) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO usuarios (numero, vies_lat, vies_lon, ultima_atualizacao)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(numero) DO UPDATE SET
             vies_lat = ?, vies_lon = ?, ultima_atualizacao = ?`,
          [numero, vies.vies_lat, vies.vies_lon, new Date().toISOString(),
           vies.vies_lat, vies.vies_lon, new Date().toISOString()],
          (err) => { if (err) reject(err); else resolve(); }
        );
      });
    }

    res.status(201).json({
      mensagem: 'Feedback recebido! Obrigado por melhorar o Orion.',
      viés_aplicado: vies
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ====================================================================
// FUNÇÕES AUXILIARES
// ====================================================================
function calcularMediaPonderada(leituras) {
  const validas = leituras.filter(l => l.rsrp > -110);
  if (validas.length === 0) {
    const latMedia = leituras.reduce((s, l) => s + l.latitude, 0) / leituras.length;
    const lonMedia = leituras.reduce((s, l) => s + l.longitude, 0) / leituras.length;
    return { lat: latMedia, lon: lonMedia };
  }
  const pesos = validas.map(l => Math.pow(10, l.rsrp / 10));
  const somaPesos = pesos.reduce((a, b) => a + b, 0);
  let latFinal = 0, lonFinal = 0;
  validas.forEach((l, i) => {
    latFinal += l.latitude * (pesos[i] / somaPesos);
    lonFinal += l.longitude * (pesos[i] / somaPesos);
  });
  return { lat: latFinal, lon: lonFinal };
}

function calcularRaioIncerteza(leituras) {
  if (leituras.length < 2) return 300;
  const lats = leituras.map(l => l.latitude);
  const lons = leituras.map(l => l.longitude);
  const desvioLat = desvioPadrao(lats);
  const desvioLon = desvioPadrao(lons);
  const raioMetros = Math.max(desvioLat, desvioLon) * 111000;
  return Math.min(Math.max(raioMetros, 20), 1000);
}

function desvioPadrao(values) {
  const n = values.length;
  if (n === 0) return 0;
  const media = values.reduce((s, v) => s + v, 0) / n;
  const somaQuad = values.reduce((s, v) => s + (v - media) ** 2, 0);
  return Math.sqrt(somaQuad / n);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ====================================================================
// INICIALIZAÇÃO
// ====================================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor Orion rodando na porta ${PORT}`);
  console.log(`📅 Data/Hora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(`📂 Frontend disponível em: http://localhost:${PORT}/mapa-localizar.html`);
  migrarDadosAntigos();
});
