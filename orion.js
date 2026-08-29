// ============================================================
// ORION - SISTEMA DE GERENCIAMENTO DE ERBs (VERSÃO COMPLETA COM ML)
// ============================================================
// Este arquivo é o coração do sistema ORION. Ele gerencia:
// 1. Importação de dados de ERBs a partir de arquivos CSV
// 2. API REST para consulta de estações próximas
// 3. Cadastro e gerenciamento de números de telefone
// 4. Histórico de consultas
// 5. Gestão de alvos (números de interesse)
// 6. Gestão de bases (setores/instalações)
// 7. Gestão de recursos (números associados a bases)
// 8. Filtros inteligentes para alertas
// 9. Inteligência preditiva (análise de padrões e alertas)
// 10. Machine Learning para localização (KNN)
// ============================================================

// ============================================================
// IMPORTAÇÃO DE MÓDULOS
// ============================================================

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES INICIAIS
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
// BANCO DE DADOS (COM CRASES PARA ESCAPAR NOMES DE COLUNAS)
// ============================================================

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // ============================================================
    // TABELA 1: estacoes (ERBs)
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS estacoes (
        \`id_estacao\` TEXT PRIMARY KEY,
        \`operadora\` TEXT,
        \`uf\` TEXT,
        \`municipio\` TEXT,
        \`bairro\` TEXT,
        \`endereco\` TEXT,
        \`codigo_municipio_ibge\` TEXT,
        \`latitude\` REAL,
        \`longitude\` REAL,
        \`tecnologias\` TEXT,
        \`frequencias\` TEXT,
        \`azimutes\` TEXT,
        \`emissoes\` TEXT,
        \`fonte\` TEXT,
        \`opencellid_radio\` TEXT,
        \`opencellid_cell\` TEXT,
        \`opencellid_correspondencia\` TEXT,
        \`anatel_correspondencia\` TEXT,
        \`data_importacao\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela estacoes:', err.message);
        else console.log('✅ Tabela estacoes criada/verificada com sucesso.');
    });

    // ============================================================
    // TABELA 2: numeros
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS numeros (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT UNIQUE,
        \`operadora\` TEXT,
        \`uf\` TEXT,
        \`municipio\` TEXT,
        \`latitude\` REAL,
        \`longitude\` REAL,
        \`data_cadastro\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela numeros:', err.message);
    });

    // ============================================================
    // TABELA 3: historico
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS historico (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT,
        \`estacao_id\` TEXT,
        \`distancia\` REAL,
        \`data_consulta\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela historico:', err.message);
    });

    // ============================================================
    // TABELA 4: importacao_log
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS importacao_log (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`arquivo\` TEXT,
        \`registros_lidos\` INTEGER,
        \`registros_importados\` INTEGER,
        \`data_importacao\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela importacao_log:', err.message);
    });

    // ============================================================
    // TABELA 5: alvos
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS alvos (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT UNIQUE,
        \`operadora\` TEXT,
        \`uf\` TEXT,
        \`municipio\` TEXT,
        \`tag\` TEXT,
        \`nome\` TEXT,
        \`data_cadastro\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela alvos:', err.message);
    });

    // ============================================================
    // TABELA 6: bases
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS bases (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`nome\` TEXT NOT NULL,
        \`uf\` TEXT,
        \`municipio\` TEXT,
        \`latitude\` REAL,
        \`longitude\` REAL,
        \`descricao\` TEXT
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela bases:', err.message);
    });

    // ============================================================
    // TABELA 7: recursos
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS recursos (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT UNIQUE,
        \`operadora\` TEXT,
        \`nome\` TEXT,
        \`base_id\` INTEGER,
        \`status\` TEXT DEFAULT 'desconhecido',
        FOREIGN KEY (\`base_id\`) REFERENCES \`bases\`(\`id\`)
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela recursos:', err.message);
    });

    // ============================================================
    // TABELA 8: alocacoes (histórico de movimentações)
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS alocacoes (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`recurso_id\` INTEGER,
        \`base_id\` INTEGER,
        \`data_inicio\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        \`data_fim\` DATETIME,
        FOREIGN KEY (\`recurso_id\`) REFERENCES \`recursos\`(\`id\`),
        FOREIGN KEY (\`base_id\`) REFERENCES \`bases\`(\`id\`)
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela alocacoes:', err.message);
    });

    // ============================================================
    // TABELA 9: filtros inteligentes
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS filtros (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`nome\` TEXT NOT NULL,
        \`tag\` TEXT,
        \`operadora\` TEXT,
        \`uf\` TEXT,
        \`municipio\` TEXT,
        \`base_id\` INTEGER,
        \`distancia_max\` REAL,
        \`horario_inicio\` TEXT,
        \`horario_fim\` TEXT,
        \`notificar\` INTEGER DEFAULT 1,
        \`ativo\` INTEGER DEFAULT 1,
        \`data_criacao\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela filtros:', err.message);
        else console.log('✅ Tabela filtros criada/verificada com sucesso.');
    });

    // ============================================================
    // TABELA 10: historico_localizacao (para inteligência preditiva)
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS historico_localizacao (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT,
        \`latitude\` REAL,
        \`longitude\` REAL,
        \`estacao_id\` TEXT,
        \`data_hora\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (\`numero\`) REFERENCES \`recursos\`(\`numero\`)
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela historico_localizacao:', err.message);
        else console.log('✅ Tabela historico_localizacao criada/verificada com sucesso.');
    });

    // ============================================================
    // TABELA 11: dados_sinal (para Machine Learning)
    // ============================================================
    db.run(`CREATE TABLE IF NOT EXISTS dados_sinal (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT,
        \`estacao_id\` TEXT,
        \`latitude\` REAL,
        \`longitude\` REAL,
        \`rsrp\` REAL,
        \`sinr\` REAL,
        \`ta\` REAL,
        \`data_hora\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela dados_sinal:', err.message);
        else console.log('✅ Tabela dados_sinal criada/verificada com sucesso.');
    });
});

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

            rl.on('close', () => {
                const qtd = Object.keys(estacoes).length;
                console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);
                console.log(`   ⚠️ ${ignorados} linhas ignoradas, ${erros} erros.`);

                if (qtd > 0) {
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO estacoes (
                            \`id_estacao\`, \`operadora\`, \`uf\`, \`municipio\`, \`bairro\`, \`endereco\`,
                            \`codigo_municipio_ibge\`, \`latitude\`, \`longitude\`, \`tecnologias\`,
                            \`frequencias\`, \`azimutes\`, \`emissoes\`, \`fonte\`,
                            \`opencellid_radio\`, \`opencellid_cell\`, \`opencellid_correspondencia\`, \`anatel_correspondencia\`
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);

                    db.serialize(() => {
                        db.run('BEGIN TRANSACTION');
                        let count = 0;
                        let errosInsercao = 0;

                        for (const id in estacoes) {
                            const e = estacoes[id];
                            try {
                                stmt.run(
                                    e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
                                    e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
                                    e.frequencias, e.azimutes, e.emissoes, e.fonte,
                                    e.opencellid_radio, e.opencellid_cell, e.opencellid_correspondencia, e.anatel_correspondencia
                                );
                                count++;
                                if (count % 5000 === 0) {
                                    console.log(`   ⏳ ${count} estações inseridas...`);
                                }
                            } catch (insertErr) {
                                errosInsercao++;
                                if (errosInsercao <= 5) {
                                    console.error(`   ❌ Erro ao inserir estação ${e.id_estacao}: ${insertErr.message}`);
                                }
                            }
                        }
                        stmt.finalize();

                        db.run('COMMIT', (err) => {
                            if (err) {
                                console.error('❌ Erro no COMMIT da transação:', err.message);
                                db.run('ROLLBACK');
                            } else {
                                console.log(`   ✅ ${count} estações inseridas com sucesso.`);
                                if (errosInsercao > 0) {
                                    console.log(`   ⚠️ ${errosInsercao} estações tiveram erro na inserção.`);
                                }
                            }
                        });
                    });
                }

                const logStmt = db.prepare(`
                    INSERT INTO importacao_log (\`arquivo\`, \`registros_lidos\`, \`registros_importados\`)
                    VALUES (?, ?, ?)
                `);
                logStmt.run(arquivo, linhaAtual, qtd);
                logStmt.finalize();

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
// FUNÇÃO PARA TREINAR O MODELO KNN
// ============================================================

function treinarModeloKNN() {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM dados_sinal', (err, rows) => {
            if (err) {
                reject('Erro ao buscar dados de sinal: ' + err.message);
                return;
            }

            if (rows.length < 10) {
                reject('Dados insuficientes para treinar o modelo (mínimo 10 registros).');
                return;
            }

            // Prepara os dados para o modelo
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

            const modelData = { features, labels };
            const fs = require('fs');
            const modelPath = path.join(__dirname, 'models', 'knn_model.json');

            const modelsDir = path.join(__dirname, 'models');
            if (!fs.existsSync(modelsDir)) {
                fs.mkdirSync(modelsDir);
            }

            fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
            resolve({ total_registros: rows.length });
        });
    });
}

// ============================================================
// FUNÇÃO PARA PREDIZER LOCALIZAÇÃO COM KNN
// ============================================================

function predizerLocalizacaoKNN(estacao_id, rsrp, sinr, ta, k = 3) {
    return new Promise((resolve, reject) => {
        const fs = require('fs');
        const modelPath = path.join(__dirname, 'models', 'knn_model.json');

        if (!fs.existsSync(modelPath)) {
            reject('Modelo não encontrado. Treine o modelo primeiro.');
            return;
        }

        const modelData = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
        const { features, labels } = modelData;

        if (features.length === 0) {
            reject('Modelo vazio. Treine o modelo primeiro.');
            return;
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

        resolve({ latitude: predLat, longitude: predLon, k: k });
    });
}

// ============================================================
// ROTAS DA API
// ============================================================

// ============================================================
// ROTAS PARA ESTAÇÕES (ERBs)
// ============================================================

app.get('/api/estacoes/mais-proxima', (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ error: 'Latitude e longitude devem ser números válidos' });
    }

    const sql = `
        SELECT *,
            (6371 * acos( cos(radians(?)) * cos(radians(\`latitude\`)) *
                cos(radians(\`longitude\`) - radians(?)) + sin(radians(?)) *
                sin(radians(\`latitude\`)) )) AS distancia
        FROM estacoes
        WHERE \`latitude\` IS NOT NULL AND \`longitude\` IS NOT NULL
        ORDER BY distancia ASC
        LIMIT 1
    `;

    db.get(sql, [latitude, longitude, latitude], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Nenhuma ERB encontrada nas proximidades' });
        }
        res.json(row);
    });
});

app.get('/api/estacoes/proximas', (req, res) => {
    const { lat, lon, raio } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const raioKm = parseFloat(raio) || 10;
    const sql = `
        SELECT *,
            (6371 * acos( cos(radians(?)) * cos(radians(\`latitude\`)) *
                cos(radians(\`longitude\`) - radians(?)) + sin(radians(?)) *
                sin(radians(\`latitude\`)) )) AS distancia
        FROM estacoes
        WHERE \`latitude\` IS NOT NULL AND \`longitude\` IS NOT NULL
        AND (6371 * acos( cos(radians(?)) * cos(radians(\`latitude\`)) *
                cos(radians(\`longitude\`) - radians(?)) + sin(radians(?)) *
                sin(radians(\`latitude\`)) )) <= ?
        ORDER BY distancia
        LIMIT 50
    `;

    db.all(sql, [lat, lon, lat, lat, lon, lat, raioKm], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/estacoes/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM estacoes WHERE `id_estacao` = ?', [id], (err, row) => {
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
    db.all('SELECT * FROM estacoes WHERE `uf` = ? ORDER BY `municipio`', [uf.toUpperCase()], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/estacoes/operadora/:operadora', (req, res) => {
    const { operadora } = req.params;
    db.all('SELECT * FROM estacoes WHERE `operadora` LIKE ? ORDER BY `uf`, `municipio`', [`%${operadora}%`], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// ============================================================
// ROTAS PARA NÚMEROS
// ============================================================

app.post('/api/numeros', (req, res) => {
    const { numero, operadora, uf, municipio } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO numeros (\`numero\`, \`operadora\`, \`uf\`, \`municipio\`)
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

app.post('/api/numeros/localizacao', (req, res) => {
    const { numero, latitude, longitude, uf, municipio } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO numeros (\`numero\`, \`uf\`, \`municipio\`, \`latitude\`, \`longitude\`)
        VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(numero, uf || '', municipio || '', latitude, longitude, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: `Localização do número ${numero} atualizada` });
    });
});

app.get('/api/numeros', (req, res) => {
    db.all('SELECT * FROM numeros ORDER BY `data_cadastro` DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/numeros/:numero', (req, res) => {
    const { numero } = req.params;
    db.get('SELECT * FROM numeros WHERE `numero` = ?', [numero], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Número não encontrado' });
        }
        res.json(row);
    });
});

// ============================================================
// ROTAS PARA ALVOS
// ============================================================

app.post('/api/alvos', (req, res) => {
    const { numero, operadora, uf, municipio, tag, nome } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO alvos (\`numero\`, \`operadora\`, \`uf\`, \`municipio\`, \`tag\`, \`nome\`)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(numero, operadora || '', uf || '', municipio || '', tag || '', nome || '', function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

app.get('/api/alvos', (req, res) => {
    db.all('SELECT * FROM alvos ORDER BY data_cadastro DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/alvos/tag/:tag', (req, res) => {
    const { tag } = req.params;
    db.all('SELECT * FROM alvos WHERE tag = ? ORDER BY data_cadastro DESC', [tag], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.delete('/api/alvos/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM alvos WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, deleted: this.changes });
    });
});

// ============================================================
// ROTAS PARA BASES
// ============================================================

app.post('/api/bases', (req, res) => {
    const { nome, uf, municipio, latitude, longitude, descricao } = req.body;
    if (!nome || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Nome, latitude e longitude são obrigatórios' });
    }

    const stmt = db.prepare(`
        INSERT INTO bases (\`nome\`, \`uf\`, \`municipio\`, \`latitude\`, \`longitude\`, \`descricao\`)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(nome, uf || '', municipio || '', latitude, longitude, descricao || '', function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

app.get('/api/bases', (req, res) => {
    db.all('SELECT * FROM bases ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/bases/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM bases WHERE id = ?', [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Base não encontrada' });
        }
        res.json(row);
    });
});

app.delete('/api/bases/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM bases WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, deleted: this.changes });
    });
});

// ============================================================
// ROTAS PARA RECURSOS (COM CRIAÇÃO AUTOMÁTICA DE BASE)
// ============================================================

async function criarBaseAutomatica(numero, lat = -15.8, lon = -47.9) {
    const nomeBase = `Base Automática - ${numero}`;
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO bases (\`nome\`, \`uf\`, \`municipio\`, \`latitude\`, \`longitude\`, \`descricao\`)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(nomeBase, '', '', lat, lon, 'Base criada automaticamente pelo ORION', function(err) {
            stmt.finalize();
            if (err) {
                reject(err);
            } else {
                resolve(this.lastID);
            }
        });
    });
}

app.post('/api/recursos', (req, res) => {
    const { numero, operadora, nome, base_id, status, latitude, longitude } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    db.get('SELECT * FROM recursos WHERE numero = ?', [numero], async (err, recursoExistente) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        let finalBaseId = base_id;
        let coordenadasUsadas = { lat: latitude || -15.8, lon: longitude || -47.9 };

        if (!recursoExistente && !base_id) {
            try {
                finalBaseId = await criarBaseAutomatica(numero, coordenadasUsadas.lat, coordenadasUsadas.lon);
                console.log(`✅ Base automática criada para o número ${numero} (ID: ${finalBaseId})`);
            } catch (error) {
                return res.status(500).json({ error: 'Erro ao criar base automática: ' + error.message });
            }
        }

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO recursos (\`numero\`, \`operadora\`, \`nome\`, \`base_id\`, \`status\`)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(numero, operadora || '', nome || '', finalBaseId || null, status || 'desconhecido', function(err) {
            stmt.finalize();
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({
                success: true,
                id: this.lastID,
                base_id: finalBaseId,
                message: recursoExistente ? 'Recurso atualizado' : 'Recurso cadastrado com base automática'
            });
        });
    });
});

app.get('/api/recursos', (req, res) => {
    db.all('SELECT * FROM recursos ORDER BY numero', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/recursos/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM recursos WHERE id = ?', [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Recurso não encontrado' });
        }
        res.json(row);
    });
});

app.get('/api/recursos/numero/:numero', (req, res) => {
    const { numero } = req.params;
    db.get('SELECT * FROM recursos WHERE numero = ?', [numero], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Recurso não encontrado' });
        }
        res.json(row);
    });
});

app.put('/api/recursos/:id/mover', (req, res) => {
    const { id } = req.params;
    const { base_id } = req.body;
    if (base_id === undefined) {
        return res.status(400).json({ error: 'base_id é obrigatório' });
    }

    const stmt = db.prepare('UPDATE recursos SET base_id = ? WHERE id = ?');
    stmt.run(base_id, id, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, updated: this.changes });
    });
});

app.delete('/api/recursos/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM recursos WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, deleted: this.changes });
    });
});

// ============================================================
// ROTAS PARA FILTROS INTELIGENTES
// ============================================================

app.post('/api/filtros', (req, res) => {
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;
    if (!nome) {
        return res.status(400).json({ error: 'Nome do filtro é obrigatório' });
    }

    const stmt = db.prepare(`
        INSERT INTO filtros (
            \`nome\`, \`tag\`, \`operadora\`, \`uf\`, \`municipio\`, \`base_id\`,
            \`distancia_max\`, \`horario_inicio\`, \`horario_fim\`, \`notificar\`, \`ativo\`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        nome, tag || null, operadora || null, uf || null, municipio || null, base_id || null,
        distancia_max || null, horario_inicio || null, horario_fim || null,
        notificar !== undefined ? notificar : 1,
        ativo !== undefined ? ativo : 1,
        function(err) {
            stmt.finalize();
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.get('/api/filtros', (req, res) => {
    db.all('SELECT * FROM filtros ORDER BY nome', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.get('/api/filtros/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM filtros WHERE id = ?', [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: 'Filtro não encontrado' });
        }
        res.json(row);
    });
});

app.put('/api/filtros/:id', (req, res) => {
    const { id } = req.params;
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;

    const stmt = db.prepare(`
        UPDATE filtros SET
            \`nome\` = ?, \`tag\` = ?, \`operadora\` = ?, \`uf\` = ?, \`municipio\` = ?,
            \`base_id\` = ?, \`distancia_max\` = ?, \`horario_inicio\` = ?, \`horario_fim\` = ?,
            \`notificar\` = ?, \`ativo\` = ?
        WHERE id = ?
    `);
    stmt.run(
        nome, tag || null, operadora || null, uf || null, municipio || null,
        base_id || null, distancia_max || null, horario_inicio || null, horario_fim || null,
        notificar !== undefined ? notificar : 1,
        ativo !== undefined ? ativo : 1,
        id,
        function(err) {
            stmt.finalize();
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, updated: this.changes });
        }
    );
});

app.delete('/api/filtros/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM filtros WHERE id = ?', [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, deleted: this.changes });
    });
});

// ============================================================
// ROTAS PARA HISTÓRICO E INTELIGÊNCIA PREDITIVA
// ============================================================

app.get('/api/historico', (req, res) => {
    db.all(`
        SELECT h.*, e.\`operadora\`, e.\`municipio\`, e.\`uf\`
        FROM historico h
        LEFT JOIN estacoes e ON h.\`estacao_id\` = e.\`id_estacao\`
        ORDER BY h.\`data_consulta\` DESC
        LIMIT 100
    `, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/historico', (req, res) => {
    const { numero, estacao_id, distancia } = req.body;
    if (!numero || !estacao_id) {
        return res.status(400).json({ error: 'Número e estacao_id são obrigatórios' });
    }

    const stmt = db.prepare(`
        INSERT INTO historico (\`numero\`, \`estacao_id\`, \`distancia\`)
        VALUES (?, ?, ?)
    `);
    stmt.run(numero, estacao_id, distancia || null, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/historico-localizacao', (req, res) => {
    const { numero, latitude, longitude, estacao_id } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    const stmt = db.prepare(`
        INSERT INTO historico_localizacao (\`numero\`, \`latitude\`, \`longitude\`, \`estacao_id\`)
        VALUES (?, ?, ?, ?)
    `);
    stmt.run(numero, latitude, longitude, estacao_id || null, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

app.get('/api/analise-padroes', (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    db.all(`
        SELECT
            \`latitude\`,
            \`longitude\`,
            COUNT(*) AS frequencia,
            DATE(\`data_hora\`) AS data,
            strftime('%H', \`data_hora\`) AS hora
        FROM historico_localizacao
        WHERE \`numero\` = ?
        GROUP BY \`latitude\`, \`longitude\`, DATE(\`data_hora\`), strftime('%H', \`data_hora\`)
        ORDER BY \`data_hora\` DESC
        LIMIT 100
    `, [numero], (err, rows) => {
        if (err) {
            console.error('❌ Erro ao buscar histórico:', err.message);
            return res.status(500).json({ error: err.message });
        }

        if (rows.length === 0) {
            return res.json({ pattern: 'Sem dados suficientes' });
        }

        const locationCount = {};
        rows.forEach(row => {
            const key = `${row.latitude},${row.longitude}`;
            locationCount[key] = (locationCount[key] || 0) + row.frequencia;
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
        rows.forEach(row => {
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
                total_registros: rows.length
            }
        });
    });
});

app.get('/api/alertas', (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    db.all(`
        SELECT
            \`latitude\`,
            \`longitude\`,
            \`data_hora\`
        FROM historico_localizacao
        WHERE \`numero\` = ?
        ORDER BY \`data_hora\` DESC
        LIMIT 10
    `, [numero], (err, rows) => {
        if (err) {
            console.error('❌ Erro ao buscar localizações:', err.message);
            return res.status(500).json({ error: err.message });
        }

        if (rows.length < 3) {
            return res.json({ alerta: 'Sem dados suficientes para alertas' });
        }

        let distanciaTotal = 0;
        let intervalos = 0;

        for (let i = 0; i < rows.length - 1; i++) {
            const lat1 = rows[i].latitude;
            const lon1 = rows[i].longitude;
            const lat2 = rows[i+1].latitude;
            const lon2 = rows[i+1].longitude;

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
    });
});

// ============================================================
// ROTAS PARA COLETAR DADOS DE SINAL E ML
// ============================================================

/**
 * Rota para coletar dados de sinal manualmente
 * @route POST /api/coletar-sinal
 */
app.post('/api/coletar-sinal', (req, res) => {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, estacao_id, latitude e longitude são obrigatórios' });
    }

    const stmt = db.prepare(`
        INSERT INTO dados_sinal (\`numero\`, \`estacao_id\`, \`latitude\`, \`longitude\`, \`rsrp\`, \`sinr\`, \`ta\`)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(numero, estacao_id, latitude, longitude, rsrp || null, sinr || null, ta || null, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID, message: 'Dados de sinal coletados com sucesso.' });
    });
});

/**
 * Rota para coletar dados de sinal automaticamente com treinamento do modelo KNN
 * @route POST /api/coletar-sinal-auto
 */
app.post('/api/coletar-sinal-auto', (req, res) => {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, estacao_id, latitude e longitude são obrigatórios' });
    }

    // 1. Insere os dados de sinal
    const stmt = db.prepare(`
        INSERT INTO dados_sinal (\`numero\`, \`estacao_id\`, \`latitude\`, \`longitude\`, \`rsrp\`, \`sinr\`, \`ta\`)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(numero, estacao_id, latitude, longitude, rsrp || null, sinr || null, ta || null, function(err) {
        stmt.finalize();
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        // 2. Verifica se há dados suficientes para treinar
        db.get('SELECT COUNT(*) AS total FROM dados_sinal', (err, row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            const total = row.total;
            // 3. Se houver 10 ou mais registros, treina o modelo automaticamente
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
                id: this.lastID,
                message: 'Dados de sinal coletados com sucesso.',
                total_registros: total
            });
        });
    });
});

/**
 * Rota para treinar o modelo KNN manualmente
 * @route POST /api/treinar-modelo
 */
app.post('/api/treinar-modelo', async (req, res) => {
    try {
        const result = await treinarModeloKNN();
        res.json({ success: true, message: `Modelo treinado com ${result.total_registros} registros.` });
    } catch (error) {
        res.status(500).json({ error: error });
    }
});

/**
 * Rota para predizer a localização com base em dados de sinal usando KNN
 * @route GET /api/predizer-localizacao
 */
app.get('/api/predizer-localizacao', (req, res) => {
    const { estacao_id, rsrp, sinr, ta, k } = req.query;

    if (!estacao_id) {
        return res.status(400).json({ error: 'estacao_id é obrigatório' });
    }

    const kValue = parseInt(k) || 3;

    predizerLocalizacaoKNN(estacao_id, parseFloat(rsrp), parseFloat(sinr), parseFloat(ta), kValue)
        .then(result => {
            res.json({
                success: true,
                latitude: result.latitude,
                longitude: result.longitude,
                k: result.k,
                metodo: 'KNN'
            });
        })
        .catch(error => {
            res.status(500).json({ error: error });
        });
});

// ============================================================
// ROTA PARA ESTATÍSTICAS
// ============================================================

app.get('/api/estatisticas', (req, res) => {
    db.all(`
        SELECT
            (SELECT COUNT(*) FROM estacoes) AS total_estacoes,
            (SELECT COUNT(DISTINCT \`operadora\`) FROM estacoes) AS total_operadoras,
            (SELECT COUNT(DISTINCT \`uf\`) FROM estacoes) AS total_ufs,
            (SELECT COUNT(*) FROM numeros) AS total_numeros,
            (SELECT COUNT(*) FROM alvos) AS total_alvos,
            (SELECT COUNT(*) FROM bases) AS total_bases,
            (SELECT COUNT(*) FROM recursos) AS total_recursos,
            (SELECT COUNT(*) FROM filtros) AS total_filtros,
            (SELECT COUNT(*) FROM historico_localizacao) AS total_localizacoes,
            (SELECT COUNT(*) FROM dados_sinal) AS total_dados_sinal
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

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR (IPv4 e IPv6)
// ============================================================
// O servidor escuta em todos os endereços (IPv4 e IPv6) por padrão.
// O Render fornece suporte a ambos os protocolos.
app.listen(port, () => {
    console.log(`🚀 ORION rodando na porta ${port} (IPv4 e IPv6)`);
});

process.on('SIGINT', () => {
    db.close(() => {
        console.log('👋 ORION encerrado.');
        process.exit(0);
    });
});
