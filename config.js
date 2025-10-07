// config.js
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
const allowedBaseDir = process.cwd();
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

// ✅ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: определяем publicDirectory
const publicDirectory = path.join(__dirname, 'public');

// Экспортируем config с publicDirectory
const config = {
  port,
  videoDir: requestedDir,        // ✅ videoDir (не videoDirectory!)
  publicDirectory,               // ✅ обязательно!
  jwtSecret: jwtSecret || 'your-super-secret-jwt-key-change-in-production',
  jwtExpiresIn
};

// Создание videoDir при старте
(async () => {
  try {
    await fs.access(config.videoDir, fs.constants.W_OK);
  } catch {
    try {
      await fs.mkdir(config.videoDir, { recursive: true });
      console.log(`[CONFIG] Создана папка для видео: ${config.videoDir}`);
    } catch (error) {
      console.error(`[CONFIG] Не удалось создать папку видео: ${error.message}`);
    }
  }
})();

module.exports = config; // ✅ обязательно!