const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Banco de dados SQLite
const dbPath = path.join(__dirname, 'orion.db');
const db = new sqlite3.Database(dbPath);

// ============================================================
// 1. INICIALIZAÇÃO DO BANCO DE DADOS
// ============================================================
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS estacoes (
    id_estacao TEXT PRIMARY KEY,
    operadora TEXT,
    uf TEXT,
    municipio TEXT,
    bairro TEXT,
    endereco TEXT,
    codigo_municipio_ibge TEXT,
    latitude REAL,
    longitude REAL,
    tecnologias TEXT,
    frequencias TEXT,
    azimutes TEXT,
    emissoes TEXT,
    fonte TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS numeros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT UNIQUE,
    operadora TEXT,
    uf TEXT,
    municipio TEXT,
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    estacao_id TEXT,
    distancia REAL,
    data_consulta DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS importacao_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arquivo TEXT,
    registros_lidos INTEGER,
    registros_importados INTEGER,
    data_importacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ============================================================
// 2. FUNÇÃO PARA IMPORTAR OS ARQUIVOS ERB
// ============================================================
async function importarERBs() {
  const dataDir = path.join(__dirname, 'data');
  const arquivos = fs.readdirSync(dataDir).filter(f => f.startsWith('Estacoes_Licenciadas_SMP_part') && f.endsWith('.csv'));

  if (arquivos.length === 0) {
    console.log('⚠️ Nenhum arquivo Estacoes_Licenciadas_SMP_part encontrado em /data.');
    return;
  }

  console.log(`📂 Encontrados ${arquivos.length} arquivos de ERB.`);

  let totalLidos = 0;
  let totalImportados = 0;

  for (const arquivo of arquivos.sort()) {
    const caminho = path.join(dataDir, arquivo);
    const estacoes = {};

    await new Promise((resolve, reject) => {
      fs.createReadStream(caminho)
        .pipe(csv({ separator: ',' }))
        .on('data', (row) => {
          totalLidos++;
          const id = row['Número da Estação'] || row['id_estacao'] || row['Número da Estação']?.trim();
          if (!id) return;

          if (!estacoes[id]) {
            estacoes[id] = {
              id_estacao: id,
              operadora: row['Prestadora'] || row['operadora'] || '',
              uf: row['UF'] || row['uf'] || '',
              municipio: row['Município'] || row['municipio'] || '',
              bairro: row['Bairro'] || row['bairro'] || '',
              endereco: row['Logradouro'] || row['endereco'] || '',
              codigo_municipio_ibge: row['Código do Município'] || row['codigo_municipio_ibge'] || '',
              latitude: parseFloat(row['Latitude'] || row['latitude'] || 0),
              longitude: parseFloat(row['Longitude'] || row['longitude'] || 0),
              frequencias: [],
              azimutes: [],
              emissoes: [],
              fonte: 'Anatel',
              tecnologias: row['tecnologias'] || ''
            };
          }

          // Adiciona frequências e azimutes
          const freqIni = row['Frequência Inicial (MHz)'] || row['frequencia_inicial'] || '';
          const freqFim = row['Frequência Final (MHz)'] || row['frequencia_final'] || '';
          if (freqIni && freqFim) {
            estacoes[id].frequencias.push(`${freqIni}-${freqFim}`);
          }

          const azimute = row['Azimute'] || '';
          if (azimute) {
            estacoes[id].azimutes.push(azimute);
          }

          const emissao = row['Emissão'] || row['emissao'] || '';
          if (emissao) {
            estacoes[id].emissoes.push(emissao);
          }
        })
        .on('end', () => {
          console.log(`✅ Lidos ${Object.keys(estacoes).length} estações únicas de ${arquivo}`);
          // Insere no banco
          const stmt = db.prepare(`
            INSERT OR REPLACE INTO estacoes (
              id_estacao, operadora, uf, municipio, bairro, endereco,
              codigo_municipio_ibge, latitude, longitude, tecnologias,
              frequencias, azimutes, emissoes, fonte
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const id in estacoes) {
            const e = estacoes[id];
            stmt.run(
              e.id_estacao,
              e.operadora,
              e.uf,
              e.municipio,
              e.bairro,
              e.endereco,
              e.codigo_municipio_ibge,
              e.latitude,
              e.longitude,
              e.tecnologias || '',
              e.frequencias.join('; '),
              e.azimutes.join('; '),
              e.emissoes.join('; '),
              e.fonte
            );
            totalImportados++;
          }

          stmt.finalize();

          // Log da importação
          const logStmt = db.prepare(`
            INSERT INTO importacao_log (arquivo, registros_lidos, registros_importados)
            VALUES (?, ?, ?)
          `);
          logStmt.run(arquivo, Object.keys(estacoes).length, Object.keys(estacoes).length);
          logStmt.finalize();

          resolve();
        })
        .on('error', (err) => {
          console.error(`❌ Erro ao ler ${arquivo}:`, err);
          reject(err);
        });
    });
  }

  console.log(`📊 Total: ${totalLidos} linhas lidas, ${totalImportados} estações importadas.`);
}

// ============================================================
// 3. ROTAS DA API
// ============================================================

// Rota para listar estações próximas a um ponto
app.get('/api/estacoes/proximas', (req, res) => {
  const { lat, lon, raio } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
  }

  const raioKm = parseFloat(raio) || 10;

  // Fórmula de Haversine aproximada
  const sql = `
    SELECT *,
      (6371 * acos( cos(radians(?)) * cos(radians(latitude)) *
        cos(radians(longitude) - radians(?)) + sin(radians(?)) *
        sin(radians(latitude)) )) AS distancia
    FROM estacoes
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    HAVING distancia <= ?
    ORDER BY distancia
    LIMIT 50
  `;

  db.all(sql, [lat, lon, lat, raioKm], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Rota para cadastrar número
app.post('/api/numeros', (req, res) => {
  const { numero, operadora, uf, municipio } = req.body;
  if (!numero) {
    return res.status(400).json({ error: 'Número é obrigatório' });
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO numeros (numero, operadora, uf, municipio)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(numero, operadora || '', uf || '', municipio || '', function(err) {
    stmt.finalize();
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// Rota para listar números cadastrados
app.get('/api/numeros', (req, res) => {
  db.all('SELECT * FROM numeros ORDER BY data_cadastro DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Rota para consultar histórico
app.get('/api/historico', (req, res) => {
  db.all(`
    SELECT h.*, e.operadora, e.municipio, e.uf
    FROM historico h
    LEFT JOIN estacoes e ON h.estacao_id = e.id_estacao
    ORDER BY h.data_consulta DESC
    LIMIT 100
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ============================================================
// 4. INICIALIZAÇÃO DO SERVIDOR
// ============================================================

// Importa os ERBs ao iniciar
(async () => {
  await importarERBs();
  console.log('✅ ORION pronto para uso.');
})();

app.listen(port, () => {
  console.log(`🚀 ORION rodando na porta ${port}`);
});

// Tratamento de encerramento
process.on('SIGINT', () => {
  db.close();
  console.log('👋 ORION encerrado.');
  process.exit(0);
});
