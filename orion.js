/**
 * ====================================================================
 * ORION - SISTEMA DE GERENCIAMENTO DE ERBs E LOCALIZAÇÃO INTELIGENTE
 * ====================================================================
 * VERSÃO: 2.3 (com fallback inteligente e aprendizado contínuo)
 * DATA: 2026-08-30
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

function parseNumber(value) {
    if (typeof value === 'number' && !isNaN(value)) return value;
    if (typeof value === 'string') {
        const cleaned = value.replace(',', '.').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }
    return null;
}

function calcularMediaPonderada(leituras) {
    const validas = leituras.filter(l => {
        const rsrp = parseNumber(l.rsrp);
        return rsrp !== null && rsrp > -110;
    });

    if (validas.length === 0) {
        const lats = leituras.map(l => parseNumber(l.latitude)).filter(v => v !== null);
        const lons = leituras.map(l => parseNumber(l.longitude)).filter(v => v !== null);
        if (lats.length === 0 || lons.length === 0) {
            return { lat: null, lon: null };
        }
        return {
            lat: lats.reduce((a, b) => a + b, 0) / lats.length,
            lon: lons.reduce((a, b) => a + b, 0) / lons.length
        };
    }

    const pesos = validas.map(l => Math.pow(10, parseNumber(l.rsrp) / 10));
    const somaPesos = pesos.reduce((a, b) => a + b, 0);
    if (somaPesos === 0) {
        const lats = validas.map(l => parseNumber(l.latitude)).filter(v => v !== null);
        const lons = validas.map(l => parseNumber(l.longitude)).filter(v => v !== null);
        return {
            lat: lats.reduce((a, b) => a + b, 0) / lats.length,
            lon: lons.reduce((a, b) => a + b, 0) / lons.length
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

    return { lat: latFinal, lon: lonFinal };
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
// ROTAS DA API (Todas as rotas existentes + novas)
// ============================================================

// ... [Todas as rotas existentes: estacoes, numeros, alvos, bases, recursos, filtros, historico, alertas, coleta] ...

// ============================================================
// NOVA ROTA: /api/localizar-fallback (FALLBACK INTELIGENTE)
// ============================================================
app.get('/api/localizar-fallback', async (req, res) => {
    const { numero } = req.query;
    if (!numero) return res.status(400).json({ error: 'Número não informado' });

    try {
        // 1. Primeiro, tenta localizar com dados de sinal (coletas)
        const { data: leituras, error: leiturasError } = await supabase
            .from('coletas')
            .select('latitude, longitude, rsrp, timestamp')
            .eq('numero', numero)
            .order('timestamp', { ascending: false })
            .limit(15);

        if (!leiturasError && leituras && leituras.length > 0) {
            console.log(`📊 Encontradas ${leituras.length} leituras para ${numero}`);
            const leiturasCorrigidas = leituras.map(l => ({
                latitude: parseNumber(l.latitude),
                longitude: parseNumber(l.longitude),
                rsrp: parseNumber(l.rsrp) || -100,
                timestamp: l.timestamp
            })).filter(l => l.latitude !== null && l.longitude !== null);

            if (leiturasCorrigidas.length > 0) {
                const { lat, lon } = calcularMediaPonderada(leiturasCorrigidas);
                const raio = calcularRaioIncerteza(leiturasCorrigidas);
                return res.json({
                    numero,
                    latitude: lat || 0,
                    longitude: lon || 0,
                    raio_incerteza_metros: Math.round(raio),
                    precisao: raio < 100 ? 'Alta' : raio < 300 ? 'Média' : 'Baixa',
                    total_amostras: leituras.length,
                    metodo: 'Ponderado por RSRP + Filtro Kalman + Correção de Viés',
                    fallback: false
                });
            }
        }

        // 2. Se não tem dados de sinal, busca a última localização GPS enviada
        const { data: ultimoGPS, error: gpsError } = await supabase
            .from('historico_localizacao')
            .select('latitude, longitude')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(1);

        if (!gpsError && ultimoGPS && ultimoGPS.length > 0) {
            console.log(`📍 Último GPS encontrado para ${numero}`);
            return res.json({
                numero,
                latitude: ultimoGPS[0].latitude,
                longitude: ultimoGPS[0].longitude,
                raio_incerteza_metros: 500,
                precisao: 'Muito Baixa',
                total_amostras: 0,
                metodo: 'Última localização GPS conhecida',
                fallback: true,
                mensagem: 'Localização aproximada baseada no último GPS. Clique para corrigir.'
            });
        }

        // 3. Busca a localização da torre (Cell ID) no banco de ERBs
        const { data: ultimoSinal, error: sinalError } = await supabase
            .from('dados_sinal')
            .select('estacao_id, latitude, longitude')
            .eq('numero', numero)
            .order('data_hora', { ascending: false })
            .limit(1);

        if (!sinalError && ultimoSinal && ultimoSinal.length > 0) {
            const estacaoId = ultimoSinal[0].estacao_id;
            console.log(`📡 Buscando torre com ID: ${estacaoId}`);
            
            if (estacaoId && estacaoId !== 'desconhecido') {
                const { data: estacao, error: estacaoError } = await supabase
                    .from('estacoes')
                    .select('latitude, longitude')
                    .eq('id_estacao', estacaoId)
                    .single();

                if (!estacaoError && estacao) {
                    console.log(`🗼 Torre encontrada: ${estacao.latitude}, ${estacao.longitude}`);
                    return res.json({
                        numero,
                        latitude: estacao.latitude,
                        longitude: estacao.longitude,
                        raio_incerteza_metros: 5000,
                        precisao: 'Muito Baixa',
                        total_amostras: 0,
                        metodo: 'Localização da torre (Cell ID)',
                        fallback: true,
                        estacao_id: estacaoId,
                        mensagem: 'Localização aproximada baseada na torre de celular. Clique para corrigir.'
                    });
                }
            }
        }

        // 4. Nada encontrado – retorna 404 com sugestão
        console.log(`❌ Nenhuma localização encontrada para ${numero}`);
        return res.status(404).json({
            erro: 'Nenhuma localização encontrada para este número',
            sugestao: 'Instale o script de coleta no celular ou envie dados de sinal manualmente.'
        });

    } catch (err) {
        console.error('❌ Erro no fallback:', err);
        res.status(500).json({ error: 'Erro ao processar localização: ' + err.message });
    }
});

// ============================================================
// ROTA DE FEEDBACK (já existente, mantida)
// ============================================================
app.post('/api/feedback', async (req, res) => {
    try {
        const { numero, lat_real, lon_real, lat_mostrada, lon_mostrada } = req.body;
        if (!numero || lat_real === undefined || lon_real === undefined) {
            return res.status(400).json({ error: 'Campos obrigatórios: numero, lat_real, lon_real' });
        }

        const latReal = parseNumber(lat_real);
        const lonReal = parseNumber(lon_real);
        if (latReal === null || lonReal === null) {
            return res.status(400).json({ error: 'lat_real ou lon_real inválidos' });
        }

        const { error: insertError } = await supabase
            .from('feedback')
            .insert([{ numero, lat_real: latReal, lon_real: lonReal, lat_mostrada: parseNumber(lat_mostrada) || 0, lon_mostrada: parseNumber(lon_mostrada) || 0 }]);
        if (insertError) {
            console.error('Erro ao salvar feedback:', insertError);
            return res.status(500).json({ error: 'Erro ao salvar feedback' });
        }

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
                const latReal = parseNumber(f.lat_real) || 0;
                const lonReal = parseNumber(f.lon_real) || 0;
                const latMostrada = parseNumber(f.lat_mostrada) || 0;
                const lonMostrada = parseNumber(f.lon_mostrada) || 0;
                somaViesLat += (latReal - latMostrada);
                somaViesLon += (lonReal - lonMostrada);
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
        res.status(500).json({ error: 'Erro interno ao processar feedback: ' + err.message });
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
    console.log(`🧠 Rotas disponíveis:`);
    console.log(`   GET /api/localizar-fallback?numero=XX (FALLBACK INTELIGENTE)`);
    console.log(`   POST /api/feedback`);
    console.log(`📊 Tabelas: coletas, feedback, usuarios, posicoes_historicas`);
});

process.on('SIGINT', () => {
    console.log('👋 ORION encerrado.');
    process.exit(0);
});
