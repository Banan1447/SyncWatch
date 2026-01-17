// routes/auth.js
const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');
const { authenticateToken } = require('../middleware/auth'); // Импортируем middleware

const authService = new AuthService(); // Создаём экземпляр сервиса

// Регистрация
router.post('/register', async (req, res) => {
  console.log('=== РЕГИСТРАЦИЯ ЗАПРОС ===');
  console.log('Тело запроса:', req.body);
  console.log('Тип тела:', typeof req.body);
  console.log('========================');
  
  // Проверяем, что тело запроса существует
  if (!req.body) {
    return res.status(400).json({ 
      success: false, 
      error: 'Тело запроса отсутствует' 
    });
  }
  
  const { username, email, password } = req.body;

  // Проверяем конкретные поля
  if (!username) {
    return res.status(400).json({ 
      success: false, 
      error: 'Username is required' 
    });
  }
  
  if (typeof username !== 'string' || username.trim().length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Username must be a non-empty string' 
    });
  }

  if (!email) {
    return res.status(400).json({ 
      success: false, 
      error: 'Email is required' 
    });
  }

  if (typeof email !== 'string' || email.trim().length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Email must be a non-empty string' 
    });
  }

  if (!password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password is required' 
    });
  }

  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password must be a non-empty string' 
    });
  }
  
  // Проверка длины пароля
  if (password.length < 8) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password must be at least 8 characters long' 
    });
  }

  try {
    const result = await authService.register(username.trim(), email.trim(), password);
    res.status(201).json(result);
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Вход
router.post('/login', async (req, res) => {
  console.log('=== ВХОД ЗАПРОС ===');
  console.log('Тело запроса:', req.body);
  console.log('========================');
  
  if (!req.body) {
    return res.status(400).json({ 
      success: false, 
      error: 'Тело запроса отсутствует' 
    });
  }
  
  const { username, password } = req.body;

  if (!username) {
    return res.status(400).json({ 
      success: false, 
      error: 'Username is required' 
    });
  }
  
  if (typeof username !== 'string' || username.trim().length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Username must be a non-empty string' 
    });
  }

  if (!password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password is required' 
    });
  }

  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password must be a non-empty string' 
    });
  }

  try {
    const result = await authService.login(username.trim(), password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// Получение информации о текущем пользователе (требует токен)
router.get('/profile', authenticateToken, (req, res) => { // Добавлен authenticateToken middleware!
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