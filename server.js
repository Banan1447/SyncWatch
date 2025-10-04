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

// ✅ Middleware для логирования HTTP-запросов
function logRequests(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');
  const method = req.method;
  const url = req.url;

  // Для API маршрутов, не связанных с видео, можно логировать сразу
  if (url.startsWith('/api/') && !url.startsWith('/api/videos') && !url.startsWith('/videos/')) {
    console.log(`[HTTP] IP: ${cleanIP} | Method: ${method} | URL: ${url} | SocketID: N/A`);
  }
  // Для /api/videos и /upload логирование будет чуть позже, внутри обработчиков, чтобы учесть контекст
  // Но базовое логирование запроса происходит здесь
  console.log(`[HTTP] IP: ${cleanIP} | Method: ${method} | URL: ${url} | SocketID: N/A`);
  next();
}

// Применяем middleware для логирования
app.use(logRequests);
app.use(express.json());
app.use(express.static('public'));
app.use('/videos', express.static(VIDEO_FOLDER));

// --- ROOM LOGIC ВЫНЕСЕН В rooms.js ---
const roomsData = require('./rooms.js');
let rooms = roomsData.getRooms();
function getRoomList() { return roomsData.getRoomList(); }

// ✅ РАСШИРЕННЫЙ СПИСОК ВИДЕОФОРМАТОВ
const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|wmv|flv|mkv|mpg|mpeg|3gp|3g2|ts|mts|m2ts|vob|f4v|f4p|f4a|f4b|mp3|wav|aac|flac|wma|m4a|asf|rm|rmvb|vcd|svcd|dvd|yuv|y4m)$/i;

// ✅ Функция проверки доступа только с localhost
function isLocalhostOnly(req, res, next) {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }
  next();
}

// ✅ Функция логирования для клиентских обращений
function logClientRequest(clientIP, socketId, action, details = '') {
  const cleanIP = clientIP.replace(/^::ffff:/, '');
  const id = socketId || 'N/A';
  console.log(`[CLIENT] IP: ${cleanIP} | SocketID: ${id} | Action: ${action} | Details: ${details}`);
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

// ✅ Получить информацию о видео (обновлённая логика)
function getVideoInfo(file) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(VIDEO_FOLDER, file);
    // Проверяем, существует ли файл перед вызовом ffprobe
    if (!fs.existsSync(filePath)) {
      console.warn(`[FFPROBE] Файл не существует: ${filePath}`);
      resolve({ resolution: 'N/A', bitrate: 'N/A' });
      return;
    }

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        // Логируем ошибку ffprobe
        console.warn(`[FFPROBE] Ошибка для ${file}:`, err.message);
        // Всё равно возвращаем N/A, чтобы не ломать цепочку
        resolve({ resolution: 'N/A', bitrate: 'N/A' });
        return;
      }

      try {
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (videoStream) {
          resolve({
            resolution: `${videoStream.width || 'N/A'}x${videoStream.height || 'N/A'}`,
            bitrate: videoStream.bit_rate || 'N/A'
          });
        } else {
          console.warn(`[FFPROBE] Нет видеопотока в ${file}`);
          resolve({ resolution: 'N/A', bitrate: 'N/A' });
        }
      } catch (parseErr) {
        console.error(`[FFPROBE] Ошибка парсинга метаданных для ${file}:`, parseErr);
        resolve({ resolution: 'N/A', bitrate: 'N/A' });
      }
    });
  });
}


// API: получить список видео (обновлённая логика с Promise.all)
// УБРАНО isLocalhostOnly для /api/videos, чтобы player.html работал
app.get('/api/videos', async (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/videos', 'Fetching video list');

  try {
    const files = getVideoFiles();
    if (files.length === 0) {
      console.log(`[API] В папке ${VIDEO_FOLDER} нет видеофайлов.`);
      return res.json([]);
    }

    console.log(`[API] Найдено ${files.length} видеофайлов. Получаем метаданные...`);

    // Создаём массив промисов для каждого файла
    const promises = files.map(async (file) => {
      const info = await getVideoInfo(file);
      const ext = file.split('.').pop().toLowerCase();
      const supportedFormats = ['mp4', 'webm', 'ogg'];
      const isSupported = supportedFormats.includes(ext);
      return { name: file, ...info, isSupported };
    });

    // Ждём выполнения всех промисов
    const videos = await Promise.all(promises);

    console.log(`[API] Метаданные получены для ${videos.length} файлов.`);
    res.json(videos);
  } catch (error) {
    console.error('[API] Ошибка при получении списка видео:', error);
    // Возвращаем пустой массив в случае критической ошибки
    res.status(500).json([]);
  }
});


// API: проверить качество
app.get('/api/check-quality/:file/:quality', isLocalhostOnly, (req, res) => {
  const { file, quality } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/check-quality', `File: ${file}, Quality: ${quality}`);

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
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /upload', `File: ${req.file ? req.file.filename : 'N/A'}`);

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
app.post('/api/delete-video', isLocalhostOnly, (req, res) => {
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/delete-video', `Filename: ${filename}`);

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
app.post('/api/rename-video', isLocalhostOnly, (req, res) => {
  const { oldName, newName } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rename-video', `Old: ${oldName}, New: ${newName}`);

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
app.get('/admin', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /admin', '');

  const cleanIP = clientIP.replace(/^::ffff:/, '');
  if (cleanIP === '127.0.0.1' || cleanIP === '::1') {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(403).send('Доступ запрещён. Админ-панель доступна только с localhost.');
  }
});

// ✅ API: получить текущие настройки
app.get('/api/config', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/config', '');

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
app.post('/api/set-video-folder', isLocalhostOnly, (req, res) => {
  const { folder } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/set-video-folder', `Folder: ${folder}`);

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
app.post('/api/set-port', isLocalhostOnly, (req, res) => {
  const { port } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/set-port', `Port: ${port}`);

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
      const data = fs.readFileSync(TRANSCODE_TEMPLATES_FILE, 'utf8');
      console.log(`[TRANSCODE] Загружены шаблоны из: ${TRANSCODE_TEMPLATES_FILE}`);
      return JSON.parse(data);
    }
    console.log(`[TRANSCODE] Файл шаблонов не найден: ${TRANSCODE_TEMPLATES_FILE}`);
    return [];
  } catch (err) {
    console.error('[TRANSCODE] Ошибка загрузки шаблонов:', err);
    return [];
  }
}

// Сохранение шаблонов
function saveTranscodeTemplates(templates) {
  try {
    fs.writeFileSync(TRANSCODE_TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    console.log(`[TRANSCODE] Сохранены шаблоны в: ${TRANSCODE_TEMPLATES_FILE}`);
    return true;
  } catch (err) {
    console.error('[TRANSCODE] Ошибка сохранения шаблонов:', err);
    return false;
  }
}

// Загрузка очереди
function loadTranscodeQueue() {
  try {
    if (fs.existsSync(TRANSCODE_QUEUE_FILE)) {
      const data = fs.readFileSync(TRANSCODE_QUEUE_FILE, 'utf8');
      console.log(`[TRANSCODE] Загружена очередь из: ${TRANSCODE_QUEUE_FILE}`);
      return JSON.parse(data);
    }
    console.log(`[TRANSCODE] Файл очереди не найден: ${TRANSCODE_QUEUE_FILE}`);
    return [];
  } catch (err) {
    console.error('[TRANSCODE] Ошибка загрузки очереди:', err);
    return [];
  }
}

// Сохранение очереди
function saveTranscodeQueue(queue) {
  try {
    fs.writeFileSync(TRANSCODE_QUEUE_FILE, JSON.stringify(queue, null, 2));
    console.log(`[TRANSCODE] Сохранена очередь в: ${TRANSCODE_QUEUE_FILE}`);
    return true;
  } catch (err) {
    console.error('[TRANSCODE] Ошибка сохранения очереди:', err);
    return false;
  }
}

// API: получить шаблоны
app.get('/api/transcode/templates', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/transcode/templates', '');

  const templates = loadTranscodeTemplates();
  console.log(`[TRANSCODE] Отправлено ${templates.length} шаблонов`);
  res.json({ success: true, templates });
});

// API: сохранить шаблон
app.post('/api/transcode/save-template', isLocalhostOnly, (req, res) => {
  const { name, description, command } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/save-template', `Name: ${name}`);

  if (!name || !command) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const templates = loadTranscodeTemplates();
  const id = 'tmpl_' + Math.random().toString(36).substr(2, 8);

  const newTemplate = {
    id,
    name,
    description: description || '',
    command,
    createdAt: new Date().toISOString()
  };

  templates.push(newTemplate);

  if (saveTranscodeTemplates(templates)) {
    console.log(`[TRANSCODE] Сохранён шаблон: ${name} (${id})`);
    res.json({ success: true, id, template: newTemplate });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save template' });
  }
});

// API: удалить шаблон
app.post('/api/transcode/delete-template', isLocalhostOnly, (req, res) => {
  const { id } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/delete-template', `ID: ${id}`);

  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing template ID' });
  }

  let templates = loadTranscodeTemplates();
  const templateToDelete = templates.find(t => t.id === id);
  if (!templateToDelete) {
    return res.status(400).json({ success: false, error: 'Template not found' });
  }

  templates = templates.filter(t => t.id !== id);

  if (saveTranscodeTemplates(templates)) {
    console.log(`[TRANSCODE] Удалён шаблон: ${templateToDelete.name} (${id})`);
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

// API: получить очередь
app.get('/api/transcode/queue', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/transcode/queue', '');

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

  console.log(`[TRANSCODE] Отправлена очередь: ${queueWithNames.length} элементов`);
  res.json({ success: true, queue: queueWithNames });
});

// API: добавить в очередь
app.post('/api/transcode/add-to-queue', isLocalhostOnly, (req, res) => {
  const { fileId, templateId } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/add-to-queue', `File: ${fileId}, TemplateID: ${templateId}`);

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

  const newItem = {
    id,
    fileId,
    templateId,
    status: 'pending',
    progress: 0,
    isCancelled: false, // <-- Добавлен флаг отмены
    createdAt: new Date().toISOString()
  };

  queue.push(newItem);

  if (saveTranscodeQueue(queue)) {
    console.log(`[TRANSCODE] Добавлен в очередь: ${fileId} с шаблоном ${template.name} (${id})`);
    res.json({ success: true, id, item: newItem });

    // Запускаем обработку очереди
    processTranscodeQueue();
  } else {
    res.status(500).json({ success: false, error: 'Failed to add to queue' });
  }
});

// === API: отменить задание в очереди (обновлённая версия с удалением) ===
app.post('/api/transcode/cancel-job', isLocalhostOnly, (req, res) => {
  const { jobId } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/cancel-job', `JobID: ${jobId}`);

  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Missing job ID' });
  }

  let queue = loadTranscodeQueue();
  const jobIndex = queue.findIndex(item => item.id === jobId);

  if (jobIndex === -1) {
    // Проверяем, возможно, задание уже было удалено
    return res.status(400).json({ success: false, error: 'Job not found (may have been removed)' });
  }

  const job = queue[jobIndex];

  // Проверяем, можно ли отменить задание
  // pending - можно отменить и удалить
  // processing - можно отменить (processTranscodeQueue проверит isCancelled и убьёт ffmpeg, затем удалит)
  // completed/error/cancelled - нельзя отменить
  if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
    return res.status(400).json({ success: false, error: 'Job cannot be cancelled (already finished)' });
  }

  // Отмечаем задание как отменённое
  job.isCancelled = true; // <-- Устанавливаем флаг отмены

  // Если задание ещё не началось, сразу удаляем его
  if (job.status === 'pending') {
    queue.splice(jobIndex, 1); // Удаляем элемент из массива
    if (saveTranscodeQueue(queue)) {
      console.log(`[TRANSCODE] Задание отменено и удалено из очереди: ${jobId} (${job.fileId})`);
      res.json({ success: true, message: 'Job cancelled and removed' });
      // Перезапускаем очередь, на случай, если отменили текущее задание
      processTranscodeQueue();
    } else {
      res.status(500).json({ success: false, error: 'Failed to update queue' });
    }
    return;
  }

  // Если статус 'processing', статус изменится на 'cancelled' в processTranscodeQueue,
  // и задание будет удалено там же после остановки ffmpeg
  // Обновим очередь, чтобы флаг isCancelled был сохранён
  if (saveTranscodeQueue(queue)) {
    console.log(`[TRANSCODE] Задание отмечено для отмены: ${jobId} (${job.fileId})`);
    res.json({ success: true, message: 'Job marked for cancellation' });
    // processTranscodeQueue() будет проверять isCancelled и удалит его позже
  } else {
    res.status(500).json({ success: false, error: 'Failed to update queue' });
  }
});

// === БЫСТРОЕ ТРАНСКОДИРОВАНИЕ (обновлённая версия с NVENC и AAC) ===
app.post('/api/transcode/quick-transcode', isLocalhostOnly, (req, res) => {
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/quick-transcode', `Filename: ${filename}`);

  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверное имя файла' });
  }

  const inputFile = path.join(VIDEO_FOLDER, filename);
  const ext = path.extname(filename).toLowerCase();
  const name = path.basename(filename, ext);
  const outputFile = path.join(VIDEO_FOLDER, `${name}.mp4`); // Всегда .mp4

  // ✅ Проверяем, существует ли исходный файл
  if (!fs.existsSync(inputFile)) {
    return res.status(400).json({ success: false, error: 'Исходный файл не существует' });
  }

  // ✅ Проверяем, существует ли выходной файл
  if (fs.existsSync(outputFile)) {
    return res.status(400).json({ success: false, error: 'Выходной файл уже существует' });
  }

  console.log(`[TRANSCODE] Начало быстрого транскодирования (NVENC+AAC): ${filename} → ${name}.mp4`);

  // --- ИСПОЛЬЗУЕМ NVENC И AAC ---
  const command = ffmpeg(inputFile)
    .output(outputFile)
    .videoCodec('h264_nvenc') // <-- Используем NVENC
    .audioCodec('aac')        // <-- Перекодируем аудио в AAC
    .outputOption('-preset', 'llhq') // <-- Устанавливаем пресет для NVENC
    // .outputOption('-b:a', '128k') // <-- Опционально: битрейт аудио
    .on('start', (cmd) => {
      console.log(`[TRANSCODE] Запущена команда: ${cmd}`);
    })
    .on('progress', (progress) => {
      if (progress.percent) {
        console.log(`[TRANSCODE] Прогресс: ${filename} - ${Math.round(progress.percent)}%`);
      }
    })
    .on('end', () => {
      console.log(`[TRANSCODE] Завершено быстрое транскодирование: ${filename} → ${name}.mp4`);
      res.json({ success: true, output: `${name}.mp4` });
    })
    .on('error', (err) => {
      console.error(`[TRANSCODE] Ошибка быстрого транскодирования: ${filename}`, err);

      // --- FALLBACK: если NVENC не работает ---
      console.log(`[TRANSCODE] Fallback: стандартное кодирование CPU для ${filename}`);
      const fallbackCommand = ffmpeg(inputFile)
        .output(outputFile)
        .videoCodec('libx264') // <-- CPU кодирование
        .audioCodec('aac')     // <-- Всё ещё AAC
        .on('start', (cmd) => {
          console.log(`[TRANSCODE] Запущена fallback команда: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`[TRANSCODE] Fallback прогресс: ${filename} - ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`[TRANSCODE] Завершено fallback транскодирование: ${filename} → ${name}.mp4`);
          res.json({ success: true, output: `${name}.mp4` });
        })
        .on('error', (fallbackErr) => {
          console.error(`[TRANSCODE] Ошибка fallback транскодирования: ${filename}`, fallbackErr);
          res.status(500).json({ success: false, error: fallbackErr.message });
        });

      fallbackCommand.run();
    });

  command.run();
});

// === TRANSCODE PROCESSOR (обновлённая версия с поддержкой отмены и удаления) ===
async function processTranscodeQueue() {
  const queue = loadTranscodeQueue();
  // Находим первый *не отменённый* ожидающий элемент
  const pendingItem = queue.find(item => item.status === 'pending' && !item.isCancelled); // <-- Добавлена проверка isCancelled
  if (!pendingItem) {
    console.log('[TRANSCODE] Очередь пуста или все задания отменены/обработаны, ожидание...');
    return;
  }

  console.log(`[TRANSCODE] Обработка задания: ${pendingItem.id} (${pendingItem.fileId})`); // Лог для отладки

  // Проверяем, не отменено ли задание в процессе выполнения (например, если оно было отменено сразу после запуска)
  // Загружаем очередь снова, на случай, если другой процесс её изменил
  const freshQueue = loadTranscodeQueue();
  const freshItem = freshQueue.find(item => item.id === pendingItem.id);
  if (freshItem && freshItem.isCancelled) {
    console.log(`[TRANSCODE] Задание ${pendingItem.id} было отменено до начала обработки.`);
    // Обновляем статус в оригинальной очереди и сохраняем
    const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
    if (itemInOriginalQueue) {
      itemInOriginalQueue.status = 'cancelled'; // <-- Новый статус
      itemInOriginalQueue.completedAt = new Date().toISOString();
      saveTranscodeQueue(queue);
    }
    // Запускаем следующий
    setTimeout(() => {
      processTranscodeQueue();
    }, 1000);
    return;
  }

  // Обновляем статус на 'processing'
  pendingItem.status = 'processing';
  pendingItem.startedAt = new Date().toISOString();
  saveTranscodeQueue(queue);

  const templates = loadTranscodeTemplates();
  try {
    const template = templates.find(t => t.id === pendingItem.templateId);
    if (!template) throw new Error('Template not found');

    const inputFile = path.join(VIDEO_FOLDER, pendingItem.fileId);
    const outputFile = path.join(VIDEO_FOLDER,
      pendingItem.fileId.replace(/\.[^/.]+$/, "") + "_" +
      template.name.toLowerCase().replace(/\s+/g, '_') + ".mp4");

    console.log(`[TRANSCODE] Начало конвертации: ${pendingItem.fileId} → ${outputFile}`);

    // --- КРИТИЧЕСКИЙ УЧАСТОК: Запуск ffmpeg ---
    // Необходимо отслеживать, отменено ли задание *во время* выполнения ffmpeg
    // fluent-ffmpeg позволяет остановить процесс через .kill()
    let ffmpegProcess = null;

    // Функция для проверки отмены (может быть вызвана периодически)
    const checkCancellation = () => {
      const queueDuringProcess = loadTranscodeQueue();
      const itemDuringProcess = queueDuringProcess.find(item => item.id === pendingItem.id);
      if (itemDuringProcess && itemDuringProcess.isCancelled) {
        console.log(`[TRANSCODE] Задание ${pendingItem.id} отменено во время обработки, останавливаем ffmpeg...`);
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGKILL'); // Принудительно останавливаем ffmpeg
        }
        // Обновляем статус в очереди
        const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
        if (itemInOriginalQueue) {
          itemInOriginalQueue.status = 'cancelled';
          itemInOriginalQueue.progress = 0; // Или оставить последний прогресс?
          itemInOriginalQueue.completedAt = new Date().toISOString();
          saveTranscodeQueue(queue);
        }
        // Запускаем следующий
        setTimeout(() => {
          processTranscodeQueue();
        }, 1000);
        return true; // Отменено
      }
      return false; // Не отменено
    };

    const command = ffmpeg(inputFile)
      .output(outputFile)
      .on('start', (cmd) => {
        console.log(`[TRANSCODE] FFmpeg запущен для ${pendingItem.fileId}: ${cmd}`);
        // Сохраняем ссылку на процесс ffmpeg (нужно немного хакнуть fluent-ffmpeg)
        // fluent-ffmpeg использует внутренний процесс spawn, можно попытаться получить его
        // Это зависит от версии fluent-ffmpeg. В новой версии можно получить через .on('codecData', ...) и доступ к процессу
        // Но проще передать ffmpegProcess в on('start')
        // fluent-ffmpeg не предоставляет прямого доступа к child_process напрямую через .on('start')
        // Однако, мы можем использовать setInterval для периодической проверки
        const cancelCheckInterval = setInterval(() => {
          if (checkCancellation()) {
            clearInterval(cancelCheckInterval);
          }
        }, 2000); // Проверяем каждые 2 секунды

        command.on('end', () => {
          clearInterval(cancelCheckInterval); // Останавливаем проверку при завершении
          // Проверяем отмену ещё раз перед обновлением статуса
          if (checkCancellation()) return; // Если было отменено во время завершения, выходим

          // Завершено успешно
          const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
          if (itemInOriginalQueue) {
            itemInOriginalQueue.status = 'completed';
            itemInOriginalQueue.completedAt = new Date().toISOString();
            saveTranscodeQueue(queue);
            console.log(`[TRANSCODE] Завершена конвертация: ${pendingItem.fileId}`);
          }
          // Запускаем следующий
          setTimeout(() => {
            processTranscodeQueue();
          }, 1000);
        });

        command.on('error', (err) => {
          clearInterval(cancelCheckInterval); // Останавливаем проверку при ошибке
          // Проверяем отмену ещё раз перед обновлением статуса ошибки
          if (checkCancellation()) return; // Если было отменено во время ошибки, выходим

          // Ошибка выполнения ffmpeg
          const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
          if (itemInOriginalQueue) {
            itemInOriginalQueue.status = 'error';
            itemInOriginalQueue.error = err.message;
            itemInOriginalQueue.completedAt = new Date().toISOString();
            saveTranscodeQueue(queue);
            console.error(`[TRANSCODE] Ошибка конвертации: ${pendingItem.fileId}`, err);
          }
          // Запускаем следующий
          setTimeout(() => {
            processTranscodeQueue();
          }, 1000);
        });
      })
      .on('progress', (progress) => {
        // Обновляем прогресс
        const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
        if (itemInOriginalQueue && !itemInOriginalQueue.isCancelled) { // Обновляем только если не отменено
          if (progress.percent) {
            itemInOriginalQueue.progress = progress.percent;
            saveTranscodeQueue(queue);
            console.log(`[TRANSCODE] Прогресс: ${pendingItem.fileId} - ${Math.round(progress.percent)}%`);
          }
        }
      });

    command.run();
    // Сохраняем ссылку на command для возможного .kill() (не всегда работает напрямую)
    // ffmpegProcess = command; // Это не даст доступ к внутреннему child_process в большинстве версий

  } catch (err) {
    // Обработка ошибки на уровне try/catch
    const itemInOriginalQueue = queue.find(item => item.id === pendingItem.id);
    if (itemInOriginalQueue) {
      itemInOriginalQueue.status = 'error';
      itemInOriginalQueue.error = err.message;
      itemInOriginalQueue.completedAt = new Date().toISOString();
      saveTranscodeQueue(queue);
    }
    console.error(`[TRANSCODE] Ошибка обработки очереди (внешняя):`, err);
    // Запускаем следующий
    setTimeout(() => {
      processTranscodeQueue();
    }, 1000);
  }
}

// === TRANSCODE PAGE ===
app.get('/transcode', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /transcode', '');

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
  console.log(`[TRANSCODE] Создан файл шаблонов: ${TRANSCODE_TEMPLATES_FILE}`);
}

if (!fs.existsSync(TRANSCODE_QUEUE_FILE)) {
  saveTranscodeQueue([]);
  console.log(`[TRANSCODE] Создан файл очереди: ${TRANSCODE_QUEUE_FILE}`);
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С ФАЙЛОВОЙ СИСТЕМОЙ ===

// ✅ Функция для получения относительного пути от VIDEO_FOLDER
function getRelativePath(fullPath) {
  return path.relative(VIDEO_FOLDER, fullPath).split(path.sep).join('/'); // Всегда используем '/' для путей API
}

// ✅ Функция для получения абсолютного пути
function getAbsolutePath(relativePath) {
  // Предотвращаем Directory Traversal
  const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(VIDEO_FOLDER, normalizedPath);
}

// ✅ Функция для рекурсивного создания директории
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ✅ Функция для получения структуры папок и файлов (рекурсивно)
function getDirectoryStructure(dir, basePath = '') {
  const result = [];
  try {
    const items = fs.readdirSync(dir);
    items.forEach(item => {
      // ✅ Игнорируем файлы-пустышки
      if (item === '.empty') return;

      const fullPath = path.join(dir, item);
      const relativePath = path.join(basePath, item).split(path.sep).join('/'); // Всегда используем '/' для путей API
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        result.push({
          name: item,
          type: 'folder',
          path: relativePath,
          children: getDirectoryStructure(fullPath, relativePath) // Рекурсивный вызов
        });
      } else if (VIDEO_EXTENSIONS.test(item)) {
        result.push({
          name: item,
          type: 'file',
          path: relativePath
        });
      }
    });
  } catch (err) {
    console.error(`Ошибка чтения директории ${dir}:`, err);
  }
  return result;
}

// === НОВЫЕ API ДЛЯ РАБОТЫ С ПАПКАМИ ===

// API: получить структуру папок и файлов
app.get('/api/files/list', isLocalhostOnly, (req, res) => { // Можно убрать isLocalhostOnly, если нужно доступ из сети
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/files/list', '');
  try {
    const structure = getDirectoryStructure(VIDEO_FOLDER);
    res.json({ success: true, structure });
  } catch (err) {
    console.error('[FILES] Ошибка получения структуры:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: создать папку
app.post('/api/files/create-folder', isLocalhostOnly, (req, res) => {
  const { folderPath } = req.body; // folderPath - относительный путь от VIDEO_FOLDER
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/files/create-folder', `Path: ${folderPath}`);

  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверный путь папки' });
  }

  const fullPath = getAbsolutePath(folderPath);
  const parentDir = path.dirname(fullPath);

  // Проверяем, что родительская директория существует
  if (!fs.existsSync(parentDir)) {
    return res.status(400).json({ success: false, error: 'Родительская папка не существует' });
  }

  try {
    ensureDir(fullPath);
    console.log(`[FILES] Папка создана: ${fullPath}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[FILES] Ошибка создания папки:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: удалить папку (и всё её содержимое)
app.post('/api/files/delete-folder', isLocalhostOnly, (req, res) => {
  const { folderPath } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/files/delete-folder', `Path: ${folderPath}`);

  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверный путь папки' });
  }

  const fullPath = getAbsolutePath(folderPath);

  // Проверяем, что путь находится внутри VIDEO_FOLDER
  if (!fullPath.startsWith(VIDEO_FOLDER)) {
    return res.status(400).json({ success: false, error: 'Нельзя удалить папку вне базовой директории' });
  }

  // Проверяем, что это действительно папка
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return res.status(400).json({ success: false, error: 'Путь не является папкой' });
  }

  try {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`[FILES] Папка удалена: ${fullPath}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[FILES] Ошибка удаления папки:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === МОДИФИЦИРОВАННЫЙ UPLOAD API ДЛЯ ПОДДЕРЖКИ ПАПОК ===

// Настройка multer для загрузки с сохранением оригинальной структуры папок
const folderAwareStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Получаем относительный путь папки из заголовка или параметра запроса
    let relativeFolderPath = req.headers['x-folder-path'] || req.body.folderPath || '';
    // Нормализуем путь, чтобы предотвратить Directory Traversal
    relativeFolderPath = path.normalize(relativeFolderPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absoluteFolderPath = path.join(VIDEO_FOLDER, relativeFolderPath);
    // Создаем папку, если её нет
    ensureDir(absoluteFolderPath);
    cb(null, absoluteFolderPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const folderAwareUpload = multer({ storage: folderAwareStorage });

// API: загрузка видео с поддержкой папок
app.post('/api/upload/to-folder', folderAwareUpload.single('video'), (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const folderPath = req.headers['x-folder-path'] || req.body.folderPath || '';
  logClientRequest(clientIP, 'N/A', 'POST /api/upload/to-folder', `File: ${req.file ? req.file.filename : 'N/A'}, Folder: ${folderPath}`);

  if (req.file) {
    const relativeFilePath = path.join(folderPath, req.file.filename).split(path.sep).join('/'); // Всегда используем '/' для путей API
    res.json({ success: true, file: req.file.filename, path: relativeFilePath });
    // Оповещение комнат не требуется, так как это File Manager
  } else {
    res.status(400).json({ success: false, error: 'Файл не загружен' });
  }
});

// === НОВОЕ: API ДЛЯ ПЕРЕМЕЩЕНИЯ ФАЙЛОВ И ПАПОК ===

// API: переместить файл или папку
app.post('/api/files/move', isLocalhostOnly, (req, res) => {
  const { sourcePath, destPath } = req.body; // sourcePath и destPath - относительные пути
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/files/move', `Source: ${sourcePath}, Dest: ${destPath}`);

  if (!sourcePath || !destPath || typeof sourcePath !== 'string' || typeof destPath !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверные пути' });
  }

  // Получаем абсолютные пути
  const fullSourcePath = getAbsolutePath(sourcePath);
  const fullDestPath = getAbsolutePath(destPath);

  // Проверяем, что исходный путь существует
  if (!fs.existsSync(fullSourcePath)) {
    return res.status(400).json({ success: false, error: 'Исходный файл/папка не существует' });
  }

  // Проверяем, что целевой путь существует и является папкой
  if (!fs.existsSync(fullDestPath) || !fs.statSync(fullDestPath).isDirectory()) {
    return res.status(400).json({ success: false, error: 'Целевая папка не существует или не является папкой' });
  }

  // Формируем путь к новому месту
  const sourceName = path.basename(sourcePath);
  const newFullPath = path.join(fullDestPath, sourceName);

  // Проверяем, что новый путь не существует
  if (fs.existsSync(newFullPath)) {
    return res.status(400).json({ success: false, error: 'Файл/папка с таким именем уже существует в целевой папке' });
  }

  // Проверяем, что не пытаемся переместить папку внутрь себя
  const realSource = fs.realpathSync(fullSourcePath);
  const realDest = fs.realpathSync(fullDestPath);
  if (realDest.startsWith(realSource + path.sep)) {
    return res.status(400).json({ success: false, error: 'Нельзя переместить папку внутрь себя' });
  }

  try {
    // Перемещаем файл или папку
    fs.renameSync(fullSourcePath, newFullPath);
    console.log(`[FILES] Перемещено: ${sourcePath} → ${path.join(destPath, sourceName)}`);
    res.json({ success: true });
    // Оповещение комнат не требуется, так как это File Manager
  } catch (err) {
    console.error('[FILES] Ошибка перемещения:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === НОВОЕ: API ДЛЯ РАБОТЫ С КОМНАТАМИ ===

// API: получить список комнат
app.get('/api/rooms', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/rooms', '');
  try {
    const list = getRoomList();
    res.json({ success: true, rooms: list });
  } catch (err) {
    console.error('[ROOMS] Ошибка получения списка комнат:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: создать комнату
app.post('/api/rooms', isLocalhostOnly, (req, res) => {
  const { name } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms', `Name: ${name}`);
  try {
    const id = 'room_' + Math.random().toString(36).substr(2, 8);
    rooms[id] = {
      name: name || id,
      users: {},
      currentVideo: null,
      // ✅ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
      state: {
        currentVideo: null,
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1.0,
        volume: 1.0,
        muted: false,
        quality: 'original',
        subtitles: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      chat: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    roomsData.setRooms(rooms);
    res.json({ success: true, id, name: rooms[id].name });
    io.emit('room-list', getRoomList());
  } catch (err) {
    console.error('[ROOMS] Ошибка создания комнаты:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: удалить комнату
app.delete('/api/rooms/:id', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'DELETE /api/rooms/:id', `ID: ${id}`);
  try {
    if (rooms[id]) {
      delete rooms[id];
      roomsData.setRooms(rooms);
      io.emit('room-list', getRoomList());
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Room not found' });
    }
  } catch (err) {
    console.error('[ROOMS] Ошибка удаления комнаты:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: получить информацию о комнате
app.get('/api/rooms/:id', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/rooms/:id', `ID: ${id}`);
  try {
    if (rooms[id]) {
      res.json({ success: true, room: rooms[id] });
    } else {
      res.status(404).json({ success: false, error: 'Room not found' });
    }
  } catch (err) {
    console.error('[ROOMS] Ошибка получения информации о комнате:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: присоединиться к комнате
app.post('/api/rooms/:id/join', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/join', `ID: ${id}, Name: ${name}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    // В реальном API может потребоваться токен или другая аутентификация
    // Для простоты, просто возвращаем ID комнаты
    res.json({ success: true, room: { id, name: rooms[id].name } });
  } catch (err) {
    console.error('[ROOMS] Ошибка присоединения к комнате:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: выйти из комнаты
app.post('/api/rooms/:id/leave', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/leave', `ID: ${id}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    // В реальном API может потребоваться токен или другая аутентификация
    // Для простоты, просто возвращаем успех
    res.json({ success: true });
  } catch (err) {
    console.error('[ROOMS] Ошибка выхода из комнаты:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: выбрать видео в комнате
app.post('/api/rooms/:id/select-video', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/select-video', `ID: ${id}, Filename: ${filename}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    // УБРАНО: rooms[id].state.currentTime = 0;
    rooms[id].currentVideo = filename;
    rooms[id].state.currentVideo = filename;
    // УБРАНО: rooms[id].state.currentTime = 0; // <-- УДАЛЕНО
    rooms[id].state.isPlaying = false; // <-- ОСТАВЛЕНО: чтобы остановить воспроизведение
    rooms[id].state.updatedAt = new Date().toISOString();
    roomsData.setRooms(rooms);
    io.to(id).emit('video-updated', filename);
    io.to(id).emit('room-state', rooms[id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ROOMS] Ошибка выбора видео:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: отправить команду видео в комнату
app.post('/api/rooms/:id/video-command', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const { type, time, volume, muted, rate } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/video-command', `ID: ${id}, Type: ${type}, Time: ${time}, Volume: ${volume}, Muted: ${muted}, Rate: ${rate}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    // Отправляем команду всем в комнате
    io.to(id).emit('video-command', { type, time, volume, muted, rate });
    // Обновляем глобальное состояние комнаты
    if (type === 'play') {
      rooms[id].state.isPlaying = true;
      rooms[id].state.updatedAt = new Date().toISOString();
    } else if (type === 'pause') {
      rooms[id].state.isPlaying = false;
      rooms[id].state.updatedAt = new Date().toISOString();
    } else if (type === 'seek' && typeof time === 'number') {
      rooms[id].state.currentTime = time;
      rooms[id].state.updatedAt = new Date().toISOString();
    } else if (type === 'volume' && typeof volume === 'number') {
      rooms[id].state.volume = volume;
      rooms[id].state.updatedAt = new Date().toISOString();
    } else if (type === 'mute') {
      rooms[id].state.muted = muted;
      rooms[id].state.updatedAt = new Date().toISOString();
    } else if (type === 'rate' && typeof rate === 'number') {
      rooms[id].state.playbackRate = rate;
      rooms[id].state.updatedAt = new Date().toISOString();
    }
    roomsData.setRooms(rooms);
    io.to(id).emit('room-state', rooms[id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ROOMS] Ошибка отправки команды видео:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: получить состояние комнаты
app.get('/api/rooms/:id/state', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/rooms/:id/state', `ID: ${id}`);
  try {
    if (rooms[id]) {
      res.json({ success: true, state: rooms[id].state });
    } else {
      res.status(404).json({ success: false, error: 'Room not found' });
    }
  } catch (err) {
    console.error('[ROOMS] Ошибка получения состояния комнаты:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: обновить состояние комнаты
app.post('/api/rooms/:id/update-state', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const stateUpdates = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/update-state', `ID: ${id}, Updates: ${JSON.stringify(stateUpdates)}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    rooms[id].state = {
      ...rooms[id].state,
      ...stateUpdates,
      updatedAt: new Date().toISOString()
    };
    rooms[id].updatedAt = new Date().toISOString();
    roomsData.setRooms(rooms);
    io.to(id).emit('room-state', rooms[id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ROOMS] Ошибка обновления состояния комнаты:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: получить список пользователей в комнате
app.get('/api/rooms/:id/users', isLocalhostOnly, (req, res) => {
  const { id } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/rooms/:id/users', `ID: ${id}`);
  try {
    if (rooms[id]) {
      res.json({ success: true, users: rooms[id].users });
    } else {
      res.status(404).json({ success: false, error: 'Room not found' });
    }
  } catch (err) {
    console.error('[ROOMS] Ошибка получения списка пользователей:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: обновить состояние пользователя
app.post('/api/rooms/:id/users/:userId/update-state', isLocalhostOnly, (req, res) => {
  const { id, userId } = req.params;
  const stateUpdates = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/users/:userId/update-state', `ID: ${id}, UserID: ${userId}, Updates: ${JSON.stringify(stateUpdates)}`);
  try {
    if (!rooms[id]) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    if (!rooms[id].users[userId]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    rooms[id].users[userId].userState = {
      ...rooms[id].users[userId].userState,
      ...stateUpdates,
      lastUpdated: new Date().toISOString()
    };
    roomsData.setRooms(rooms);
    io.to(id).emit('room-state', rooms[id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[ROOMS] Ошибка обновления состояния пользователя:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: выгнать пользователя из комнаты
app.post('/api/rooms/:id/users/:userId/kick', isLocalhostOnly, (req, res) => {
  const { id, userId } = req.params;
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'POST /api/rooms/:id/users/:userId/kick', `ID: ${id}, KickedUserID: ${userId}`);
  try {
    if (rooms[id] && rooms[id].users[userId]) {
      // Отправляем пользователю команду на выход
      io.to(userId).emit('kicked-from-room', { message: 'You have been kicked from the room' });
      // Удаляем пользователя из комнаты
      delete rooms[id].users[userId];
      roomsData.setRooms(rooms);
      // Обновляем состояние комнаты
      io.to(id).emit('room-state', rooms[id]);
      io.emit('room-list', getRoomList());
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    console.error('[ROOMS] Ошибка выгона пользователя:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === НОВОЕ: ФАЙЛ-ПУСТЫШКА ===
// Перенаправляет в корневую папку видео
app.get('/.empty', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /.empty', 'Redirecting to root video folder');
  res.redirect('/files'); // Перенаправляем на страницу управления файлами в корне
});

// ✅ ГЛАВНАЯ СТРАНИЦА - РЕДИРЕКТ НА SELECT-ROOM
app.get('/', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /', '');
  res.redirect('/select-room.html');
});

// ✅ Страница выбора комнаты
app.get('/select-room.html', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /select-room.html', '');
  res.sendFile(path.join(__dirname, 'public', 'select-room.html'));
});

// ✅ Страница плеера
app.get('/player.html', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /player.html', '');
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ✅ Страница управления файлами - БЕЗ РЕДИРЕКТА
app.get('/files', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /files', '');
  res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

// Сокеты
io.on('connection', (socket) => {
  const clientIP = socket.request.connection.remoteAddress;
  console.log(`[SOCKET] User connected: ${socket.id} from IP: ${clientIP}`);
  let joinedRoom = null;
  let userName = `User${Math.floor(Math.random()*10000)}`;

  // --- ROOM EVENTS ---
  socket.on('create-room', ({ name }, cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET create-room', `Name: ${name}`);
    const id = 'room_' + Math.random().toString(36).substr(2, 8);
    rooms[id] = {
      name: name || id,
      users: {},
      currentVideo: null,
      // ✅ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
      state: {
        currentVideo: null,
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1.0,
        volume: 1.0,
        muted: false,
        quality: 'original',
        subtitles: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      chat: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    roomsData.setRooms(rooms);
    cb && cb({ id, name: rooms[id].name });
    io.emit('room-list', getRoomList());
  });

  socket.on('get-rooms', (cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET get-rooms', '');
    cb && cb(getRoomList());
  });

  socket.on('join-room', ({ roomId, name }, cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET join-room', `RoomID: ${roomId}, Name: ${name}`);
    if (!rooms[roomId]) {
      cb && cb({ error: 'Room not found' });
      return;
    }
    if (joinedRoom) socket.leave(joinedRoom);
    joinedRoom = roomId;
    userName = name || userName;
    rooms[roomId].users[socket.id] = {
      name: userName,
      ping: 0,
      buffer: 0,
      status: 'paused',
      position: 0,
      ready: false,
      // ✅ СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЯ
      userState: {
        isReady: false,
        isBuffering: false,
        currentPosition: 0,
        currentVolume: 1.0,
        isMuted: false,
        playbackRate: 1.0,
        lastUpdated: new Date().toISOString()
      }
    };
    roomsData.setRooms(rooms);
    socket.join(roomId);
    cb && cb({ success: true, room: { id: roomId, name: rooms[roomId].name } });
    // ✅ ОТПРАВЛЯЕМ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
    io.to(roomId).emit('room-state', rooms[roomId]);
    io.emit('room-list', getRoomList());
  });

  socket.on('leave-room', (cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET leave-room', `RoomID: ${joinedRoom}`);
    if (joinedRoom && rooms[joinedRoom]) {
      delete rooms[joinedRoom].users[socket.id];
      roomsData.setRooms(rooms);
      socket.leave(joinedRoom);
      // ✅ ОТПРАВЛЯЕМ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
      io.emit('room-list', getRoomList());
    }
    joinedRoom = null;
    cb && cb({ success: true });
  });

  // --- УДАЛЕНИЕ КОМНАТЫ ---
  socket.on('delete-room', ({ roomId }, cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET delete-room', `RoomID: ${roomId}`);
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
      logClientRequest(clientIP, socket.id, 'SOCKET ping', `RoomID: ${joinedRoom}`);
      const start = Date.now();
      socket.emit('pong', start);
    }
  });

  socket.on('pong-response', (start) => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      logClientRequest(clientIP, socket.id, 'SOCKET pong-response', `RoomID: ${joinedRoom}`);
      const latency = Date.now() - start;
      rooms[joinedRoom].users[socket.id].ping = latency;
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('buffer-update', (data) => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      logClientRequest(clientIP, socket.id, 'SOCKET buffer-update', `RoomID: ${joinedRoom}, Position: ${data.position}, Status: ${data.status}`);
      rooms[joinedRoom].users[socket.id].buffer = data.buffer;
      rooms[joinedRoom].users[socket.id].position = data.position;
      rooms[joinedRoom].users[socket.id].status = data.status;
      // ✅ ОБНОВЛЯЕМ СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЯ
      rooms[joinedRoom].users[socket.id].userState = {
        ...rooms[joinedRoom].users[socket.id].userState,
        currentPosition: data.position,
        isBuffering: data.status === 'buffering',
        isPlaying: data.status === 'playing',
        currentVolume: data.volume || 1.0,
        isMuted: data.muted || false,
        playbackRate: data.playbackRate || 1.0,
        lastUpdated: new Date().toISOString()
      };
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('video-command', (data) => {
    if (joinedRoom) {
      logClientRequest(clientIP, socket.id, 'SOCKET video-command', `RoomID: ${joinedRoom}, Type: ${data.type}, Time: ${data.time}, Volume: ${data.volume}, Muted: ${data.muted}, Rate: ${data.rate}`);
      socket.to(joinedRoom).emit('video-command', data);
      // ✅ ОБНОВЛЯЕМ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
      if (data.type === 'play') {
        rooms[joinedRoom].state.isPlaying = true;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      } else if (data.type === 'pause') {
        rooms[joinedRoom].state.isPlaying = false;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      } else if (data.type === 'seek' && typeof data.time === 'number') {
        rooms[joinedRoom].state.currentTime = data.time;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      } else if (data.type === 'volume' && typeof data.volume === 'number') {
        rooms[joinedRoom].state.volume = data.volume;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      } else if (data.type === 'mute') {
        rooms[joinedRoom].state.muted = data.muted;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      } else if (data.type === 'rate' && typeof data.rate === 'number') {
        rooms[joinedRoom].state.playbackRate = data.rate;
        rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      }
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('select-video', (filename) => {
    // УБРАНО: rooms[joinedRoom].state.currentTime = 0;
    if (joinedRoom && rooms[joinedRoom]) {
      logClientRequest(clientIP, socket.id, 'SOCKET select-video', `RoomID: ${joinedRoom}, Filename: ${filename}`);
      rooms[joinedRoom].currentVideo = filename;
      rooms[joinedRoom].state.currentVideo = filename;
      // УБРАНО: rooms[joinedRoom].state.currentTime = 0; // <-- УДАЛЕНО
      rooms[joinedRoom].state.isPlaying = false; // <-- ОСТАВЛЕНО: чтобы остановить воспроизведение
      rooms[joinedRoom].state.updatedAt = new Date().toISOString();
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('video-updated', filename);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  socket.on('set-name', (name) => {
    logClientRequest(clientIP, socket.id, 'SOCKET set-name', `Name: ${name}`);
    userName = name;
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      rooms[joinedRoom].users[socket.id].name = name;
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  // ✅ НОВОЕ: ОБНОВЛЕНИЕ ГЛОБАЛЬНОГО СОСТОЯНИЯ КОМНАТЫ
  socket.on('update-room-state', (stateUpdates) => {
    if (joinedRoom && rooms[joinedRoom]) {
      logClientRequest(clientIP, socket.id, 'SOCKET update-room-state', `RoomID: ${joinedRoom}, Updates: ${JSON.stringify(stateUpdates)}`);
      rooms[joinedRoom].state = {
        ...rooms[joinedRoom].state,
        ...stateUpdates,
        updatedAt: new Date().toISOString()
      };
      rooms[joinedRoom].updatedAt = new Date().toISOString();
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  // ✅ НОВОЕ: ОБНОВЛЕНИЕ СОСТОЯНИЯ ПОЛЬЗОВАТЕЛЯ
  socket.on('update-user-state', (stateUpdates) => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].users[socket.id]) {
      logClientRequest(clientIP, socket.id, 'SOCKET update-user-state', `RoomID: ${joinedRoom}, Updates: ${JSON.stringify(stateUpdates)}`);
      rooms[joinedRoom].users[socket.id].userState = {
        ...rooms[joinedRoom].users[socket.id].userState,
        ...stateUpdates,
        lastUpdated: new Date().toISOString()
      };
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
    }
  });

  // ✅ НОВОЕ: КИК ПОЛЬЗОВАТЕЛЯ
  socket.on('kick-user', ({ userId, roomId }, cb) => {
    logClientRequest(clientIP, socket.id, 'SOCKET kick-user', `RoomID: ${roomId}, KickedUserID: ${userId}`);
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
      logClientRequest(clientIP, socket.id, 'SOCKET disconnect', `RoomID: ${joinedRoom}`);
      delete rooms[joinedRoom].users[socket.id];
      roomsData.setRooms(rooms);
      // ✅ ИСПРАВЛЕНО: используем joinedRoom вместо roomId
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
      io.emit('room-list', getRoomList());
    }
    joinedRoom = null; // ✅ Сброс joinedRoom
    console.log(`[SOCKET] User disconnected: ${socket.id} from IP: ${clientIP}`);
  });
});

// ✅ Используем порт из config.js
const PORT = config.port;
server.listen(PORT, () => {
  console.log(`[SERVER] Запущен на http://localhost:${PORT}`);
  console.log(`[INFO] Админ-панель: http://localhost:${PORT}/admin (только с localhost)`);
  console.log(`[INFO] Папка с видео: ${VIDEO_FOLDER}`);
});