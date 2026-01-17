// config/index.js
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');

// Функция для сохранения конфигурации
function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log('[CONFIG] Configuration saved to file');
  } catch (error) {
    console.error('[CONFIG] Error saving configuration:', error);
  }
}

// Функция для загрузки конфигурации
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const savedConfig = JSON.parse(data);
      console.log('[CONFIG] Configuration loaded from file');
      return savedConfig;
    }
  } catch (error) {
    console.error('[CONFIG] Error loading configuration:', error);
  }
  return null;
}

const defaultConfig = {
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
    maxUsersPerRoom: 500
  },

  // Настройки rate limiting
  rateLimit: {
    apiRequestsPerMinute: 0 // 0 = отключено
  }
};

// Загружаем сохраненную конфигурацию или используем по умолчанию
const savedConfig = loadConfig();
const config = savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig;

// Добавляем метод сохранения к конфигурации
config.save = () => saveConfig(config);

// Экспортируем конфигурацию
module.exports = config;