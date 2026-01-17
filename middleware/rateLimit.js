// middleware/rateLimit.js
// Простая реализация rate limiting (для продакшена используйте Redis или специализированную библиотеку)

// В режиме разработки отключаем rate limiting
const isDevelopment = process.env.NODE_ENV === 'development';

const rateLimitStore = new Map();

// Очистка старых записей каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.resetTime > 300000) { // 5 минут
      rateLimitStore.delete(key);
    }
  }
}, 300000);

// Rate limiting middleware
const createRateLimit = (maxRequests = 100, windowMs = 60000) => { // 100 запросов в минуту по умолчанию
  return (req, res, next) => {
    // В режиме разработки пропускаем rate limiting
    if (isDevelopment) {
      return next();
    }

    // Если maxRequests = 0, отключаем rate limiting
    if (maxRequests === 0) {
      return next();
    }

    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, {
        count: 0,
        resetTime: now + windowMs
      });
    }

    const userData = rateLimitStore.get(key);

    // Сброс счетчика если время вышло
    if (now > userData.resetTime) {
      userData.count = 0;
      userData.resetTime = now + windowMs;
    }

    userData.count++;

    // Установка headers
    res.set({
      'X-RateLimit-Limit': maxRequests,
      'X-RateLimit-Remaining': Math.max(0, maxRequests - userData.count),
      'X-RateLimit-Reset': userData.resetTime
    });

    if (userData.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later'
      });
    }

    next();
  };
};

// Разные лимиты для разных типов запросов
const authRateLimit = createRateLimit(5, 60000); // 5 попыток входа в минуту
const apiRateLimit = createRateLimit(100, 60000); // 100 API запросов в минуту
const fileRateLimit = createRateLimit(200, 60000); // 200 файловых операций в минуту

module.exports = {
  createRateLimit,
  authRateLimit,
  apiRateLimit,
  fileRateLimit
};