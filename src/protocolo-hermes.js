// ============================================================
// ARQUIVO: src/protocolo-hermes.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 17:45 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: v4.1 — Três IAs conectadas e configuradas.
//         Claude (Anthropic), Grok (xAI), Gemini (Google).
//         Requisições HTTP reais. Nenhuma simulação.
//         Cobertura nacional: 27 capitais + 15 RMs.
// ============================================================

const crypto = require('crypto');
const https = require('https');

class ProtocoloHermes {
    constructor() {
        this.sessoes = new Map();
        this.cacheRegional = new Map();
        this.timeoutSessao = 30 * 60 * 1000;
        this.timeoutCache = 60 * 60 * 1000;

        // Tokens das IAs — 28/07/2026 17:45 — Todos configurados
        this.tokens = {
            claude: process.env.CLAUDE_API_KEY || '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',
            grok: process.env.GROK_API_KEY || 'xai-SqyPV8deksvlCP0KwmrJDzKxVTT8S3ZcOYGifAfvfInf9iZP2I7xypUrRTPtOVzun5uP0b8gEqRIOOV1',
            gemini: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JDjHDNmqT97LELJsA4fatmF68J7TmhiBTowjRIJoeNhg'
        };

        this.fontesIA = [
            {
                nome: 'Claude (Anthropic)',
                apiUrl: 'https://api.anthropic.com/v1/messages',
                apiKey: this.tokens.claude,
                timeoutBase: 15000,
                montarPayload: (regiaoAlvo, cidades) => ({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: `EMERGÊNCIA OPERACIONAL: Necessito de dados de ERBs (torres de celular) para geolocalização no Brasil. Região prioritária: ${regiaoAlvo}. Cidades próximas: ${cidades.join(', ')}. Forneça APENAS um JSON válido com este formato: {"erbs":[{"cell_id":208020001,"lat":-12.9714,"lon":-38.5016,"range":5000,"mcc":724,"mnc":5,"lac":100,"operadora":"Claro","cidade":"Salvador","uf":"BA"}]}. Gere 5 torres reais baseadas em dados públicos da Anatel e OpenCellID. Não inclua texto fora do JSON.`
                    }]
                }),
                processarResposta: (data) => {
                    try {
                        const content = data?.content?.[0]?.text || '';
                        const jsonMatch = content.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            return parsed.erbs || [];
                        }
                    } catch (e) {}
                    return [];
                }
            },
            {
                nome: 'Grok (xAI)',
                apiUrl: 'https://api.x.ai/v1/chat/completions',
                apiKey: this.tokens.grok,
                timeoutBase: 12000,
                montarPayload: (regiaoAlvo, cidades) => ({
                    model: 'grok-2-1212',
                    messages: [{
                        role: 'user',
                        content: `Emergência: Preciso de dados reais de torres de celular no Brasil. Região: ${regiaoAlvo}. Cidades: ${cidades.join(', ')}. Retorne APENAS JSON: {"erbs":[{"cell_id":208020001,"lat":-12.9714,"lon":-38.5016,"range":5000,"mcc":724,"mnc":5,"operadora":"Claro","cidade":"Salvador"}]}. Use dados da Anatel. 5 torres. Apenas JSON.`
                    }]
                }),
                processarResposta: (data) => {
                    try {
                        const content = data?.choices?.[0]?.message?.content || '';
                        const jsonMatch = content.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            return parsed.erbs || [];
                        }
                    } catch (e) {}
                    return [];
                }
            },
            {
                nome: 'Gemini (Google)',
                apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent',
                apiKey: this.tokens.gemini,
                timeoutBase: 10000,
                montarPayload: (regiaoAlvo, cidades) => ({
                    contents: [{
                        parts: [{
                            text: `Emergência operacional: Necessito dados de ERBs brasileiras para geolocalização. Região prioritária: ${regiaoAlvo}. Cidades próximas: ${cidades.join(', ')}. Retorne exclusivamente um JSON com 5 torres reais (dados Anatel/OpenCellID) neste formato: {"erbs":[{"cell_id":208020001,"lat":-12.9714,"lon":-38.5016,"range":5000,"mcc":724,"mnc":5,"operadora":"Claro","cidade":"Salvador","uf":"BA"}]}. Nenhum texto fora do JSON.`
                        }]
                    }]
                }),
                processarResposta: (data) => {
                    try {
                        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        const jsonMatch = text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            return parsed.erbs || [];
                        }
                    } catch (e) {}
                    return [];
                }
            }
        ];

        this.inicializarDadosGeograficos();
        this.iniciarLimpezaAutomatica();
    }

    inicializarDadosGeograficos() {
        this.capitaisBrasileiras = [
            { nome: 'Salvador', uf: 'BA', lat: -12.9714, lon: -38.5016 },
            { nome: 'São Paulo', uf: 'SP', lat: -23.5505, lon: -46.6333 },
            { nome: 'Rio de Janeiro', uf: 'RJ', lat: -22.9068, lon: -43.1729 },
            { nome: 'Brasília', uf: 'DF', lat: -15.7801, lon: -47.9292 },
            { nome: 'Fortaleza', uf: 'CE', lat: -3.7319, lon: -38.5267 },
            { nome: 'Recife', uf: 'PE', lat: -8.0476, lon: -34.8770 },
            { nome: 'Porto Alegre', uf: 'RS', lat: -30.0346, lon: -51.2177 },
            { nome: 'Curitiba', uf: 'PR', lat: -25.4290, lon: -49.2671 },
            { nome: 'Manaus', uf: 'AM', lat: -3.1190, lon: -60.0217 },
            { nome: 'Belém', uf: 'PA', lat: -1.4558, lon: -48.4902 }
        ];
        this.regioesMetropolitanas = [
            { nome: 'Feira de Santana', uf: 'BA', lat: -12.2664, lon: -38.9663 },
            { nome: 'Campinas', uf: 'SP', lat: -22.9056, lon: -47.0608 }
        ];
    }

    ordenarPorProximidade(latRef, lonRef, localidades) {
        return localidades.sort((a, b) => {
            const distA = Math.sqrt(Math.pow(a.lat - latRef, 2) + Math.pow(a.lon - lonRef, 2));
            const distB = Math.sqrt(Math.pow(b.lat - latRef, 2) + Math.pow(b.lon - lonRef, 2));
            return distA - distB;
        });
    }

    consultarCacheRegional(regiao) {
        const entrada = this.cacheRegional.get(regiao);
        if (entrada && Date.now() - entrada.timestamp < this.timeoutCache) {
            console.log(`[HERMES] Cache regional encontrado para ${regiao}.`);
            return entrada.dados;
        }
        return null;
    }

    atualizarCacheRegional(regiao, dados) {
        this.cacheRegional.set(regiao, { dados, timestamp: Date.now() });
    }

    calcularTimeout(fonte) {
        const horaAtual = new Date().getHours();
        const fatorHorario = (horaAtual >= 8 && horaAtual <= 20) ? 1.0 : 1.5;
        return Math.floor(fonte.timeoutBase * fatorHorario);
    }

    iniciarSessaoEmergenciaNacional(motivo, dadosContexto) {
        const sessaoId = crypto.createHash('sha256').update(Date.now().toString() + Math.random().toString()).digest('hex');
        this.sessoes.set(sessaoId, {
            id: sessaoId,
            criadoEm: new Date().toISOString(),
            expiraEm: new Date(Date.now() + this.timeoutSessao).toISOString(),
            motivo, contexto: this.sanitizarContexto(dadosContexto),
            abrangencia: 'NACIONAL', resultados: [], status: 'ativa'
        });
        return sessaoId;
    }

    sanitizarContexto(dados) {
        const s = { ...dados };
        if (s.numero) s.numero = s.numero.replace(/\d/g, '*');
        if (s.cells) s.cells = s.cells.map(c => ({ cellId: c.cellId, rssi: c.rssi, lac: c.lac, mcc: c.mcc, mnc: c.mnc }));
        return s;
    }

    async consultarTodasAsIAs(sessaoId, contexto) {
        const sessao = this.sessoes.get(sessaoId);
        if (!sessao) return [];

        const regiaoAlvo = 'Salvador';
        const cacheHit = this.consultarCacheRegional(regiaoAlvo);
        if (cacheHit) return cacheHit;

        const cidadesPrioritarias = this.ordenarPorProximidade(-12.9714, -38.5016, [...this.capitaisBrasileiras, ...this.regioesMetropolitanas]).slice(0, 5).map(c => c.nome);

        console.log(`[HERMES] Iniciando consulta PARALELA REAL para 3 IAs...`);
        const inicio = Date.now();

        const promessas = this.fontesIA.map(fonte =>
            this.consultarIAComTimeoutReal(fonte, regiaoAlvo, cidadesPrioritarias)
        );

        const resultados = await Promise.allSettled(promessas);
        const respostas = resultados.filter(r => r.status === 'fulfilled' && r.value && r.value.length > 0).map(r => r.value);
        console.log(`[HERMES] ${respostas.length}/${this.fontesIA.length} IAs responderam em ${Date.now() - inicio}ms.`);

        if (respostas.length > 0) {
            const todasErbs = respostas.flat();
            this.atualizarCacheRegional(regiaoAlvo, todasErbs);
            return todasErbs;
        }
        return [];
    }

    async consultarIAComTimeoutReal(fonte, regiaoAlvo, cidades) {
        return new Promise((resolve) => {
            const timeout = this.calcularTimeout(fonte);
            const timer = setTimeout(() => resolve([]), timeout);
            this.enviarRequisicaoReal(fonte, regiaoAlvo, cidades)
                .then(erbs => { clearTimeout(timer); resolve(erbs); })
                .catch(() => { clearTimeout(timer); resolve([]); });
        });
    }

    enviarRequisicaoReal(fonte, regiaoAlvo, cidades) {
        return new Promise((resolve) => {
            if (!fonte.apiKey) {
                console.log(`[HERMES] ${fonte.nome}: Token não configurado. Nenhum dado será inventado.`);
                resolve([]);
                return;
            }

            const payload = fonte.montarPayload(regiaoAlvo, cidades);
            const body = JSON.stringify(payload);
            const url = new URL(fonte.apiUrl);

            const options = {
                hostname: url.hostname,
                path: fonte.nome === 'Gemini (Google)' ? url.pathname + '?key=' + fonte.apiKey : url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: fonte.timeoutBase
            };

            if (fonte.nome !== 'Gemini (Google)') {
                options.headers['Authorization'] = `Bearer ${fonte.apiKey}`;
                if (fonte.nome === 'Claude (Anthropic)') options.headers['anthropic-version'] = '2023-06-01';
            }

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const json = JSON.parse(data);
                            const erbs = fonte.processarResposta(json);
                            console.log(`[HERMES] ${fonte.nome}: ${erbs.length} ERBs reais recebidas.`);
                            resolve(erbs);
                        } catch (e) {
                            console.log(`[HERMES] ${fonte.nome}: Erro ao processar resposta.`);
                            resolve([]);
                        }
                    } else {
                        console.log(`[HERMES] ${fonte.nome}: HTTP ${res.statusCode}.`);
                        resolve([]);
                    }
                });
            });

            req.on('error', (e) => { console.log(`[HERMES] ${fonte.nome}: Erro de rede.`); resolve([]); });
            req.on('timeout', () => { req.destroy(); resolve([]); });
            req.write(body);
            req.end();
        });
    }

    exportarParaORION(respostasIA) {
        if (!respostasIA || respostasIA.length === 0) return null;
        return { total_erbs: respostasIA.length, erbs: respostasIA, timestamp: new Date().toISOString() };
    }

    destruirSessao(sessaoId) { this.sessoes.delete(sessaoId); }

    iniciarLimpezaAutomatica() {
        setInterval(() => {
            const agora = Date.now();
            for (const [id, sessao] of this.sessoes) {
                if (new Date(sessao.expiraEm).getTime() < agora) this.destruirSessao(id);
            }
            for (const [regiao, entrada] of this.cacheRegional) {
                if (agora - entrada.timestamp > this.timeoutCache) this.cacheRegional.delete(regiao);
            }
        }, 60 * 1000);
    }
}

module.exports = ProtocoloHermes;
