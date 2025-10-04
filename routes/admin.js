// server/routes/admin.js
const express = require('express');
const router = express.Router();
const AuthService = require('../services/authService');
const RoomService = require('../services/roomService');
const { authenticateToken, isAdmin, isLocalhostOnly } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');

const authService = new AuthService();
const roomService = new RoomService();

// GET /api/admin/users
router.get('/users', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/admin/users', `Admin: ${req.user.username}`);
  
  try {
    // В реальном приложении здесь был бы пагинация и фильтры
    const users = authService.loadUsers().map(user => {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    });

    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/rooms
router.get('/rooms', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/admin/rooms', `Admin: ${req.user.username}`);
  
  try {
    const rooms = roomService.getAllRooms();
    res.json({ success: true, rooms });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/rooms/:id/kick
router.post('/rooms/:id/kick', authenticateToken, isAdmin, (req, res) => {
  const { id } = req.params;
  const { username } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/admin/rooms/:id/kick', `RoomID: ${id}, Username: ${username}`);
  
  try {
    if (!username) {
      return res.status(400).json({ success: false, error: 'Username required' });
    }

    // В реальном приложении нужно найти userId по username
    // Здесь упрощенная логика
    const room = roomService.getRoom(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    // Ищем пользователя по имени в комнате
    let targetUserId = null;
    for (const [userId, user] of room.users) {
      if (user.name === username) {
        targetUserId = userId;
        break;
      }
    }

    if (!targetUserId) {
      return res.status(404).json({ success: false, error: 'User not found in room' });
    }

    const success = roomService.kickUser(id, targetUserId, req.user.id);
    if (!success) {
      return res.status(403).json({ success: false, error: 'Not authorized to kick from this room' });
    }

    res.json({ success: true, message: 'User kicked from room' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/logs
router.get('/logs', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const fs = require('fs');
  const path = require('path');
  
  logClientRequest(clientIP, 'N/A', 'GET /api/admin/logs', `Admin: ${req.user.username}`);
  
  try {
    const logsFile = path.join(__dirname, '../../logs.txt');
    if (!fs.existsSync(logsFile)) {
      return res.json({ success: true, logs: [] });
    }

    const logsContent = fs.readFileSync(logsFile, 'utf8');
    const logs = logsContent.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const match = line.match(/\[(.*?)\] (.*)/);
        return match ? { timestamp: match[1], message: match[2] } : { message: line };
      })
      .reverse() // Последние логи первыми
      .slice(0, 1000); // Ограничиваем количество

    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;