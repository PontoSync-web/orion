const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const dbPath = path.join(__dirname, 'orion.db');
const db = new sqlite3.Database(dbPath);

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
});

async function importarERBs() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    console.log('⚠️ Pasta /data não encontrada.');
    return;
  }

  const arquivos = fs.readdirSync(dataDir).filter(f => f.startsWith('Estacoes_Licenciadas_SMP_part') && f.endsWith('.csv'));

  if (arquivos.length === 0) {
    console.log('⚠️ Nenhum arquivo ERB encontrado.');
    return;
  }

  console.log(`📂 Encontrados ${arquivos.length} arquivos.`);

  for (const arquivo of arquivos.sort()) {
    const caminho = path.join(dataDir, arquivo);
    const separador = detectarSeparador(caminho);
    
    console.log(`🔍 Lendo ${arquivo} (ignorando cabeçalho)...`);

    let estacoes = {};
    let linhaAtual = 0;

    await new Promise((resolve, reject) => {
      fs.createReadStream(caminho, { encoding: 'utf8' })
        .pipe(csv({
          separator: separador,
          skipLines: 1,  // ← PULA O CABEÇALHO
          mapHeaders: ({ header, index }) => {
            return `coluna_${index}`; // Nomes genéricos para as colunas
          }
        }))
        .on('data', (row) => {
          linhaAtual++;
          
          // Mapeamento baseado na posição (ordem das colunas)
          const id = row['coluna_2'] || row['coluna_0'] || row['coluna_1']; // Ajuste conforme seu CSV
          if (!id) return;

          if (!estacoes[id]) {
            estacoes[id] = {
              id_estacao: id,
              operadora: row['coluna_1'] || '',
              uf: row['coluna_4'] || '',
              municipio: row['coluna_5'] || '',
              bairro: row['coluna_6'] || '',
              endereco: row['coluna_7'] || '',
              codigo_municipio_ibge: row['coluna_8'] || '',
              latitude: parseFloat(row['coluna_9'] || 0),
              longitude: parseFloat(row['coluna_10'] || 0),
              frequencias: [],
              azimutes: [],
              emissoes: [],
              fonte: 'Anatel',
              tecnologias: ''
            };
          }

          // Adiciona frequências e azimutes
          const freqIni = row['coluna_11'] || '';
          const freqFim = row['coluna_12'] || '';
          if (freqIni && freqFim) {
            estacoes[id].frequencias.push(`${freqIni}-${freqFim}`);
          }

          const azimute = row['coluna_13'] || '';
          if (azimute) {
            estacoes[id].azimutes.push(azimute);
          }

          const emissao = row['coluna_14'] || '';
          if (emissao) {
            estacoes[id].emissoes.push(emissao);
          }
        })
        .on('end', () => {
          const qtd = Object.keys(estacoes).length;
          console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações.`);

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
              e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
              e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
              e.frequencias.join('; '), e.azimutes.join('; '), e.emissoes.join('; '), e.fonte
            );
          }

          stmt.finalize();
          resolve();
        })
        .on('error', (err) => {
          console.error(`❌ Erro:`, err);
          reject(err);
        });
    });
  }
  console.log('✅ Importação concluída.');
}

function detectarSeparador(caminho) {
  try {
    const primeiraLinha = fs.readFileSync(caminho, 'utf8').split('\n')[0];
    if (primeiraLinha.includes(';')) return ';';
    if (primeiraLinha.includes('\t')) return '\t';
    return ',';
  } catch (err) {
    return ',';
  }
}

// ============================================================
// ROTAS DA API
// ============================================================

app.get('/api/estacoes/proximas', (req, res) => {
  const { lat, lon, raio } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Lat/Lon obrigatórias' });

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
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/estacoes/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM estacoes WHERE id_estacao = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Estação não encontrada' });
    res.json(row);
  });
});

app.get('/api/estacoes/uf/:uf', (req, res) => {
  const { uf } = req.params;
  db.all('SELECT * FROM estacoes WHERE uf = ? ORDER BY municipio', [uf.toUpperCase()], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/estacoes/operadora/:operadora', (req, res) => {
  const { operadora } = req.params;
  db.all('SELECT * FROM estacoes WHERE operadora LIKE ? ORDER BY uf, municipio', [`%${operadora}%`], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

(async () => {
  await importarERBs();
  console.log('✅ ORION pronto.');
})();

app.listen(port, () => {
  console.log(`🚀 ORION rodando na porta ${port}`);
});

process.on('SIGINT', () => {
  db.close();
  console.log('👋 ORION encerrado.');
  process.exit(0);
});
