const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const devicesRoutes = require('./routes/devices.routes');
const consentRoutes = require('./routes/consent.routes');
const locationRoutes = require('./routes/location.routes');
const { errorHandler } = require('./middlewares/errorHandler');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
 res.json({
 status: 'ok',
 service: 'Orion',
 mode: 'device-based-secure'
 });
});

app.use('/api/devices', devicesRoutes);
app.use('/api/consent', consentRoutes);
app.use('/api/location', locationRoutes);

app.use(errorHandler);

module.exports = app;
