// Helper: tenta inserir com 15 placeholders e, se der erro de coluna/placeholder,
// faz fallback para inserção com 14 valores.
// Uso: const { runInsert } = require('./scripts/db-utils');
// const res = await runInsert(db, values15Array);
const sqlite3 = require('sqlite3').verbose();

function runInsert(db, values) {
  return new Promise((resolve) => {
    const sql15 = 'INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    const sql14 = 'INSERT OR REPLACE INTO cell_towers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

    db.run(sql15, values, function (err) {
      if (!err) return resolve({ ok: true, used: 15, lastID: this.lastID, changes: this.changes });
      const msg = (err && err.message) ? err.message.toLowerCase() : '';
      if (msg.includes('columns') || msg.includes('bind') || msg.includes('column count') || (msg.includes('has') && msg.includes('values'))) {
        db.run(sql14, values.slice(0, 14), function (err2) {
          if (err2) return resolve({ ok: false, error: err2.message });
          return resolve({ ok: true, used: 14, lastID: this.lastID, changes: this.changes });
        });
      } else {
        return resolve({ ok: false, error: err.message });
      }
    });
  });
}

module.exports = { runInsert };
