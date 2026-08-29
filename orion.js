/**
 * ====================================================================
 * ARQUIVO: server.js
 * DATA: 2026-08-29
 * HORA: 16:20 BRT
 * DESCRIÇÃO: Servidor backend completo do Orion - Geolocalização por Celular
 * AUTOR: Equipe Orion
 * VERSÃO: 2.1 (com migração automática de dados antigos para o filtro Kalman)
 * ====================================================================
 * 
 * Este arquivo contém TODAS as funcionalidades do Orion:
 * 
 * 1. Coleta de dados de sinal (RSRP, SINR, TA) - POST /api/coletar-sinal-auto
 * 2. Localização com média ponderada por RSRP + Filtro Kalman - GET /api/localizar
 * 3. Correção por Timing Advance (TA) baseada na distância da torre
 * 4. Feedback do usuário para correção manual - POST /api/feedback
 * 5. Recalibração automática de viés por número de celular
 * 6. Cálculo de raio de incerteza (precisão da localização)
 * 7. Banco de dados SQLite com todas as tabelas necessárias
 * 8. Histórico de posições para suavização de trajetória
 * 9. Fallback inteligente (404) em vez de localização padrão incorreta
 * 10. MIGRAÇÃO AUTOMÁTICA: popula posicoes_historicas com dados antigos da coletas
 * 
 * ====================================================================
 * DEPENDÊNCIAS:
 *   npm install express sqlite3
 * ====================================================================
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsear JSON
app.use(express.json());

// ====================================================================
// BANCO DE DADOS SQLITE - CRIAÇÃO DE TODAS AS TABELAS
// ====================================================================
const db = new sqlite3.Database('./orion.db');

// Tabela 1: Coletas (dados brutos enviados pelos dispositivos)
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

// Tabela 2: Estações (torres de celular) - para correção por TA
db.run(`
  CREATE TABLE IF NOT EXISTS estacoes (
    id TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    nome TEXT
  )
`);

// Tabela 3: Feedback dos usuários (correções manuais)
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

// Tabela 4: Usuários (armazena viés de cada número para aprendizado contínuo)
db.run(`
  CREATE TABLE IF NOT EXISTS usuarios (
    numero TEXT PRIMARY KEY,
    vies_lat REAL DEFAULT 0,
    vies_lon REAL DEFAULT 0,
    ultima_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Tabela 5: Histórico de posições calculadas (para filtro de Kalman)
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
// MIGRAÇÃO AUTOMÁTICA: POPULAR posicoes_historicas COM DADOS ANTIGOS
// ====================================================================
// Esta função roda uma única vez na inicialização do servidor.
// Ela insere a ÚLTIMA coordenada de cada número que já existe na tabela coletas.
// Isso garante que o filtro de Kalman tenha um ponto de partida para números antigos.
// ====================================================================
function migrarDadosAntigos() {
  console.log('🔄 Verificando necessidade de migração de dados antigos...');

  db.get(
    `SELECT COUNT(*) as total FROM posicoes_historicas`,
    (err, row) => {
      if (err) {
        console.error('❌ Erro ao verificar histórico:', err);
        return;
      }

      // Se já houver registros em posicoes_historicas, não faz nada
      if (row.total > 0) {
        console.log(`✅ Histórico já possui ${row.total} registros. Migração não necessária.`);
        return;
      }

      // Se não houver, popula com a última localização de cada número
      console.log('📥 Populando posicoes_historicas com dados antigos da tabela coletas...');

      db.run(`
        INSERT INTO posicoes_historicas (numero, latitude, longitude, timestamp)
        SELECT 
          c.numero,
          c.latitude,
          c.longitude,
          c.timestamp
        FROM coletas c
        INNER JOIN (
          SELECT numero, MAX(timestamp) as ultimo_timestamp
          FROM coletas
          GROUP BY numero
        ) ultima ON c.numero = ultima.numero AND c.timestamp = ultima.ultimo_timestamp
      `, function(err) {
        if (err) {
          console.error('❌ Erro na migração:', err);
        } else {
          console.log(`✅ Migração concluída! ${this.changes} registros inseridos em posicoes_historicas.`);
        }
      });
    }
  );
}

// ====================================================================
// ROTA 1: COLETA DE SINAL (POST /api/coletar-sinal-auto)
// ====================================================================
app.post('/api/coletar-sinal-auto', async (req, res) => {
  try {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    // Validação básica
    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
    }

    // Insere a leitura no banco
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO coletas (numero, estacao_id, latitude, longitude, rsrp, sinr, ta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [numero, estacao_id, latitude, longitude, rsrp, sinr, ta],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // --- Correção por Timing Advance (TA) ---
    let latFinal = latitude;
    let lonFinal = longitude;

    // Busca a estação no banco (se cadastrada)
    const estacao = await new Promise((resolve, reject) => {
      db.get('SELECT latitude, longitude FROM estacoes WHERE id = ?', [estacao_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (estacao && ta) {
      // 1 TA = 78,12 metros (padrão LTE)
      const raioMaximoKm = (ta * 78.12) / 1000;
      const distAtual = haversine(latitude, longitude, estacao.latitude, estacao.longitude);

      if (distAtual > raioMaximoKm) {
        // Projeta o ponto para dentro do círculo (em direção à torre)
        const proporcao = raioMaximoKm / distAtual;
        latFinal = estacao.latitude + (latitude - estacao.latitude) * proporcao;
        lonFinal = estacao.longitude + (longitude - estacao.longitude) * proporcao;
      }
    }

    // Resposta com a posição corrigida (opcional)
    res.status(201).json({
      mensagem: 'Leitura registrada com sucesso',
      latitude_corrigida: latFinal,
      longitude_corrigida: lonFinal
    });

  } catch (err) {
    console.error('Erro ao salvar coleta:', err);
    res.status(500).json({ erro: 'Erro interno ao salvar coleta' });
  }
});

// ====================================================================
// ROTA 2: LOCALIZAÇÃO (GET /api/localizar)
// ====================================================================
app.get('/api/localizar', async (req, res) => {
  const { numero } = req.query;

  if (!numero) {
    return res.status(400).json({ erro: 'Número não informado' });
  }

  try {
    // Busca as últimas 15 leituras do número
    const leituras = await new Promise((resolve, reject) => {
      db.all(
        `SELECT latitude, longitude, rsrp, timestamp FROM coletas 
         WHERE numero = ? 
         ORDER BY timestamp DESC 
         LIMIT 15`,
        [numero],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (!leituras || leituras.length === 0) {
      return res.status(404).json({ 
        erro: 'Nenhuma localização encontrada para este número',
        sugestao: 'Realize uma coleta primeiro usando o aplicativo ou script'
      });
    }

    // --- PASSO 1: Média Ponderada por RSRP ---
    const { lat: latPonderada, lon: lonPonderada } = calcularMediaPonderada(leituras);

    // --- PASSO 2: Filtro de Kalman (suavização com histórico) ---
    // Busca as últimas 5 posições armazenadas para o mesmo número
    const historico = await new Promise((resolve, reject) => {
      db.all(
        `SELECT latitude, longitude FROM posicoes_historicas 
         WHERE numero = ? 
         ORDER BY timestamp DESC 
         LIMIT 5`,
        [numero],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Se houver histórico, aplica o filtro exponencial
    let latFinal = latPonderada;
    let lonFinal = lonPonderada;

    if (historico.length > 0) {
      const ultima = historico[0];
      // 70% da nova leitura, 30% do histórico
      latFinal = ultima.latitude * 0.3 + latPonderada * 0.7;
      lonFinal = ultima.longitude * 0.3 + lonPonderada * 0.7;
    }

    // --- PASSO 3: Aplicar viés corrigido pelo feedback dos usuários ---
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

    // --- PASSO 4: Calcular raio de incerteza ---
    const raioMetros = calcularRaioIncerteza(leituras);

    // --- PASSO 5: Salvar a posição calculada no histórico (para futuros filtros) ---
    db.run(
      `INSERT INTO posicoes_historicas (numero, latitude, longitude, timestamp)
       VALUES (?, ?, ?, ?)`,
      [numero, latFinal, lonFinal, new Date().toISOString()]
    );

    // Retorna a localização mais precisa possível
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
    console.error('Erro ao consultar localização:', err);
    res.status(500).json({ erro: 'Erro ao consultar localização' });
  }
});

// ====================================================================
// ROTA 3: FEEDBACK DO USUÁRIO (POST /api/feedback)
// ====================================================================
app.post('/api/feedback', async (req, res) => {
  try {
    const { numero, lat_real, lon_real, lat_mostrada, lon_mostrada } = req.body;

    if (!numero || lat_real === undefined || lon_real === undefined) {
      return res.status(400).json({ erro: 'Campos obrigatórios: numero, lat_real, lon_real' });
    }

    // Salva o feedback
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO feedback (numero, lat_real, lon_real, lat_mostrada, lon_mostrada)
         VALUES (?, ?, ?, ?, ?)`,
        [numero, lat_real, lon_real, lat_mostrada || 0, lon_mostrada || 0],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Recalibra o viés para esse número (últimos 5 feedbacks)
    const vies = await new Promise((resolve, reject) => {
      db.all(
        `SELECT AVG(lat_real - lat_mostrada) as vies_lat,
                AVG(lon_real - lon_mostrada) as vies_lon
         FROM feedback
         WHERE numero = ?
         ORDER BY timestamp DESC
         LIMIT 5`,
        [numero],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    if (vies && vies.vies_lat !== null) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO usuarios (numero, vies_lat, vies_lon, ultima_atualizacao)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(numero) DO UPDATE SET
             vies_lat = ?,
             vies_lon = ?,
             ultima_atualizacao = ?`,
          [numero, vies.vies_lat, vies.vies_lon, new Date().toISOString(),
           vies.vies_lat, vies.vies_lon, new Date().toISOString()],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    res.status(201).json({
      mensagem: 'Feedback recebido com sucesso! Obrigado por ajudar a melhorar o Orion.',
      viés_aplicado: vies
    });

  } catch (err) {
    console.error('Erro ao salvar feedback:', err);
    res.status(500).json({ erro: 'Erro interno ao processar feedback' });
  }
});

// ====================================================================
// FUNÇÕES AUXILIARES
// ====================================================================

/**
 * Calcula a média ponderada das leituras usando RSRP como peso
 * Quanto maior o RSRP (menos negativo), maior o peso
 */
function calcularMediaPonderada(leituras) {
  // Filtra leituras com RSRP muito baixo (ruído)
  const validas = leituras.filter(l => l.rsrp > -110);

  if (validas.length === 0) {
    // Fallback: média simples
    const latMedia = leituras.reduce((s, l) => s + l.latitude, 0) / leituras.length;
    const lonMedia = leituras.reduce((s, l) => s + l.longitude, 0) / leituras.length;
    return { lat: latMedia, lon: lonMedia };
  }

  // Converte RSRP (dBm) para escala linear (mW)
  const pesos = validas.map(l => Math.pow(10, l.rsrp / 10));
  const somaPesos = pesos.reduce((a, b) => a + b, 0);

  let latFinal = 0, lonFinal = 0;
  validas.forEach((l, i) => {
    latFinal += l.latitude * (pesos[i] / somaPesos);
    lonFinal += l.longitude * (pesos[i] / somaPesos);
  });

  return { lat: latFinal, lon: lonFinal };
}

/**
 * Calcula o raio de incerteza com base na dispersão das leituras
 * Retorna o valor em metros
 */
function calcularRaioIncerteza(leituras) {
  if (leituras.length < 2) return 300; // valor padrão

  const lats = leituras.map(l => l.latitude);
  const lons = leituras.map(l => l.longitude);

  const desvioLat = desvioPadrao(lats);
  const desvioLon = desvioPadrao(lons);

  // 1 grau ≈ 111 km (na linha do equador)
  const raioMetros = Math.max(desvioLat, desvioLon) * 111000;

  // Limita entre 20m e 1km
  return Math.min(Math.max(raioMetros, 20), 1000);
}

/**
 * Calcula o desvio padrão de um array de números
 */
function desvioPadrao(values) {
  const n = values.length;
  if (n === 0) return 0;
  const media = values.reduce((s, v) => s + v, 0) / n;
  const somaQuad = values.reduce((s, v) => s + (v - media) ** 2, 0);
  return Math.sqrt(somaQuad / n);
}

/**
 * Distância Haversine em quilômetros entre dois pontos (lat, lon)
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ====================================================================
// INICIALIZAÇÃO DO SERVIDOR (COM MIGRAÇÃO AUTOMÁTICA)
// ====================================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor Orion rodando na porta ${PORT}`);
  console.log(`📅 Data/Hora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(`✅ Banco de dados: orion.db`);
  console.log(`📊 Tabelas criadas: coletas, estacoes, feedback, usuarios, posicoes_historicas`);
  console.log(`🔗 Endpoints disponíveis:`);
  console.log(`   POST /api/coletar-sinal-auto`);
  console.log(`   GET  /api/localizar?numero=XX`);
  console.log(`   POST /api/feedback`);
  
  // Roda a migração de dados antigos (se necessário)
  migrarDadosAntigos();
});

// ====================================================================
// FIM DO ARQUIVO
// ====================================================================
