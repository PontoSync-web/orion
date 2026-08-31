/**
 * ====================================================================
 * ORION - SISTEMA DE GERENCIAMENTO DE ERBs E LOCALIZAÇÃO INTELIGENTE
 * ====================================================================
 * VERSÃO: 3.0 (com aprendizado contínuo, feedback inteligente e ajuste automático)
 * DATA: 2026-08-31
 * ====================================================================
 * 
 * O Orion agora aprende com cada correção do usuário:
 * 1. Salva feedbacks detalhados (RSRP, SINR, TA, método usado)
 * 2. Calcula viés médio por número
 * 3. Analisa padrões de erro por faixa de RSRP
 * 4. Ajusta pesos automaticamente
 * 5. Melhora a precisão continuamente
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
const CONFIG = {
    VIES_MINIMO: 0.00001,      // 1 metro em graus
    CONFIANCA_MINIMA: 0.3,      // 30% de confiança para aplicar viés
    ERRO_MAXIMO_FILTRAR: 5000,  // 5km - filtrar outliers
    PESO_RSRP_PADRAO: 1.0,
    PESO_TA_PADRAO: 0.5
};

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

function parseNumber(value) {
    if (typeof value === 'number' && !isNaN(value)) return value;
    if (typeof value === 'string') {
        const cleaned = value.replace(',', '.').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }
    return null;
}

function calcularMediaPonderada(leituras, pesosPersonalizados = null) {
    // Filtra leituras válidas
    const validas = leituras.filter(l => {
        const rsrp = parseNumber(l.rsrp);
        return rsrp !== null && rsrp > -110;
    });

    if (validas.length === 0) {
        // Fallback: média simples
        const lats = leituras.map(l => parseNumber(l.latitude)).filter(v => v !== null);
        const lons = leituras.map(l => parseNumber(l.longitude)).filter(v => v !== null);
        if (lats.length === 0 || lons.length === 0) {
            return { lat: null, lon: null, pesos_usados: null };
        }
        return {
            lat: lats.reduce((a, b) => a + b, 0) / lats.length,
            lon: lons.reduce((a, b) => a + b, 0) / lons.length,
            pesos_usados: null
        };
    }

    // Converte RSRP para escala linear e calcula pesos
    let pesos = validas.map(l => Math.pow(10, parseNumber(l.rsrp) / 10));
    
    // Aplica pesos personalizados (aprendizado)
    if (pesosPersonalizados) {
        pesos = pesos.map((p, i) => {
            const rsrp = parseNumber(validas[i].rsrp);
            if (rsrp === null) return p;
            // Ajusta peso baseado no RSRP (aprendido)
            const fator = pesosPersonalizados.rsrp?.[Math.floor(rsrp / 10) * 10] || 1.0;
            return p * fator;
        });
    }

    const somaPesos = pesos.reduce((a, b) => a + b, 0);
    if (somaPesos === 0) {
        const lats = validas.map(l => parseNumber(l.latitude)).filter(v => v !== null);
        const lons = validas.map(l => parseNumber(l.longitude)).filter(v => v !== null);
        return {
            lat: lats.reduce((a, b) => a + b, 0) / lats.length,
            lon: lons.reduce((a, b) => a + b, 0) / lons.length,
            pesos_usados: null
        };
    }

    let latFinal = 0, lonFinal = 0;
    validas.forEach((l, i) => {
        const lat = parseNumber(l.latitude);
        const lon = parseNumber(l.longitude);
        if (lat !== null && lon !== null) {
            latFinal += lat * (pesos[i] / somaPesos);
            lonFinal += lon * (pesos[i] / somaPesos);
        }
    });

    return { lat: latFinal, lon: lonFinal, pesos_usados: pesos };
}

function calcularRaioIncerteza(leituras) {
    const lats = leituras.map(l => parseNumber(l.latitude)).filter(v => v !== null);
    const lons = leituras.map(l => parseNumber(l.longitude)).filter(v => v !== null);
    if (lats.length < 2 || lons.length < 2) return 300;
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

function calcularErro(lat1, lon1, lat2, lon2) {
    const lat1Num = parseNumber(lat1) || 0;
    const lon1Num = parseNumber(lon1) || 0;
    const lat2Num = parseNumber(lat2) || 0;
    const lon2Num = parseNumber(lon2) || 0;
    return haversine(lat1Num, lon1Num, lat2Num, lon2Num) * 1000;
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
// MIGRAÇÃO AUTOMÁTICA
// ============================================================
async function migrarDadosAntigos() {
    console.log('🔄 Verificando necessidade de migração...');
    const { count, error: countError } = await supabase
        .from('posicoes_historicas')
        .select('*', { count: 'exact', head: true });

    if (countError) {
        console.log('ℹ️ Tabela posicoes_historicas ainda não existe.');
        return;
    }

    if (count > 0) {
        console.log(`✅ Histórico já possui ${count} registros.`);
        return;
    }

    console.log('📥 Populando posicoes_historicas com dados antigos...');

    let { data, error } = await supabase
        .from('dados_sinal')
        .select('numero, latitude, longitude, data_hora')
        .order('data_hora', { ascending: false });

    if (error || !data || data.length === 0) {
        console.log('ℹ️ Nenhum dado em dados_sinal. Tentando coletas...');
        const result = await supabase
            .from('coletas')
            .select('numero, latitude, longitude, timestamp')
            .order('timestamp', { ascending: false });
        if (result.error) {
            console.error('❌ Erro ao buscar dados antigos de coletas:', result.error);
            return;
        }
        data = result.data;
        if (!data || data.length === 0) {
            console.log('ℹ️ Nenhum dado antigo para migrar.');
            return;
        }
        data = data.map(row => ({ ...row, data_hora: row.timestamp }));
    }

    const ultimasPosicoes = {};
    data.forEach(row => {
        if (!ultimasPosicoes[row.numero]) {
            ultimasPosicoes[row.numero] = {
                numero: row.numero,
                latitude: parseNumber(row.latitude) || 0,
                longitude: parseNumber(row.longitude) || 0,
                timestamp: row.data_hora || row.timestamp || new Date().toISOString()
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
// FUNÇÃO PARA CARREGAR AJUSTES GLOBAIS
// ============================================================
async function carregarAjustesGlobais() {
    try {
        const { data, error } = await supabase
            .from('configuracoes')
            .select('valor')
            .eq('chave', 'ajustes_rsrp')
            .single();
        
        if (error || !data) {
            console.log('ℹ️ Ajustes globais não encontrados. Usando padrão.');
            return { rsrp: {} };
        }
        return data.valor;
    } catch (error) {
        console.log('⚠️ Erro ao carregar ajustes globais:', error);
        return { rsrp: {} };
    }
}

// ============================================================
// ROTAS DA API (TODAS AS ROTAS EXISTENTES)
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
    const
