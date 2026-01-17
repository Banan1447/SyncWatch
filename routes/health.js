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
        status: fs.existsSync(config.videoDir) ? 'healthy' : 'unhealthy',
        path: config.videoDir,
        writable: (() => {
          try {
            fs.accessSync(config.videoDir, fs.constants.W_OK);
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
        status: 'healthy' // Простая проверка, можно улучшить
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

// --- ДОБАВЛЕНО: GET /api/system/status ---
router.get('/status', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/system/status', '');

  // Простой ответ с базовой информацией о статусе сервера
  res.json({
    success: true,
    status: {
      server: 'running',
      uptime: process.uptime(), // Время работы в секундах
      timestamp: new Date().toISOString(), // Текущая дата/время
      nodeVersion: process.version, // Версия Node.js
      pid: process.pid, // ID процесса
      // Можно добавить другую информацию, например, статус подключения к БД
    }
  });
});
// --- КОНЕЦ ДОБАВЛЕНИЯ ---

// GET /api/system/stats
router.get('/stats', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/system/stats', '');
  
  try {
    // --- ВАЖНО: Создание нового экземпляра RoomService ---
    // Это может не отражать актуальное состояние, если RoomService хранит данные в памяти
    // и зависит от сокет-соединений, установленных в основном процессе.
    const RoomService = require('../services/roomService');
    const roomService = new RoomService(); // Новый экземпляр, возможно, с пустыми комнатами
    // ----------------------------------------

    const stats = {
      rooms: {
        total: 0, // Будет ноль, если комнаты хранятся в памяти и не загружены в этот экземпляр
        active: 0, // Будет ноль
        totalUsers: 0 // Будет ноль
      },
      videos: {
        total: 0,
        supported: 0,
        supportedFormats: ['mp4', 'webm', 'ogg', 'avi', 'mkv'] // Пример списка
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform
      },
      timestamp: new Date().toISOString()
    };

    // Получение списка видеофайлов
    if (fs.existsSync(config.videoDir)) {
      const videoFiles = fs.readdirSync(config.videoDir).filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mp4', '.webm', '.ogg', '.avi', '.mkv'].includes(ext); // Пример поддерживаемых форматов
      });

      stats.videos.total = videoFiles.length;
      stats.videos.supported = videoFiles.length; // Все отфильтрованные считаются поддерживаемыми
    } else {
        // Папка видео не существует
        console.warn(`[HEALTH ROUTES] Папка видео ${config.videoDir} не найдена при запросе /stats.`);
        stats.videos.total = -1; // Или другое значение для обозначения ошибки
        stats.videos.supported = -1;
    }

    // Попытка получить комнаты из текущего экземпляра RoomService (может быть пусто)
    const rooms = roomService.getAllRooms();
    // Подсчёт "живых" пользователей в комнатах, полученных из *этого* экземпляра
    stats.rooms.total = rooms.length;
    stats.rooms.active = rooms.filter(room => (room.users ? room.users.size : 0) > 0).length;
    stats.rooms.totalUsers = rooms.reduce((sum, room) => sum + (room.users ? room.users.size : 0), 0);

    res.json({ success: true, stats });
  } catch (error) {
    console.error('[HEALTH ROUTES] Ошибка получения статистики:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
