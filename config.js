// config.js
const path = require('path');

const config = {
  port: process.env.PORT || 3000,
  videoDirectory: process.env.VIDEO_DIRECTORY || path.join(process.cwd(), 'videos'),
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h'
};

// Создаем папку videos, если её нет
const fs = require('fs');
if (!fs.existsSync(config.videoDirectory)) {
  fs.mkdirSync(config.videoDirectory, { recursive: true });
  console.log(`[CONFIG] Создана папка для видео: ${config.videoDirectory}`);
}

module.exports = config;