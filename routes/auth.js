// routes/auth.js
const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');

const authService = new AuthService(); // Создаём экземпляр сервиса

// Регистрация
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await authService.register(username, password);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Вход
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await authService.login(username, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// Получение информации о текущем пользователе (требует токен)
router.get('/profile', (req, res) => {
  // authenticateToken middleware должен быть вызван до этого маршрута (см. middleware/auth.js)
  // req.user будет установлено в middleware
  if (req.user) {
    const userInfo = authService.getUser(req.user.username);
    if (userInfo) {
      res.json({ success: true, user: userInfo });
    } else {
      res.status(404).json({ success: false, error: 'Пользователь не найден.' });
    }
  } else {
    res.status(401).json({ success: false, error: 'Требуется аутентификация.' });
  }
});

module.exports = router;
