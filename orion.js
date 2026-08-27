const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(__dirname, 'orion.db');

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ============================================================
// BANCO DE DADOS
// ============================================================
const db = new sqlite3.Database(DB_PATH);

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
    fonte TEXT,
    opencellid_radio TEXT,
    opencellid_cell TEXT,
    opencellid_correspondencia TEXT,
    anatel_correspondencia TEXT,
    data_importacao DATETIME DEFAULT CURRENT_TIMESTAMP
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
// FUNÇÃO PARA IMPORTAR ERBs
// ============================================================
async function importarERBs() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('⚠️ Pasta /data não encontrada.');
    return;
  }

  const arquivos = fs.readdirSync(DATA_DIR).filter(f => 
    f.startsWith('erb_consolidado_final_part') && f.endsWith('.csv')
  );

  if (arquivos.length === 0) {
    console.log('⚠️ Nenhum arquivo ERB encontrado.');
    return;
  }

  console.log(`📂 Encontrados ${arquivos.length} arquivos.`);

  for (const arquivo of arquivos.sort()) {
    const caminho = path.join(DATA_DIR, arquivo);
    console.log(`🔍 Lendo ${arquivo}...`);

    let estacoes = {};
    let linhaAtual = 0;

    await new Promise((resolve, reject) => {
      fs.createReadStream(caminho, { encoding: 'utf8' })
        .pipe(csv({
          separator: ',',
          skipLines: 0,
          quote: '"',
          escape: '"',
          mapHeaders: ({ header, index }) => `coluna_${index}`
        }))
        .on('data', (row) => {
          linhaAtual++;
          
          const id = row['coluna_0'] || '';
          if (!id) return;

          // Valida coordenadas
          const lat = parseFloat(row['coluna_10'] || 0);
          const lon = parseFloat(row['coluna_11'] || 0);
          
          // Descarta coordenadas inválidas (ex: -99.52 ou fora do Brasil)
          if (isNaN(lat) || isNaN(lon) || lat < -34 || lat > 6 || lon < -75 || lon > -33) {
            return;
          }

          if (!estacoes[id]) {
            estacoes[id] = {
              id_estacao: id,
              operadora: row['coluna_1'] || '',
              uf: row['coluna_2'] || '',
              municipio: row['coluna_3'] || '',
              bairro: row['coluna_4'] || '',
              endereco: row['coluna_5'] || '',
              codigo_municipio_ibge: row['coluna_6'] || '',
              latitude: lat,
              longitude: lon,
              tecnologias: row['coluna_8'] || '',
              frequencias: row['coluna_9'] || '',
              azimutes: '',
              emissoes: row['coluna_25'] || '',
              fonte: 'OpenCellID + Anatel',
              opencellid_radio: row['coluna_12'] || '',
              opencellid_cell: row['coluna_16'] || '',
              opencellid_correspondencia: row['coluna_21'] || '',
              anatel_correspondencia: row['coluna_27'] || ''
            };
          }
        })
        .on('end', () => {
          const qtd = Object.keys(estacoes).length;
          console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);

          const stmt = db.prepare(`
            INSERT OR REPLACE INTO estacoes (
              id_estacao, operadora, uf, municipio, bairro, endereco,
              codigo_municipio_ibge, latitude, longitude, tecnologias,
              frequencias, azimutes, emissoes, fonte,
              opencellid_radio, opencellid_cell, opencellid_correspondencia, anatel_correspondencia
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const id in estacoes) {
            const e = estacoes[id];
            stmt.run(
              e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
              e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
              e.frequencias, e.azimutes, e.emissoes, e.fonte,
              e.opencellid_radio, e.opencellid_cell, e.opencellid_correspondencia, e.anatel_correspondencia
            );
          }

          stmt.finalize();

          const logStmt = db.prepare(`
            INSERT INTO importacao_log (arquivo, registros_lidos, registros_importados)
            VALUES (?, ?, ?)
          `);
          logStmt.run(arquivo, linhaAtual, qtd);
          logStmt.finalize();

          resolve();
        })
        .on('error', (err) => {
          console.error(`❌ Erro ao ler ${arquivo}:`, err);
          reject(err);
        });
    });
  }
  console.log('✅ Importação concluída.');
}

// ============================================================
// ROTAS DA API
// ============================================================

app.get('/api/estacoes/proximas', (req, res) => {
  const { lat, lon, raio } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
  }

  const raioKm = parseFloat(raio) || 10;
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

app.get('/api/estacoes/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM estacoes WHERE id_estacao = ?', [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Estação não encontrada' });
    }
    res.json(row);
  });
});

app.get('/api/estacoes/uf/:uf', (req, res) => {
  const { uf } = req.params;
  db.all('SELECT * FROM estacoes WHERE uf = ? ORDER BY municipio', [uf.toUpperCase()], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.get('/api/estacoes/operadora/:operadora', (req, res) => {
  const { operadora } = req.params;
  db.all('SELECT * FROM estacoes WHERE operadora LIKE ? ORDER BY uf, municipio', [`%${operadora}%`], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

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

app.get('/api/numeros', (req, res) => {
  db.all('SELECT * FROM numeros ORDER BY data_cadastro DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

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

app.get('/api/estatisticas', (req, res) => {
  db.all(`
    SELECT 
      (SELECT COUNT(*) FROM estacoes) AS total_estacoes,
      (SELECT COUNT(DISTINCT operadora) FROM estacoes) AS total_operadoras,
      (SELECT COUNT(DISTINCT uf) FROM estacoes) AS total_ufs,
      (SELECT COUNT(*) FROM numeros) AS total_numeros
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows[0]);
  });
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

(async () => {
  await importarERBs();
  console.log('✅ ORION pronto para uso.');
})();

app.listen(port, () => {
  console.log(`🚀 ORION rodando na porta ${port}`);
});

process.on('SIGINT', () => {
  db.close();
  console.log('👋 ORION encerrado.');
  process.exit(0);
});
