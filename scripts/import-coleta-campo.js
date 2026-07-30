// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// DATA: 30 de Julho de 2026
// HORÁRIO: 22:30 (Salvador, Bahia, Brasil)
// MOTIVO: Correção definitiva dos índices das colunas (Lat=9, Lon=10)
//         e conversão do formato numérico brasileiro.
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');

function log(msg) { console.log('[COLETA-CAMPO] ' + msg); }

function parseNumeroBr(valor) {
    if (!valor || valor === '*') return NaN;
    // Remove separadores de milhar (.) e troca vírgula decimal por ponto
    let limpo = valor.trim();
    // Se tem vírgula e ponto, assume que ponto é milhar e vírgula é decimal
    if (limpo.includes(',') && limpo.includes('.')) {
        limpo = limpo.replace(/\./g, '').replace(',', '.');
    } else if (limpo.includes(',')) {
        limpo = limpo.replace(',', '.');
    }
    return parseFloat(limpo);
}

async function importarArquivo(arquivoPath, db, stmt) {
    return new Promise((resolve) => {
        let count = 0;
        let ignoradas = 0;
        let header = true;

        const rl = readline.createInterface({ input: fs.createReadStream(arquivoPath) });

        rl.on('line', (line) => {
            if (header) { header = false; return; }
            
            const cols = line.split('\t');
            if (cols.length < 15) { ignoradas++; return; }

            try {
                // CORREÇÃO: Latitude é coluna 9, Longitude é coluna 10
                const lat = parseNumeroBr(cols[9]);
                const lon = parseNumeroBr(cols[10]);

                if (isNaN(lat) || isNaN(lon)) { ignoradas++; return; }

                const numEstacao = parseInt(cols[2]) || 0; // Número da Estação é coluna 2
                const cellId = numEstacao > 0 ? numEstacao : (208000000 + count);
                
                const emissao = cols[14]?.trim() || '';
                let radio = 'LTE';
                let range = 5000;
                if (emissao.includes('200KG7W')) { radio = 'GSM'; range = 8000; }
                else if (emissao.includes('5M00')) { radio = 'UMTS'; range = 5000; }
                else if (emissao.includes('20M0')) { radio = 'LTE'; range = 3000; }

                const prestadora = cols[0]?.trim()?.toUpperCase() || '';
                let mnc = 5;
                if (prestadora.includes('VIVO') || prestadora.includes('TELEFONICA')) mnc = 6;
                else if (prestadora.includes('TIM')) mnc = 2;
                else if (prestadora.includes('CLARO')) mnc = 5;
                else if (prestadora.includes('OI')) mnc = 31;

                const area = Math.floor(cellId / 1000);

                stmt.run([radio, 724, mnc, area, cellId, 0, lon, lat, range, 100, 1, 1609459200, 1609459200, -71]);
                count++;
            } catch (e) { ignoradas++; }
        });

        rl.on('close', () => resolve({ count, ignoradas }));
    });
}

async function main() {
    log('=== IMPORTADOR DE DADOS DE CAMPO (FORMATO ANATEL - CORRIGIDO) ===');
    const arquivos = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('coleta_campo') && f.endsWith('.csv'));
    if (arquivos.length === 0) { log('Nenhum arquivo encontrado.'); process.exit(0); }
    log(`Encontrados ${arquivos.length} arquivos.`);

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

    let totalImportadas = 0, totalIgnoradas = 0;
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for (const arquivo of arquivos) {
        const arquivoPath = path.join(DATA_DIR, arquivo);
        log(`Processando: ${arquivo}...`);
        const { count, ignoradas } = await importarArquivo(arquivoPath, db, stmt);
        totalImportadas += count;
        totalIgnoradas += ignoradas;
        log(`  -> ${count.toLocaleString()} importadas, ${ignoradas.toLocaleString()} ignoradas.`);
    }

    db.run('COMMIT'); stmt.finalize();
    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');

    const depois = await new Promise((resolve) => db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0)));
    db.close();

    log('=== IMPORTAÇÃO CONCLUÍDA ===');
    log(`Antes: ${antes.toLocaleString()}`);
    log(`Depois: ${depois.toLocaleString()}`);
    log(`Total importadas: ${totalImportadas.toLocaleString()}`);
    process.exit(0);
}

main();
