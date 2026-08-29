/**
 * ====================================================================
 * ORION - SISTEMA DE GERENCIAMENTO DE ERBs E LOCALIZAÇÃO INTELIGENTE
 * ====================================================================
 * VERSÃO: 2.1 (com localização inteligente, feedback, KNN e cadastro)
 * DATA: 2026-08-29
 * ====================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// SUPABASE
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
// FUNÇÕES AUXILIARES (matemática)
// ============================================================
function calcularMediaPonderada(leituras) {
    const validas = leituras.filter(l => l.rsrp > -110);
    if (validas.length === 0) {
        const latMedia = leituras.reduce((s, l) => s + l.latitude, 0) / leituras.length;
        const lonMedia = leituras.reduce((s, l) => s + l.longitude, 0) / leituras.length;
        return { lat: latMedia, lon: lonMedia };
    }
    const pesos = validas.map(l => Math.pow(10, l.rsrp / 10));
    const somaPesos = pesos.reduce((a, b) => a + b, 0);
    let latFinal = 0, lonFinal = 0;
    validas.forEach((l, i) => {
        latFinal += l.latitude * (pesos[i] / somaPesos);
        lonFinal += l.longitude * (pesos[i] / somaPesos);
    });
    return { lat: latFinal, lon: lonFinal };
}

function calcularRaioIncerteza(leituras) {
    if (leituras.length < 2) return 300;
    const lats = leituras.map(l => l.latitude);
    const lons = leituras.map(l => l.longitude);
    const desvioLat = desvioPadrao(lats);
    const desvioLon = desvioPadrao(lons);
    const raioMetros = Math.max(desvioLat, desvioLon) * 111000;
    return Math.min(Math.max(raioMetros, 20), 1000);
}

function desvioPadrao(values) {
    const n = values.length;
    if (n === 0) return 0;
    const media = values.reduce((s, v) => s + v, 0) / n;
    const somaQuad = values.reduce((s, v) => s + (v - media) ** 2, 0);
    return Math.sqrt(somaQuad / n);
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// FUNÇÕES PARA IMPORTAR ERBs E ML (KNN)
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
    return valores;
}

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

async function treinarModeloKNN() {
    try {
        const { data: rows, error } = await supabase
            .from('dados_sinal')
            .select('*');
        if (error) throw error;
        if (!rows || rows.length < 10) {
            throw new Error('Dados insuficientes para treinar o modelo (mínimo 10 registros).');
        }
        const features = [];
        const labels = [];
        rows.forEach(row => {
            features.push([row.estacao_id, row.rsrp || 0, row.sinr || 0, row.ta || 0]);
            labels.push([row.latitude, row.longitude]);
        });
        const modelData = { features, labels };
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

function predizerLocalizacaoKNN(estacao_id, rsrp, sinr, ta, k = 3) {
    return new Promise((resolve, reject) => {
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
        let sumLat = 0, sumLon = 0;
        kNearest.forEach(neighbor => {
            sumLat += labels[neighbor.index][0];
            sumLon += labels[neighbor.index][1];
        });
        resolve({ latitude: sumLat / k, longitude: sumLon / k, k });
    });
}

// ============================================================
// MIGRAÇÃO AUTOMÁTICA (popula histórico com dados antigos)
// ============================================================
async function migrarDadosAntigos() {
    console.log('🔄 Verificando necessidade de migração...');
    const { count, error: countError } = await supabase
        .from('posicoes_historicas')
        .select('*', { count: 'exact', head: true });
    if (countError) {
        console.log('ℹ️ Tabela posicoes_historicas pode não existir ainda. Verifique se o SQL foi executado.');
        return;
    }
    if (count > 0) {
        console.log(`✅ Histórico já possui ${count} registros. Migração não necessária.`);
        return;
    }
    console.log('📥 Populando posicoes_historicas com dados antigos...');
    const { data, error } = await supabase
        .from('dados_sinal')
        .select('numero, latitude, longitude, data_hora')
        .order('data_hora', { ascending: false });
    if (error) {
        console.error('❌ Erro ao buscar dados antigos:', error);
        return;
    }
    if (!data || data.length === 0) {
        console.log('ℹ️ Nenhum dado antigo para migrar.');
        return;
    }
    const ultimasPosicoes = {};
    data.forEach(row => {
        if (!ultimasPosicoes[row.numero]) {
            ultimasPosicoes[row.numero] = {
                numero: row.numero,
                latitude: row.latitude,
                longitude: row.longitude,
                timestamp: row.data_hora
            };
        }
    });
    const historico = Object.values(ultimasPosicoes);
    if (historico.length === 0) {
        console.log('ℹ️ Nenhum dado antigo para migrar.');
        return;
    }
    const { error: insertError } = await supabase
        .from('posicoes_historicas')
        .insert(historico);
    if (insertError) {
        console.error('❌ Erro na migração:', insertError);
    } else {
        console.log(`✅ Migração concluída! ${historico.length} registros inseridos.`);
    }
}

// ============================================================
// ROTAS DA API
// ============================================================

// --- ESTAÇÕES (ERBs) ---
app.get('/api/estacoes/mais-proxima', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (isNaN(latitude) || isNaN(longitude)) return res.status(400).json({ error: 'Valores inválidos' });
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
            const dist = Math.sqrt(Math.pow(estacao.latitude - latitude, 2) + Math.pow(estacao.longitude - longitude, 2)) * 111;
            if (dist < menorDistancia) {
                menorDistancia = dist;
                maisProxima = { ...estacao, distancia: dist };
            }
        });
        if (!maisProxima) return res.status(404).json({ error: 'Nenhuma ERB encontrada' });
        res.json(maisProxima);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/estacoes/proximas', async (req, res) => {
    const { lat, lon, raio } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
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
            .map(estacao => ({ ...estacao, distancia: Math.sqrt(Math.pow(estacao.latitude - latitude, 2) + Math.pow(estacao.longitude - longitude, 2)) * 111 }))
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

// --- NÚMEROS ---
app.post('/api/numeros', async (req, res) => {
    const { numero, operadora, uf, municipio } = req.body;
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });
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

// --- ALVOS ---
app.post('/api/alvos', async (req, res) => {
    const { numero, operadora, uf, municipio, tag, nome } = req.body;
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });
    try {
        const { data, error } = await supabase
            .from('alvos')
            .upsert({ numero, operadora: operadora || '', uf: uf || '', municipio: municipio || '', tag: tag || '', nome: nome || '' })
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

// --- BASES ---
app.post('/api/bases', async (req, res) => {
    const { nome, uf, municipio, latitude, longitude, descricao } = req.body;
    if (!nome || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Nome, latitude e longitude são obrigatórios' });
    }
    try {
        const { data, error } = await supabase
            .from('bases')
            .insert({ nome, uf: uf || '', municipio: municipio || '', latitude, longitude, descricao: descricao || '' })
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

// --- RECURSOS ---
async function criarBaseAutomatica(numero, lat = -15.8, lon = -47.9) {
    const nomeBase = `Base Automática - ${numero}`;
    const { data, error } = await supabase
        .from('bases')
        .insert({ nome: nomeBase, uf: '', municipio: '', latitude: lat, longitude: lon, descricao: 'Base criada automaticamente pelo ORION' })
        .select();
    if (error) throw error;
    return data[0].id;
}

app.post('/api/recursos', async (req, res) => {
    const { numero, operadora, nome, base_id, status, latitude, longitude } = req.body;
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });
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
            .upsert({ numero, operadora: operadora || '', nome: nome || '', base_id: finalBaseId || null, status: status || 'desconhecido' })
            .select();
        if (error) throw error;
        res.json({ success: true, id: data[0]?.id, base_id: finalBaseId, message: recursoExistente ? 'Recurso atualizado' : 'Recurso cadastrado com base automática' });
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
    if (base_id === undefined) return res.status(400).json({ error: 'base_id é obrigatório' });
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

// --- FILTROS ---
app.post('/api/filtros', async (req, res) => {
    const { nome, tag, operadora, uf, municipio, base_id, distancia_max, horario_inicio, horario_fim, notificar, ativo } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do filtro é obrigatório' });
    try {
        const { data, error } = await supabase
            .from('filtros')
            .insert({ nome, tag: tag || null, operadora: operadora || null, uf: uf || null, municipio: municipio || null, base_id: base_id || null, distancia_max: distancia_max || null, horario_inicio: horario_inicio || null, horario_fim: horario_fim || null, notificar: notificar !== undefined ? notificar : 1, ativo: ativo !== undefined ? ativo : 1 })
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
            .update({ nome, tag: tag || null, operadora: operadora || null, uf: uf || null, municipio: municipio || null, base_id: base_id || null, distancia_max: distancia_max || null, horario_inicio: horario_inicio || null, horario_fim: horario_fim || null, notificar: notificar !== undefined ? notificar : 1, ativo: ativo !== undefined ? ativo : 1 })
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

// --- HISTÓRICO E INTELIGÊNCIA PREDITIVA ---
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
    if (!numero || !estacao_id) return res.status(400).json({ error: 'Número e estacao_id são obrigatórios' });
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
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });
    try {
        const { data: rows, error } = await supabase
            .from('historico_localizacao')
            .select('*')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(100);
        if (error) throw error;
        if (!rows || rows.length === 0) return res.json({ pattern: 'Sem dados suficientes' });
        const locationCount = {};
        rows.forEach(row => {
            const key = `${row.latitude},${row.longitude}`;
            locationCount[key] = (locationCount[key] || 0) + 1;
        });
        let mostFrequent = null, maxCount = 0;
        for (const [key, count] of Object.entries(locationCount)) {
            if (count > maxCount) { maxCount = count; mostFrequent = key; }
        }
        const [lat, lon] = mostFrequent ? mostFrequent.split(',').map(Number) : [null, null];
        const hourCount = {};
        rows.forEach(row => {
            const hora = new Date(row.data_hora).getHours().toString();
            hourCount[hora] = (hourCount[hora] || 0) + 1;
        });
        let mostFrequentHour = null, maxHourCount = 0;
        for (const [hora, count] of Object.entries(hourCount)) {
            if (count > maxHourCount) { maxHourCount = count; mostFrequentHour = hora; }
        }
        res.json({ pattern: { localizacao_mais_frequente: { latitude: lat, longitude: lon }, horario_mais_frequente: mostFrequentHour, total_registros: rows.length } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/alertas', async (req, res) => {
    const { numero } = req.query;
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });
    try {
        const { data: rows, error } = await supabase
            .from('historico_localizacao')
            .select('*')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(10);
        if (error) throw error;
        if (!rows || rows.length < 3) return res.json({ alerta: 'Sem dados suficientes para alertas' });
        let distanciaTotal = 0, intervalos = 0;
        for (let i = 0; i < rows.length - 1; i++) {
            const lat1 = rows[i].latitude, lon1 = rows[i].longitude;
            const lat2 = rows[i+1].latitude, lon2 = rows[i+1].longitude;
            const dist = Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lon2 - lon1, 2)) * 111;
            distanciaTotal += dist;
            intervalos++;
        }
        const velocidadeMedia = intervalos > 0 ? distanciaTotal / intervalos : 0;
        if (velocidadeMedia > 50) {
            res.json({ alerta: `🚨 Movimento suspeito detectado (${velocidadeMedia.toFixed(1)} km/h).` });
        } else if (velocidadeMedia > 20) {
            res.json({ alerta: `⚠️ Movimento moderado detectado (${velocidadeMedia.toFixed(1)} km/h).` });
        } else {
            res.json({ alerta: `✅ Padrão normal (${velocidadeMedia.toFixed(1)} km/h).` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- COLETA DE SINAL E ML ---
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
        // Insere em dados_sinal
        const { data, error } = await supabase
            .from('dados_sinal')
            .insert({ numero, estacao_id, latitude, longitude, rsrp: rsrp || null, sinr: sinr || null, ta: ta || null })
            .select();
        if (error) throw error;

        // Insere em coletas (para localização inteligente)
        const { error: insertColetaError } = await supabase
            .from('coletas')
            .insert([{ numero, estacao_id, latitude, longitude, rsrp, sinr, ta }]);
        if (insertColetaError) {
            console.error('Erro ao inserir em coletas:', insertColetaError);
        }

        // Correção por TA
        let latFinal = latitude, lonFinal = longitude;
        const { data: estacao, error: estacaoError } = await supabase
            .from('estacoes')
            .select('latitude, longitude')
            .eq('id_estacao', estacao_id)
            .maybeSingle();
        if (!estacaoError && estacao && ta) {
            const raioMaximoKm = (ta * 78.12) / 1000;
            const distAtual = haversine(latitude, longitude, estacao.latitude, estacao.longitude);
            if (distAtual > raioMaximoKm) {
                const proporcao = raioMaximoKm / distAtual;
                latFinal = estacao.latitude + (latitude - estacao.latitude) * proporcao;
                lonFinal = estacao.longitude + (longitude - estacao.longitude) * proporcao;
            }
        }

        // Treina modelo KNN se houver dados suficientes
        const { count, error: countError } = await supabase
            .from('dados_sinal')
            .select('*', { count: 'exact', head: true });
        if (countError) throw countError;
        if (count >= 10) {
            treinarModeloKNN()
                .then(result => console.log(`✅ Modelo treinado automaticamente com ${result.total_registros} registros.`))
                .catch(error => console.error('❌ Erro ao treinar modelo automaticamente:', error));
        }

        res.json({
            success: true,
            id: data[0]?.id,
            message: 'Dados de sinal coletados com sucesso.',
            total_registros: count,
            latitude_corrigida: latFinal,
            longitude_corrigida: lonFinal
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
    if (!estacao_id) return res.status(400).json({ error: 'estacao_id é obrigatório' });
    const kValue = parseInt(k) || 3;
    predizerLocalizacaoKNN(estacao_id, parseFloat(rsrp), parseFloat(sinr), parseFloat(ta), kValue)
        .then(result => res.json({ success: true, latitude: result.latitude, longitude: result.longitude, k: result.k, metodo: 'KNN' }))
        .catch(error => res.status(500).json({ error }));
});

// ============================================================
// ROTAS INTELIGENTES (NOVAS)
// ============================================================

// Localização inteligente (estilo Google)
app.get('/api/localizar-inteligente', async (req, res) => {
    const { numero } = req.query;
    if (!numero) return res.status(400).json({ error: 'Número não informado' });

    try {
        // Busca as últimas 15 leituras na tabela coletas
        const { data: leituras, error: leiturasError } = await supabase
            .from('coletas')
            .select('latitude, longitude, rsrp, timestamp')
            .eq('numero', numero)
            .order('timestamp', { ascending: false })
            .limit(15);

        if (leiturasError) {
            console.error('Erro ao buscar leituras:', leiturasError);
            return res.status(500).json({ error: 'Erro ao consultar dados' });
        }

        if (!leituras || leituras.length === 0) {
            return res.status(404).json({
                erro: 'Nenhuma localização encontrada para este número',
                sugestao: 'Realize uma coleta primeiro usando o aplicativo ou script'
            });
        }

        // Média ponderada por RSRP
        const { lat: latPonderada, lon: lonPonderada } = calcularMediaPonderada(leituras);

        // Filtro de Kalman (histórico)
        const { data: historico, error: historicoError } = await supabase
            .from('posicoes_historicas')
            .select('latitude, longitude')
            .eq('numero', numero)
            .order('timestamp', { ascending: false })
            .limit(5);

        let latFinal = latPonderada, lonFinal = lonPonderada;
        if (!historicoError && historico && historico.length > 0) {
            const ultima = historico[0];
            latFinal = ultima.latitude * 0.3 + latPonderada * 0.7;
            lonFinal = ultima.longitude * 0.3 + lonPonderada * 0.7;
        }

        // Aplicar viés do feedback
        const { data: usuario, error: usuarioError } = await supabase
            .from('usuarios')
            .select('vies_lat, vies_lon')
            .eq('numero', numero)
            .maybeSingle();
        if (!usuarioError && usuario) {
            latFinal += usuario.vies_lat;
            lonFinal += usuario.vies_lon;
        }

        // Raio de incerteza
        const raioMetros = calcularRaioIncerteza(leituras);

        // Salvar no histórico
        await supabase
            .from('posicoes_historicas')
            .insert([{ numero, latitude: latFinal, longitude: lonFinal, timestamp: new Date().toISOString() }]);

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
        console.error('Erro ao consultar localização inteligente:', err);
        res.status(500).json({ error: 'Erro interno ao processar localização' });
    }
});

// Feedback do usuário
app.post('/api/feedback', async (req, res) => {
    try {
        const { numero, lat_real, lon_real, lat_mostrada, lon_mostrada } = req.body;
        if (!numero || lat_real === undefined || lon_real === undefined) {
            return res.status(400).json({ error: 'Campos obrigatórios: numero, lat_real, lon_real' });
        }

        // Salva o feedback
        const { error: insertError } = await supabase
            .from('feedback')
            .insert([{ numero, lat_real, lon_real, lat_mostrada: lat_mostrada || 0, lon_mostrada: lon_mostrada || 0 }]);
        if (insertError) {
            console.error('Erro ao salvar feedback:', insertError);
            return res.status(500).json({ error: 'Erro ao salvar feedback' });
        }

        // Recalcula o viés com os últimos 5 feedbacks
        const { data: feedbacks, error: feedbackError } = await supabase
            .from('feedback')
            .select('lat_real, lon_real, lat_mostrada, lon_mostrada')
            .eq('numero', numero)
            .order('timestamp', { ascending: false })
            .limit(5);

        let viesLat = 0, viesLon = 0;
        if (!feedbackError && feedbacks && feedbacks.length > 0) {
            let somaViesLat = 0, somaViesLon = 0;
            feedbacks.forEach(f => {
                somaViesLat += (f.lat_real - (f.lat_mostrada || 0));
                somaViesLon += (f.lon_real - (f.lon_mostrada || 0));
            });
            viesLat = somaViesLat / feedbacks.length;
            viesLon = somaViesLon / feedbacks.length;

            await supabase
                .from('usuarios')
                .upsert({ numero, vies_lat: viesLat, vies_lon: viesLon, ultima_atualizacao: new Date().toISOString() }, { onConflict: 'numero' });
        }

        res.status(201).json({
            mensagem: 'Feedback recebido! Obrigado por melhorar o Orion.',
            viés_aplicado: { vies_lat: viesLat, vies_lon: viesLon }
        });

    } catch (err) {
        console.error('Erro ao processar feedback:', err);
        res.status(500).json({ error: 'Erro interno ao processar feedback' });
    }
});

// --- ESTATÍSTICAS ---
app.get('/api/estatisticas', async (req, res) => {
    try {
        const [
            estacoesResult, numerosResult, alvosResult, basesResult,
            recursosResult, filtrosResult, localizacoesResult,
            dadosSinalResult, coletasResult, feedbackResult,
            usuariosResult, historicoPosicoesResult
        ] = await Promise.all([
            supabase.from('estacoes').select('*', { count: 'exact', head: true }),
            supabase.from('numeros').select('*', { count: 'exact', head: true }),
            supabase.from('alvos').select('*', { count: 'exact', head: true }),
            supabase.from('bases').select('*', { count: 'exact', head: true }),
            supabase.from('recursos').select('*', { count: 'exact', head: true }),
            supabase.from('filtros').select('*', { count: 'exact', head: true }),
            supabase.from('historico_localizacao').select('*', { count: 'exact', head: true }),
            supabase.from('dados_sinal').select('*', { count: 'exact', head: true }),
            supabase.from('coletas').select('*', { count: 'exact', head: true }).catch(() => ({ count: 0 })),
            supabase.from('feedback').select('*', { count: 'exact', head: true }).catch(() => ({ count: 0 })),
            supabase.from('usuarios').select('*', { count: 'exact', head: true }).catch(() => ({ count: 0 })),
            supabase.from('posicoes_historicas').select('*', { count: 'exact', head: true }).catch(() => ({ count: 0 }))
        ]);

        const { data: operadoras } = await supabase
            .from('estacoes')
            .select('operadora')
            .not('operadora', 'is', null);
        const { data: ufs } = await supabase
            .from('estacoes')
            .select('uf')
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
            total_dados_sinal: dadosSinalResult.count || 0,
            total_coletas: coletasResult.count || 0,
            total_feedback: feedbackResult.count || 0,
            total_usuarios_com_viés: usuariosResult.count || 0,
            total_historico_posicoes: historicoPosicoesResult.count || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
(async () => {
    await importarERBs();
    console.log('✅ ORION pronto para uso.');
})();

app.listen(port, () => {
    console.log(`🚀 ORION rodando na porta ${port}`);
    console.log(`📅 Data/Hora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log(`🧠 Novas rotas inteligentes disponíveis:`);
    console.log(`   GET /api/localizar-inteligente?numero=XX`);
    console.log(`   POST /api/feedback`);
    console.log(`📊 Tabelas adicionais: coletas, feedback, usuarios, posicoes_historicas`);
});

process.on('SIGINT', () => {
    console.log('👋 ORION encerrado.');
    process.exit(0);
});
