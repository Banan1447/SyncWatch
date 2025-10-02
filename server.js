// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Используем текущую директорию для папки videos
const VIDEO_FOLDER = path.join(process.cwd(), 'videos');

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

// Получить список видеофайлов
function getVideoFiles() {
  try {
    return fs.readdirSync(VIDEO_FOLDER).filter(file => /\.(mp4|webm|ogg)$/i.test(file));
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

  files.forEach(file => {
    getVideoInfo(file, info => {
      videos.push({ name: file, ...info });
      if (videos.length === files.length) {
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

  // ✅ Обновляем путь к видео
  VIDEO_FOLDER = path.resolve(folder);
  // Обновляем middleware для раздачи видео
  app.use('/videos', express.static(VIDEO_FOLDER));
  console.log(`[ADMIN] Папка с видео изменена на: ${VIDEO_FOLDER}`);
  res.json({ success: true, folder: VIDEO_FOLDER });
});

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
      chat: []
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

  socket.on('send-comment', (comment) => {
    if (joinedRoom && rooms[joinedRoom]) {
      rooms[joinedRoom].chat.push(comment);
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('new-comment', comment);
    }
  });

  socket.on('disconnect', () => {
    if (joinedRoom && rooms[joinedRoom]) {
      delete rooms[joinedRoom].users[socket.id];
      roomsData.setRooms(rooms);
      io.to(joinedRoom).emit('room-state', rooms[joinedRoom]);
      io.emit('room-list', getRoomList());
    }
    console.log('[SOCKET] User disconnected:', socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[SERVER] Запущен на http://localhost:${PORT}`);
  console.log(`[INFO] Админ-панель: http://localhost:${PORT}/admin (только с localhost)`);
  console.log(`[INFO] Папка с видео: ${VIDEO_FOLDER}`);
});