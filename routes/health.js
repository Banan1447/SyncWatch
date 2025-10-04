// server/routes/health.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { logClientRequest } = require('../middleware/logging');
const config = require('../config');

// GET /api/system/health
router.get('/health', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/system/health', '');
  
  try {
    const healthChecks = {
      server: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      },
      videoDirectory: {
        status: fs.existsSync(config.videoDirectory) ? 'healthy' : 'unhealthy',
        path: config.videoDirectory,
        writable: (() => {
          try {
            fs.accessSync(config.videoDirectory, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })()
      },
      memory: {
        status: 'healthy',
        usage: process.memoryUsage(),
        usagePercent: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)
      },
      disk: {
        status: 'healthy'
      }
    };

    // Проверяем использование памяти
    if (healthChecks.memory.usagePercent > 90) {
      healthChecks.memory.status = 'warning';
    }

    // Проверяем общее здоровье системы
    const allHealthy = Object.values(healthChecks).every(check => check.status === 'healthy');
    healthChecks.overall = allHealthy ? 'healthy' : 'degraded';

    res.json({ success: true, health: healthChecks });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      health: { overall: 'unhealthy', error: error.message } 
    });
  }
});

// GET /api/system/stats
router.get('/stats', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/system/stats', '');
  
  try {
    const RoomService = require('../services/roomService');
    const roomService = new RoomService();
    const VideoService = require('../services/videoService');
    const videoService = new VideoService(config.videoDirectory);

    const rooms = roomService.getAllRooms();
    const videos = videoService.getVideoFiles();

    const stats = {
      rooms: {
        total: rooms.length,
        active: rooms.filter(room => room.userCount > 0).length,
        totalUsers: rooms.reduce((sum, room) => sum + room.userCount, 0)
      },
      videos: {
        total: videos.length,
        supported: videos.filter(video => {
          const ext = video.split('.').pop().toLowerCase();
          return ['mp4', 'webm', 'ogg'].includes(ext);
        }).length
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform
      },
      timestamp: new Date().toISOString()
    };

    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;