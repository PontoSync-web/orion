const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middlewares/auth');
const locationController = require('../controllers/location.controller');

router.post('/report', requireAuth, locationController.report);
router.get('/latest/:deviceId', requireAuth, locationController.latest);

module.exports = router;
