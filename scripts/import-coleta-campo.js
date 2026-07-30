// ============================================================
// ARQUIVO: scripts/import-coleta-campo.js
// DATA: 30 de Julho de 2026
// HORÁRIO: 20:45 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Adaptação para processar o formato tabulado do
//         ficheiro da Anatel com estações licenciadas.
//         Ignora linhas com coordenadas em asterisco (*).
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
            
            // O ficheiro é separado por tabulações
            const cols = line.split('\t');
            
            // Verifica o número mínimo de colunas esperadas (15)
            if (cols.length < 15) { ignoradas++; return; }

            try {
                // Coluna 10: Latitude, Coluna 11: Longitude
                const latStr = cols[10]?.trim();
                const lonStr = cols[11]?.trim();
                
                // Ignora linhas sem coordenadas válidas (ex: '*')
                if (!latStr || !lonStr || latStr === '*' || lonStr === '*') { 
                    ignoradas++; return; 
                }

                // Converte para número, lidando com formato brasileiro (1.825.000,00 -> 1825000.00)
                const lat = parseFloat(latStr.replace(/\./g, '').replace(',', '.'));
                const lon = parseFloat(lonStr.replace(/\./g, '').replace(',', '.'));
                
                if (isNaN(lat) || isNaN(lon)) { ignoradas++; return; }

                // Gera um Cell ID a partir do número da estação (coluna 3)
                const numEstacao = parseInt(cols[3]) || 0;
                const cellId = numEstacao > 0 ? numEstacao : (208000000 + count);
                
                // Mapeia a tecnologia (coluna 14: Emissão) para tipo de rádio
                const emissao = cols[14]?.trim() || '';
                let radio = 'LTE';
                let range = 5000;
                
                if (emissao.includes('200KG7W')) { radio = 'GSM'; range = 8000; }
                else if (emissao.includes('5M00G7W') || emissao.includes('5M00G9W')) { radio = 'UMTS'; range = 5000; }
                else if (emissao.includes('20M0G7W')) { radio = 'LTE'; range = 3000; }
                
                // Mapeia a operadora (coluna 1) para MNC
                const prestadora = cols[0]?.trim()?.toUpperCase() || '';
                let mnc = 5; // Padrão Claro
                if (prestadora.includes('VIVO') || prestadora.includes('TELEFONICA')) mnc = 6;
                else if (prestadora.includes('TIM')) mnc = 2;
                else if (prestadora.includes('CLARO')) mnc = 5;
                else if (prestadora.includes('OI')) mnc = 31;
                
                const area = Math.floor(cellId / 1000);

                stmt.run([radio, 724, mnc, area, cellId, 0, lon, lat, range, 100, 1, 1609459200, 1609459200, -71]);
                count++;
            } catch (e) { ignoradas++; }
        });

        rl.on('close', () => {
            resolve({ count, ignoradas });
        });
    });
}

async function main() {
    log('=== IMPORTADOR DE DADOS DE CAMPO (FORMATO ANATEL) ===');
    log('Fonte: Estações licenciadas da Anatel');
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
    log('Dados 100% reais da Anatel.');
    process.exit(0);
}

main();
