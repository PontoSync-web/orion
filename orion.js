// ============================================================
// ORION - SISTEMA DE GERENCIAMENTO DE ERBs
// ============================================================
// Este arquivo é o coração do sistema ORION. Ele gerencia:
// 1. Importação de dados de ERBs a partir de arquivos CSV
// 2. API REST para consulta de estações próximas
// 3. Cadastro e gerenciamento de números de telefone
// 4. Histórico de consultas
// ============================================================

// ============================================================
// IMPORTAÇÃO DE MÓDULOS
// ============================================================

const express = require('express');        // Framework web para criar a API
const sqlite3 = require('sqlite3').verbose(); // Banco de dados SQLite
const path = require('path');              // Manipulação de caminhos de arquivos
const fs = require('fs');                  // Sistema de arquivos
const readline = require('readline');      // Leitura de arquivos linha a linha

// ============================================================
// CONFIGURAÇÕES INICIAIS
// ============================================================

const app = express();
const port = process.env.PORT || 3000;     // Porta definida pelo Render ou padrão 3000

// Diretórios importantes
const DATA_DIR = path.join(__dirname, 'data');    // Onde estão os CSVs
const DB_PATH = path.join(__dirname, 'orion.db'); // Banco de dados SQLite

// ============================================================
// MIDDLEWARE
// ============================================================

// Permite que o servidor entenda JSON no corpo das requisições
app.use(express.json());

// Serve arquivos estáticos da pasta 'public'
app.use(express.static('public'));

// Configuração CORS para permitir requisições de qualquer origem
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ============================================================
// BANCO DE DADOS
// ============================================================

// Cria uma instância do banco de dados SQLite
const db = new sqlite3.Database(DB_PATH);

// Inicializa as tabelas do banco de dados (se não existirem)
db.serialize(() => {
  // Tabela principal: armazena todas as estações (ERBs)
  db.run(`CREATE TABLE IF NOT EXISTS estacoes (
    id_estacao TEXT PRIMARY KEY,                // Identificador único da estação
    operadora TEXT,                             // Nome da operadora (TIM, VIVO, CLARO, etc.)
    uf TEXT,                                    // Estado (ex: SP, RJ, BA)
    municipio TEXT,                             // Município
    bairro TEXT,                                // Bairro
    endereco TEXT,                              // Endereço completo
    codigo_municipio_ibge TEXT,                 // Código IBGE do município
    latitude REAL,                              // Coordenada geográfica
    longitude REAL,                             // Coordenada geográfica
    tecnologias TEXT,                           // Tecnologias disponíveis (2G, 3G, 4G, 5G)
    frequencias TEXT,                           // Frequências em MHz
    azimutes TEXT,                              // Azimutes das antenas
    emissoes TEXT,                              // Tipos de emissão
    fonte TEXT,                                 // Fonte dos dados (Anatel, OpenCellID, etc.)
    opencellid_radio TEXT,                      // Tecnologia registrada no OpenCellID
    opencellid_cell TEXT,                       // ID da célula no OpenCellID
    opencellid_correspondencia TEXT,            // "sim" se há correspondência com Anatel
    anatel_correspondencia TEXT,                // "sim" se há correspondência com OpenCellID
    data_importacao DATETIME DEFAULT CURRENT_TIMESTAMP // Data de importação
  )`, (err) => {
    if (err) {
      console.error('❌ Erro ao criar tabela estacoes:', err.message);
    } else {
      console.log('✅ Tabela estacoes criada/verificada com sucesso.');
    }
  });

  // Tabela para armazenar números de telefone cadastrados
  db.run(`CREATE TABLE IF NOT EXISTS numeros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT UNIQUE,                         // Número de telefone
    operadora TEXT,                             // Operadora do número
    uf TEXT,                                    // Estado de origem
    municipio TEXT,                             // Município de origem
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP // Data de cadastro
  )`, (err) => {
    if (err) console.error('❌ Erro ao criar tabela numeros:', err.message);
  });

  // Tabela para registrar o histórico de consultas
  db.run(`CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,                                // Número consultado
    estacao_id TEXT,                            // ID da estação encontrada
    distancia REAL,                             // Distância da estação
    data_consulta DATETIME DEFAULT CURRENT_TIMESTAMP // Data da consulta
  )`, (err) => {
    if (err) console.error('❌ Erro ao criar tabela historico:', err.message);
  });

  // Tabela para registrar logs das importações
  db.run(`CREATE TABLE IF NOT EXISTS importacao_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arquivo TEXT,                               // Nome do arquivo importado
    registros_lidos INTEGER,                    // Total de linhas lidas
    registros_importados INTEGER,               // Total de estações importadas
    data_importacao DATETIME DEFAULT CURRENT_TIMESTAMP // Data da importação
  )`, (err) => {
    if (err) console.error('❌ Erro ao criar tabela importacao_log:', err.message);
  });
});

// ============================================================
// FUNÇÃO PARA PARSEAR LINHA CSV COM ASPAS (FORMATO ESPECIAL)
// ============================================================
// Esta função é especializada para o formato das suas linhas CSV.
// Cada linha começa e termina com aspas duplas (").
// Campos com vírgulas são escapados com aspas duplas ("").
// ============================================================

function parseCSVLine(line, linhaNumero) {
    // Remove as aspas externas (primeiro e último caractere)
    // Ex: "1000001021,TIM,RS,..." → 1000001021,TIM,RS,...
    if (line.startsWith('"') && line.endsWith('"')) {
        line = line.substring(1, line.length - 1);
    }

    // Substitui aspas duplas escapadas ("""") por um placeholder temporário
    // Ex: """RUA DR ALVES VALENCA, S N,""" → "RUA DR ALVES VALENCA, S N,"
    line = line.replace(/""/g, '\x00');

    // Divide a linha pelos separadores (vírgula) que não estão entre aspas
    const valores = [];
    let campoAtual = '';
    let dentroAspas = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            // Inverte o estado "dentro de aspas"
            dentroAspas = !dentroAspas;
        } else if (char === ',' && !dentroAspas) {
            // Fim do campo: restaura os placeholders (aspas escapadas)
            valores.push(campoAtual.replace(/\x00/g, '"'));
            campoAtual = '';
        } else {
            campoAtual += char;
        }
    }
    // Adiciona o último campo
    valores.push(campoAtual.replace(/\x00/g, '"'));

    // LOG DE DEPURAÇÃO: Mostra os detalhes das primeiras 3 linhas
    if (linhaNumero <= 3) {
        console.log(`   🔎 Linha ${linhaNumero} (campos): ${valores.length} campos encontrados.`);
        console.log(`   🔎 ID (campo 0): "${valores[0] || 'VAZIO'}"`);
        console.log(`   🔎 Lat (campo 10): "${valores[10] || 'VAZIO'}"`);
        console.log(`   🔎 Lon (campo 11): "${valores[11] || 'VAZIO'}"`);
    }

    return valores;
}

// ============================================================
// FUNÇÃO PARA IMPORTAR ERBs
// ============================================================
// Esta é a função principal que lê os arquivos CSV e importa os dados
// para o banco de dados SQLite.
// ============================================================

async function importarERBs() {
    // Verifica se a pasta /data existe
    if (!fs.existsSync(DATA_DIR)) {
        console.log('⚠️ Pasta /data não encontrada.');
        return;
    }

    // Lista todos os arquivos que começam com 'erb_consolidado_final_part' e terminam com .csv
    const arquivos = fs.readdirSync(DATA_DIR).filter(f =>
        f.startsWith('erb_consolidado_final_part') && f.endsWith('.csv')
    );

    // Se não encontrar nenhum arquivo, encerra a função
    if (arquivos.length === 0) {
        console.log('⚠️ Nenhum arquivo ERB encontrado.');
        return;
    }

    console.log(`📂 Encontrados ${arquivos.length} arquivos.`);

    // Processa cada arquivo encontrado
    for (const arquivo of arquivos.sort()) {
        const caminho = path.join(DATA_DIR, arquivo);
        console.log(`🔍 Lendo ${arquivo}...`);

        // Objeto para armazenar estações únicas (evita duplicatas)
        let estacoes = {};
        let linhaAtual = 0;
        let erros = 0;
        let ignorados = 0;

        // Promise para processar o arquivo de forma assíncrona
        await new Promise((resolve, reject) => {
            // Cria uma interface de leitura linha a linha
            const rl = readline.createInterface({
                input: fs.createReadStream(caminho, { encoding: 'utf8' }),
                crlfDelay: Infinity // Trata corretamente quebras de linha CRLF
            });

            // Evento disparado para cada linha lida
            rl.on('line', (line) => {
                linhaAtual++;

                // Pula linhas vazias
                if (!line.trim()) {
                    ignorados++;
                    return;
                }
                // Pula linhas que parecem ser cabeçalho (caso existam)
                if (line.toLowerCase().includes('id_estacao')) {
                    ignorados++;
                    return;
                }

                try {
                    // Tenta parsear a linha usando a função especializada
                    const valores = parseCSVLine(line, linhaAtual);

                    // Verifica se a linha tem pelo menos 10 campos (mínimo esperado)
                    if (valores.length < 10) {
                        if (linhaAtual <= 3) {
                            console.log(`   ⚠️ Linha ${linhaAtual} ignorada: apenas ${valores.length} campos.`);
                        }
                        erros++;
                        return;
                    }

                    // Extrai o ID da estação (primeiro campo)
                    const id = valores[0] || '';
                    if (!id) {
                        if (linhaAtual <= 3) {
                            console.log(`   ⚠️ Linha ${linhaAtual} ignorada: ID vazio.`);
                        }
                        erros++;
                        return;
                    }

                    // Extrai coordenadas (campos 10 e 11)
                    const lat = parseFloat(valores[10] || 0);
                    const lon = parseFloat(valores[11] || 0);

                    // Verifica se as coordenadas são números válidos
                    if (isNaN(lat) || isNaN(lon)) {
                        if (linhaAtual <= 3) {
                            console.log(`   ⚠️ Linha ${linhaAtual} ignorada: coordenadas inválidas (lat: ${valores[10]}, lon: ${valores[11]}).`);
                        }
                        erros++;
                        return;
                    }

                    // Se o ID ainda não foi registrado, cria um novo registro
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
                            tecnologias: valores[8] || '',
                            frequencias: valores[9] || '',
                            azimutes: '',
                            emissoes: valores[25] || '',
                            fonte: 'OpenCellID + Anatel',
                            opencellid_radio: valores[12] || '',
                            opencellid_cell: valores[16] || '',
                            opencellid_correspondencia: valores[21] || '',
                            anatel_correspondencia: valores[27] || ''
                        };
                    }
                } catch (err) {
                    // Captura qualquer erro inesperado durante o processamento
                    erros++;
                    if (erros <= 5) {
                        console.log(`   ❌ Erro crítico na linha ${linhaAtual}: ${err.message}`);
                    }
                }
            });

            // Evento disparado quando a leitura do arquivo é concluída
            rl.on('close', () => {
                const qtd = Object.keys(estacoes).length;
                console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);
                console.log(`   ⚠️ ${ignorados} linhas ignoradas, ${erros} erros.`);

                // Se houver estações para importar, insere no banco de dados
                if (qtd > 0) {
                    // Prepara a instrução SQL para inserção (com OR REPLACE para evitar duplicatas)
                    const stmt = db.prepare(`
                        INSERT OR REPLACE INTO estacoes (
                            id_estacao, operadora, uf, municipio, bairro, endereco,
                            codigo_municipio_ibge, latitude, longitude, tecnologias,
                            frequencias, azimutes, emissoes, fonte,
                            opencellid_radio, opencellid_cell, opencellid_correspondencia, anatel_correspondencia
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);

                    let errosInsercao = 0;
                    // Percorre todas as estações e as insere no banco
                    for (const id in estacoes) {
                        const e = estacoes[id];
                        try {
                            stmt.run(
                                e.id_estacao, e.operadora, e.uf, e.municipio, e.bairro, e.endereco,
                                e.codigo_municipio_ibge, e.latitude, e.longitude, e.tecnologias,
                                e.frequencias, e.azimutes, e.emissoes, e.fonte,
                                e.opencellid_radio, e.opencellid_cell, e.opencellid_correspondencia, e.anatel_correspondencia
                            );
                        } catch (insertErr) {
                            errosInsercao++;
                            if (errosInsercao <= 5) {
                                console.error(`   ❌ Erro ao inserir estação ${e.id_estacao}: ${insertErr.message}`);
                                console.error(`      Dados: ${JSON.stringify(e)}`);
                            }
                        }
                    }
                    stmt.finalize(); // Finaliza a instrução preparada
                    console.log(`   ✅ ${Object.keys(estacoes).length - errosInsercao} estações inseridas com sucesso.`);
                }

                // Registra o log da importação
                const logStmt = db.prepare(`
                    INSERT INTO importacao_log (arquivo, registros_lidos, registros_importados)
                    VALUES (?, ?, ?)
                `);
                logStmt.run(arquivo, linhaAtual, qtd);
                logStmt.finalize();

                resolve(); // Resolve a Promise
            });

            // Tratamento de erro na leitura do arquivo
            rl.on('error', (err) => {
                console.error(`❌ Erro ao ler ${arquivo}:`, err);
                reject(err); // Rejeita a Promise
            });
        });
    }
    console.log('✅ Importação concluída.');
}

// ============================================================
// ROTAS DA API
// ============================================================
// Estas são as rotas que o ORION disponibiliza para consulta
// ============================================================

// Rota para buscar estações próximas a uma localização
// Parâmetros: lat (latitude), lon (longitude), raio (em km, opcional, padrão 10)
app.get('/api/estacoes/proximas', (req, res) => {
    const { lat, lon, raio } = req.query;

    // Validação dos parâmetros obrigatórios
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const raioKm = parseFloat(raio) || 10;

    // Consulta SQL com fórmula de Haversine para calcular distância
    // A fórmula de Haversine calcula a distância entre dois pontos na esfera terrestre
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

    // Executa a consulta com os parâmetros fornecidos
    db.all(sql, [lat, lon, lat, raioKm], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows); // Retorna os resultados em JSON
    });
});

// Rota para buscar uma estação específica pelo ID
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

// Rota para listar todas as estações de um estado (UF)
app.get('/api/estacoes/uf/:uf', (req, res) => {
    const { uf } = req.params;
    db.all('SELECT * FROM estacoes WHERE uf = ? ORDER BY municipio', [uf.toUpperCase()], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Rota para listar todas as estações de uma operadora
app.get('/api/estacoes/operadora/:operadora', (req, res) => {
    const { operadora } = req.params;
    db.all('SELECT * FROM estacoes WHERE operadora LIKE ? ORDER BY uf, municipio', [`%${operadora}%`], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Rota para cadastrar um número de telefone para monitoramento
app.post('/api/numeros', (req, res) => {
    const { numero, operadora, uf, municipio } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    // Insere ou substitui o número na tabela 'numeros'
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

// Rota para listar todos os números cadastrados
app.get('/api/numeros', (req, res) => {
    db.all('SELECT * FROM numeros ORDER BY data_cadastro DESC', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Rota para buscar o histórico de consultas
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

// Rota para obter estatísticas gerais do sistema
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

// Função autoexecutável que inicia a importação e depois o servidor
(async () => {
    await importarERBs(); // Primeiro importa os dados
    console.log('✅ ORION pronto para uso.'); // Depois confirma que está pronto
})();

// Inicia o servidor HTTP na porta configurada
app.listen(port, () => {
    console.log(`🚀 ORION rodando na porta ${port}`);
});

// ============================================================
// TRATAMENTO DE ENCERRAMENTO
// ============================================================

// Garante que o banco de dados seja fechado corretamente ao encerrar o servidor
process.on('SIGINT', () => {
    db.close(() => {
        console.log('👋 ORION encerrado.');
        process.exit(0);
    });
});
