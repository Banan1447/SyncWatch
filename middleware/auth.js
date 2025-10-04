// middleware/auth.js

// Заглушка: Middleware для проверки JWT токена (позволяет всем)
const authenticateToken = (req, res, next) => {
  // Для заглушки, мы просто "подставляем" фиктивного пользователя
  // или разрешаем доступ всем, вызывая next() без проверки
  req.user = { username: 'guest_user', id: 'guest_id' }; // Пример фиктивного пользователя
  console.log('[AUTH MIDDLEWARE] Пропускаем аутентификацию (заглушка). Пользователь: guest_user');
  next(); // Разрешаем доступ к следующему обработчику
};

// Заглушка: Middleware для проверки, что запрос пришёл с localhost
const isLocalhostOnly = (req, res, next) => {
  // const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  // const cleanIP = clientIP.replace(/^::ffff:/, '');
  // if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
  //   next();
  // } else {
  //   res.status(403).json({ success: false, error: 'Доступ разрешён только с localhost.' });
  // }

  // Заглушка: разрешаем доступ с любого IP
  console.log('[AUTH MIDDLEWARE] Пропускаем проверку localhost (заглушка).');
  next(); // Разрешаем доступ
};

module.exports = { authenticateToken, isLocalhostOnly };
