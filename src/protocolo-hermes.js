// ============================================================
// ARQUIVO: src/protocolo-hermes.js
// VERSÃO: 6.0
// DATA: 04/08/2026
// MOTIVO: Integração com OpenAI, Claude, Gemini e outras IAs.
// ============================================================

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias
const TIMEOUT = 30000; // 30 segundos
const MAX_RETRIES = 2;

class ProtocoloHermes {
    constructor() {
        this.sessoes = new Map();
        this.cacheRegional = new Map();

        // Lista de IAs configuráveis via variáveis de ambiente
        this.ias = [
            {
                nome: 'OpenAI',
                url: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
                key: process.env.OPENAI_API_KEY,
                modelo: 'gpt-4o',
                formato: 'openai'
            },
            {
                nome: 'Claude',
                url: process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages',
                key: process.env.CLAUDE_API_KEY,
                modelo: 'claude-3-sonnet-20240229',
                formato: 'anthropic'
            },
            {
                nome: 'Gemini',
                url: process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
                key: process.env.GEMINI_API_KEY,
                modelo: 'gemini-1.5-pro',
                formato: 'gemini'
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
            }
        ].filter(ia => ia.key && ia.key.length > 0);

        console.log(`[HERMES] Inicializado com ${this.ias.length} IAs configuradas.`);
    }

    construirPrompt(regiao, cells) {
        const cellInfo = cells?.map(c =>
            `Cell ID: ${c.cellId}, MCC: ${c.mcc || 724}, MNC: ${c.mnc || 5}`
        ).join('\n') || 'Cell ID: 181814277, MCC: 724, MNC: 5';

        return `
Você é um sistema de geolocalização de torres de celular.
Preciso das coordenadas EXATAS (latitude, longitude) das ERBs abaixo na região de ${regiao}:

${cellInfo}

REGRAS:
1. Pesquise em fontes públicas: ANATEL, CellMapper, OpenCellID.
2. Retorne APENAS JSON no formato:
   {"erbs": [{"cell_id": 123, "lat": -12.9714, "lon": -38.5016, "range": 1500}]}
3. Se não encontrar, retorne {"erbs": []}.
4. Sua resposta deve ser APENAS o JSON, sem texto adicional.
`;
    }

    async consultarIA(ia, prompt, tentativa = 0) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

            let body = {};
            let headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ia.key}`
            };

            switch (ia.formato) {
                case 'anthropic':
                    body = { model: ia.modelo, max_tokens: 500, temperature: 0.1, messages: [{ role: 'user', content: prompt }] };
                    break;
                case 'gemini':
                    body = { contents: [{ parts: [{ text: prompt }] }] };
                    delete headers.Authorization;
                    ia.url = `${ia.url}?key=${ia.key}`;
                    break;
                case 'cohere':
                    body = { model: ia.modelo, message: prompt, temperature: 0.1, max_tokens: 500 };
                    break;
                default: // openai
                    body = { model: ia.modelo, max_tokens: 500, temperature: 0.1, messages: [{ role: 'user', content: prompt }] };
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
                default:
                    content = data.choices?.[0]?.message?.content || '';
            }

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

    async consultarTodasAsIAs(sessaoId, params) {
        const { regiao, cells } = params;
        const cellId = cells?.[0]?.cellId || 'desconhecido';

        const cacheKey = `${regiao}:${cellId}`;
        if (this.cacheRegional.has(cacheKey)) {
            const cached = this.cacheRegional.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                console.log(`[HERMES] Cache hit para ${cacheKey}`);
                return cached.data;
            }
        }

        const prompt = this.construirPrompt(regiao, cells);

        const promessas = this.ias.map(ia => this.consultarIA(ia, prompt));
        const resultados = await Promise.race([
            Promise.allSettled(promessas),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout global no Hermes')), TIMEOUT + 5000)
            )
        ]);

        if (Array.isArray(resultados)) {
            for (const res of resultados) {
                if (res.status === 'fulfilled' && res.value && res.value.length > 0) {
                    this.cacheRegional.set(cacheKey, {
                        timestamp: Date.now(),
                        data: res.value
                    });
                    console.log(`[HERMES] Dados obtidos com sucesso (${res.value.length} ERBs).`);
                    return res.value;
                }
            }
        }

        console.log('[HERMES] Nenhuma IA retornou ERBs válidas.');
        return [];
    }

    iniciarSessaoEmergenciaNacional(tipo, params) {
        const id = `sessao_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        this.sessoes.set(id, { tipo, params, timestamp: Date.now() });
        return id;
    }

    destruirSessao(id) {
        this.sessoes.delete(id);
    }
}

module.exports = ProtocoloHermes;
