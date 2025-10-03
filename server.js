// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

// ✅ Читаем настройки из config.js
const config = require('./config.js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Используем папку из config.js
const VIDEO_FOLDER = path.join(process.cwd(), config.videoDirectory);

// Создаём папку videos, если её нет
if (!fs.existsSync(VIDEO_FOLDER)) {
  fs.mkdirSync(VIDEO_FOLDER, { recursive: true });
  console.log(`[INFO] Создана папка для видео: ${VIDEO_FOLDER}`);
}

// ✅ Настройка multer для загрузки видео
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEO_FOLDER);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));
app.use('/videos', express.static(VIDEO_FOLDER));

// --- ROOM LOGIC ВЫНЕСЕН В rooms.js ---
const roomsData = require('./rooms.js');
let rooms = roomsData.getRooms();
function getRoomList() { return roomsData.getRoomList(); }

// ✅ РАСШИРЕННЫЙ СПИСОК ВИДЕОФОРМАТОВ
const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|wmv|flv|mkv|mpg|mpeg|3gp|3g2|ts|mts|m2ts|vob|f4v|f4p|f4a|f4b|mp3|wav|aac|flac|wma|m4a|asf|rm|rmvb|vcd|svcd|dvd|yuv|y4m)$/i;

// ✅ ФУНКЦИЯ ПРОВЕРКИ ПОДДЕРЖИВАЕМЫХ ФОРМАТОВ
function isSupportedFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const supportedFormats = ['mp4', 'webm', 'ogg'];
  return supportedFormats.includes(ext);
}

// Получить список видеофайлов
function getVideoFiles() {
  try {
    return fs.readdirSync(VIDEO_FOLDER).filter(file => VIDEO_EXTENSIONS.test(file));
  } catch (err) {
    console.error('Ошибка доступа к папке с видео:', err);
    return [];
  }
}

// Получить информацию о видео
function getVideoInfo(file, callback) {
  ffmpeg.ffprobe(path.join(VIDEO_FOLDER, file), (err, metadata) => {
    if (!err) {
      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (videoStream) {
        callback({
          resolution: `${videoStream.width}x${videoStream.height}`,
          bitrate: videoStream.bit_rate || 'N/A'
        });
      } else {
        callback({ resolution: 'N/A', bitrate: 'N/A' });
      }
    } else {
      callback({ resolution: 'N/A', bitrate: 'N/A' });
    }
  });
}

// API: получить список видео
app.get('/api/videos', (req, res) => {
  const files = getVideoFiles();
  const videos = [];
  if (files.length === 0) return res.json([]);

  let processed = 0;

  files.forEach(file => {
    getVideoInfo(file, info => {
      // ✅ ДОБАВЛЯЕМ isSupported В ОТВЕТ
      const isSupported = isSupportedFormat(file);
      videos.push({ 
        name: file, 
        ...info,
        isSupported
      });
      processed++;
      if (processed === files.length) {
        res.json(videos);
      }
    });
  });
});

// API: проверить качество
app.get('/api/check-quality/:file/:quality', (req, res) => {
  const { file, quality } = req.params;
  const ext = path.extname(file);
  const name = path.basename(file, ext);
  const qualityFile = `${name}_${quality}${ext}`;
  const filePath = path.join(VIDEO_FOLDER, qualityFile);

  if (fs.existsSync(filePath)) {
    res.json({ exists: true, filename: qualityFile });
  } else {
    res.json({ exists: false });
  }
});

// API: загрузка видео
// --- UPLOAD WITH ROOM BROADCAST ---
app.post('/upload', upload.single('video'), (req, res) => {
  if (req.file) {
    // Найти все комнаты, где есть пользователи (можно оптимизировать под roomId из запроса, если потребуется)
    Object.keys(rooms).forEach(roomId => {
      // Обновить список видео для всех в комнате
      io.to(roomId).emit('video-updated', req.file.filename);
      io.to(roomId).emit('room-state', rooms[roomId]);
    });
    res.json({ success: true, file: req.file.filename });
  } else {
    res.json({ success: false });
  }
});

// ✅ API: удаление видео
app.post('/api/delete-video', (req, res) => {
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверное имя файла' });
  }

  const filePath = path.join(VIDEO_FOLDER, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ success: false, error: 'Файл не существует' });
  }

  try {
    fs.unlinkSync(filePath);
    console.log(`[ADMIN] Файл удалён: ${filename}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка удаления файла:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
  }
});

// ✅ API: переименование видео
app.post('/api/rename-video', (req, res) => {
  const { oldName, newName } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  if (!oldName || !newName || typeof oldName !== 'string' || typeof newName !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверные имена файлов' });
  }

  const oldPath = path.join(VIDEO_FOLDER, oldName);
  const newPath = path.join(VIDEO_FOLDER, newName);

  // ✅ Проверяем, существует ли старый файл
  if (!fs.existsSync(oldPath)) {
    return res.status(400).json({ success: false, error: 'Старый файл не существует' });
  }

  // ✅ Проверяем, существует ли новый файл
  if (fs.existsSync(newPath)) {
    return res.status(400).json({ success: false, error: 'Новый файл уже существует' });
  }

  try {
    // ✅ Переименовываем файл
    fs.renameSync(oldPath, newPath);
    console.log(`[ADMIN] Файл переименован: ${oldName} → ${newName}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка переименования файла:', err);
    res.status(500).json({ success: false, error: 'Ошибка переименования файла' });
  }
});

// ✅ Админ-панель (только с localhost)
app.get('/admin', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');
  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(403).send('Доступ запрещён. Админ-панель доступна только с localhost.');
  }
});

// ✅ API: получить текущие настройки
app.get('/api/config', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  res.json({
    success: true,
    port: config.port,
    videoDirectory: config.videoDirectory
  });
});

// ✅ API: установить папку с видео
app.post('/api/set-video-folder', (req, res) => {
  const { folder } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  if (!folder || typeof folder !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверный путь' });
  }

  if (!fs.existsSync(folder)) {
    return res.status(400).json({ success: false, error: 'Папка не существует' });
  }

  // ✅ Безопасное обновление config.js
  const configPath = path.join(__dirname, 'config.js');
  let configContent;
  try {
    configContent = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error('Ошибка чтения config.js:', err);
    return res.status(500).json({ success: false, error: 'Не удалось прочитать config.js' });
  }

  // Заменяем videoDirectory в config.js
  const newConfigContent = configContent.replace(
    /(videoDirectory:\s*['"])[^'"]*(['"])/,
    `$1${folder}$2`
  );

  // ✅ Проверяем, что результат — валидный JS
  try {
    eval(`(${newConfigContent.replace('module.exports =', '')})`);
  } catch (err) {
    console.error('Новый config.js содержит ошибки:', err);
    return res.status(500).json({ success: false, error: 'Новый config.js содержит ошибки' });
  }

  try {
    fs.writeFileSync(configPath, newConfigContent);
  } catch (err) {
    console.error('Ошибка записи config.js:', err);
    return res.status(500).json({ success: false, error: 'Не удалось записать config.js' });
  }

  console.log(`[ADMIN] Папка с видео изменена на: ${folder}`);
  res.json({ success: true, folder: folder });
});

// ✅ API: установить порт сервера
app.post('/api/set-port', (req, res) => {
  const { port } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  if (!port || typeof port !== 'number' || port < 1024 || port > 65535) {
    return res.status(400).json({ success: false, error: 'Неверный порт (1024-65535)' });
  }

  // ✅ Безопасное обновление config.js
  const configPath = path.join(__dirname, 'config.js');
  let configContent;
  try {
    configContent = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error('Ошибка чтения config.js:', err);
    return res.status(500).json({ success: false, error: 'Не удалось прочитать config.js' });
  }

  // Заменяем port в config.js
  const newConfigContent = configContent.replace(
    /(port:\s*(?:process\.env\.PORT\s*\|\|\s*)?)\d+/,
    `$1${port}`
  );

  // ✅ Проверяем, что результат — валидный JS
  try {
    eval(`(${newConfigContent.replace('module.exports =', '')})`);
  } catch (err) {
    console.error('Новый config.js содержит ошибки:', err);
    return res.status(500).json({ success: false, error: 'Новый config.js содержит ошибки' });
  }

  try {
    fs.writeFileSync(configPath, newConfigContent);
  } catch (err) {
    console.error('Ошибка записи config.js:', err);
    return res.status(500).json({ success: false, error: 'Не удалось записать config.js' });
  }

  console.log(`[ADMIN] Порт изменён на: ${port}. Перезапустите сервер.`);
  res.json({ success: true, port: port, message: 'Порт изменён. Перезапустите сервер для применения изменений.' });
});

// === TRANSCODE API ===
const TRANSCODE_TEMPLATES_FILE = path.join(__dirname, 'transcode-templates.json');
const TRANSCODE_QUEUE_FILE = path.join(__dirname, 'transcode-queue.json');

// Загрузка шаблонов
function loadTranscodeTemplates() {
  try {
    if (fs.existsSync(TRANSCODE_TEMPLATES_FILE)) {
      return JSON.parse(fs.readFileSync(TRANSCODE_TEMPLATES_FILE, 'utf8'));
    }
    return [];
  } catch (err) {
    console.error('Error loading transcode templates:', err);
    return [];
  }
}

// Сохранение шаблонов
function saveTranscodeTemplates(templates) {
  try {
    fs.writeFileSync(TRANSCODE_TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving transcode templates:', err);
    return false;
  }
}

// Загрузка очереди
function loadTranscodeQueue() {
  try {
    if (fs.existsSync(TRANSCODE_QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(TRANSCODE_QUEUE_FILE, 'utf8'));
    }
    return [];
  } catch (err) {
    console.error('Error loading transcode queue:', err);
    return [];
  }
}

// Сохранение очереди
function saveTranscodeQueue(queue) {
  try {
    fs.writeFileSync(TRANSCODE_QUEUE_FILE, JSON.stringify(queue, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving transcode queue:', err);
    return false;
  }
}

// API: получить шаблоны
app.get('/api/transcode/templates', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const templates = loadTranscodeTemplates();
  res.json({ success: true, templates });
});

// API: сохранить шаблон
app.post('/api/transcode/save-template', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const { name, description, command } = req.body;
  if (!name || !command) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const templates = loadTranscodeTemplates();
  const id = 'tmpl_' + Math.random().toString(36).substr(2, 8);
  
  templates.push({
    id,
    name,
    description: description || '',
    command,
    createdAt: new Date().toISOString()
  });

  if (saveTranscodeTemplates(templates)) {
    res.json({ success: true, id });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save template' });
  }
});

// API: удалить шаблон
app.post('/api/transcode/delete-template', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing template ID' });
  }

  let templates = loadTranscodeTemplates();
  templates = templates.filter(t => t.id !== id);

  if (saveTranscodeTemplates(templates)) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

// API: получить очередь
app.get('/api/transcode/queue', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const queue = loadTranscodeQueue();
  const templates = loadTranscodeTemplates();

  // Добавляем имена шаблонов
  const queueWithNames = queue.map(item => {
    const template = templates.find(t => t.id === item.templateId);
    return {
      ...item,
      templateName: template ? template.name : 'Unknown'
    };
  });

  res.json({ success: true, queue: queueWithNames });
});

// API: добавить в очередь
app.post('/api/transcode/add-to-queue', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const { fileId, templateId } = req.body;
  if (!fileId || !templateId) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const templates = loadTranscodeTemplates();
  const template = templates.find(t => t.id === templateId);
  if (!template) {
    return res.status(400).json({ success: false, error: 'Template not found' });
  }

  let queue = loadTranscodeQueue();
  const id = 'job_' + Math.random().toString(36).substr(2, 8);
  
  queue.push({
    id,
    fileId,
    templateId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString()
  });

  if (saveTranscodeQueue(queue)) {
    res.json({ success: true, id });
  } else {
    res.status(500).json({ success: false, error: 'Failed to add to queue' });
  }
});

// === TRANSCODE PAGE ===
app.get('/transcode', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).send('Access denied. Transcode page available only from localhost.');
  }

  res.sendFile(path.join(__dirname, 'public', 'transcode.html'));
});

// Создаём файлы если их нет
if (!fs.existsSync(TRANSCODE_TEMPLATES_FILE)) {
  const defaultTemplates = [
    {
      id: 'tmpl_1',
      name: 'Low Quality MP4',
      description: '480p MP4 for web playback',
      command: '-vf scale=854:480 -c:v libx264 -crf 23 -preset fast {output}',
      createdAt: new Date().toISOString()
    },
    {
      id: 'tmpl_2',
      name: 'High Quality MP4',
      description: '1080p MP4 with high quality',
      command: '-vf scale=1920:1080 -c:v libx264 -crf 18 -preset slow {output}',
      createdAt: new Date().toISOString()
    }
  ];
  saveTranscodeTemplates(defaultTemplates);
}

if (!fs.existsSync(TRANSCODE_QUEUE_FILE)) {
  saveTranscodeQueue([]);
}

// ✅ ГЛАВНАЯ СТРАНИЦА - РЕДИРЕКТ НА SELECT-ROOM
app.get('/', (req, res) => {
  res.redirect('/select-room.html');
});

// ✅ Страница выбора комнаты
app.get('/select-room.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'select-room.html'));
});

// ✅ Страница плеера
app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ✅ Страница управления файлами - БЕЗ РЕДИРЕКТА
app.get('/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

// Сокеты
io.on('connection', (socket) => {
  console.log('[SOCKET] User connected:', socket.id);
  let joinedRoom = null;
  let userName = `User${Math.floor(Math.random()*10000)}`;

  // --- ROOM EVENTS ---
  socket.on('create-room', ({ name }, cb) => {
    const id = 'room_' + Math.random().toString(36).substr(2, 8);
    rooms[id] = {
      name: name || id,
      users: {},
      currentVideo: null,
      // ✅ УБРАЛИ ЧАТ
    };
    roomsData.setRooms(rooms);
    cb && cb({ id, name: rooms[id].name });
    io.emit('room-list', getRoomList());
  });

  socket.on('get-rooms', (cb) => {
    cb && cb(getRoomList());
  });

  socket.on('join-room', ({ roomId, name }, cb) => {
    if (!rooms[roomId]) return cb && cb({ error: 'Room not found' });
    if (joinedRoom) socket.leave(joinedRoom);
    joinedRoom = roomId;
    userName = name || userName;
    rooms[roomId].users[socket.id] = {
      name: userName,
      ping: 0,
      buffer: 0,
      status: 'paused',
      position: 0,
      ready: false
    };
    roomsData.setRooms(rooms);
    socket.join(roomId);
    cb && cb({ success: true, room: { id: roomId, name: rooms[roomId].name } });
    io.to(roomId).emit('room-state', rooms[roomId]);
    io.emit('room-list', getRoomList());
  });

  socket.on('leave-room', (cb) => {
    if (joinedRoom && rooms[joinedRoom]) {
      delete rooms[joinedRoom].users[socket.id];
      roomsData.setRooms(rooms);
      socket.leave(joinedRoom);
      // ✅ УБРАЛИ УДАЛЕНИЕ КОМНАТЫ, ЕСЛИ 0 УЧАСТНИКОВ
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
      io.emit('room-list', getRoomList());
    }
    joinedRoom = null;
    cb && cb({ success: true });
  });

  // --- УДАЛЕНИЕ КОМНАТЫ ---
  socket.on('delete-room', ({ roomId }, cb) => {
    if (rooms[roomId]) {
      delete rooms[roomId];
      roomsData.setRooms(rooms);
      io.emit('room-list', getRoomList());
      cb && cb({ success: true });
    } else {
      cb && cb({ success: false, error: 'Room not found' });
    }
  });

  // --- ROOM-AWARE EVENTS ---
  socket.on('ping', () => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      const start = Date.now();
      socket.emit('pong', start);
    }
  });

  socket.on('pong-response', (start) => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      const latency = Date.now() - start;
      rooms[joinedRoom].users[socket.id].ping = latency;
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('buffer-update', (data) => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      rooms[joinedRoom].users[socket.id].buffer = data.buffer;
      rooms[joinedRoom].users[socket.id].position = data.position;
      rooms[joinedRoom].users[socket.id].status = data.status;
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('video-command', (data) => {
    if (joinedRoom) {
      socket.to(joinedRoom).emit('video-command', data);
    }
  });

  socket.on('select-video', (filename) => {
    if (joinedRoom && rooms[joinedRoom]) {
      rooms[joinedRoom].currentVideo = filename;
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('video-updated', filename);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('set-name', (name) => {
    userName = name;
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      rooms[joinedRoom].users[socket.id].name = name;
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  // ✅ НОВОЕ: КИК ПОЛЬЗОВАТЕЛЯ
  socket.on('kick-user', ({ userId, roomId }, cb) => {
    if (rooms[roomId] && rooms[roomId].users[userId]) {
      // Отправляем пользователю команду на выход
      io.to(userId).emit('kicked-from-room', { message: 'You have been kicked from the room' });
      // Удаляем пользователя из комнаты
      delete rooms[roomId].users[userId];
      roomsData.setRooms(rooms);
      // Обновляем состояние комнаты
      io.to(roomId).emit('room-state', rooms[roomId]);
      io.emit('room-list', getRoomList());
      cb && cb({ success: true });
    } else {
      cb && cb({ success: false, error: 'User not found' });
    }
  });

  // ✅ УБРАЛИ ЧАТ
  socket.on('send-comment', (comment) => {
    // Удалено
  });

  socket.on('disconnect', () => {
    if (joinedRoom && rooms[joinedRoom]) {
      delete rooms[joinedRoom].users[socket.id];
      roomsData.setRooms(rooms);
      // ✅ УБРАЛИ УДАЛЕНИЕ КОМНАТЫ, ЕСЛИ 0 УЧАСТНИКОВ
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
      io.emit('room-list', getRoomList());
    }
    joinedRoom = null; // ✅ Сброс joinedRoom
    console.log('[SOCKET] User disconnected:', socket.id);
  });
});

// ✅ Используем порт из config.js
const PORT = config.port;
server.listen(PORT, () => {
  console.log(`[SERVER] Запущен на http://localhost:${PORT}`);
  console.log(`[INFO] Админ-панель: http://localhost:${PORT}/admin (только с localhost)`);
  console.log(`[INFO] Папка с видео: ${VIDEO_FOLDER}`);
});