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
      // ✅ ИСПРАВЛЕНО: правильно определяем поддерживаемые форматы
      const ext = file.split('.').pop().toLowerCase();
      const supportedFormats = ['mp4', 'webm', 'ogg'];
      const isSupported = supportedFormats.includes(ext);
      
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
app.get('/api/transcode/templates', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const templates = loadTranscodeTemplates();
  console.log(`[TRANSCODE] Отправлено ${templates.length} шаблонов`);
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

  console.log(`[TRANSCODE] Отправлена очередь: ${queueWithNames.length} элементов`);
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
  
  const newItem = {
    id,
    fileId,
    templateId,
    status: 'pending',
    progress: 0,
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

// === БЫСТРОЕ ТРАНСКОДИРОВАНИЕ ===
app.post('/api/transcode/quick-transcode', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const cleanIP = clientIP.replace(/^::ffff:/, '');

  if (cleanIP !== '127.0.0.1' && cleanIP !== '::1') {
    return res.status(403).json({ success: false, error: 'Доступ запрещён' });
  }

  const { filename } = req.body;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ success: false, error: 'Неверное имя файла' });
  }

  const inputFile = path.join(VIDEO_FOLDER, filename);
  const ext = path.extname(filename).toLowerCase();
  const name = path.basename(filename, ext);
  const outputFile = path.join(VIDEO_FOLDER, `${name}.mp4`);

  // ✅ Проверяем, существует ли исходный файл
  if (!fs.existsSync(inputFile)) {
    return res.status(400).json({ success: false, error: 'Исходный файл не существует' });
  }

  // ✅ Проверяем, существует ли выходной файл
  if (fs.existsSync(outputFile)) {
    return res.status(400).json({ success: false, error: 'Выходной файл уже существует' });
  }

  console.log(`[TRANSCODE] Начало быстрого транскодирования: ${filename} → ${name}.mp4`);

  // ✅ Если файл уже .mp4 — делаем копию
  if (ext === '.mp4') {
    try {
      fs.copyFileSync(inputFile, outputFile);
      console.log(`[TRANSCODE] Создана копия: ${filename} → ${name}.mp4`);
      return res.json({ success: true, output: `${name}.mp4` });
    } catch (err) {
      console.error(`[TRANSCODE] Ошибка копирования: ${filename}`, err);
      return res.status(500).json({ success: false, error: 'Ошибка копирования файла' });
    }
  }

  // ✅ Для других форматов — используем ffmpeg -c copy
  const command = ffmpeg(inputFile)
    .output(outputFile)
    .videoCodec('copy')
    .audioCodec('copy')
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
      
      // ✅ FALLBACK: если -c copy не работает — используем обычное кодирование
      console.log(`[TRANSCODE] Fallback: обычное кодирование для ${filename}`);
      const fallbackCommand = ffmpeg(inputFile)
        .output(outputFile)
        .videoCodec('libx264')
        .audioCodec('aac')
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

// === TRANSCODE PROCESSOR ===
async function processTranscodeQueue() {
  const queue = loadTranscodeQueue();
  const templates = loadTranscodeTemplates();
  
  // Находим первый ожидающий элемент
  const pendingItem = queue.find(item => item.status === 'pending');
  if (!pendingItem) {
    console.log('[TRANSCODE] Очередь пуста, ожидание...');
    return;
  }

  // Обновляем статус
  pendingItem.status = 'processing';
  pendingItem.startedAt = new Date().toISOString();
  saveTranscodeQueue(queue);

  try {
    const template = templates.find(t => t.id === pendingItem.templateId);
    if (!template) throw new Error('Template not found');

    const inputFile = path.join(VIDEO_FOLDER, pendingItem.fileId);
    const outputFile = path.join(VIDEO_FOLDER, 
      pendingItem.fileId.replace(/\.[^/.]+$/, "") + "_" + 
      template.name.toLowerCase().replace(/\s+/g, '_') + ".mp4");

    console.log(`[TRANSCODE] Начало конвертации: ${pendingItem.fileId} → ${outputFile}`);

    // Запускаем ffmpeg
    const command = ffmpeg(inputFile)
      .output(outputFile)
      .on('progress', (progress) => {
        // Обновляем прогресс
        if (progress.percent) {
          pendingItem.progress = progress.percent;
          saveTranscodeQueue(queue);
          console.log(`[TRANSCODE] Прогресс: ${pendingItem.fileId} - ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        // Завершено
        pendingItem.status = 'completed';
        pendingItem.completedAt = new Date().toISOString();
        saveTranscodeQueue(queue);
        console.log(`[TRANSCODE] Завершена конвертация: ${pendingItem.fileId}`);
        
        // Запускаем следующий
        setTimeout(() => {
          processTranscodeQueue();
        }, 1000);
      })
      .on('error', (err) => {
        // Ошибка
        pendingItem.status = 'error';
        pendingItem.error = err.message;
        pendingItem.completedAt = new Date().toISOString();
        saveTranscodeQueue(queue);
        console.error(`[TRANSCODE] Ошибка конвертации: ${pendingItem.fileId}`, err);
        
        // Запускаем следующий
        setTimeout(() => {
          processTranscodeQueue();
        }, 1000);
      });

    // Применяем команду из шаблона
    if (template.command.includes('-vf')) {
      const vfMatch = template.command.match(/-vf\s+([^ ]+)/);
      if (vfMatch) command.videoFilters(vfMatch[1]);
    }
    
    if (template.command.includes('-c:v')) {
      const codecMatch = template.command.match(/-c:v\s+([^ ]+)/);
      if (codecMatch) command.videoCodec(codecMatch[1]);
    }
    
    if (template.command.includes('-crf')) {
      const crfMatch = template.command.match(/-crf\s+(\d+)/);
      if (crfMatch) command.outputOptions('-crf', crfMatch[1]);
    }
    
    if (template.command.includes('-preset')) {
      const presetMatch = template.command.match(/-preset\s+([^ ]+)/);
      if (presetMatch) command.outputOptions('-preset', presetMatch[1]);
    }

    command.run();
  } catch (err) {
    pendingItem.status = 'error';
    pendingItem.error = err.message;
    pendingItem.completedAt = new Date().toISOString();
    saveTranscodeQueue(queue);
    console.error(`[TRANSCODE] Ошибка обработки очереди:`, err);
    
    // Запускаем следующий
    setTimeout(() => {
      processTranscodeQueue();
    }, 1000);
  }
}

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
  console.log(`[TRANSCODE] Создан файл шаблонов: ${TRANSCODE_TEMPLATES_FILE}`);
}

if (!fs.existsSync(TRANSCODE_QUEUE_FILE)) {
  saveTranscodeQueue([]);
  console.log(`[TRANSCODE] Создан файл очереди: ${TRANSCODE_QUEUE_FILE}`);
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
    if (joinedRoom && rooms[joinedRoom]) {
      rooms[joinedRoom].currentVideo = filename;
      rooms[joinedRoom].state.currentVideo = filename;
      rooms[joinedRoom].state.currentTime = 0;
      rooms[joinedRoom].state.isPlaying = false;
      rooms[joinedRoom].state.updatedAt = new Date().toISOString();
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

  // ✅ НОВОЕ: ОБНОВЛЕНИЕ ГЛОБАЛЬНОГО СОСТОЯНИЯ КОМНАТЫ
  socket.on('update-room-state', (stateUpdates) => {
    if (joinedRoom && rooms[joinedRoom]) {
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
      // ✅ ИСПРАВЛЕНО: используем joinedRoom вместо roomId
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