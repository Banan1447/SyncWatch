// server/routes/auth.js
const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');
const { authenticateToken } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');

const authService = new AuthService();

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { username, password, email } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/auth/register', `Username: ${username}`);
  
  try {
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const result = authService.register(username, password, email);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/auth/login', `Username: ${username}`);
  
  try {
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const result = authService.login(username, password);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(401).json({ success: false, error: error.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', authenticateToken, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/auth/refresh', `User: ${req.user.username}`);
  
  try {
    const user = authService.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const token = authService.generateToken(user);
    res.json({ success: true, token });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticateToken, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/auth/logout', `User: ${req.user.username}`);
  
  // В реальном приложении здесь можно добавить token blacklist
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/auth/profile
router.get('/profile', authenticateToken, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/auth/profile', `User: ${req.user.username}`);
  
  try {
    const user = authService.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Не возвращаем пароль
    const { password, ...userProfile } = user;
    res.json({ success: true, user: userProfile });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;