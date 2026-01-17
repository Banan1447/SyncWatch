// config/index.js
const path = require('path');

module.exports = {
  port: process.env.PORT || 3000,
  videoDirectory: path.join(__dirname, '..', 'videos'),
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-here',
  
  // Настройки транскодирования
  transcode: {
    maxConcurrentJobs: 1,
    tempDirectory: path.join(__dirname, '..', 'temp')
  },
  
  // Настройки комнат
  rooms: {
    cleanupInterval: 30000, // 30 секунд
    maxUsersPerRoom: 50
  }
};