// ============================================================
// ORION - SISTEMA DE GERENCIAMENTO DE ERBs (VERSÃO SUPABASE)
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
// 11. Integração com Supabase (PostgreSQL)
// ============================================================

// ============================================================
// IMPORTAÇÃO DE MÓDULOS
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES INICIAIS
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// CONFIGURAÇÃO DO SUPABASE
// ============================================================

const supabaseUrl = process.env.SUPABASE_URL || 'https://apjjuocqpqxaehbcagwt.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_lt3FYlhpvS0QMLsdZH3_9g_NgJxsraJ';
const supabase = createClient(supabaseUrl, supabaseKey);

console.log('🔗 Conectado ao Supabase');

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

        let estacoes = [];
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

                    estacoes.push({
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
                    });

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
                const qtd = estacoes.length;
                console.log(`✅ ${arquivo}: ${linhaAtual} linhas lidas, ${qtd} estações importadas.`);
                console.log(`   ⚠️ ${ignorados} linhas ignoradas, ${erros} erros.`);

                if (qtd > 0) {
                    // Insere em lotes (batch) no Supabase
                    const batchSize = 1000;
                    for (let i = 0; i < estacoes.length; i += batchSize) {
                        const batch = estacoes.slice(i, i + batchSize);
                        const { error } = await supabase
                            .from('estacoes')
                            .upsert(batch, { onConflict: 'id_estacao' });
                        if (error) {
                            console.error(`❌ Erro ao inserir lote ${i}:`, error.message);
                        } else {
                            console.log(`   ✅ ${batch.length} estações inseridas...`);
                        }
                    }
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
// FUNÇÃO PARA TREINAR O MODELO KNN
// ============================================================

async function treinarModeloKNN() {
    try {
        const { data: rows, error } = await supabase
            .from('dados_sinal')
            .select('*');

        if (error) throw error;

        if (!rows || rows.length < 10) {
            throw new Error('Dados insuficientes para treinar o modelo (mínimo 10 registros).');
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
        return { total_registros: rows.length };
    } catch (error) {
        throw new Error('Erro ao treinar modelo: ' + error.message);
    }
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

app.get('/api/estacoes/mais-proxima', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ error: 'Latitude e longitude devem ser números válidos' });
    }

    try {
        const { data: estacoes, error } = await supabase
            .from('estacoes')
            .select('*')
            .not('latitude', 'is', null)
            .not('longitude', 'is', null);

        if (error) throw error;

        let maisProxima = null;
        let menorDistancia = Infinity;

        estacoes.forEach(estacao => {
            const dist = Math.sqrt(
                Math.pow(estacao.latitude - latitude, 2) +
                Math.pow(estacao.longitude - longitude, 2)
            ) * 111;

            if (dist < menorDistancia) {
                menorDistancia = dist;
                maisProxima = { ...estacao, distancia: dist };
            }
        });

        if (!maisProxima) {
            return res.status(404).json({ error: 'Nenhuma ERB encontrada nas proximidades' });
        }

        res.json(maisProxima);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/estacoes/proximas', async (req, res) => {
    const { lat, lon, raio } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const raioKm = parseFloat(raio) || 10;

    try {
        const { data: estacoes, error } = await supabase
            .from('estacoes')
            .select('*')
            .not('latitude', 'is', null)
            .not('longitude', 'is', null);

        if (error) throw error;

        const resultados = estacoes
            .map(estacao => {
                const dist = Math.sqrt(
                    Math.pow(estacao.latitude - latitude, 2) +
                    Math.pow(estacao.longitude - longitude, 2)
                ) * 111;
                return { ...estacao, distancia: dist };
            })
            .filter(item => item.distancia <= raioKm)
            .sort((a, b) => a.distancia - b.distancia)
            .slice(0, 50);

        res.json(resultados);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/estacoes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('estacoes')
            .select('*')
            .eq('id_estacao', id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Estação não encontrada' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/estacoes/uf/:uf', async (req, res) => {
    const { uf } = req.params;
    try {
        const { data, error } = await supabase
            .from('estacoes')
            .select('*')
            .eq('uf', uf.toUpperCase())
            .order('municipio');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/estacoes/operadora/:operadora', async (req, res) => {
    const { operadora } = req.params;
    try {
        const { data, error } = await supabase
            .from('estacoes')
            .select('*')
            .ilike('operadora', `%${operadora}%`)
            .order('uf')
            .order('municipio');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const { data, error } = await supabase
            .from('numeros')
            .upsert({ numero, operadora: operadora || '', uf: uf || '', municipio: municipio || '' })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/numeros/localizacao', async (req, res) => {
    const { numero, latitude, longitude, uf, municipio } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    try {
        const { error } = await supabase
            .from('numeros')
            .upsert({ numero, uf: uf || '', municipio: municipio || '', latitude, longitude });

        if (error) throw error;
        res.json({ success: true, message: `Localização do número ${numero} atualizada` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/numeros', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('numeros')
            .select('*')
            .order('data_cadastro', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/numeros/:numero', async (req, res) => {
    const { numero } = req.params;
    try {
        const { data, error } = await supabase
            .from('numeros')
            .select('*')
            .eq('numero', numero)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Número não encontrado' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const { data, error } = await supabase
            .from('alvos')
            .upsert({
                numero,
                operadora: operadora || '',
                uf: uf || '',
                municipio: municipio || '',
                tag: tag || '',
                nome: nome || ''
            })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/alvos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('alvos')
            .select('*')
            .order('data_cadastro', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/alvos/tag/:tag', async (req, res) => {
    const { tag } = req.params;
    try {
        const { data, error } = await supabase
            .from('alvos')
            .select('*')
            .eq('tag', tag)
            .order('data_cadastro', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/alvos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('alvos')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const { data, error } = await supabase
            .from('bases')
            .insert({
                nome,
                uf: uf || '',
                municipio: municipio || '',
                latitude,
                longitude,
                descricao: descricao || ''
            })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bases', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('bases')
            .select('*')
            .order('nome');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('bases')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Base não encontrada' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/bases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('bases')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ROTAS PARA RECURSOS (COM CRIAÇÃO AUTOMÁTICA DE BASE)
// ============================================================

async function criarBaseAutomatica(numero, lat = -15.8, lon = -47.9) {
    const nomeBase = `Base Automática - ${numero}`;
    const { data, error } = await supabase
        .from('bases')
        .insert({
            nome: nomeBase,
            uf: '',
            municipio: '',
            latitude: lat,
            longitude: lon,
            descricao: 'Base criada automaticamente pelo ORION'
        })
        .select();

    if (error) throw error;
    return data[0].id;
}

app.post('/api/recursos', async (req, res) => {
    const { numero, operadora, nome, base_id, status, latitude, longitude } = req.body;
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const { data: recursoExistente, error: findError } = await supabase
            .from('recursos')
            .select('*')
            .eq('numero', numero)
            .maybeSingle();

        if (findError) throw findError;

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

        const { data, error } = await supabase
            .from('recursos')
            .upsert({
                numero,
                operadora: operadora || '',
                nome: nome || '',
                base_id: finalBaseId || null,
                status: status || 'desconhecido'
            })
            .select();

        if (error) throw error;
        res.json({
            success: true,
            id: data[0]?.id,
            base_id: finalBaseId,
            message: recursoExistente ? 'Recurso atualizado' : 'Recurso cadastrado com base automática'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recursos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('recursos')
            .select('*')
            .order('numero');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recursos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('recursos')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Recurso não encontrado' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recursos/numero/:numero', async (req, res) => {
    const { numero } = req.params;
    try {
        const { data, error } = await supabase
            .from('recursos')
            .select('*')
            .eq('numero', numero)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Recurso não encontrado' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/recursos/:id/mover', async (req, res) => {
    const { id } = req.params;
    const { base_id } = req.body;
    if (base_id === undefined) {
        return res.status(400).json({ error: 'base_id é obrigatório' });
    }

    try {
        const { error } = await supabase
            .from('recursos')
            .update({ base_id })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/recursos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('recursos')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const { data, error } = await supabase
            .from('filtros')
            .insert({
                nome,
                tag: tag || null,
                operadora: operadora || null,
                uf: uf || null,
                municipio: municipio || null,
                base_id: base_id || null,
                distancia_max: distancia_max || null,
                horario_inicio: horario_inicio || null,
                horario_fim: horario_fim || null,
                notificar: notificar !== undefined ? notificar : 1,
                ativo: ativo !== undefined ? ativo : 1
            })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/filtros', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('filtros')
            .select('*')
            .order('nome');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('filtros')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Filtro não encontrado' });

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;

    try {
        const { error } = await supabase
            .from('filtros')
            .update({
                nome,
                tag: tag || null,
                operadora: operadora || null,
                uf: uf || null,
                municipio: municipio || null,
                base_id: base_id || null,
                distancia_max: distancia_max || null,
                horario_inicio: horario_inicio || null,
                horario_fim: horario_fim || null,
                notificar: notificar !== undefined ? notificar : 1,
                ativo: ativo !== undefined ? ativo : 1
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/filtros/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('filtros')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// ROTAS PARA HISTÓRICO E INTELIGÊNCIA PREDITIVA
// ============================================================

app.get('/api/historico', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('historico')
            .select('*, estacoes(operadora, municipio, uf)')
            .order('data_consulta', { ascending: false })
            .limit(100);

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/historico', async (req, res) => {
    const { numero, estacao_id, distancia } = req.body;
    if (!numero || !estacao_id) {
        return res.status(400).json({ error: 'Número e estacao_id são obrigatórios' });
    }

    try {
        const { data, error } = await supabase
            .from('historico')
            .insert({ numero, estacao_id, distancia: distancia || null })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/historico-localizacao', async (req, res) => {
    const { numero, latitude, longitude, estacao_id } = req.body;
    if (!numero || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, latitude e longitude são obrigatórios' });
    }

    try {
        const { data, error } = await supabase
            .from('historico_localizacao')
            .insert({ numero, latitude, longitude, estacao_id: estacao_id || null })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analise-padroes', async (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const { data: rows, error } = await supabase
            .from('historico_localizacao')
            .select('*')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(100);

        if (error) throw error;

        if (!rows || rows.length === 0) {
            return res.json({ pattern: 'Sem dados suficientes' });
        }

        const locationCount = {};
        rows.forEach(row => {
            const key = `${row.latitude},${row.longitude}`;
            locationCount[key] = (locationCount[key] || 0) + 1;
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
            const hora = new Date(row.data_hora).getHours().toString();
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/alertas', async (req, res) => {
    const { numero } = req.query;

    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    try {
        const { data: rows, error } = await supabase
            .from('historico_localizacao')
            .select('*')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(10);

        if (error) throw error;

        if (!rows || rows.length < 3) {
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
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        const { data, error } = await supabase
            .from('dados_sinal')
            .insert({ numero, estacao_id, latitude, longitude, rsrp: rsrp || null, sinr: sinr || null, ta: ta || null })
            .select();

        if (error) throw error;
        res.json({ success: true, id: data[0]?.id, message: 'Dados de sinal coletados com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/coletar-sinal-auto', async (req, res) => {
    const { numero, estacao_id, latitude, longitude, rsrp, sinr, ta } = req.body;

    if (!numero || !estacao_id || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Número, estacao_id, latitude e longitude são obrigatórios' });
    }

    try {
        const { data, error } = await supabase
            .from('dados_sinal')
            .insert({ numero, estacao_id, latitude, longitude, rsrp: rsrp || null, sinr: sinr || null, ta: ta || null })
            .select();

        if (error) throw error;

        const { count, error: countError } = await supabase
            .from('dados_sinal')
            .select('*', { count: 'exact', head: true });

        if (countError) throw countError;

        if (count >= 10) {
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
            id: data[0]?.id,
            message: 'Dados de sinal coletados com sucesso.',
            total_registros: count
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
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

app.get('/api/estatisticas', async (req, res) => {
    try {
        const [
            estacoesResult,
            numerosResult,
            alvosResult,
            basesResult,
            recursosResult,
            filtrosResult,
            localizacoesResult,
            dadosSinalResult
        ] = await Promise.all([
            supabase.from('estacoes').select('*', { count: 'exact', head: true }),
            supabase.from('numeros').select('*', { count: 'exact', head: true }),
            supabase.from('alvos').select('*', { count: 'exact', head: true }),
            supabase.from('bases').select('*', { count: 'exact', head: true }),
            supabase.from('recursos').select('*', { count: 'exact', head: true }),
            supabase.from('filtros').select('*', { count: 'exact', head: true }),
            supabase.from('historico_localizacao').select('*', { count: 'exact', head: true }),
            supabase.from('dados_sinal').select('*', { count: 'exact', head: true })
        ]);

        const { data: operadoras } = await supabase
            .from('estacoes')
            .select('operadora', { count: 'exact', head: false })
            .not('operadora', 'is', null);

        const { data: ufs } = await supabase
            .from('estacoes')
            .select('uf', { count: 'exact', head: false })
            .not('uf', 'is', null);

        const operadorasUnicas = new Set(operadoras?.map(item => item.operadora) || []);
        const ufsUnicas = new Set(ufs?.map(item => item.uf) || []);

        res.json({
            total_estacoes: estacoesResult.count || 0,
            total_operadoras: operadorasUnicas.size,
            total_ufs: ufsUnicas.size,
            total_numeros: numerosResult.count || 0,
            total_alvos: alvosResult.count || 0,
            total_bases: basesResult.count || 0,
            total_recursos: recursosResult.count || 0,
            total_filtros: filtrosResult.count || 0,
            total_localizacoes: localizacoesResult.count || 0,
            total_dados_sinal: dadosSinalResult.count || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

(async () => {
    await importarERBs();
    console.log('✅ ORION pronto para uso.');
})();

app.listen(port, () => {
    console.log(`🚀 ORION rodando na porta ${port} (IPv4 e IPv6)`);
});

process.on('SIGINT', () => {
    console.log('👋 ORION encerrado.');
    process.exit(0);
});
