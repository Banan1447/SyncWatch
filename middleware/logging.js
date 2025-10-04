// middleware/logging.js

function logRequests(req, res, next) {
  // Временная метка
  const timestamp = new Date().toISOString();
  // Метод HTTP и URL
  const method = req.method;
  const url = req.url;
  // IP-адрес клиента (с учётом возможных прокси)
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || (req.headers && req.headers['x-forwarded-for']);

  console.log(`[LOG ${timestamp}] ${method} ${url} - IP: ${clientIP}`);

  // Передаём управление следующему middleware
  next();
}

// Добавляем функцию logClientRequest
function logClientRequest(clientIP, socketId, action, details) {
  const timestamp = new Date().toISOString();
  console.log(`[LOG ${timestamp}] ${action} - IP: ${clientIP}, Socket: ${socketId}. Details: ${details}`);
}

// Экспортируем обе функции
module.exports = { logRequests, logClientRequest };