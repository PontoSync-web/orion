const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
 fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'orion.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
 db.run('PRAGMA foreign_keys = ON');

 db.run(`
 CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 active INTEGER NOT NULL DEFAULT 1,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
 )
 `);

 db.run(`
 CREATE TABLE IF NOT EXISTS devices (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 device_token TEXT UNIQUE NOT NULL,
 label TEXT,
 platform TEXT,
 consent_status INTEGER NOT NULL DEFAULT 0,
 last_seen_at DATETIME,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (user_id) REFERENCES users(id)
 )
 `);

 db.run(`
 CREATE TABLE IF NOT EXISTS consents (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 device_id INTEGER NOT NULL,
 purpose TEXT NOT NULL,
 consent_status INTEGER NOT NULL DEFAULT 0,
 granted_at DATETIME,
 revoked_at DATETIME,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (user_id) REFERENCES users(id),
 FOREIGN KEY (device_id) REFERENCES devices(id)
 )
 `);

 db.run(`
 CREATE TABLE IF NOT EXISTS locations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 device_id INTEGER NOT NULL,
 latitude REAL NOT NULL,
 longitude REAL NOT NULL,
 accuracy REAL,
 source TEXT,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (device_id) REFERENCES devices(id)
 )
 `);

 db.run(`
 CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_user_id INTEGER,
 action TEXT NOT NULL,
 entity_type TEXT,
 entity_id TEXT,
 details TEXT,
 ip TEXT,
 user_agent TEXT,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP
 )
 `);
});

module.exports = db;
