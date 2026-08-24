const locationService = require('../services/location.service');

async function report(req, res, next) {
 try {
 const {
 deviceId,
 latitude,
 longitude,
 accuracy,
 source
 } = req.body;

 const location = await locationService.reportLocation({
 userId: req.user.id,
 deviceId,
 latitude,
 longitude,
 accuracy,
 source,
 ip: req.ip,
 userAgent: req.headers['user-agent']
 });

 return res.status(201).json({
 status: 'ok',
 location
 });
 } catch (err) {
 return next(err);
 }
}

async function latest(req, res, next) {
 try {
 const { deviceId } = req.params;

 const location = await locationService.getLatestLocation({
 userId: req.user.id,
 deviceId,
 ip: req.ip,
 userAgent: req.headers['user-agent']
 });

 if (!location) {
 return res.status(404).json({
 error: 'Nenhuma localização encontrada para este dispositivo.'
 });
 }

 return res.json({
 status: 'ok',
 location
 });
 } catch (err) {
 return next(err);
 }
}

module.exports = {
 report,
 latest
};
