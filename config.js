const path = require('path');
const fs = require('fs').promises;

// --- Валидация PORT ---
const portEnv = process.env.PORT;
const port = portEnv ? parseInt(portEnv, 10) : 3000;
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Некорректный порт: ${portEnv}`);
}

// --- Валидация VIDEO_DIRECTORY ---
const videoDirEnv = process.env.VIDEO_DIRECTORY;
const allowedBaseDir = process.cwd(); // или другая базовая директория
const requestedDir = path.resolve(path.normalize(videoDirEnv || path.join(allowedBaseDir, 'videos')));

if (!requestedDir.startsWith(allowedBaseDir)) {
  throw new Error(`VIDEO_DIRECTORY вне разрешённой области: ${allowedBaseDir}`);
}

// --- Валидация JWT_EXPIRES_IN ---
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '24h';
const expiresInRegex = /^(\d+)(s|m|h|d|w)$/;
if (!expiresInRegex.test(jwtExpiresIn)) {
  throw new Error(`Некорректный формат jwtExpiresIn: ${jwtExpiresIn}`);
}

// --- Валидация JWT_SECRET ---
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.warn('[CONFIG] Переменная JWT_SECRET не установлена. Используется НЕБЕЗОПАСНЫЙ ключ по умолчанию!');
  console.warn('[CONFIG] Установите JWT_SECRET в переменных окружения!');
}

const config = {
  port,
  videoDirectory: requestedDir,
  jwtSecret: jwtSecret || 'your-super-secret-jwt-key-change-in-production',
  jwtExpiresIn
};

// --- Создание директории и проверка прав ---
(async () => {
  try {
    await fs.access(config.videoDirectory, fs.constants.W_OK);
  } catch {
    try {
      await fs.mkdir(config.videoDirectory, { recursive: true });
      console.log(`[CONFIG] Создана папка для видео: ${config.videoDirectory}`);
    } catch (error) {
      throw new Error(`Не удалось создать или получить доступ к ${config.videoDirectory}: ${error.message}`);
    }
  }
})();

module.exports = config;