// ============================================================
// ARQUIVO: src/protocolo-hermes.js
// VERSÃO: 6.0 – SUPER REDE DE IAs (20+ modelos)
// DATA: 04/08/2026
// AUTOR: Eng Souza
// MOTIVO: Integrar Qwen, GLM, HappyHorse, Wan, FunAudio,
//         CosyVoice, TongYi, Kimi e outros para máxima eficiência.
// ============================================================

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias
const TIMEOUT = 30000; // 30 segundos por IA
const MAX_RETRIES = 2;

class ProtocoloHermes {
    constructor() {
        this.sessoes = new Map();
        this.cacheRegional = new Map();

        // Lista gigante de IAs com seus respectivos endpoints e chaves (via env)
        this.ias = [
            // ===== IAs principais (já existentes) =====
            {
                nome: 'Claude',
                url: process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages',
                key: process.env.CLAUDE_API_KEY,
                modelo: 'claude-3-sonnet-20240229',
                formato: 'anthropic'
            },
            {
                nome: 'Grok',
                url: process.env.GROK_API_URL || 'https://api.x.ai/v1/chat/completions',
                key: process.env.GROK_API_KEY,
                modelo: 'grok-1',
                formato: 'openai'
            },
            {
                nome: 'Gemini',
                url: process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
                key: process.env.GEMINI_API_KEY,
                modelo: 'gemini-1.5-pro',
                formato: 'gemini'
            },
            {
                nome: 'OpenAI',
                url: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
                key: process.env.OPENAI_API_KEY,
                modelo: 'gpt-4o',
                formato: 'openai'
            },
            {
                nome: 'DeepSeek',
                url: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
                key: process.env.DEEPSEEK_API_KEY,
                modelo: 'deepseek-chat',
                formato: 'openai'
            },
            {
                nome: 'Mistral',
                url: process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1/chat/completions',
                key: process.env.MISTRAL_API_KEY,
                modelo: 'mistral-large-latest',
                formato: 'openai'
            },
            {
                nome: 'Cohere',
                url: process.env.COHERE_API_URL || 'https://api.cohere.ai/v1/chat',
                key: process.env.COHERE_API_KEY,
                modelo: 'command-r-plus',
                formato: 'cohere'
            },

            // ===== Novas IAs solicitadas =====
            {
                nome: 'Qwen3.8-Máx',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen-max',
                formato: 'dashscope'
            },
            {
                nome: 'happyhorse-1.1-i2v',
                url: process.env.HAPPYHORSE_API_URL || 'https://api.happyhorse.ai/v1/i2v',
                key: process.env.HAPPYHORSE_API_KEY,
                modelo: 'happyhorse-1.1-i2v',
                formato: 'openai'
            },
            {
                nome: 'happyhorse-1.1-t2v',
                url: process.env.HAPPYHORSE_API_URL || 'https://api.happyhorse.ai/v1/t2v',
                key: process.env.HAPPYHORSE_API_KEY,
                modelo: 'happyhorse-1.1-t2v',
                formato: 'openai'
            },
            {
                nome: 'happyhorse-1.1-r2v',
                url: process.env.HAPPYHORSE_API_URL || 'https://api.happyhorse.ai/v1/r2v',
                key: process.env.HAPPYHORSE_API_KEY,
                modelo: 'happyhorse-1.1-r2v',
                formato: 'openai'
            },
            {
                nome: 'glm-5.2-fast-preview',
                url: process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                key: process.env.GLM_API_KEY,
                modelo: 'glm-5.2-fast-preview',
                formato: 'openai'
            },
            {
                nome: 'glm-5.2',
                url: process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                key: process.env.GLM_API_KEY,
                modelo: 'glm-5.2',
                formato: 'openai'
            },
            {
                nome: 'wan2.7-t2v',
                url: process.env.WAN_API_URL || 'https://api.wan.ai/v1/t2v',
                key: process.env.WAN_API_KEY,
                modelo: 'wan2.7-t2v',
                formato: 'openai'
            },
            {
                nome: 'wan2.7-i2v',
                url: process.env.WAN_API_URL || 'https://api.wan.ai/v1/i2v',
                key: process.env.WAN_API_KEY,
                modelo: 'wan2.7-i2v',
                formato: 'openai'
            },
            {
                nome: 'qwen3.5-omni-plus',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen3.5-omni-plus',
                formato: 'dashscope'
            },
            {
                nome: 'qwen3.6-max-preview',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen3.6-max-preview',
                formato: 'dashscope'
            },
            {
                nome: 'fun-asr-realtime',
                url: process.env.FUNASR_API_URL || 'https://api.funasr.com/v1/realtime',
                key: process.env.FUNASR_API_KEY,
                modelo: 'fun-asr-realtime',
                formato: 'openai'
            },
            {
                nome: 'cosyvoice-v3-plus',
                url: process.env.COSYVOICE_API_URL || 'https://api.cosyvoice.com/v3/plus',
                key: process.env.COSYVOICE_API_KEY,
                modelo: 'cosyvoice-v3-plus',
                formato: 'openai'
            },
            {
                nome: 'voice-enrollment',
                url: process.env.VOICE_ENROLL_API_URL || 'https://api.voiceenroll.com/v1',
                key: process.env.VOICE_ENROLL_API_KEY,
                modelo: 'voice-enrollment',
                formato: 'openai'
            },
            {
                nome: 'fun-asr-mtl',
                url: process.env.FUNASR_API_URL || 'https://api.funasr.com/v1/mtl',
                key: process.env.FUNASR_API_KEY,
                modelo: 'fun-asr-mtl',
                formato: 'openai'
            },
            {
                nome: 'z-image-turbo',
                url: process.env.ZIMAGE_API_URL || 'https://api.zimage.com/turbo',
                key: process.env.ZIMAGE_API_KEY,
                modelo: 'z-image-turbo',
                formato: 'openai'
            },
            {
                nome: 'tongyi-embedding-vision-plus',
                url: process.env.TONGYI_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'tongyi-embedding-vision-plus',
                formato: 'dashscope'
            },
            {
                nome: 'qwen-voice-design',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen-voice-design',
                formato: 'dashscope'
            },
            {
                nome: 'qwen-max',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen-max',
                formato: 'dashscope'
            },
            {
                nome: 'qwen3-coder-30b-a3b-instruct',
                url: process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
                key: process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY,
                modelo: 'qwen3-coder-30b-a3b-instruct',
                formato: 'dashscope'
            },
            {
                nome: 'kimi-k2.7-code',
                url: process.env.KIMI_API_URL || 'https://api.moonshot.cn/v1/chat/completions',
                key: process.env.KIMI_API_KEY,
                modelo: 'kimi-k2.7-code',
                formato: 'openai'
            }
        ].filter(ia => ia.key && ia.key.length > 0); // só usa as que têm chave configurada

        console.log(`[HERMES] Inicializado com ${this.ias.length} IAs configuradas.`);
    }

    /**
     * Constrói um prompt agressivo para geolocalização.
     */
    construirPrompt(regiao, cells) {
        const cellInfo = cells?.map(c =>
            `Cell ID: ${c.cellId}, MCC: ${c.mcc || 724}, MNC: ${c.mnc || 5}`
        ).join('\n') || 'Cell ID: 181814277, MCC: 724, MNC: 5';

        return `
Você é um sistema de geolocalização de torres de celular da ANATEL.
Preciso das coordenadas EXATAS (latitude, longitude) das ERBs abaixo na região de ${regiao}:

${cellInfo}

REGRAS OBRIGATÓRIAS:
1. Pesquise em fontes públicas: ANATEL, CellMapper, OpenCellID, ou dados de operadoras.
2. Se encontrar dados oficiais, retorne APENAS JSON no formato:
   {"erbs": [{"cell_id": 123, "lat": -12.9714, "lon": -38.5016, "range": 1500}]}
3. Se não encontrar, faça uma estimativa baseada na localização da operadora (Claro - 724/05) na região.
4. NUNCA invente dados. Se não tiver certeza, retorne {"erbs": []}.
5. Sua resposta deve ser APENAS o JSON, sem texto adicional.
`;
    }

    /**
     * Consulta uma IA específica com retry e timeout.
     */
    async consultarIA(ia, prompt, tentativa = 0) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

            let body = {};
            let headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ia.key}`
            };

            // Monta o payload de acordo com o formato da IA
            switch (ia.formato) {
                case 'anthropic':
                    body = {
                        model: ia.modelo,
                        max_tokens: 500,
                        temperature: 0.1,
                        messages: [{ role: 'user', content: prompt }]
                    };
                    break;
                case 'gemini':
                    body = {
                        contents: [{ parts: [{ text: prompt }] }]
                    };
                    delete headers.Authorization;
                    ia.url = `${ia.url}?key=${ia.key}`;
                    break;
                case 'cohere':
                    body = {
                        model: ia.modelo,
                        message: prompt,
                        temperature: 0.1,
                        max_tokens: 500
                    };
                    break;
                case 'dashscope':
                    // API da Alibaba (Qwen)
                    body = {
                        model: ia.modelo,
                        input: {
                            messages: [{ role: 'user', content: prompt }]
                        },
                        parameters: {
                            result_format: 'message',
                            max_tokens: 500,
                            temperature: 0.1
                        }
                    };
                    headers = {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${ia.key}`
                    };
                    break;
                case 'openai':
                default:
                    body = {
                        model: ia.modelo,
                        max_tokens: 500,
                        temperature: 0.1,
                        messages: [{ role: 'user', content: prompt }]
                    };
            }

            const response = await fetch(ia.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} - ${response.statusText}`);
            }

            const data = await response.json();
            let content = '';

            // Extrai o texto da resposta conforme o formato
            switch (ia.formato) {
                case 'anthropic':
                    content = data.content?.[0]?.text || '';
                    break;
                case 'gemini':
                    content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    break;
                case 'cohere':
                    content = data.text || '';
                    break;
                case 'dashscope':
                    content = data.output?.choices?.[0]?.message?.content || data.output?.text || '';
                    break;
                default:
                    content = data.choices?.[0]?.message?.content || '';
            }

            // Tenta extrair JSON da resposta
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.erbs && Array.isArray(parsed.erbs) && parsed.erbs.length > 0) {
                    return parsed.erbs;
                }
            }
            return null;
        } catch (err) {
            if (tentativa < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 2000 * (tentativa + 1)));
                return this.consultarIA(ia, prompt, tentativa + 1);
            }
            console.error(`[HERMES] Erro na IA ${ia.nome}:`, err.message);
            return null;
        }
    }

    /**
     * Consulta todas as IAs em paralelo e retorna o primeiro resultado válido.
     */
    async consultarTodasAsIAs(sessaoId, params) {
        const { regiao, cells } = params;
        const cellId = cells?.[0]?.cellId || 'desconhecido';

        // Verifica cache regional
        const cacheKey = `${regiao}:${cellId}`;
        if (this.cacheRegional.has(cacheKey)) {
            const cached = this.cacheRegional.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                console.log(`[HERMES] Cache hit para ${cacheKey}`);
                return cached.data;
            }
        }

        const prompt = this.construirPrompt(regiao, cells);

        // Lança todas as consultas em paralelo com timeout global
        const promessas = this.ias.map(ia => this.consultarIA(ia, prompt));
        const resultados = await Promise.race([
            Promise.allSettled(promessas),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout global no Hermes')), TIMEOUT + 5000)
            )
        ]);

        // Itera sobre os resultados resolvidos
        if (Array.isArray(resultados)) {
            for (const res of resultados) {
                if (res.status === 'fulfilled' && res.value && res.value.length > 0) {
                    const erbs = res.value;
                    this.cacheRegional.set(cacheKey, {
                        timestamp: Date.now(),
                        data: erbs
                    });
                    console.log(`[HERMES] Dados obtidos com sucesso (${erbs.length} ERBs) via ${res.value.fonte || 'IA'}.`);
                    return erbs;
                }
            }
        }

        console.log('[HERMES] Nenhuma IA retornou ERBs válidas.');
        return [];
    }

    /**
     * Inicia uma sessão de emergência.
     */
    iniciarSessaoEmergenciaNacional(tipo, params) {
        const id = `sessao_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        this.sessoes.set(id, { tipo, params, timestamp: Date.now() });
        return id;
    }

    /**
     * Destroi uma sessão.
     */
    destruirSessao(id) {
        this.sessoes.delete(id);
    }
}

module.exports = ProtocoloHermes;
