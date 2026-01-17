// routes/admin.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../middleware/auth');

// ✅ ИСПРАВЛЕНО: Этот файл не должен использоваться напрямую
// Вместо этого используем endpoints в server.js, которые используют AdminService
// Этот файл оставлен для совместимости, но маршруты должны быть в server.js

// Примечание: Все admin endpoints должны быть определены в server.js
// с использованием this.adminService, this.authService и т.д.

module.exports = router;
