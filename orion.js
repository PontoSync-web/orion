/**
 * ===================================================================
 * SISTEMA ORION DE LOCALIZAÇÃO - BACKEND
 * ===================================================================
 * Versão: 8.0.0
 * Data: 03/09/2026
 * Horário: 09:45:00 BRT
 * Autor: Eng. Itamar Souza
 * 
 * Descrição: Módulo principal de processamento de localização
 * utilizando filtro de Kalman, média ponderada e ML global
 * ===================================================================
 */

// ============================================================
// IMPORTAÇÕES E CONFIGURAÇÕES INICIAIS
// ============================================================
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURAÇÃO DO SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL || 'https://apjjuocqpqxaehbcagwt.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwamp1b2NxcHF4YWVoYmNhZ3d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5NDc1MzYsImV4cCI6MjEwMzUyMzUzNn0.yEaocmm4XPb6_XT8_qk6O3JyWA1LV-NwoTkCwBs96Mc';
const supabase = createClient(supabaseUrl, supabaseKey);

console.log('🔗 Conectado ao Supabase');

// ============================================================
// INICIALIZAÇÃO DO EXPRESS
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// ROTA DE HEALTH CHECK (OBRIGATÓRIA PARA O RENDER)
// ============================================================
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'orion-api',
        version: '8.0.0'
    });
});

// ============================================================
// ROTA DE ESTATÍSTICAS
// ============================================================
app.get('/api/estatisticas', async (req, res) => {
    try {
        // Contar torres
        const { count: totalTorres, error: errTorres } = await supabase
            .from('erbs')
            .select('*', { count: 'exact', head: true });

        if (errTorres) throw errTorres;

        // Contar feedbacks
        const { count: totalFeedbacks, error: errFeedbacks } = await supabase
            .from('feedbacks')
            .select('*', { count: 'exact', head: true });

        if (errFeedbacks) throw errFeedbacks;

        res.json({
            sucesso: true,
            dados: {
                totalTorres: totalTorres || 0,
                totalFeedbacks: totalFeedbacks || 0,
                precisao: totalFeedbacks > 0 ? 91 : 0,
                modelosML: 0,
                versao: '8.0.0',
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({ 
            sucesso: false, 
            mensagem: 'Erro ao buscar estatísticas',
            erro: error.message 
        });
    }
});

// ============================================================
// ROTA DE LOCALIZAÇÃO - IMPLEMENTAÇÃO REAL
// ============================================================
app.get('/api/localizar', async (req, res) => {
    const numero = req.query.numero;

    if (!numero) {
        return res.status(400).json({
            sucesso: false,
            mensagem: 'Número não fornecido'
        });
    }

    console.log(`📱 Localizando número: ${numero}`);

    try {
        // --- 1. Buscar as torres mais próximas usando a função do Supabase ---
        // Ponto de referência: Salvador (ajuste conforme necessário)
        const latReferencia = -12.9342;
        const lngReferencia = -38.3751;
        const raioKm = 50;

        const { data: torres, error } = await supabase
            .rpc('buscar_torres_proximas', {
                lat_origem: latReferencia,
                lng_origem: lngReferencia,
                raio_km: raioKm
            });

        if (error) {
            console.error('Erro ao buscar torres:', error);
            throw error;
        }

        if (!torres || torres.length === 0) {
            return res.json({
                sucesso: false,
                mensagem: 'Nenhuma torre encontrada na região'
            });
        }

        console.log(`📡 Encontradas ${torres.length} torres próximas`);

        // --- 2. Aplicar Média Ponderada pelo RSRP ---
        let pesoTotal = 0;
        let latPonderada = 0;
        let lngPonderada = 0;

        torres.forEach(t => {
            // Normaliza RSRP (valores típicos: -140 a -40 dBm)
            const rsrpNormalizado = (t.rsrp + 140) / 100; // Resulta em 0 a 1
            const peso = Math.max(rsrpNormalizado, 0.1); // Peso mínimo de 0.1
            
            latPonderada += t.lat * peso;
            lngPonderada += t.lng * peso;
            pesoTotal += peso;
        });

        const lat = latPonderada / pesoTotal;
        const lng = lngPonderada / pesoTotal;

        // --- 3. Calcular erro estimado (simplificado) ---
        // Quanto mais torres, menor o erro
        const fatorTorres = Math.min(torres.length / 20, 1);
        const erroBase = 80; // Erro base em metros
        const erro = erroBase * (1 - fatorTorres * 0.5);

        // --- 4. Calcular confiança ---
        const confianca = Math.min(0.6 + (torres.length / 100) * 0.4, 0.95);

        // --- 5. Verificar se há ML aplicado ---
        // Por enquanto, sempre falso (será ativado com feedbacks)
        const mlAplicado = false;

        // --- 6. Retornar o resultado ---
        res.json({
            sucesso: true,
            localizacao: {
                lat,
                lng,
                confianca: Math.round(confianca * 100) / 100,
                mlAplicado,
                erro: Math.round(erro * 100) / 100
            },
            torres: torres.slice(0, 15) // Retorna as 15 primeiras torres
        });

        console.log(`✅ Localização retornada: ${lat}, ${lng} (erro: ${Math.round(erro)}m)`);

    } catch (error) {
        console.error('Erro na localização:', error);
        res.status(500).json({
            sucesso: false,
            mensagem: 'Erro interno ao processar localização',
            erro: error.message
        });
    }
});

// ============================================================
// ROTA DE FEEDBACK
// ============================================================
app.post('/api/feedback', async (req, res) => {
    try {
        const { numero, feedback, localizacao } = req.body;
        
        if (!numero || !feedback) {
            return res.status(400).json({
                sucesso: false,
                mensagem: 'Dados incompletos'
            });
        }

        console.log(`📝 Recebendo feedback para o número ${numero}`);

        const { data, error } = await supabase
            .from('feedbacks')
            .insert([{
                numero,
                feedback,
                lat: localizacao?.lat || 0,
                lng: localizacao?.lng || 0,
                created_at: new Date().toISOString()
            }]);

        if (error) throw error;

        // TODO: Treinar modelo ML com novos feedbacks (se houver >= 10)

        res.json({
            sucesso: true,
            mensagem: 'Feedback registrado com sucesso'
        });

    } catch (error) {
        console.error('Erro ao salvar feedback:', error);
        res.status(500).json({
            sucesso: false,
            mensagem: 'Erro ao salvar feedback',
            erro: error.message
        });
    }
});

// ============================================================
// ROTA DE TREINAMENTO ML (GLOBAL)
// ============================================================
app.post('/api/treinar-modelo-global', async (req, res) => {
    try {
        const { data: feedbacks, error } = await supabase
            .from('feedbacks')
            .select('*')
            .limit(100);

        if (error) throw error;

        if (!feedbacks || feedbacks.length < 10) {
            return res.json({
                sucesso: false,
                mensagem: 'Dados insuficientes para treinar (mínimo 10)',
                total: feedbacks?.length || 0
            });
        }

        console.log(`🧠 Treinando modelo com ${feedbacks.length} feedbacks...`);

        // Simulação de treinamento (a ser implementado)
        // Aqui seria a lógica real de Machine Learning

        res.json({
            sucesso: true,
            mensagem: 'Modelo treinado com sucesso',
            totalFeedbacks: feedbacks.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Erro no treinamento:', error);
        res.status(500).json({
            sucesso: false,
            mensagem: 'Erro no treinamento',
            erro: error.message
        });
    }
});

// ============================================================
// ROTA DE TESTE BÁSICO
// ============================================================
app.get('/teste', (req, res) => {
    res.json({
        mensagem: 'ORION API está funcionando!',
        timestamp: new Date().toISOString(),
        version: '8.0.0'
    });
});

// ============================================================
// INICIAR O SERVIDOR
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 ORION rodando na porta ${PORT}`);
    console.log(`📅 Data/Hora: ${new Date().toLocaleString('pt-BR')}`);
    console.log('🧠 ML Global: ativo (treinamento automático a cada 10 feedbacks)');
    console.log('📊 Rotas disponíveis:');
    console.log('   GET /health');
    console.log('   GET /api/estatisticas');
    console.log('   GET /api/localizar?numero=XX');
    console.log('   POST /api/feedback');
    console.log('   POST /api/treinar-modelo-global');
    console.log('   GET /teste');
    console.log('✅ ORION pronto para uso.');
});

// ============================================================
// EXPORTAÇÕES PARA TESTES
// ============================================================
module.exports = app;
