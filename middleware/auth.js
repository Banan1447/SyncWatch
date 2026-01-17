// middleware/auth.js
const AuthService = require('../services/authService');

const authService = new AuthService();

// Реальная проверка JWT токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  console.log('[AUTH MIDDLEWARE] Authorization header:', authHeader); // Добавим отладку
  
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  console.log('[AUTH MIDDLEWARE] Extracted token (start):', token ? token.substring(0, 20) + '...' : 'undefined'); // Добавим отладку

  if (!token) {
    console.log('[AUTH MIDDLEWARE] No token provided');
    return res.status(401).json({ success: false, error: 'Требуется токен аутентификации' });
  }

  try {
    console.log('[AUTH MIDDLEWARE] Attempting to verify token...');
    const user = authService.verifyToken(token);
    console.log('[AUTH MIDDLEWARE] Token verification result:', user); // Добавим отладку
    
    if (!user) {
      console.log('[AUTH MIDDLEWARE] Token verification failed - user is null');
      return res.status(403).json({ success: false, error: 'Неверный или просроченный токен' });
    }

    req.user = user;
    console.log(`[AUTH MIDDLEWARE] Успешная аутентификация пользователя: ${user.username}`);
    next();
  } catch (error) {
    console.error('[AUTH MIDDLEWARE] Ошибка проверки токена:', error);
    return res.status(403).json({ success: false, error: 'Ошибка проверки токена' });
  }
};

// Проверка прав администратора
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Требуется аутентификация' });
  }

  // В режиме разработки разрешаем всем
  if (process.env.NODE_ENV === 'development') {
    console.log(`[AUTH MIDDLEWARE] Development mode - admin access granted for: ${req.user.username}`);
    return next();
  }

  // Проверяем, является ли пользователь администратором
  const userData = authService.getUser(req.user.username);
  if (userData && userData.role === 'admin') {
    next();
  } else {
    res.status(403).json({ success: false, error: 'Требуются права администратора' });
  }
};

// Проверка localhost (опционально)
const isLocalhostOnly = (req, res, next) => {
  // В режиме разработки разрешаем доступ с любого IP
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');
  
  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    next();
  } else {
    console.warn(`[AUTH MIDDLEWARE] Попытка доступа к защищенному маршруту с IP: ${cleanIP}`);
    res.status(403).json({ success: false, error: 'Доступ разрешён только с localhost' });
  }
};

module.exports = { authenticateToken, isAdmin, isLocalhostOnly };