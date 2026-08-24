const db = require('../config/db');
const audit = require('./audit.service');

function checkConsent(deviceId) {
 return new Promise((resolve, reject) => {
 db.get(
 `SELECT consent_status FROM devices WHERE id = ?`,
 [deviceId],
 (err, row) => {
 if (err) return reject(err);
 if (!row) return reject(new Error('Dispositivo não encontrado.'));
 resolve(row.consent_status === 1);
 }
 );
 });
}

function reportLocation({ userId, deviceId, latitude, longitude, accuracy, source, ip, userAgent }) {
 return new Promise(async (resolve, reject) => {
 try {
 if (!deviceId) return reject(new Error('deviceId é obrigatório.'));
 if (latitude === undefined || longitude === undefined) {
 return reject(new Error('latitude e longitude são obrigatórios.'));
 }

 const hasConsent = await checkConsent(deviceId);
 if (!hasConsent) {
 return reject(new Error('Consentimento não concedido para este dispositivo.'));
 }

 db.run(
 `INSERT INTO locations (device_id, latitude, longitude, accuracy, source)
 VALUES (?, ?, ?, ?, ?)`,
 [deviceId, latitude, longitude, accuracy || null, source || 'manual'],
 async function (err) {
 if (err) return reject(err);

 try {
 await audit.log({
 actorUserId: userId,
 action: 'LOCATION_REPORTED',
 entityType: 'device',
 entityId: String(deviceId),
 details: JSON.stringify({
 latitude,
 longitude,
 accuracy: accuracy || null,
 source: source || 'manual'
 }),
 ip,
 userAgent
 });
 } catch (_) {}

 resolve({
 status: 'ok',
 locationId: this.lastID
 });
 }
 );
 } catch (err) {
 reject(err);
 }
 });
}

function latestLocation(deviceId) {
 return new Promise((resolve, reject) => {
 db.get(
 `SELECT * FROM locations WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
 [deviceId],
 (err, row) => {
 if (err) return reject(err);
 if (!row) return resolve(null);
 resolve(row);
 }
 );
 });
}

module.exports = {
 reportLocation,
 latestLocation,
 checkConsent
};
