// server/routes/videos.js
const express = require('express');
const router = express.Router();
const VideoService = require('../services/videoService');
const { isLocalhostOnly } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');
const config = require('../config');

// ✅ ИСПРАВЛЕНО: используем config.videoDir вместо config.videoDirectory
const videoService = new VideoService(config.videoDir);

// GET /api/videos
router.get('/', async (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/videos', 'Fetching video list');
  
  try {
    const videos = await videoService.getAllVideos();
    // Убедимся, что ответ — массив объектов с полем "name"
    const formattedVideos = videos.map(video => {
      if (typeof video === 'string') {
        // Если сервис возвращает строки (имена файлов), оборачиваем в объект
        return { name: video };
      }
      // Если уже объект — оставляем как есть, но гарантируем наличие "name"
      return { name: video.name || video.filename || video, ...video };
    });
    res.json(formattedVideos);
  } catch (error) {
    console.error('[VIDEOS API] Ошибка при получении списка видео:', error);
    res.status(500).json([]); // Возвращаем пустой массив, а не ошибку
  }
});

// GET /api/videos/check-quality/:file/:quality
router.get('/check-quality/:file/:quality', (req, res) => {
  const { file, quality } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'GET /api/videos/check-quality', `File: ${file}, Quality: ${quality}`);
  
  try {
    const result = videoService.checkQuality(file, quality);
    res.json(result);
  } catch (error) {
    console.error('[VIDEOS API] Ошибка checkQuality:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/videos/delete
router.post('/delete', isLocalhostOnly, (req, res) => {
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/videos/delete', `Filename: ${filename}`);
  
  try {
    videoService.deleteVideo(filename);
    res.json({ success: true });
  } catch (error) {
    console.error('[VIDEOS API] Ошибка удаления видео:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/videos/rename
router.post('/rename', isLocalhostOnly, (req, res) => {
  const { oldName, newName } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/videos/rename', `Old: ${oldName}, New: ${newName}`);
  
  try {
    videoService.renameVideo(oldName, newName);
    res.json({ success: true });
  } catch (error) {
    console.error('[VIDEOS API] Ошибка переименования видео:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;