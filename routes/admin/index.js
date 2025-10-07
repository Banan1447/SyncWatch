// routes/admin/index.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../../middleware/auth');

// Защищаем все роуты
router.use(authenticateToken);
router.use(isAdmin);

// Подключаем подмодули — они обрабатывают КОРНЕВОЙ путь внутри /admin
router.use('/rooms', require('./rooms'));     // → /api/admin/rooms
router.use('/stats', require('./stats'));     // → /api/admin/stats
// router.use('/users', require('./users'));
// router.use('/transcode', require('./transcode'));

module.exports = router;