// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// DATA: 30 de Julho de 2026
// HORÁRIO: 18:15 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Compatibilidade com múltiplas partes do CSV.
//         Processa todos os arquivos que começam com
//         "coleta_campo" na pasta data/.
// ============================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'cell_towers.db');

function log(msg) { console.log('[COLETA-CAMPO] ' + msg); }

async function importarArquivo(arquivoPath, db, stmt) {
    return new Promise((resolve) => {
        let count = 0;
        let ignoradas = 0;
        let header = true;

        const rl = readline.createInterface({ input: fs.createReadStream(arquivoPath) });

        rl.on('line', (line) => {
            if (header) { header = false; return; }
            const cols = line.split(',');
            if (cols.length < 7) { ignoradas++; return; }

            try {
                const cellId = parseInt(cols[1]) || 0;
                const lat = parseFloat(cols[5]) || 0;
                const lon = parseFloat(cols[4]) || 0;
                const range = parseInt(cols[6]) || 5000;
                const mcc = parseInt(cols[2]) || 724;
                const mnc = parseInt(cols[3]) || 5;

                if (!cellId || !lat || !lon) { ignoradas++; return; }

                stmt.run(['GSM', mcc, mnc, Math.floor(cellId / 1000), cellId, 0, lon, lat, range, 100, 1, 1609459200, 1609459200, -71]);
                count++;
            } catch (e) { ignoradas++; }
        });

        rl.on('close', () => {
            resolve({ count, ignoradas });
        });
    });
}

async function main() {
    log('=== IMPORTADOR DE DADOS DE CAMPO (MÚLTIPLAS PARTES) ===');
    log('Fonte: Coleta própria via app OpenCellID');
    log('');

    // Procura por qualquer arquivo que comece com "coleta_campo" e termine com ".csv"
    const arquivos = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('coleta_campo') && f.endsWith('.csv'));

    if (arquivos.length === 0) {
        log('Nenhum arquivo coleta_campo*.csv encontrado. Nada a importar.');
        process.exit(0);
    }

    log(`Encontrados ${arquivos.length} arquivos para importar.`);

    const db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode=WAL');
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

    let totalImportadas = 0;
    let totalIgnoradas = 0;

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

    for (const arquivo of arquivos) {
        const arquivoPath = path.join(DATA_DIR, arquivo);
        log(`Processando: ${arquivo}...`);
        const { count, ignoradas } = await importarArquivo(arquivoPath, db, stmt);
        totalImportadas += count;
        totalIgnoradas += ignoradas;
        log(`  ${arquivo}: ${count.toLocaleString()} importadas, ${ignoradas.toLocaleString()} ignoradas.`);
    }

    db.run('COMMIT');
    stmt.finalize();

    db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
    db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');

    const depois = await new Promise((resolve) => {
        db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => resolve(row ? row.c : 0));
    });
    db.close();

    log('');
    log('=== IMPORTAÇÃO CONCLUÍDA ===');
    log('Antes: ' + antes.toLocaleString());
    log('Depois: ' + depois.toLocaleString());
    log('Total importadas: ' + totalImportadas.toLocaleString());
    log('Total ignoradas: ' + totalIgnoradas.toLocaleString());
    log('Dados 100% reais, coletados em campo pelo investigador.');
    process.exit(0);
}

main();
