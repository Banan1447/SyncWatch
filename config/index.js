// config/index.js

// Этот файл экспортирует объект с настройками для приложения SyncWatch.
// Значения могут быть получены из переменных окружения или установлены по умолчанию.

module.exports = {
  // Порт, на котором будет слушать HTTP-сервер
  port: process.env.PORT || 3000,

  // Путь к папке, где хранятся видеофайлы (относительно корня проекта)
  videoDirectory: process.env.VIDEO_DIR || './videos',

  // Секретный ключ для подписи и проверки JWT-токенов.
  // Крайне важно использовать надёжный, сложный и стабильный ключ в продакшене.
  // Лучше всего передавать его через переменную окружения JWT_SECRET.
  jwtSecret: process.env.JWT_SECRET || 'your_very_strong_secret_key_here', // ЗАМЕНИТЕ НА НАСТОЯЩИЙ СЕКРЕТ!

  // Пример добавления других настроек:
  // dbUrl: process.env.DB_URL || 'mongodb://localhost:27017/syncwatch',
  // logLevel: process.env.LOG_LEVEL || 'info',
  // maxVideoFileSize: process.env.MAX_VIDEO_FILE_SIZE || '1GB', // Пример для routes/files.js
  // allowedVideoTypes: process.env.ALLOWED_VIDEO_TYPES || ['.mp4', '.avi', '.mkv'], // Пример для routes/files.js
};
