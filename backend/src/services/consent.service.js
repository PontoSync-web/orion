const db = require('../config/db');
const audit = require('./audit.service');

function grantConsent({ userId, deviceId, purpose, ip, userAgent }) {
 return new Promise((resolve, reject) => {
 if (!deviceId || !purpose) {
 return reject(new Error('deviceId e purpose são obrigatórios'));
 }

 db.run(
 `INSERT INTO consents (user_id, device_id, purpose, consent_status, granted_at)
 VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
 [userId, deviceId, purpose],
 function (err) {
 if (err) return reject(err);

 db.run(
 `UPDATE devices
 SET consent_status = 1, updated_at = CURRENT_TIMESTAMP
 WHERE id = ?`,
 [deviceId],
 (updateErr) => {
 if (updateErr) return reject(updateErr);

 audit.log({
 actorUserId: userId,
 action: 'CONSENT_GRANTED',
 entityType: 'device',
 entityId: String(deviceId),
 details: JSON.stringify({ purpose }),
 ip,
 userAgent
 }).catch(() => {});

 resolve({
 id: this.lastID,
 deviceId,
 purpose,
 consentStatus: true
 });
 }
 );
 }
 );
 });
}

function revokeConsent({ userId, deviceId, ip, userAgent }) {
 return new Promise((resolve, reject) => {
 if (!deviceId) {
 return reject(new Error('deviceId é obrigatório'));
 }

 db.run(
 `UPDATE consents
 SET consent_status = 0, revoked_at = CURRENT_TIMESTAMP
 WHERE device_id = ? AND consent_status = 1`,
 [deviceId],
 function (err) {
 if (err) return reject(err);

 db.run(
 `UPDATE devices
 SET consent_status = 0, updated_at = CURRENT_TIMESTAMP
 WHERE id = ?`,
 [deviceId],
 (updateErr) => {
 if (updateErr) return reject(updateErr);

 audit.log({
 actorUserId: userId,
 action: 'CONSENT_REVOKED',
 entityType: 'device',
 entityId: String(deviceId),
 details: JSON.stringify({ revoked: true }),
 ip,
 userAgent
 }).catch(() => {});

 resolve({
 deviceId,
 consentStatus: false
 });
 }
 );
 }
 );
 });
}

module.exports = {
 grantConsent,
 revokeConsent
};
