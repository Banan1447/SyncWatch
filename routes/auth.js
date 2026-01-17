// routes/auth.js
const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');
const { authenticateToken } = require('../middleware/auth'); // Импортируем middleware

const authService = new AuthService(); // Создаём экземпляр сервиса

// Регистрация
router.post('/register', async (req, res) => {
  // Проверяем, что тело запроса существует и является объектом
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Invalid request body'
    });
  }

  const { username, email, password } = req.body;

  // Строгая валидация полей
  if (!username || typeof username !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Username is required and must be a string'
    });
  }

  const trimmedUsername = username.trim();
  if (trimmedUsername.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Username cannot be empty'
    });
  }

  if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
    return res.status(400).json({
      success: false,
      error: 'Username must be between 3 and 50 characters'
    });
  }

  // Проверка формата username (только буквы, цифры, подчеркивание, дефис)
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedUsername)) {
    return res.status(400).json({
      success: false,
      error: 'Username can only contain letters, numbers, underscores and hyphens'
    });
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Email is required and must be a string'
    });
  }

  const trimmedEmail = email.trim();
  if (trimmedEmail.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Email cannot be empty'
    });
  }

  // Проверка формата email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid email format'
    });
  }

  if (!password || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Password is required and must be a string'
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 8 characters long'
    });
  }

  if (password.length > 128) {
    return res.status(400).json({
      success: false,
      error: 'Password too long (max 128 characters)'
    });
  }

  try {
    const result = await authService.register(trimmedUsername, trimmedEmail, password);
    res.status(201).json(result);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Вход
router.post('/login', async (req, res) => {
  console.log('=== ВХОД ЗАПРОС ===');
  console.log('Тело запроса:', req.body);
  console.log('========================');
  
  // Проверяем, что тело запроса существует и является объектом
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'Invalid request body'
    });
  }
  
  const { username, password } = req.body;

  // Строгая валидация полей
  if (!username || typeof username !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Username is required and must be a string'
    });
  }

  const trimmedUsername = username.trim();
  if (trimmedUsername.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Username cannot be empty'
    });
  }

  if (trimmedUsername.length > 50) {
    return res.status(400).json({
      success: false,
      error: 'Username too long (max 50 characters)'
    });
  }

  if (!password || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Password is required and must be a string'
    });
  }

  if (password.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Password cannot be empty'
    });
  }

  if (password.length > 128) {
    return res.status(400).json({
      success: false,
      error: 'Password too long (max 128 characters)'
    });
  }

  try {
    const result = await authService.login(trimmedUsername, password);
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