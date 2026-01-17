// middleware/auth.js
const AuthService = require('../services/authService');

// Создаем экземпляр AuthService
const authService = new AuthService();

// Функция для инициализации AuthService (будет вызвана из server.js)
let authServiceInitialized = false;
const initializeAuthService = async () => {
  if (!authServiceInitialized) {
    await authService.initialize();
    authServiceInitialized = true;
  }
};

// Реальная проверка JWT токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ success: false, error: 'Требуется токен аутентификации' });
  }

  const token = authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Требуется токен аутентификации' });
  }

  try {
    const user = authService.verifyToken(token);

    if (!user) {
      return res.status(403).json({ success: false, error: 'Неверный или просроченный токен' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: 'Ошибка проверки токена' });
  }
};

// Проверка прав администратора
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Требуется аутентификация' });
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
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    next();
  } else {
    res.status(403).json({ success: false, error: 'Доступ разрешён только с localhost' });
  }
};

module.exports = { authenticateToken, isAdmin, isLocalhostOnly, initializeAuthService };