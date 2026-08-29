// ============================================================
// ORION - SISTEMA DE GERENCIAMENTO DE ERBs (VERSÃO SUPABASE)
// ============================================================
// Este arquivo é o coração do sistema ORION, adaptado para PostgreSQL
// no Supabase, garantindo persistência dos dados.
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES INICIAIS
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// CONEXÃO COM O BANCO DE DADOS (SUPABASE - POSTGRESQL)
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Erro ao conectar ao Supabase:', err.message);
    } else {
        console.log('✅ Conectado ao Supabase (PostgreSQL) com sucesso!');
        release();
    }
});

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
// INICIALIZAÇÃO DO BANCO DE DADOS (CRIAÇÃO DE TABELAS)
// ============================================================

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS estacoes (
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
                data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela estacoes criada/verificada com sucesso.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS numeros (
                id SERIAL PRIMARY KEY,
                numero TEXT UNIQUE,
                operadora TEXT,
                uf TEXT,
                municipio TEXT,
                latitude REAL,
                longitude REAL,
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico (
                id SERIAL PRIMARY KEY,
                numero TEXT,
                estacao_id TEXT,
                distancia REAL,
                data_consulta TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS importacao_log (
                id SERIAL PRIMARY KEY,
                arquivo TEXT,
                registros_lidos INTEGER,
                registros_importados INTEGER,
                data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alvos (
                id SERIAL PRIMARY KEY,
                numero TEXT UNIQUE,
                operadora TEXT,
                uf TEXT,
                municipio TEXT,
                tag TEXT,
                nome TEXT,
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS bases (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                uf TEXT,
                municipio TEXT,
                latitude REAL,
                longitude REAL,
                descricao TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS recursos (
                id SERIAL PRIMARY KEY,
                numero TEXT UNIQUE,
                operadora TEXT,
                nome TEXT,
                base_id INTEGER,
                status TEXT DEFAULT 'desconhecido',
                FOREIGN KEY (base_id) REFERENCES bases(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alocacoes (
                id SERIAL PRIMARY KEY,
                recurso_id INTEGER,
                base_id INTEGER,
                data_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_fim TIMESTAMP,
                FOREIGN KEY (recurso_id) REFERENCES recursos(id),
                FOREIGN KEY (base_id) REFERENCES bases(id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS filtros (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                tag TEXT,
                operadora TEXT,
                uf TEXT,
                municipio TEXT,
                base_id INTEGER,
                distancia_max REAL,
                horario_inicio TEXT,
                horario_fim TEXT,
                notificar INTEGER DEFAULT 1,
                ativo INTEGER DEFAULT 1,
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela filtros criada/verificada com sucesso.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico_localizacao (
                id SERIAL PRIMARY KEY,
                numero TEXT,
                latitude REAL,
                longitude REAL,
                estacao_id TEXT,
                data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (numero) REFERENCES recursos(numero)
            )
        `);
        console.log('✅ Tabela historico_localizacao criada/verificada com sucesso.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS dados_sinal (
                id SERIAL PRIMARY KEY,
                numero TEXT,
                estacao_id TEXT,
                latitude REAL,
                longitude REAL,
                rsrp REAL,
                sinr REAL,
                ta REAL,
                data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela dados_sinal criada/verificada com sucesso.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS modelos (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                modelo BYTEA,
                total_registros INTEGER,
                data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabela modelos criada/verificada com sucesso.');

    } catch (err) {
        console.error('❌ Erro ao criar tabelas:', err.message);
    }
}
// ============================================================
// FUNÇÃO PARA PARSEAR LINHA CSV
// ============================================================

function parseCSVLine(line, linhaNumero) {
    line = line.trimEnd();
    if (line.startsWith('"') && line.endsWith('"')) {
        line = line.substring(1, line.length - 1);
    }

    const valores = [];
    let campoAtual = '';
    let dentroAspas = false;
    let i = 0;

    while (i < line.length) {
        const char = line[i];
        if (char === '"') {
            if (i + 1 < line.length && line[i + 1] === '"') {
                campoAtual += '"';
                i += 2;
                continue;
            }
            dentroAspas = !dentroAspas;
        } else if (char === ',' && !dentroAspas) {
            valores.push(campoAtual);
            campoAtual = '';
        } else {
            campoAtual += char;
        }
        i++;
    }
    valores.push(campoAtual);

    if (linhaNumero <= 3) {
        console.log(`   🔎 Linha ${linhaNumero} (campos): ${valores.length} campos encontrados.`);
        console.log(`   🔎 ID (campo 0): "${valores[0] || 'VAZIO'}"`);
        console.log(`   🔎 Lat (campo 12): "${valores[12] || 'VAZIO'}"`);
        console.log(`   🔎 Lon (campo 13): "${valores[13] || 'VAZIO'}"`);
    }

    return valores;
}

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
        let erros = 0;
        let ignorados = 0;

        await new Promise((resolve, reject) => {
            const rl = readline.createInterface({
                input: fs.createReadStream(caminho, { encoding: 'utf8' }),
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                linhaAtual++;
                if (!line.trim()) { ignorados++; return; }
                if (line.toLowerCase().includes('id_estacao')) { ignorados++; return; }

                try {
                    const valores = parseCSVLine(line, linhaAtual);
                    if (valores.length < 10) { erros++; return; }

                    const id = valores[0] || '';
                    if (!id) { erros++; return; }

                    const lat = parseFloat(valores[12] || 0);
                    const lon = parseFloat(valores[13] || 0);
                    if (isNaN(lat) || isNaN(lon)) { erros++; return; }

                    if (!estacoes[id]) {
                        estacoes[id] = {
                            id_estacao: id,
                            operadora: valores[1] || '',
                            uf: valores[2] || '',
                            municipio: valores[3] || '',
                            bairro: valores[4] || '',
                            endereco: valores[5] || '',
                            codigo_municipio_ibge: valores[6] || '',
                            latitude: lat,
                            longitude: lon,
                            tecnologias: valores[10] || '',
                            frequencias: valores[11] || '',
                            azimutes: '',
                            emissoes: valores[25] || '',
                            fonte: 'OpenCellID + Anatel',
                            opencellid_radio: valores[14] || '',
                            opencellid_cell: valores[18] || '',
                            opencellid_correspondencia: valores[23] || '',
                            anatel_correspondencia: valores[29] || ''
                        };
                    }

                    if (linhaAtual % 5000 === 0) {
                        console.log(`   ⏳ Processadas ${linhaAtual} linhas...`);
                    }

                } catch (err) {
                    erros++;
                    if (erros <= 5) {
                        console.log(`   ❌ Erro crítico na linha ${linhaAtual}: ${err.message}`);
                    }
                }
            });

            rl.on('close', async () => {
                const qtd = Object.keys(estacoes).length;
                console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);
                console.log(`   ⚠️ ${ignorados} linhas ignoradas, ${erros} erros.`);

                if (qtd > 0) {
                    try {
                        await pool.query('BEGIN');

                        for (const id in estacoes) {
                            const e = estacoes[id];
                            await pool.query(`
                                INSERT INTO estacoes (
                                    id_estacao, operadora, uf, municipio, bairro, endereco,
                                    codigo_municipio_ibge, latitude, longitude, tecnologias,
                                    frequencias, azimutes, emissoes, fonte,
                                    opencellid_radio, opencellid_cell, opencellid_correspondencia, anatel_correspondencia
                                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                                ON CONFLICT (id_estacao) DO UPDATE SET
                                    operadora = EXCLUDED.operadora,
                                    uf = EXCLUDED.uf,
                                    municipio = EXCLUDED.municipio,
                                    bairro = EXCLUDED.bairro,
                                    endereco = EXCLUDED.endereco,
                                    codigo_municipio_ibge = EXCLUDED.codigo_municipio_ibge,
                                    latitude = EXCLUDED.latitude,
                                    longitude = EXCLUDED.longitude,
                                    tecnologias = EXCLUDED.tecnologias,
                                    frequencias = EXCLUDED.frequencias,
                                    azimutes = EXCLUDED.azimutes,
                                    emissoes = EXCLUDED.emissoes,
                                    fonte = EXCLUDED.fonte,
                                    opencellid_radio = EXCLUDED.opencellid_radio,
                                    opencellid_cell = EXCLUDED.opencellid_cell,
                                    opencellid_correspondencia = EXCLUDED.opencellid_correspondencia,
                                    anatel_correspondencia = EXCLUDED.anatel_correspondencia
                            `, [
                                e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
                                e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
                                e.frequencias, e.azimutes, e.emissoes, e.fonte,
                                e.opencellid_radio, e.opencellid_cell, e.opencellid_correspondencia, e.anatel_correspondencia
                            ]);
                        }

                        await pool.query('COMMIT');
                        console.log(`   ✅ ${qtd} estações inseridas com sucesso.`);
                    } catch (err) {
                        await pool.query('ROLLBACK');
                        console.error(`   ❌ Erro ao inserir estações:`, err.message);
                    }
                }

                try {
                    await pool.query(`
                        INSERT INTO importacao_log (arquivo, registros_lidos, registros_importados)
                        VALUES ($1, $2, $3)
                    `, [arquivo, linhaAtual, qtd]);
                } catch (err) {
                    console.error('❌ Erro ao registrar log:', err.message);
                }

                resolve();
            });

            rl.on('error', (err) => {
                console.error(`❌ Erro ao ler ${arquivo}:`, err);
                reject(err);
            });
        });
    }
    console.log('✅ Importação concluída.');
}
// ============================================================
// FUNÇÃO PARA SALVAR O MODELO NO BANCO DE DADOS
// ============================================================
async function salvarModeloNoBanco(features, labels, totalRegistros) {
    try {
        const modelData = { features, labels };
        const modelJSON = JSON.stringify(modelData);
        const modeloBuffer = Buffer.from(modelJSON, 'utf8');

        await pool.query(`
            INSERT INTO modelos (nome, modelo, total_registros)
            VALUES ($1, $2, $3)
            ON CONFLICT (nome) DO UPDATE SET
                modelo = EXCLUDED.modelo,
                total_registros = EXCLUDED.total_registros,
                data_criacao = CURRENT_TIMESTAMP
        `, ['knn_model', modeloBuffer, totalRegistros]);

        console.log(`✅ Modelo salvo no banco de dados (${totalRegistros} registros).`);
        return { success: true };
    } catch (err) {
        console.error('❌ Erro ao salvar modelo:', err.message);
        throw err;
    }
}

// ============================================================
// FUNÇÃO PARA CARREGAR O MODELO DO BANCO DE DADOS
// ============================================================
async function carregarModeloDoBanco() {
    try {
        const result = await pool.query(`
            SELECT * FROM modelos WHERE nome = $1 ORDER BY data_criacao DESC LIMIT 1
        `, ['knn_model']);

        if (result.rows.length === 0) {
            throw new Error('Modelo não encontrado no banco de dados.');
        }

        const row = result.rows[0];
        const modelJSON = row.modelo.toString('utf8');
        const modelData = JSON.parse(modelJSON);
        return modelData;
    } catch (err) {
        throw new Error('Erro ao carregar modelo: ' + err.message);
    }
}

// ============================================================
// FUNÇÃO PARA TREINAR O MODELO KNN (SALVANDO NO BANCO)
// ============================================================
async function treinarModeloKNN() {
    try {
        const result = await pool.query('SELECT * FROM dados_sinal');
        const rows = result.rows;

        if (rows.length < 10) {
            throw new Error('Dados insuficientes para treinar o modelo (mínimo 10 registros).');
        }

        const features = [];
        const labels = [];

        rows.forEach(row => {
            const feature = [
                row.estacao_id,
                row.rsrp || 0,
                row.sinr || 0,
                row.ta || 0
            ];
            features.push(feature);
            labels.push([row.latitude, row.longitude]);
        });

        await salvarModeloNoBanco(features, labels, rows.length);
        return { total_registros: rows.length };
    } catch (err) {
        throw new Error('Erro ao treinar modelo: ' + err.message);
    }
}

// ============================================================
// FUNÇÃO PARA PREDIZER LOCALIZAÇÃO COM KNN (CARREGANDO DO BANCO)
// ============================================================
async function predizerLocalizacaoKNN(estacao_id, rsrp, sinr, ta, k = 3) {
    try {
        const modelData = await carregarModeloDoBanco();
        const { features, labels } = modelData;

        if (features.length === 0) {
            throw new Error('Modelo vazio.');
        }

        const query = [estacao_id, rsrp || 0, sinr || 0, ta || 0];

        const distances = features.map((feature, index) => {
            const dist = Math.sqrt(
                Math.pow(feature[0] - query[0], 2) +
                Math.pow(feature[1] - query[1], 2) +
                Math.pow(feature[2] - query[2], 2) +
                Math.pow(feature[3] - query[3], 2)
            );
            return { index, distance: dist };
        });

        distances.sort((a, b) => a.distance - b.distance);
        const kNearest = distances.slice(0, k);

        let sumLat = 0;
        let sumLon = 0;
        kNearest.forEach(neighbor => {
            sumLat += labels[neighbor.index][0];
            sumLon += labels[neighbor.index][1];
        });

        const predLat = sumLat / k;
        const predLon = sumLon / k;

        return { latitude: predLat, longitude: predLon, k: k };
    } catch (err) {
        throw new Error('Erro ao predizer localização: ' + err.message);
    }
}
// ============================================================
// ROTAS DA API
// ============================================================

// ============================================================
// ROTAS PARA ESTAÇÕES (ERBs)
// ============================================================

app.get('/api/estacoes/mais-proxima', async (req, res) => {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
        return res.status(400).json({
            error: 'Latitude e longitude são obrigatórias. Nenhum fallback será usado.'
        });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({
            error: 'Latitude e longitude devem ser números válidos.'
        });
    }

    try {
        const result = await pool.query(`
            SELECT *,
                (6371 * acos( cos(radians($1)) * cos(radians(latitude)) *
                    cos(radians(longitude) - radians($2)) + sin(radians($1)) *
                    sin(radians(latitude)) )) AS distancia
            FROM estacoes
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            ORDER BY distancia ASC
            LIMIT 1
        `, [latitude, longitude]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Nenhuma ERB encontrada nas proximidades.'
            });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/estacoes/proximas', async (req, res) => {
    const { lat, lon, raio } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const raioKm = parseFloat(raio) || 10;
    try {
        const result = await pool.query(`
            SELECT *,
                (6371 * acos( cos(radians($1)) * cos(radians(latitude)) *
                    cos(radians(longitude) - radians($2)) + sin(radians($1)) *
                    sin(radians(latitude)) )) AS distancia
            FROM estacoes
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            AND (6371 * acos( cos(radians($1)) * cos(radians(latitude)) *
                    cos(radians(longitude) - radians($2)) + sin(radians($1)) *
                    sin(radians(latitude)) )) <= $3
            ORDER BY distancia
            LIMIT 50
        `, [lat, lon, raioKm]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/estacoes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM estacoes WHERE id_estacao = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Estação não encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/estacoes/uf/:uf', async (req, res) => {
    const { uf } = req.params;
    try {
        const result = await pool.query('SELECT * FROM estacoes WHERE uf = $1 ORDER BY municipio', [uf.toUpperCase()]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/estacoes/operadora/:operadora', async (req, res) => {
    const { operadora } = req.params;
    try {
        const result = await pool.query('SELECT * FROM estacoes WHERE operadora LIKE $1 ORDER BY uf, municipio', [`%${operadora}%`]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA NÚMEROS
// ============================================================

app.post('/api/numeros', async (req, res) => {
    const { numero, operadora, uf, municipio } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        await pool.query(`
            INSERT INTO numeros (numero, operadora, uf, municipio)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (numero) DO UPDATE SET
                operadora = EXCLUDED.operadora,
                uf = EXCLUDED.uf,
                municipio = EXCLUDED.municipio
        `, [numero, operadora || '', uf || '', municipio || '']);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/numeros/localizacao', async (req, res) => {
    const { numero, latitude, longitude, uf, municipio } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    try {
        await pool.query(`
            INSERT INTO numeros (numero, uf, municipio, latitude, longitude)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (numero) DO UPDATE SET
                uf = EXCLUDED.uf,
                municipio = EXCLUDED.municipio,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude
        `, [numero, uf || '', municipio || '', latitude, longitude]);

        res.json({ success: true, message: `Localização do número ${numero} atualizada` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/numeros', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM numeros ORDER BY data_cadastro DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/numeros/:numero', async (req, res) => {
    const { numero } = req.params;
    try {
        const result = await pool.query('SELECT * FROM numeros WHERE numero = $1', [numero]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Número não encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA ALVOS
// ============================================================

app.post('/api/alvos', async (req, res) => {
    const { numero, operadora, uf, municipio, tag, nome } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        await pool.query(`
            INSERT INTO alvos (numero, operadora, uf, municipio, tag, nome)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (numero) DO UPDATE SET
                operadora = EXCLUDED.operadora,
                uf = EXCLUDED.uf,
                municipio = EXCLUDED.municipio,
                tag = EXCLUDED.tag,
                nome = EXCLUDED.nome
        `, [numero, operadora || '', uf || '', municipio || '', tag || '', nome || '']);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/alvos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM alvos ORDER BY data_cadastro DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/alvos/tag/:tag', async (req, res) => {
    const { tag } = req.params;
    try {
        const result = await pool.query('SELECT * FROM alvos WHERE tag = $1 ORDER BY data_cadastro DESC', [tag]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/alvos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM alvos WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Alvo não encontrado' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA BASES
// ============================================================

app.post('/api/bases', async (req, res) => {
    const { nome, uf, municipio, latitude, longitude, descricao } = req.body;
    if (!nome || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Nome, latitude e longitude são obrigatórios' });
    }

    try {
        const result = await pool.query(`
            INSERT INTO bases (nome, uf, municipio, latitude, longitude, descricao)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [nome, uf || '', municipio || '', latitude, longitude, descricao || '']);

        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/bases', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bases ORDER BY nome');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/bases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM bases WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Base não encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/bases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM bases WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Base não encontrada' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA RECURSOS
// ============================================================

async function criarBaseAutomatica(numero, lat = null, lon = null) {
    if (lat === null || lon === null) {
        console.log(`⚠️ Número ${numero}: coordenadas não fornecidas. Base NÃO criada.`);
        return null;
    }

    const nomeBase = `Base Automática - ${numero}`;
    try {
        const result = await pool.query(`
            INSERT INTO bases (nome, uf, municipio, latitude, longitude, descricao)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [nomeBase, '', '', lat, lon, 'Base criada automaticamente pelo ORION']);

        console.log(`✅ Base automática criada para o número ${numero} com coordenadas reais (${lat}, ${lon})`);
        return result.rows[0].id;
    } catch (err) {
        console.error('❌ Erro ao criar base automática:', err.message);
        return null;
    }
}

app.post('/api/recursos', async (req, res) => {
    const { numero, operadora, nome, base_id, status, latitude, longitude } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const recursoExistente = await pool.query('SELECT * FROM recursos WHERE numero = $1', [numero]);
        let finalBaseId = base_id;

        if (recursoExistente.rows.length === 0 && !base_id) {
            if (latitude && longitude) {
                finalBaseId = await criarBaseAutomatica(numero, latitude, longitude);
            } else {
                console.log(`⚠️ Número ${numero} cadastrado sem coordenadas. Base NÃO criada.`);
            }
        }

        await pool.query(`
            INSERT INTO recursos (numero, operadora, nome, base_id, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (numero) DO UPDATE SET
                operadora = EXCLUDED.operadora,
                nome = EXCLUDED.nome,
                base_id = EXCLUDED.base_id,
                status = EXCLUDED.status
        `, [numero, operadora || '', nome || '', finalBaseId || null, status || 'desconhecido']);

        res.json({
            success: true,
            message: recursoExistente.rows.length > 0 ? 'Recurso atualizado' : 'Recurso cadastrado' + (finalBaseId ? ' com base automática' : ' sem base')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recursos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM recursos ORDER BY numero');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recursos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM recursos WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Recurso não encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recursos/numero/:numero', async (req, res) => {
    const { numero } = req.params;
    try {
        const result = await pool.query('SELECT * FROM recursos WHERE numero = $1', [numero]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Recurso não encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/recursos/:id/mover', async (req, res) => {
    const { id } = req.params;
    const { base_id } = req.body;
    if (base_id === undefined) {
        return res.status(400).json({ error: 'base_id é obrigatório' });
    }

    try {
        await pool.query('UPDATE recursos SET base_id = $1 WHERE id = $2', [base_id, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/recursos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM recursos WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Recurso não encontrado' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA FILTROS INTELIGENTES
// ============================================================

app.post('/api/filtros', async (req, res) => {
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;
    if (!nome) {
        return res.status(400).json({ error: 'Nome do filtro é obrigatório' });
    }

    try {
        await pool.query(`
            INSERT INTO filtros (
                nome, tag, operadora, uf, municipio, base_id,
                distancia_max, horario_inicio, horario_fim, notificar, ativo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [nome, tag || null, operadora || null, uf || null, municipio || null, base_id || null,
            distancia_max || null, horario_inicio || null, horario_fim || null,
            notificar !== undefined ? notificar : 1,
            ativo !== undefined ? ativo : 1]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/filtros', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM filtros ORDER BY nome');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM filtros WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Filtro não encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;

    try {
        await pool.query(`
            UPDATE filtros SET
                nome = $1, tag = $2, operadora = $3, uf = $4, municipio = $5,
                base_id = $6, distancia_max = $7, horario_inicio = $8, horario_fim = $9,
                notificar = $10, ativo = $11
            WHERE id = $12
        `, [nome, tag || null, operadora || null, uf || null, municipio || null,
            base_id || null, distancia_max || null, horario_inicio || null, horario_fim || null,
            notificar !== undefined ? notificar : 1,
            ativo !== undefined ? ativo : 1, id]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM filtros WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Filtro não encontrado' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA HISTÓRICO E INTELIGÊNCIA PREDITIVA
// ============================================================

app.get('/api/historico', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT h.*, e.operadora, e.municipio, e.uf
            FROM historico h
            LEFT JOIN estacoes e ON h.estacao_id = e.id_estacao
            ORDER BY h.data_consulta DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/historico', async (req, res) => {
    const { numero, estacao_id, distancia } = req.body;
    if (!numero || !estacao_id) {
        return res.status(400).json({ error: 'Número e estacao_id são obrigatórios' });
    }

    try {
        await pool.query(`
            INSERT INTO historico (numero, estacao_id, distancia)
            VALUES ($1, $2, $3)
        `, [numero, estacao_id, distancia || null]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/historico-localizacao', async (req, res) => {
    const { numero, latitude, longitude, estacao_id } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    try {
        await pool.query(`
            INSERT INTO historico_localizacao (numero, latitude, longitude, estacao_id)
            VALUES ($1, $2, $3, $4)
        `, [numero, latitude, longitude, estacao_id || null]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analise-padroes', async (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const result = await pool.query(`
            SELECT
                latitude,
                longitude,
                COUNT(*) AS frequencia,
                DATE(data_hora) AS data,
                EXTRACT(HOUR FROM data_hora) AS hora
            FROM historico_localizacao
            WHERE numero = $1
            GROUP BY latitude, longitude, DATE(data_hora), EXTRACT(HOUR FROM data_hora)
            ORDER BY data_hora DESC
            LIMIT 100
        `, [numero]);

        if (result.rows.length === 0) {
            return res.json({ pattern: 'Sem dados suficientes' });
        }

        const locationCount = {};
        result.rows.forEach(row => {
            const key = `${row.latitude},${row.longitude}`;
            locationCount[key] = (locationCount[key] || 0) + Number(row.frequencia);
        });

        let mostFrequent = null;
        let maxCount = 0;
        for (const [key, count] of Object.entries(locationCount)) {
            if (count > maxCount) {
                maxCount = count;
                mostFrequent = key;
            }
        }

        const [lat, lon] = mostFrequent ? mostFrequent.split(',').map(Number) : [null, null];

        const hourCount = {};
        result.rows.forEach(row => {
            const hora = row.hora;
            hourCount[hora] = (hourCount[hora] || 0) + 1;
        });

        let mostFrequentHour = null;
        let maxHourCount = 0;
        for (const [hora, count] of Object.entries(hourCount)) {
            if (count > maxHourCount) {
                maxHourCount = count;
                mostFrequentHour = hora;
            }
        }

        res.json({
            pattern: {
                localizacao_mais_frequente: { latitude: lat, longitude: lon },
                horario_mais_frequente: mostFrequentHour,
                total_registros: result.rows.length
            }
        });
    } catch (err) {
        console.error('❌ Erro ao buscar histórico:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/alertas', async (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const result = await pool.query(`
            SELECT latitude, longitude, data_hora
            FROM historico_localizacao
            WHERE numero = $1
            ORDER BY data_hora DESC
            LIMIT 10
        `, [numero]);

        if (result.rows.length < 3) {
            return res.json({ alerta: 'Sem dados suficientes para alertas' });
        }

        let distanciaTotal = 0;
        let intervalos = 0;

        for (let i = 0; i < result.rows.length - 1; i++) {
            const lat1 = result.rows[i].latitude;
            const lon1 = result.rows[i].longitude;
            const lat2 = result.rows[i+1].latitude;
            const lon2 = result.rows[i+1].longitude;

            const dist = Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lon2 - lon1, 2)) * 111;
            distanciaTotal += dist;
            intervalos++;
        }

        const velocidadeMedia = intervalos > 0 ? distanciaTotal / intervalos : 0;

        if (velocidadeMedia > 50) {
            res.json({
                alerta: `🚨 Movimento suspeito detectado (${velocidadeMedia.toFixed(1)} km/h). Últimas localizações indicam deslocamento rápido.`
            });
        } else if (velocidadeMedia > 20) {
            res.json({
                alerta: `⚠️ Movimento moderado detectado (${velocidadeMedia.toFixed(1)} km/h).`
            });
        } else {
            res.json({
                alerta: `✅ Padrão normal (${velocidadeMedia.toFixed(1)} km/h).`
            });
        }
    } catch (err) {
        console.error('❌ Erro ao buscar localizações:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROTAS PARA COLETAR DADOS DE SINAL E ML
// ============================================================

app.post('/api/coletar-sinal', async (req, res) => {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, estacao_id, latitude e longitude são obrigatórios' });
    }

    try {
        await pool.query(`
            INSERT INTO dados_sinal (numero, estacao_id, latitude, longitude, rsrp, sinr, ta)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [numero, estacao_id, latitude, longitude, rsrp || null, sinr || null, ta || null]);

        res.json({ success: true, message: 'Dados de sinal coletados com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coletar-sinal-auto', async (req, res) => {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, estacao_id, latitude e longitude são obrigatórios' });
    }

    try {
        await pool.query(`
            INSERT INTO dados_sinal (numero, estacao_id, latitude, longitude, rsrp, sinr, ta)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [numero, estacao_id, latitude, longitude, rsrp || null, sinr || null, ta || null]);

        const result = await pool.query('SELECT COUNT(*) AS total FROM dados_sinal');
        const total = parseInt(result.rows[0].total);

        if (total >= 10) {
            treinarModeloKNN()
                .then(result => {
                    console.log(`✅ Modelo treinado automaticamente com ${result.total_registros} registros.`);
                })
                .catch(error => {
                    console.error('❌ Erro ao treinar modelo automaticamente:', error);
                });
        }

        res.json({
            success: true,
            message: 'Dados de sinal coletados com sucesso.',
            total_registros: total
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/treinar-modelo', async (req, res) => {
    try {
        const result = await treinarModeloKNN();
        res.json({ success: true, message: `Modelo treinado com ${result.total_registros} registros.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/predizer-localizacao', async (req, res) => {
    const { estacao_id, rsrp, sinr, ta, k } = req.query;

    if (!estacao_id) {
        return res.status(400).json({ error: 'estacao_id é obrigatório' });
    }

    const kValue = parseInt(k) || 3;

    try {
        const result = await predizerLocalizacaoKNN(estacao_id, parseFloat(rsrp), parseFloat(sinr), parseFloat(ta), kValue);
        res.json({
            success: true,
            latitude: result.latitude,
            longitude: result.longitude,
            k: result.k,
            metodo: 'KNN'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ROTA PARA ESTATÍSTICAS
// ============================================================

app.get('/api/estatisticas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM estacoes) AS total_estacoes,
                (SELECT COUNT(DISTINCT operadora) FROM estacoes) AS total_operadoras,
                (SELECT COUNT(DISTINCT uf) FROM estacoes) AS total_ufs,
                (SELECT COUNT(*) FROM numeros) AS total_numeros,
                (SELECT COUNT(*) FROM alvos) AS total_alvos,
                (SELECT COUNT(*) FROM bases) AS total_bases,
                (SELECT COUNT(*) FROM recursos) AS total_recursos,
                (SELECT COUNT(*) FROM filtros) AS total_filtros,
                (SELECT COUNT(*) FROM historico_localizacao) AS total_localizacoes,
                (SELECT COUNT(*) FROM dados_sinal) AS total_dados_sinal,
                (SELECT COUNT(*) FROM modelos) AS total_modelos
        `);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

(async () => {
    await initDatabase();
    await importarERBs();
    console.log('✅ ORION pronto para uso.');
})();

app.listen(port, () => {
    console.log(`🚀 ORION rodando na porta ${port}`);
});

process.on('SIGINT', () => {
    pool.end(() => {
        console.log('👋 ORION encerrado.');
        process.exit(0);
    });
});
