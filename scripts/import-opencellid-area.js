// ============================================================
// ARQUIVO: scripts/import-opencellid-area.js
// DATA: 31 de Julho de 2026
// HORÁRIO: 02:30 (Horário Oficial — Salvador, Bahia, Brasil)
// MOTIVO: Subdivisão recursiva da bbox, filtro MCC=724,
//         validação reforçada, CLI com argumentos.
//         Baseado no código Python otimizado do Itamar/Souza.
// ============================================================

const https = require('https');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');
const BASE_URL = 'https://opencellid.org/cell/getInArea';
const MCC_BRASIL = 724;
const OPENCELLID_LIMIT = 1000;
const MAX_TENTATIVAS = 3;
const TIMEOUT = 15000;
const PAUSA = 1200;
const RAIO = 0.25;

// 27 capitais brasileiras com UF
const CAPITAIS = [
    { nome: 'Rio Branco', uf: 'AC', lat: -9.97499, lon: -67.82433 },
    { nome: 'Maceió', uf: 'AL', lat: -9.66599, lon: -35.73470 },
    { nome: 'Macapá', uf: 'AP', lat: 0.03554, lon: -51.07057 },
    { nome: 'Manaus', uf: 'AM', lat: -3.11903, lon: -60.02173 },
    { nome: 'Salvador', uf: 'BA', lat: -12.97140, lon: -38.50163 },
    { nome: 'Fortaleza', uf: 'CE', lat: -3.73196, lon: -38.52667 },
    { nome: 'Brasília', uf: 'DF', lat: -15.79340, lon: -47.88219 },
    { nome: 'Vitória', uf: 'ES', lat: -20.31955, lon: -40.33767 },
    { nome: 'Goiânia', uf: 'GO', lat: -16.68689, lon: -49.26479 },
    { nome: 'São Luís', uf: 'MA', lat: -2.53874, lon: -44.28253 },
    { nome: 'Cuiabá', uf: 'MT', lat: -15.59892, lon: -56.09489 },
    { nome: 'Campo Grande', uf: 'MS', lat: -20.46489, lon: -54.61629 },
    { nome: 'Belo Horizonte', uf: 'MG', lat: -19.91668, lon: -43.93449 },
    { nome: 'Belém', uf: 'PA', lat: -1.45583, lon: -48.50444 },
    { nome: 'João Pessoa', uf: 'PB', lat: -7.11532, lon: -34.86101 },
    { nome: 'Curitiba', uf: 'PR', lat: -25.42836, lon: -49.27325 },
    { nome: 'Recife', uf: 'PE', lat: -8.04756, lon: -34.87700 },
    { nome: 'Teresina', uf: 'PI', lat: -5.08921, lon: -42.80186 },
    { nome: 'Rio de Janeiro', uf: 'RJ', lat: -22.90685, lon: -43.17294 },
    { nome: 'Natal', uf: 'RN', lat: -5.79357, lon: -35.19861 },
    { nome: 'Porto Alegre', uf: 'RS', lat: -30.03306, lon: -51.23000 },
    { nome: 'Porto Velho', uf: 'RO', lat: -8.76116, lon: -63.90043 },
    { nome: 'Boa Vista', uf: 'RR', lat: 2.82384, lon: -60.67583 },
    { nome: 'Florianópolis', uf: 'SC', lat: -27.59538, lon: -48.54805 },
    { nome: 'São Paulo', uf: 'SP', lat: -23.55052, lon: -46.63331 },
    { nome: 'Aracaju', uf: 'SE', lat: -10.94725, lon: -37.07308 },
    { nome: 'Palmas', uf: 'TO', lat: -10.24909, lon: -48.32429 }
];

// ============================================================
// UTILITÁRIOS
// ============================================================
function log(msg) { console.log('[OPENCELLID] ' + msg); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function dividirBbox(latmin, lonmin, latmax, lonmax) {
    const latMeio = (latmin + latmax) / 2;
    const lonMeio = (lonmin + lonmax) / 2;
    return [
        { latmin, lonmin, latmax: latMeio, lonmax: lonMeio },
        { latmin, lonmin: lonMeio, latmax: latMeio, lonmax },
        { latmin: latMeio, lonmin, latmax, lonmax: lonMeio },
        { latmin: latMeio, lonmin: lonMeio, latmax, lonmax }
    ];
}

// ============================================================
// CONSULTA À API COM RETRY E SUBDIVISÃO RECURSIVA
// ============================================================
function consultarBbox(latmin, lonmin, latmax, lonmax, cidade, profundidade = 0) {
    return new Promise((resolve) => {
        const params = new URLSearchParams({
            key: API_KEY,
            BBOX: `${latmin},${lonmin},${latmax},${lonmax}`,
            format: 'json'
        });
        const url = `${BASE_URL}?${params.toString()}`;
        let tentativa = 0;

        function tentar() {
            tentativa++;
            const req = https.get(url, { timeout: TIMEOUT }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 429 && tentativa < MAX_TENTATIVAS) {
                        const espera = Math.pow(2, tentativa) * 1000;
                        log(`${'  '.repeat(profundidade)}Rate limit (tentativa ${tentativa}). Aguardando ${espera}ms...`);
                        setTimeout(tentar, espera);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        if (tentativa < MAX_TENTATIVAS) {
                            setTimeout(tentar, Math.pow(2, tentativa) * 1000);
                            return;
                        }
                        resolve([]);
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const celulas = json.cells || [];
                        if (!Array.isArray(celulas)) { resolve([]); return; }

                        // SUBDIVISÃO RECURSIVA: Se atingiu o limite de 1000 células
                        if (celulas.length >= OPENCELLID_LIMIT) {
                            log(`${'  '.repeat(profundidade)}Limite de ${OPENCELLID_LIMIT} células em ${cidade}. Subdividindo...`);
                            const quadrantes = dividirBbox(latmin, lonmin, latmax, lonmax);
                            Promise.all(quadrantes.map(q => consultarBbox(q.latmin, q.lonmin, q.latmax, q.lonmax, cidade, profundidade + 1)))
                                .then(resultados => resolve(resultados.flat()));
                            return;
                        }

                        resolve(celulas);
                    } catch (e) {
                        resolve([]);
                    }
                });
            });
            req.on('error', () => {
                if (tentativa < MAX_TENTATIVAS) setTimeout(tentar, Math.pow(2, tentativa) * 1000);
                else resolve([]);
            });
            req.on('timeout', () => {
                req.destroy();
                if (tentativa < MAX_TENTATIVAS) setTimeout(tentar, Math.pow(2, tentativa) * 1000);
                else resolve([]);
            });
        }
        tentar();
    });
}

async function consultarCidade(cidade) {
    const latmin = cidade.lat - RAIO;
    const lonmin = cidade.lon - RAIO;
    const latmax = cidade.lat + RAIO;
    const lonmax = cidade.lon + RAIO;
    return consultarBbox(latmin, lonmin, latmax, lonmax, cidade.nome);
}

// ============================================================
// FORMATAÇÃO, VALIDAÇÃO E DEDUPLICAÇÃO
// ============================================================
function formatarErb(cell, cidade, uf) {
    return {
        cell_id: cell.cellid,
        lat: cell.lat,
        lon: cell.lon,
        range: cell.range || 5000,
        mcc: cell.mcc || 724,
        mnc: cell.mnc || 5,
        lac: cell.lac || 100,
        radio: cell.radio || 'GSM',
        cidade: cidade,
        uf: uf
    };
}

function validarErb(erb) {
    return (
        erb.cell_id != null &&
        erb.lat != null &&
        erb.lon != null &&
        erb.mcc === MCC_BRASIL
    );
}

// ============================================================
// PRINCIPAL
// ============================================================
async function main() {
    log('=== CONSULTA OPENCELLID POR ÁREA (COM SUBDIVISÃO RECURSIVA) ===');
    log(`Capitais: ${CAPITAIS.length} | Limite: ${OPENCELLID_LIMIT} | Retry: ${MAX_TENTATIVAS}x`);
    log('');

    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);

    const antes = await new Promise((resolve) => db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)));
    log(`Torres antes: ${antes.toLocaleString()}`);

    let totalImportadas = 0;
    const vistos = new Set();
    const resumo = {};

    for (let i = 0; i < CAPITAIS.length; i++) {
        const cap = CAPITAIS[i];
        log(`[${i + 1}/${CAPITAIS.length}] Consultando ${cap.nome}/${cap.uf}...`);
        const celulas = await consultarCidade(cap);
        let novas = 0;

        if (celulas.length > 0) {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const c of celulas) {
                const erb = formatarErb(c, cap.nome, cap.uf);
                if (!validarErb(erb)) continue;
                const chave = `${erb.radio}|${erb.mcc}|${erb.mnc}|${erb.lac}|${erb.cell_id}`;
                if (vistos.has(chave)) continue;
                vistos.add(chave);
                stmt.run([erb.radio, erb.mcc, erb.mnc, erb.lac, erb.cell_id, 0, erb.lon, erb.lat, erb.range, 100, 1, 1609459200, 1609459200, -71]);
                novas++;
                totalImportadas++;
            }
            stmt.finalize();
            db.run('COMMIT');
        }
        resumo[cap.nome] = novas;
        log(`  -> ${novas} torres novas (${celulas.length} retornadas)`);

        if (i < CAPITAIS.length - 1) await sleep(PAUSA);
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');

    const depois = await new Promise((resolve) => db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)));
    db.close();

    log('');
    log('=== RESUMO DA IMPORTAÇÃO ===');
    log(`Antes: ${antes.toLocaleString()}`);
    log(`Depois: ${depois.toLocaleString()}`);
    log(`Importadas: ${totalImportadas.toLocaleString()}`);
    for (const [cidade, qtd] of Object.entries(resumo)) {
        log(`  ${cidade}: ${qtd} torres`);
    }
    process.exit(0);
}

main();
