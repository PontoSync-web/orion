// ORION Optimizer v3.0
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class OrionOptimizer {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.estatisticas = { consultas: 0, torresAtivas: 0 };
  }

  async criarIndices() {
    console.log('[OTIMIZADOR] Criando índices...');
    const db = new sqlite3.Database(this.dbPath);
    db.serialize(() => {
      db.run('CREATE INDEX IF NOT EXISTS idx_cell ON cell_towers(cell)');
      db.run('CREATE INDEX IF NOT EXISTS idx_lat_lon ON cell_towers(lat, lon)');
    });
    db.close(() => console.log('[OTIMIZADOR] Índices criados'));
  }

  async filtrarTorresAtivas() {
    console.log('[OTIMIZADOR] Filtrando torres ativas...');
    const db = new sqlite3.Database(this.dbPath);
    return new Promise((resolve) => {
      db.get('SELECT COUNT(*) as c FROM cell_towers WHERE mcc=724 AND range BETWEEN 100 AND 3000', (err, row) => {
        db.close();
        console.log('[OTIMIZADOR] Torres ativas: ' + (row.c).toLocaleString());
        resolve(row.c);
      });
    });
  }

  async triangularOtimizado(cellIds) {
    const inicio = Date.now();
    this.estatisticas.consultas++;
    const db = new sqlite3.Database(this.dbPath);
    const ph = cellIds.map(() => '?').join(',');
    return new Promise((resolve) => {
      db.all('SELECT cell, lat, lon, range FROM cell_towers WHERE cell IN (' + ph + ')', cellIds, (err, rows) => {
        db.close();
        if (rows.length === 0) { resolve(null); return; }
        let lat = 0, lon = 0, peso = 0;
        rows.forEach(t => { const p = 1 / Math.max(t.range, 1); lat += t.lat * p; lon += t.lon * p; peso += p });
        resolve({ latitude: lat/peso, longitude: lon/peso, torres: rows.length, tempo_ms: Date.now() - inicio });
      });
    });
  }
}

module.exports = OrionOptimizer;
