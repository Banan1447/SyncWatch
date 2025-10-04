// routes/admin.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isLocalhostOnly } = require('../middleware/auth');
const AdminService = require('../services/adminService'); // Предполагаем, что сервис будет создан

const adminService = new AdminService(); // Создаём экземпляр сервиса

// --- ЗАЩИЩЁННЫЕ МАРШРУТЫ ---
// Все маршруты ниже требуют JWT токен в заголовке Authorization

// Маршрут для получения общей информации/статистики для администратора
router.get('/stats', authenticateToken, (req, res) => {
  console.log(`[ADMIN API] Запрос статистики от пользователя: ${req.user.username}`);
  try {
    // Пример: получить статистику из AdminService
    const stats = adminService.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[ADMIN API] Ошибка получения статистики:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера при получении статистики' });
  }
});

// Маршрут для получения списка пользователей (требует аутентификации)
router.get('/users', authenticateToken, (req, res) => {
  console.log(`[ADMIN API] Запрос списка пользователей от пользователя: ${req.user.username}`);
  try {
    // Пример: получить список пользователей из AdminService (или AuthService)
    // const users = adminService.getUsers(); // или authService.getUsersList();
    // res.json({ success: true, users });
    res.json({ success: true, users: [], message: 'Получение списка пользователей не реализовано в этом примере.' });
  } catch (error) {
    console.error('[ADMIN API] Ошибка получения списка пользователей:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера при получении списка пользователей' });
  }
});

// --- МАРШРУТЫ, ОГРАНИЧЕННЫЕ ТОЛЬКО ДЛЯ LOCALHOST ---
// Эти маршруты требуют, чтобы запрос пришёл с localhost (127.0.0.1 или ::1)
// Они могут НЕ требовать JWT токена, если доступны только с localhost, но часто требуют оба.

// Маршрут для получения чувствительной информации (например, активных сессий, подробной статистики)
// Обычно требует оба: аутентификации и localhost
router.get('/sensitive-info', authenticateToken, isLocalhostOnly, (req, res) => {
  console.log(`[ADMIN API] Запрос чувствительной информации от пользователя ${req.user.username} с localhost`);
  try {
    // Пример: получить чувствительную информацию
    const sensitiveInfo = adminService.getSensitiveInfo();
    res.json({ success: true, sensitiveInfo });
  } catch (error) {
    console.error('[ADMIN API] Ошибка получения чувствительной информации:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера при получении чувствительной информации' });
  }
});

// Маршрут для выполнения чувствительной операции (например, перезапуск части сервиса, очистка кэша)
// Обычно требует оба: аутентификации и localhost
router.post('/perform-sensitive-action', authenticateToken, isLocalhostOnly, (req, res) => {
  const { action } = req.body;
  console.log(`[ADMIN API] Запрос выполнения чувствительного действия "${action}" от пользователя ${req.user.username} с localhost`);
  try {
    // Пример: выполнить действие через AdminService
    const result = adminService.performAction(action);
    res.json({ success: true, result });
  } catch (error) {
    console.error(`[ADMIN API] Ошибка выполнения действия "${action}":`, error);
    res.status(500).json({ success: false, error: `Ошибка сервера при выполнении действия "${action}": ${error.message}` });
  }
});

// --- ОБЫЧНЫЙ МАРШРУТ (НЕ ЗАЩИЩЁННЫЙ) ---
// Пример маршрута, который не требует аутентификации (например, проверка состояния)
// router.get('/health', (req, res) => {
//   res.json({ status: 'OK' });
// });

module.exports = router;
