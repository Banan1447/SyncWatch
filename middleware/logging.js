const ignoredPaths = [
  '/api/system/health',
  '/api/system/status',
  '/favicon.ico',
];

function logRequests(req, res, next) {
  // Пропускаем игнорируемые маршруты
  if (ignoredPaths.includes(req.path)) {
    return next();
  }

  const timestamp = new Date().toISOString();
  const method = req.method;
  const path = req.path; // Без query-параметров

  // IP-адрес: учитываем прокси
  const forwarded = req.headers['x-forwarded-for'];
  const clientIP = Array.isArray(forwarded)
    ? forwarded[0].split(',')[0].trim()
    : forwarded?.split(',')[0].trim() || req.ip;

  console.log(`[LOG ${timestamp}] ${method} ${path} - IP: ${clientIP}`);

  next();
}

function logClientRequest(clientIP, socketId, action, details) {
  const timestamp = new Date().toISOString();
  console.log(`[WS ${timestamp}] ${action} - IP: ${clientIP}, Socket: ${socketId}. Details: ${details}`);
}

module.exports = { logRequests, logClientRequest };