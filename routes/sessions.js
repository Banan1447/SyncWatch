// server/routes/sessions.js
const express = require('express');
const router = express.Router();
const RoomService = require('../services/roomService');
const { authenticateToken } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');

const roomService = new RoomService();

// POST /api/sessions/create
router.post('/create', authenticateToken, (req, res) => {
  const { name } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/sessions/create', `Name: ${name}, User: ${req.user.username}`);
  
  try {
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'Session name required' });
    }

    const room = roomService.createRoom(name, req.user.id);
    res.json({ 
      success: true, 
      id: room.id, 
      name: room.name 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/sessions/:id
router.get('/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'GET /api/sessions/:id', `SessionID: ${id}`);
  
  try {
    const room = roomService.getRoom(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Не возвращаем всю внутреннюю информацию
    const sessionInfo = {
      id: room.id,
      name: room.name,
      creator: room.creator,
      userCount: room.users.size,
      state: room.state,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt
    };

    res.json({ success: true, session: sessionInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/sessions/:id/users
router.get('/:id/users', authenticateToken, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'GET /api/sessions/:id/users', `SessionID: ${id}`);
  
  try {
    const room = roomService.getRoom(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const users = Array.from(room.users.values()).map(user => ({
      id: user.id,
      name: user.name,
      status: user.status,
      position: user.position,
      userState: user.userState,
      joinedAt: user.joinedAt
    }));

    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/sessions/stop
router.post('/stop', authenticateToken, (req, res) => {
  const { roomId } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/sessions/stop', `RoomID: ${roomId}, User: ${req.user.username}`);
  
  try {
    if (!roomId) {
      return res.status(400).json({ success: false, error: 'Room ID required' });
    }

    const success = roomService.deleteRoom(roomId, req.user.id);
    if (!success) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this room' });
    }

    res.json({ success: true, message: 'Session stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/sessions/chat
router.post('/chat', authenticateToken, (req, res) => {
  const { roomId, message } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/sessions/chat', `RoomID: ${roomId}, User: ${req.user.username}`);
  
  try {
    if (!roomId || !message) {
      return res.status(400).json({ success: false, error: 'Room ID and message required' });
    }

    const chatMessage = roomService.addChatMessage(
      roomId, 
      req.user.id, 
      message, 
      req.user.username
    );

    if (!chatMessage) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    res.json({ success: true, message: chatMessage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/sessions/chat/history
router.get('/chat/history', authenticateToken, (req, res) => {
  const { roomId, limit = 50 } = req.query;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'GET /api/sessions/chat/history', `RoomID: ${roomId}`);
  
  try {
    if (!roomId) {
      return res.status(400).json({ success: false, error: 'Room ID required' });
    }

    const messages = roomService.getChatHistory(roomId, parseInt(limit));
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;