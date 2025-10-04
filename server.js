// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');

// Исправленный путь к config (из корня проекта)
const config = require('./config');

// Middleware
// Исправленный путь к logging middleware (из корня проекта)
const { logRequests } = require('./middleware/logging');

// Routes - ИСПРАВЛЕНЫ ПУТИ (все маршруты находятся в подкаталоге ./routes/)
const authRoutes = require('./routes/auth');
const videoRoutes = require('./routes/videos');
const sessionRoutes = require('./routes/sessions');
const adminRoutes = require('./routes/admin');
const metricsRoutes = require('./routes/metrics');
const healthRoutes = require('./routes/health');
const transcodeRoutes = require('./routes/transcode');
const fileRoutes = require('./routes/files'); // Исправлено

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(logRequests);
app.use(express.json());
app.use(express.static('public'));
app.use('/videos', express.static(config.videoDirectory));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/system', healthRoutes);
app.use('/api/transcode', transcodeRoutes);
app.use('/api/files', fileRoutes); // Теперь правильно подключено

// WebSocket
require('./socket')(io); // Путь к socket.js в подкаталоге server/

// Basic upload (для обратной совместимости)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.videoDirectory);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.post('/upload', upload.single('video'), (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  // Исправленный путь к logging middleware (из корня проекта)
  const { logClientRequest } = require('./middleware/logging');

  logClientRequest(clientIP, 'N/A', 'POST /upload', `File: ${req.file ? req.file.filename : 'N/A'}`);

  if (req.file) {
    // Оповещение о новом видео через WebSocket
    io.emit('video-updated', req.file.filename);
    res.json({ success: true, file: req.file.filename });
  } else {
    res.json({ success: false });
  }
});

// Статические страницы
app.get('/', (req, res) => {
  res.redirect('/select-room.html');
});

app.get('/admin', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(403).send('Доступ запрещён. Админ-панель доступна только с localhost.');
  }
});

app.get('/transcode', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    res.sendFile(path.join(__dirname, 'public', 'transcode.html'));
  } else {
    res.status(403).send('Access denied. Transcode page available only from localhost.');
  }
});

app.get('/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

// Редиректы для старых URL
app.get('/select-room.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'select-room.html'));
});

app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Файл-пустышка
app.get('/.empty', (req, res) => {
  res.redirect('/files');
});

// Обработка 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Обработка ошибок
app.use((error, req, res, next) => {
  console.error('[SERVER] Unhandled error:', error);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Запуск сервера
server.listen(config.port, () => {
  console.log(`[SERVER] Запущен на http://localhost:${config.port}`);
  console.log(`[INFO] Админ-панель: http://localhost:${config.port}/admin (только с localhost)`);
  console.log(`[INFO] Транскодер: http://localhost:${config.port}/transcode (только с localhost)`);
  console.log(`[INFO] Файловый менеджер: http://localhost:${config.port}/files`);
  console.log(`[INFO] Папка с видео: ${config.videoDirectory}`);
  console.log(`[INFO] JWT Secret: ${config.jwtSecret ? '✓ Настроен' : '✗ Отсутствует'}`);
});
