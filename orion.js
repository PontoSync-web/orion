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

// Inicialização do Banco de Dados
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
// FUNÇÃO PARA NORMALIZAR CABEÇALHOS
// ============================================================
function normalizarHeader(str) {
  return str.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .replace(/[^a-zA-Z0-9]/g, '_')   // Substitui caracteres especiais por _
    .toLowerCase()
    .replace(/_+/g, '_')              // Remove underscores duplicados
    .replace(/^_|_$/g, '');           // Remove underscores no início e fim
}

// ============================================================
// FUNÇÃO PARA DETECTAR SEPARADOR
// ============================================================
function detectarSeparador(caminho) {
  const primeiraLinha = fs.readFileSync(caminho, 'utf8').split('\n')[0];
  if (primeiraLinha.includes(';')) return ';';
  if (primeiraLinha.includes('\t')) return '\t';
  return ',';
}

// ============================================================
// FUNÇÃO PARA LER ARQUIVO COM HEADER PADRÃO (FORMATO ANATEL)
// ============================================================
function lerArquivoAnatel(caminho, separador) {
  return new Promise((resolve, reject) => {
    const estacoes = {};
    let colunasIdentificadas = {};

    fs.createReadStream(caminho, { encoding: 'utf8' })
      .pipe(csv({
        separator: separador,
        mapHeaders: ({ header }) => normalizarHeader(header)
      }))
      .on('headers', (headers) => {
        // Mapeamento flexível de colunas
        const map = {
          id: ['numero_da_estacao', 'n_mero_da_esta_o', 'id_estacao', 'id', 'estacao_id'],
          operadora: ['prestadora', 'operadora', 'operadora_nome', 'prestador'],
          uf: ['uf', 'estado', 'sigla_uf', 'c_digo_da_uf'],
          municipio: ['municipio', 'munic_pio', 'cidade', 'localidade'],
          bairro: ['bairro', 'distrito'],
          endereco: ['logradouro', 'endereco', 'rua', 'av', 'avenida'],
          codigo_municipio: ['codigo_do_municipio', 'c_digo_do_munic_pio', 'codigo_ibge', 'ibge'],
          latitude: ['latitude', 'lat'],
          longitude: ['longitude', 'lon', 'long'],
          frequencia_inicial: ['frequencia_inicial_mhz', 'frequ_ncia_inicial_mhz', 'frequencia_inicial', 'freq_ini'],
          frequencia_final: ['frequencia_final_mhz', 'frequ_ncia_final_mhz', 'frequencia_final', 'freq_fim'],
          azimute: ['azimute', 'azimuth', 'az'],
          emissao: ['emissao', 'emiss_o', 'tipo_emissao']
        };

        colunasIdentificadas = {};
        for (const [chave, possibilidades] of Object.entries(map)) {
          const encontrada = headers.find(h => possibilidades.includes(h));
          if (encontrada) colunasIdentificadas[chave] = encontrada;
        }

        console.log(`🔍 Mapeamento:`, colunasIdentificadas);
      })
      .on('data', (row) => {
        // Pula linhas vazias
        if (Object.keys(row).length === 0) return;

        const id = row[colunasIdentificadas.id] || '';
        if (!id) return;

        if (!estacoes[id]) {
          const lat = parseFloat(row[colunasIdentificadas.latitude] || 0);
          const lon = parseFloat(row[colunasIdentificadas.longitude] || 0);
          
          // Valida coordenadas (Brasil)
          if (lat < -34 || lat > 6 || lon < -75 || lon > -33) {
            return; // Descarta coordenadas inválidas
          }

          estacoes[id] = {
            id_estacao: id,
            operadora: row[colunasIdentificadas.operadora] || '',
            uf: row[colunasIdentificadas.uf] || '',
            municipio: row[colunasIdentificadas.municipio] || '',
            bairro: row[colunasIdentificadas.bairro] || '',
            endereco: row[colunasIdentificadas.endereco] || '',
            codigo_municipio_ibge: row[colunasIdentificadas.codigo_municipio] || '',
            latitude: lat,
            longitude: lon,
            frequencias: [],
            azimutes: [],
            emissoes: [],
            fonte: 'Anatel',
            tecnologias: ''
          };
        }

        // Adiciona frequências e azimutes
        const freqIni = row[colunasIdentificadas.frequencia_inicial] || '';
        const freqFim = row[colunasIdentificadas.frequencia_final] || '';
        if (freqIni && freqFim) {
          estacoes[id].frequencias.push(`${freqIni}-${freqFim}`);
        }

        const azimute = row[colunasIdentificadas.azimute] || '';
        if (azimute) {
          estacoes[id].azimutes.push(azimute);
        }

        const emissao = row[colunasIdentificadas.emissao] || '';
        if (emissao) {
          estacoes[id].emissoes.push(emissao);
        }
      })
      .on('end', () => {
        resolve(estacoes);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

// ============================================================
// FUNÇÃO PARA IMPORTAR OS ARQUIVOS ERB
// ============================================================
async function importarERBs() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    console.log('⚠️ Pasta /data não encontrada.');
    return;
  }

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
    const separador = detectarSeparador(caminho);
    
    console.log(`🔍 Lendo ${arquivo} com separador '${separador}'`);

    try {
      const estacoes = await lerArquivoAnatel(caminho, separador);
      const qtdEstacoes = Object.keys(estacoes).length;
      console.log(`✅ ${arquivo}: ${qtdEstacoes} estações únicas identificadas.`);

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
      logStmt.run(arquivo, Object.keys(estacoes).length, qtdEstacoes);
      logStmt.finalize();

    } catch (err) {
      console.error(`❌ Erro ao ler ${arquivo}:`, err);
    }
  }

  console.log(`📊 Total: ${totalLidos} linhas lidas, ${totalImportados} estações importadas.`);
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
