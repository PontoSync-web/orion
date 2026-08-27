// ============================================================
// ORION - SISTEMA DE GERENCIAMENTO DE ERBs
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
    // Tabela estacoes
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

    // Tabela numeros
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

    // Tabela historico
    db.run(`CREATE TABLE IF NOT EXISTS historico (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`numero\` TEXT,
        \`estacao_id\` TEXT,
        \`distancia\` REAL,
        \`data_consulta\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela historico:', err.message);
    });

    // Tabela importacao_log
    db.run(`CREATE TABLE IF NOT EXISTS importacao_log (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`arquivo\` TEXT,
        \`registros_lidos\` INTEGER,
        \`registros_importados\` INTEGER,
        \`data_importacao\` DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error('❌ Erro ao criar tabela importacao_log:', err.message);
    });

    // Tabela alvos
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

    // Tabela bases
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

    // Tabela recursos
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

    // Tabela alocacoes (histórico de movimentações)
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

    // Tabela filtros inteligentes
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
