const db = require('../config/db');
const audit = require('./audit.service');

function findByToken(deviceToken) {
 return new Promise((resolve, reject) => {
 db.get(
 `SELECT id, user_id, device_token, label, platform, consent_status, last_seen_at, created_at, updated_at
 FROM devices
 WHERE device_token = ?`,
 [deviceToken],
 (err, row) => {
 if (err) return reject(err);
 resolve(row || null);
 }
 );
 });
}

function findById(id) {
 return new Promise((resolve, reject) => {
 db.get(
 `SELECT id, user_id, device_token, label, platform, consent_status, last_seen_at, created_at, updated_at
 FROM devices
 WHERE id = ?`,
 [id],
 (err, row) => {
 if (err) return reject(err);
 resolve(row || null);
 }
 );
 });
}

function listByUser(userId) {
 return new Promise((resolve, reject) => {
 db.all(
 `SELECT id, user_id, device_token, label, platform, consent_status, last_seen_at, created_at, updated_at
 FROM devices
 WHERE user_id = ?
 ORDER BY created_at DESC, id DESC`,
 [userId],
 (err, rows) => {
 if (err) return reject(err);
 resolve(rows || []);
 }
 );
 });
}

async function register({ userId, deviceToken, label, platform, ip, userAgent }) {
 if (!deviceToken || String(deviceToken).trim().length < 8) {
 throw new Error('deviceToken inválido.');
 }

 const existing = await findByToken(deviceToken);
 if (existing) {
 throw new Error('Dispositivo já registrado.');
 }

 const createdId = await new Promise((resolve, reject) => {
 db.run(
 `INSERT INTO devices (user_id, device_token, label, platform, consent_status, created_at, updated_at)
 VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
 [userId, String(deviceToken).trim(), label || null, platform || null],
 function (err) {
 if (err) return reject(err);
 resolve(this.lastID);
 }
 );
 });

 await audit.log({
 actorUserId: userId,
 action: 'DEVICE_REGISTERED',
 entityType: 'device',
 entityId: String(createdId),
 details: JSON.stringify({
 label: label || null,
 platform: platform || null
 }),
 ip,
 userAgent
 });

 return findById(createdId);
}

async function touchLastSeen(deviceId) {
 return new Promise((resolve, reject) => {
 db.run(
 `UPDATE devices
 SET last_seen_at = CURRENT_TIMESTAMP,
 updated_at = CURRENT_TIMESTAMP
 WHERE id = ?`,
 [deviceId],
 function (err) {
 if (err) return reject(err);
 resolve({
 updated: this.changes > 0
 });
 }
 );
 });
}

module.exports = {
 findByToken,
 findById,
 listByUser,
 register,
 touchLastSeen
};
