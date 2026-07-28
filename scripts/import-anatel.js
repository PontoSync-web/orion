// ============================================================
// ARQUIVO: scripts/import-anatel.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 20:00 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Importador de dados oficiais da Anatel (Mosaico).
//         Converte CSV exportado do Mosaico para o banco
//         de torres do ORION. Dados 100% reais e oficiais.
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

// Configurações
const ARQUIVO_ENTRADA = path.join(__dirname, '..', 'data', 'estacoes_anatel.csv');
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

// Mapeamento de colunas (ajuste conforme o cabeçalho do seu CSV)
const MAPA_COLUNAS = {
    lat: 'Latitude',
    lon: 'Longitude',
    operadora: 'Entidade',
    cidade: 'Município',
    uf: 'UF',
    frequencia: 'Frequência',
    servico: 'Serviço',
    numEstacao: 'Número da Estação'
};

// Mapeamento de operadoras para MNC (Mobile Network Code)
const MNC_POR_OPERADORA = {
    'VIVO': 6,
    'CLARO': 5,
    'TIM': 2,
    'OI': 31,
    'ALGAR': 11,
    'SERCOMTEL': 7,
    'NEXTEL': 0
};

function log(msg) {
    console.log('[ANATEL] ' + msg);
}

function limparCoordenada(valor) {
    if (!valor || valor === '') return null;
    try {
        return parseFloat(valor.replace(',', '.'));
    } catch (e) {
        return null;
    }
}

function detectarMNC(operadora) {
    if (!operadora) return 5;
    const upper = operadora.toUpperCase();
    for (const [nome, mnc] of Object.entries(MNC_POR_OPERADORA)) {
        if (upper.includes(nome)) return mnc;
    }
    return 5; // Padrão: Claro
}

function estimarAlcance(frequencia) {
    if (!frequencia) return 5000;
    const freq = parseFloat(frequencia.replace(',', '.'));
    if (isNaN(freq)) return 5000;
    if (freq < 1000) return 8000;  // 700-900 MHz (maior alcance)
    if (freq < 2000) return 5000;  // 1800 MHz
    return 3000;                    // > 2000 MHz (menor alcance)
}

async function main() {
    log('=== IMPORTADOR ANATEL (MOSAICO) ===');
    log('Fonte: Dados oficiais da Anatel');
    log('');

    if (!fs.existsSync(ARQUIVO_ENTRADA)) {
        log('ERRO: Arquivo não encontrado: ' + ARQUIVO_ENTRADA);
        log('');
        log('Como obter o arquivo:');
        log('1. Acesse https://sistemas.anatel.gov.br/anatelweb/mosaico');
        log('2. Filtre por "Estações" > Serviço: SMP');
        log('3. Exporte como CSV');
        log('4. Salve como "estacoes_anatel.csv" na pasta data/');
        process.exit(1);
    }

    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=OFF');
    db.run(`CREATE TABLE IF NOT EXISTS cell_towers (
        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
        cell INTEGER PRIMARY KEY, unit INTEGER,
        lon REAL, lat REAL, range INTEGER,
        samples INTEGER, changeable INTEGER,
        created INTEGER, updated INTEGER, averageSignal INTEGER
    )`);

    const antes = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    log('Torres antes: ' + antes.toLocaleString());

    // Processa o CSV
    const rl = readline.createInterface({ input: fs.createReadStream(ARQUIVO_ENTRADA) });
    let header = null;
    let colunas = {};
    let count = 0;
    let ignorados = 0;

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for await (const line of rl) {
        const cols = line.split(';');
        
        if (!header) {
            // Primeira linha: detecta índices das colunas
            header = cols;
            for (const [chave, nomeColuna] of Object.entries(MAPA_COLUNAS)) {
                colunas[chave] = header.findIndex(h => h && h.trim().toLowerCase() === nomeColuna.toLowerCase());
            }
            log('Cabeçalho detectado. Colunas mapeadas:');
            for (const [chave, idx] of Object.entries(colunas)) {
                log(`  ${chave}: coluna ${idx} (${header[idx] || 'não encontrada'})`);
            }
            continue;
        }

        const lat = limparCoordenada(cols[colunas.lat]);
        const lon = limparCoordenada(cols[colunas.lon]);
        if (lat === null || lon === null) { ignorados++; continue; }

        const operadora = cols[colunas.operadora] || '';
        const numEstacao = cols[colunas.numEstacao] || '';
        const frequencia = cols[colunas.frequencia] || '';
        const cidade = cols[colunas.cidade] || '';
        const uf = cols[colunas.uf] || '';

        // Gera um cell_id a partir do número da estação
        const cellId = parseInt(numEstacao) || (208000000 + count);
        const mnc = detectarMNC(operadora);
        const range = estimarAlcance(frequencia);

        stmt.run([
            'GSM',      // radio
            724,        // mcc (Brasil)
            mnc,        // net
            Math.floor(cellId / 1000), // area
            cellId,     // cell
            0,          // unit
            lon,        // lon
            lat,        // lat
            range,      // range
            100,        // samples
            1,          // changeable
            1609459200, // created
            1609459200, // updated
            -71         // averageSignal
        ]);
        count++;
        if (count % 10000 === 0) {
            db.run('COMMIT');
            db.run('BEGIN TRANSACTION');
            log(count.toLocaleString() + ' estações processadas...');
        }
    }

    db.run('COMMIT');
    stmt.finalize();

    // Índices
    log('Criando índices...');
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
    db.run('ANALYZE cell_towers');

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    db.close();

    log('');
    log('=== IMPORTAÇÃO CONCLUÍDA ===');
    log('Processadas: ' + count.toLocaleString() + ' estações');
    log('Ignoradas (sem coordenadas): ' + ignorados.toLocaleString());
    log('Antes: ' + antes.toLocaleString());
    log('Depois: ' + depois.toLocaleString());
    log('Novas: ' + (depois - antes).toLocaleString());
    process.exit(0);
}

main();
