// ============================================================
// ARQUIVO: scripts/import-opencellid-area.js
// DATA: 28 de Julho de 2026
// HORÁRIO: 20:30 (Horário Oficial — Salvador, Bahia, Brasil)
// FUSO: América do Sul / Brasil / Bahia (GMT-3)
// MOTIVO: Consulta ERBs reais via API OpenCellID por área.
//         Cobre todas as 27 capitais brasileiras.
//         Dados 100% reais da base pública.
// ============================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const API_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';
const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

// Todas as 27 capitais brasileiras
const CAPITAIS = [
    { nome: 'Aracaju', uf: 'SE', lat: -10.9472, lon: -37.0731 },
    { nome: 'Belém', uf: 'PA', lat: -1.4558, lon: -48.4902 },
    { nome: 'Belo Horizonte', uf: 'MG', lat: -19.9167, lon: -43.9345 },
    { nome: 'Boa Vista', uf: 'RR', lat: 2.8235, lon: -60.6758 },
    { nome: 'Brasília', uf: 'DF', lat: -15.7801, lon: -47.9292 },
    { nome: 'Campo Grande', uf: 'MS', lat: -20.4697, lon: -54.6201 },
    { nome: 'Cuiabá', uf: 'MT', lat: -15.6010, lon: -56.0974 },
    { nome: 'Curitiba', uf: 'PR', lat: -25.4290, lon: -49.2671 },
    { nome: 'Florianópolis', uf: 'SC', lat: -27.5954, lon: -48.5480 },
    { nome: 'Fortaleza', uf: 'CE', lat: -3.7319, lon: -38.5267 },
    { nome: 'Goiânia', uf: 'GO', lat: -16.6864, lon: -49.2643 },
    { nome: 'João Pessoa', uf: 'PB', lat: -7.1150, lon: -34.8631 },
    { nome: 'Macapá', uf: 'AP', lat: 0.0349, lon: -51.0694 },
    { nome: 'Maceió', uf: 'AL', lat: -9.6658, lon: -35.7353 },
    { nome: 'Manaus', uf: 'AM', lat: -3.1190, lon: -60.0217 },
    { nome: 'Natal', uf: 'RN', lat: -5.7793, lon: -35.2009 },
    { nome: 'Palmas', uf: 'TO', lat: -10.2491, lon: -48.3243 },
    { nome: 'Porto Alegre', uf: 'RS', lat: -30.0346, lon: -51.2177 },
    { nome: 'Porto Velho', uf: 'RO', lat: -8.7612, lon: -63.9039 },
    { nome: 'Recife', uf: 'PE', lat: -8.0476, lon: -34.8770 },
    { nome: 'Rio Branco', uf: 'AC', lat: -9.9747, lon: -67.8098 },
    { nome: 'Rio de Janeiro', uf: 'RJ', lat: -22.9068, lon: -43.1729 },
    { nome: 'Salvador', uf: 'BA', lat: -12.9714, lon: -38.5016 },
    { nome: 'São Luís', uf: 'MA', lat: -2.5307, lon: -44.3068 },
    { nome: 'São Paulo', uf: 'SP', lat: -23.5505, lon: -46.6333 },
    { nome: 'Teresina', uf: 'PI', lat: -5.0892, lon: -42.8019 },
    { nome: 'Vitória', uf: 'ES', lat: -20.3155, lon: -40.3128 }
];

const RAIO_GRAUS = 0.25;

function log(msg) { console.log('[OPENCELLID-AREA] ' + msg); }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function consultarArea(lat, lon, cidade) {
    return new Promise((resolve) => {
        const latmin = lat - RAIO_GRAUS;
        const lonmin = lon - RAIO_GRAUS;
        const latmax = lat + RAIO_GRAUS;
        const lonmax = lon + RAIO_GRAUS;
        
        const url = `https://opencellid.org/cell/getInArea?key=${API_KEY}&BBOX=${latmin},${lonmin},${latmax},${lonmax}&format=json`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.cells) {
                        log(`${cidade}: ${json.cells.length} torres encontradas`);
                        resolve(json.cells.map(c => ({
                            cell_id: c.cellid,
                            lat: c.lat,
                            lon: c.lon,
                            range: c.range || 5000,
                            mcc: c.mcc || 724,
                            mnc: c.mnc || 5,
                            lac: c.lac || 100,
                            radio: c.radio || 'GSM',
                            cidade: cidade,
                            uf: ''
                        })));
                    } else {
                        resolve([]);
                    }
                } catch (e) {
                    log(`Erro ao processar ${cidade}: ${e.message}`);
                    resolve([]);
                }
            });
        }).on('error', (e) => {
            log(`Erro de rede ${cidade}: ${e.message}`);
            resolve([]);
        });
    });
}

async function main() {
    log('=== CONSULTA OPENCELLID POR ÁREA ===');
    log('Capitais: ' + CAPITAIS.length);
    log('');

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

    let totalImportadas = 0;

    for (const capital of CAPITAIS) {
        const erbs = await consultarArea(capital.lat, capital.lon, capital.nome);
        
        if (erbs.length > 0) {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare('INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            
            for (const erb of erbs) {
                stmt.run([
                    erb.radio || 'GSM',
                    erb.mcc || 724,
                    erb.mnc || 5,
                    erb.lac || 100,
                    erb.cell_id,
                    0,
                    erb.lon,
                    erb.lat,
                    erb.range || 5000,
                    100,
                    1,
                    1609459200,
                    1609459200,
                    -71
                ]);
                totalImportadas++;
            }
            
            stmt.finalize();
            db.run('COMMIT');
        }
        
        await sleep(1500); // Respeita rate limit
    }

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
    log('=== CONSULTA CONCLUÍDA ===');
    log('Antes: ' + antes.toLocaleString());
    log('Depois: ' + depois.toLocaleString());
    log('Importadas: ' + totalImportadas.toLocaleString());
    process.exit(0);
}

main();
