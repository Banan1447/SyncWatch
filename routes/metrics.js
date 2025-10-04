// server/routes/metrics.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');

// Глобальные переменные для сбора метрик
const apiUsageStats = {
  totalRequests: 0,
  requestsByEndpoint: new Map(),
  requestsByMethod: new Map(),
  requestsByHour: new Map(),
  startTime: new Date().toISOString()
};

const errorCounts = {
  totalErrors: 0,
  errorsByType: new Map(),
  errorsByEndpoint: new Map()
};

const performanceMetrics = {
  responseTimes: [],
  activeConnections: 0,
  memoryUsage: [],
  uptime: 0
};

// Middleware для сбора метрик
router.use((req, res, next) => {
  const start = Date.now();
  
  // Собираем базовую статистику
  apiUsageStats.totalRequests++;
  
  const endpoint = req.path;
  const method = req.method;
  
  // Обновляем статистику по endpoint
  apiUsageStats.requestsByEndpoint.set(
    endpoint, 
    (apiUsageStats.requestsByEndpoint.get(endpoint) || 0) + 1
  );
  
  // Обновляем статистику по методу
  apiUsageStats.requestsByMethod.set(
    method, 
    (apiUsageStats.requestsByMethod.get(method) || 0) + 1
  );
  
  // Обновляем статистику по часу
  const hour = new Date().getHours();
  apiUsageStats.requestsByHour.set(
    hour, 
    (apiUsageStats.requestsByHour.get(hour) || 0) + 1
  );

  // Замеряем время ответа
  res.on('finish', () => {
    const duration = Date.now() - start;
    performanceMetrics.responseTimes.push(duration);
    
    // Держим только последние 1000 записей
    if (performanceMetrics.responseTimes.length > 1000) {
      performanceMetrics.responseTimes = performanceMetrics.responseTimes.slice(-1000);
    }
    
    // Логируем ошибки
    if (res.statusCode >= 400) {
      errorCounts.totalErrors++;
      
      errorCounts.errorsByType.set(
        res.statusCode, 
        (errorCounts.errorsByType.get(res.statusCode) || 0) + 1
      );
      
      errorCounts.errorsByEndpoint.set(
        endpoint, 
        (errorCounts.errorsByEndpoint.get(endpoint) || 0) + 1
      );
    }
  });
  
  next();
});

// GET /api/metrics/performance
router.get('/performance', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/metrics/performance', `User: ${req.user.username}`);
  
  try {
    const responseTimes = performanceMetrics.responseTimes;
    const avgResponseTime = responseTimes.length > 0 
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
      : 0;
    
    const maxResponseTime = responseTimes.length > 0 
      ? Math.max(...responseTimes) 
      : 0;
    
    const minResponseTime = responseTimes.length > 0 
      ? Math.min(...responseTimes) 
      : 0;

    const memoryUsage = process.memoryUsage();
    performanceMetrics.uptime = process.uptime();

    res.json({
      success: true,
      metrics: {
        responseTime: {
          average: Math.round(avgResponseTime),
          max: maxResponseTime,
          min: minResponseTime,
          recent: responseTimes.slice(-100)
        },
        memory: {
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          external: Math.round(memoryUsage.external / 1024 / 1024)
        },
        system: {
          uptime: performanceMetrics.uptime,
          activeConnections: performanceMetrics.activeConnections,
          nodeVersion: process.version,
          platform: process.platform
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/metrics/usage
router.get('/usage', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/metrics/usage', `User: ${req.user.username}`);
  
  try {
    const usageStats = {
      totalRequests: apiUsageStats.totalRequests,
      startTime: apiUsageStats.startTime,
      requestsByEndpoint: Object.fromEntries(apiUsageStats.requestsByEndpoint),
      requestsByMethod: Object.fromEntries(apiUsageStats.requestsByMethod),
      requestsByHour: Object.fromEntries(apiUsageStats.requestsByHour),
      currentTime: new Date().toISOString()
    };

    res.json({ success: true, usage: usageStats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/metrics/errors
router.get('/errors', authenticateToken, isAdmin, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/metrics/errors', `User: ${req.user.username}`);
  
  try {
    const errorStats = {
      totalErrors: errorCounts.totalErrors,
      errorsByType: Object.fromEntries(errorCounts.errorsByType),
      errorsByEndpoint: Object.fromEntries(errorCounts.errorsByEndpoint),
      errorRate: apiUsageStats.totalRequests > 0 
        ? (errorCounts.totalErrors / apiUsageStats.totalRequests * 100).toFixed(2)
        : 0
    };

    res.json({ success: true, errors: errorStats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;