const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'cell_towers.db');

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.get("PRAGMA table_info(cell_towers)", (err, row) => {
    // Intencional: apenas tentando obter info da tabela
  });
  db.run("ALTER TABLE cell_towers ADD COLUMN call_id TEXT", (err) => {
    if (err) {
      if (err.message && err.message.includes('duplicate column name')) {
        console.log('A coluna call_id já existe. Nada a fazer.');
      } else {
        console.error('Erro ao adicionar coluna call_id:', err.message);
      }
    } else {
      console.log('Coluna call_id adicionada com sucesso.');
    }
    db.close();
  });
});
