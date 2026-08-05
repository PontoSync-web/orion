// ============================================================
// ARQUIVO: scripts/buscar-cell-id.js
// VERSÃO: 1.1 – Com verificação de integridade do banco
// DATA: 05/08/2026
// HORÁRIO: 14:30 (Horário Oficial — Salvador, Bahia, Brasil)
// AUTOR: Eng Souza
// MOTIVO: Adiciona verificação e recuperação de banco corrompido
//         antes de consultar ou inserir dados.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_TOWERS = path.join(DATA_DIR, 'cell_towers.db');

const UNWIRED_TOKEN = process.env.UNWIRED_TOKEN || 'pk.b6eadaf01c1bce6c3c8eb52bc8b30211';
const OPENCELLID_KEY = process.env.OPENCELLID_API_KEY || 'pk.d597db3bcf9eea4d67acaeb057573fd4';

// ============================================================
// FUNÇÕES DE CONSULTA (mantidas da versão anterior)
// ============================================================
function consultarUnwiredLabs(cellId, mcc = 724, mnc = 5, lac = 1234) {
    return new Promise((resolve) => {
        if (!UNWIRED_TOKEN) { resolve(null); return; }
        const data = JSON.stringify({
            token: UNWIRED_TOKEN,
            radio: 'lte',
            mcc: mcc,
            mnc: mnc,
            cells: [{ lac: lac, cid: cellId, signal: -71 }],
            address: 1
        });
        const req = https.request({
            hostname: 'us1.unwiredlabs.com',
            path: '/v2/process.php',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const r = JSON.parse(body);
                    if (r.status === 'ok' && r.lat && r.lon) {
                        resolve({ lat: r.lat, lon: r.lon, range: r.accuracy || 500, fonte: 'unwiredlabs' });
                    } else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', (err) => { console.error(`[UNWIREDLABS] Erro: ${err.message}`); resolve(null); });
        req.write(data);
        req.end();
    });
}

function consultarOpenCellID(cellId) {
    return new Promise((resolve) => {
        if (!OPENCELLID_KEY) { resolve(null); return; }
        const req = https.get(`https://opencellid.org/cell/get?key=${OPENCELLID_KEY}&cell=${cellId}&format=json`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const d = JSON.parse(body);
                    if (d.lat && d.lon) {
                        resolve({ lat: d.lat, lon: d.lon, range: d.range || 500, fonte: 'opencellid' });
                    } else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', (err) => { console.error(`[OPENCELLID] Erro: ${err.message}`); resolve(null); });
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
}

function consultarCellMapper(cellId, mcc = 724, mnc = 5) {
    return new Promise((resolve) => {
        const lat = -12.9714;
        const lng = -38.5016;
        const url = `https://www.cellmapper.net/map/getTowers?MCC=${mcc}&MNC=${mnc}&lat=${lat}&lng=${lng}&zoom=14&format=json`;
        const req = https.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    let towers = [];
                    if (Array.isArray(data)) towers = data;
                    else if (data.towers) towers = data.towers;
                    else if (data.features) towers = data.features;
                    else {
                        for (const key in data) {
                            if (Array.isArray(data[key])) {
                                towers = data[key];
                                break;
                            }
                        }
                    }
                    for (const t of towers) {
                        let cid = t.cellId || t.cell || t.CI || t.id;
                        let lat = t.lat || t.latitude || t.LAT;
                        let lon = t.lng || t.lon || t.longitude || t.LNG;
                        if (cid && parseInt(cid) === cellId && lat && lon) {
                            resolve({ lat: parseFloat(lat), lon: parseFloat(lon), range: t.range || 1500, fonte: 'cellmapper' });
                            return;
                        }
                    }
                    resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', (err) => { console.error(`[CELLMAPPER] Erro: ${err.message}`); resolve(null); });
        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
}

// ============================================================
// VERIFICAÇÃO DE INTEGRIDADE DO BANCO
// ============================================================
function verificarERecuperarBanco() {
    try {
        if (!fs.existsSync(DB_TOWERS)) return true;
        const db = new sqlite3.Database(DB_TOWERS);
        return new Promise((resolve) => {
            db.get('SELECT COUNT(*) as c FROM cell_towers', (err, row) => {
                db.close();
                if (err) {
                    console.error('[BUSCAR] Banco corrompido. Recriando...');
                    fs.unlinkSync(DB_TOWERS);
                    const newDb = new sqlite3.Database(DB_TOWERS);
                    newDb.run('PRAGMA journal_mode=WAL');
                    newDb.run('PRAGMA secure_delete=ON');
                    newDb.run(`CREATE TABLE IF NOT EXISTS cell_towers (
                        radio TEXT, mcc INTEGER, net INTEGER, area INTEGER,
                        cell INTEGER PRIMARY KEY, unit INTEGER, lon REAL, lat REAL,
                        range INTEGER, samples INTEGER, changeable INTEGER,
                        created INTEGER, updated INTEGER, averageSignal INTEGER
                    )`, () => {
                        newDb.close();
                        console.log('[BUSCAR] Banco recriado com sucesso.');
                        resolve(true);
                    });
                } else {
                    resolve(true);
                }
            });
        });
    } catch (e) {
        console.error('[BUSCAR] Erro ao verificar banco:', e.message);
        return false;
    }
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================
async function buscarCellId(cellId, mcc = 724, mnc = 5, lac = 1234) {
    console.log(`[BUSCAR] Buscando Cell ID ${cellId} (MCC=${mcc}, MNC=${mnc}, LAC=${lac})...`);

    let resultado = await consultarUnwiredLabs(cellId, mcc, mnc, lac);
    if (resultado) {
        console.log(`[BUSCAR] Encontrado via UnwiredLabs: ${resultado.lat}, ${resultado.lon}`);
        return resultado;
    }

    resultado = await consultarOpenCellID(cellId);
    if (resultado) {
        console.log(`[BUSCAR] Encontrado via OpenCellID: ${resultado.lat}, ${resultado.lon}`);
        return resultado;
    }

    resultado = await consultarCellMapper(cellId, mcc, mnc);
    if (resultado) {
        console.log(`[BUSCAR] Encontrado via CellMapper: ${resultado.lat}, ${resultado.lon}`);
        return resultado;
    }

    console.log(`[BUSCAR] Cell ID ${cellId} não encontrado.`);
    return null;
}

// ============================================================
// INSERIR NO BANCO
// ============================================================
function inserirNoBanco(cellId, lat, lon, range, fonte, mcc = 724, mnc = 5, lac = 1234) {
    verificarERecuperarBanco();
    const db = new sqlite3.Database(DB_TOWERS);
    db.run('PRAGMA journal_mode=WAL');
    db.run(`INSERT OR REPLACE INTO cell_towers 
        (radio, mcc, net, area, cell, unit, lon, lat, range, samples, changeable, created, updated, averageSignal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['LTE', mcc, mnc, lac, cellId, 0, lon, lat, range, 100, 1, Math.floor(Date.now()/1000), Math.floor(Date.now()/1000), -71],
        (err) => {
            if (err) console.error('[BUSCAR] Erro ao inserir:', err.message);
            else console.log(`[BUSCAR] Cell ID ${cellId} inserido com sucesso.`);
            db.close();
        }
    );
}

// ============================================================
// EXECUÇÃO VIA LINHA DE COMANDO
// ============================================================
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.log('Uso: node buscar-cell-id.js <cellId> [mcc] [mnc] [lac]');
        console.log('Exemplo: node buscar-cell-id.js 119345153 724 99 37103');
        process.exit(1);
    }
    const cellId = parseInt(args[0]);
    const mcc = parseInt(args[1]) || 724;
    const mnc = parseInt(args[2]) || 5;
    const lac = parseInt(args[3]) || 1234;

    buscarCellId(cellId, mcc, mnc, lac).then(resultado => {
        if (resultado) {
            inserirNoBanco(cellId, resultado.lat, resultado.lon, resultado.range, resultado.fonte, mcc, mnc, lac);
            console.log(`✅ Cell ID ${cellId} inserido com sucesso.`);
        } else {
            console.log(`❌ Cell ID ${cellId} não encontrado.`);
        }
    });
}

module.exports = { buscarCellId, inserirNoBanco };
