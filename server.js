const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('fs-extra');
const multer = require('multer');
const config = require('./config');
const ytdl = require('ytdl-core');

// Импорт сервисов
const RoomService = require('./services/roomService');
const AuthService = require('./services/authService');
const TranscodeService = require('./services/transcodeService');
const AdminService = require('./services/adminService');
const VideoService = require('./services/videoService');
const FileService = require('./services/fileService');

// Импорт middleware
const { authenticateToken, isAdmin } = require('./middleware/auth');
const { logRequests, logClientRequest } = require('./middleware/logging');

// Импорт маршрутов
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const metricsRoutes = require('./routes/metrics');
const healthRoutes = require('./routes/health');
const filesRoutes = require('./routes/files');
const videosRoutes = require('./routes/videos');
const transcodeRoutes = require('./routes/transcode');
const roomsRoutes = require('./routes/rooms');

class SyncWatchServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    this.roomService = new RoomService();
    this.authService = new AuthService();
    this.transcodeService = new TranscodeService();
    this.adminService = new AdminService();
    this.videoService = new VideoService(config.videoDir);
    this.fileService = new FileService(config.videoDir);

    this.roomUpdateInterval = null;
    this.roomStatesAutosaveInterval = null;
    this.ROOM_STATES_FILE = path.join(__dirname, 'json', 'room-states.json');

    this.setupMiddleware();
    this.setupRoutes();
    this.loadRoomStates();
    this.setupSocketIO();
    this.startRoomStatesAutosave();
    this.setupFileUpload();
  }

  loadRoomStates() {
    try {
      if (!fs.existsSync(this.ROOM_STATES_FILE)) {
        console.log('ℹ️ Файл room-states.json не найден — будет создан при первом сохранении');
        return;
      }

      const data = fs.readFileSync(this.ROOM_STATES_FILE, 'utf8').trim();
      if (!data) {
        console.log('⚠️ Файл room-states.json пуст — игнорируем');
        return;
      }

      const savedStates = JSON.parse(data);
      for (const [roomId, state] of Object.entries(savedStates)) {
        this.roomService.updateRoomState(roomId, {
          currentVideo: state.currentVideo,
          currentTime: state.currentTime,
          isPlaying: state.isPlaying,
          duration: state.duration // ← добавлено
        });
      }
      console.log('✅ Состояния комнат загружены из room-states.json');
    } catch (err) {
      console.error('❌ Ошибка загрузки состояний комнат:', err.message);
      console.warn('⚠️ Файл room-states.json повреждён или содержит недопустимый JSON. Он будет перезаписан при следующем сохранении.');
      try {
        fs.unlinkSync(this.ROOM_STATES_FILE);
        console.log('🗑️ Повреждённый room-states.json удалён');
      } catch (delErr) {
        console.error('❌ Не удалось удалить повреждённый файл:', delErr.message);
      }
    }
  }

  saveRoomStates() {
    try {
      const allRooms = this.roomService.getAllRooms();
      const statesToSave = {};

      for (const room of allRooms) {
        if (room.id) {
          statesToSave[room.id] = {
            currentVideo: room.currentVideo || null,
            currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
            isPlaying: !!room.isPlaying,
            duration: typeof room.duration === 'number' ? room.duration : 0 // ← сохраняем длительность
          };
        }
      }

      const dir = path.dirname(this.ROOM_STATES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.ROOM_STATES_FILE, JSON.stringify(statesToSave, null, 2));
      console.log(`💾 Состояния комнат сохранены (${new Date().toISOString()})`);
    } catch (err) {
      console.error('❌ Ошибка сохранения состояний комнат:', err);
    }
  }

  startRoomStatesAutosave() {
    this.roomStatesAutosaveInterval = setInterval(() => {
      this.saveRoomStates();
    }, 5000);
    console.log('🔁 Автосохранение состояний комнат запущено (каждые 5 сек)');
  }

  extractYouTubeId(url) {
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]{11}).*/;
    const match = url.match(regExp);
    return match ? match[2] : null;
  }

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return (h ? `${h}h ` : '') + (m ? `${m}m ` : '') + `${s}s`;
  }

  setupMiddleware() {
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(logRequests);
    console.log('[DEBUG] publicDirectory =', config.publicDirectory);
    this.app.use(express.static(config.publicDirectory));
    this.app.use('/videos', express.static(config.videoDir));

    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  setupRoutes() {
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/admin', adminRoutes);
    this.app.use('/api/metrics', metricsRoutes);
    this.app.use('/api/system', healthRoutes);
    this.app.use('/api/files', filesRoutes);
    this.app.use('/api/videos', videosRoutes);
    this.app.use('/api/transcode', transcodeRoutes);
    this.app.use('/api/rooms', roomsRoutes);

    this.app.post('/api/auth/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        const result = await this.authService.login(username, password);
        if (result.success && result.user.role === 'admin') {
          res.json(result);
        } else {
          res.status(403).json({ 
            success: false, 
            error: 'Доступ разрешен только администраторам' 
          });
        }
      } catch (error) {
        res.status(401).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    this.app.get('/api/auth/profile', authenticateToken, (req, res) => {
      try {
        const user = this.authService.getUser(req.user.username);
        if (user) {
          res.json({ 
            success: true, 
            user: {
              username: user.username,
              role: user.role,
              id: user.id
            }
          });
        } else {
          res.status(404).json({ 
            success: false, 
            error: 'Пользователь не найден' 
          });
        }
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: 'Ошибка сервера' 
        });
      }
    });

    // === ADMIN API (оставлено без изменений) ===
    this.app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
      try {
        const stats = this.adminService.getStats();
        res.json({ success: true, stats });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения статистики:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении статистики' });
      }
    });

    this.app.get('/api/admin/rooms', authenticateToken, isAdmin, (req, res) => {
      try {
        const rooms = this.adminService.getAllRooms();
        res.json({ success: true, rooms });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения списка комнат:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении списка комнат' });
      }
    });

    this.app.get('/api/admin/rooms/:roomId', authenticateToken, isAdmin, (req, res) => {
      try {
        const room = this.adminService.getRoomDetails(req.params.roomId);
        if (!room) {
          return res.status(404).json({ success: false, error: 'Комната не найдена' });
        }
        res.json({ success: true, room });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения деталей комнаты:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении деталей комнаты' });
      }
    });

    this.app.delete('/api/admin/rooms/:roomId', authenticateToken, isAdmin, (req, res) => {
      try {
        const result = this.adminService.deleteRoom(req.params.roomId);
        if (result.success) {
          this.io.emit('room-deleted', { roomId: req.params.roomId });
          res.json({ success: true, message: result.message });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка удаления комнаты:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при удалении комнаты' });
      }
    });

    this.app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
      try {
        const users = this.adminService.getAllUsers();
        res.json({ success: true, users });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения списка пользователей:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении списка пользователей' });
      }
    });

    this.app.get('/api/admin/transcode/queue', authenticateToken, isAdmin, (req, res) => {
      try {
        const queue = this.adminService.getTranscodeQueue();
        res.json({ success: true, queue });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения очереди транскодирования:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении очереди транскодирования' });
      }
    });

    this.app.get('/api/admin/transcode/templates', authenticateToken, isAdmin, (req, res) => {
      try {
        const templates = this.adminService.getTranscodeTemplates();
        res.json({ success: true, templates });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения шаблонов транскодирования:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении шаблонов транскодирования' });
      }
    });

    this.app.put('/api/files/move', authenticateToken, async (req, res) => {
      try {
        const { items, destination } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
           return res.status(400).json({ success: false, error: 'Items array is required and cannot be empty' });
        }
        if (typeof destination !== 'string') {
           return res.status(400).json({ success: false, error: 'Destination must be a string' });
        }

        console.log(`[FILES API] Запрос на перемещение ${items.length} элементов в папку: "${destination}" от пользователя:`, req.user?.username);
        console.log(`[FILES API] Элементы для перемещения:`, items);

        let successCount = 0;
        let failCount = 0;
        const errors = [];

        for (const itemPath of items) {
            try {
                console.log(`[FILES API] Перемещение элемента: "${itemPath}" -> "${destination}"`);
                const targetName = itemPath.split('/').pop();
                const targetPath = destination ? `${destination}/${targetName}` : targetName;
                const result = await this.fileService.moveItem(itemPath, targetPath);
                console.log(`[FILES API] Элемент успешно перемещен: "${itemPath}" -> "${targetPath}"`);
                successCount++;
            } catch (itemError) {
                console.error(`[FILES API] Ошибка перемещения элемента "${itemPath}":`, itemError.message);
                errors.push({ item: itemPath, error: itemError.message });
                failCount++;
            }
        }

        if (failCount === 0) {
            res.status(200).json({ success: true, message: `Successfully moved ${successCount} item(s).` });
        } else if (successCount === 0) {
            res.status(500).json({ success: false, error: 'Failed to move any items.', details: errors });
        } else {
            res.status(207).json({ success: false, message: `Operation completed with errors. Moved ${successCount}, failed ${failCount}.`, details: errors });
        }

      } catch (error) {
        console.error('[FILES API] Неожиданная ошибка в обработчике /move:', error);
        res.status(500).json({ success: false, error: 'Internal server error during move operation.' });
      }
    });

    const upload = multer({ 
      dest: config.videoDir,
      limits: {
        fileSize: 100 * 1024 * 1024 * 1024
      },
      fileFilter: (req, file, cb) => {
         if (file.fieldname === 'video') {
             cb(null, true);
         } else {
             cb(new Error('Unexpected field'), false);
         }
      }
    });

    this.app.post('/upload', upload.single('video'), (req, res) => {
      if (!req.file) {
        console.error('Upload error: No file received or file filter rejected it.');
        return res.status(400).json({ success: false, error: 'No file uploaded or invalid field name. Expected field "video".' });
      }

      const finalPath = path.join(config.videoDir, req.file.originalname);
      
      fs.rename(req.file.path, finalPath, (err) => {
        if (err) {
          console.error('Upload error:', err);
          return res.status(500).json({ success: false, error: 'Failed to save file' });
        }

        res.json({ 
          success: true, 
          message: 'File uploaded successfully',
          filename: req.file.originalname,
          path: finalPath
        });
      });
    });

    this.app.get('/admin', (req, res) => {
      res.sendFile(path.join(config.publicDirectory, 'admin.html'));
    });

    this.app.get('/admin.html', (req, res) => {
      res.sendFile(path.join(config.publicDirectory, 'admin.html'));
    });

    this.app.get('/', (req, res) => {
      res.sendFile(path.join(config.publicDirectory, 'index.html'));
    });

    this.app.use('*', (req, res) => {
      res.status(404).json({ success: false, error: 'Route not found' });
    });

    this.app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    });
  }

  setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log(`[SOCKET] User connected: ${socket.id}`);

      // ✅ NEW: Принимаем статус от каждого пользователя
      socket.on('video-status', (data) => {
        const { roomId, currentTime, isPlaying, videoFile } = data;
        if (!roomId) return;

        this.roomService.updateRoomState(roomId, {
          currentTime: currentTime,
          isPlaying: isPlaying,
          currentVideo: videoFile
        });

        const room = this.roomService.getRoom(roomId);
        if (room) {
          this.io.emit('room-update', {
            roomId: roomId,
            currentTime: currentTime,
            isPlaying: isPlaying,
            videoTitle: videoFile ? videoFile.split('/').pop() : null,
            duration: room.duration || 0
          });
        }
      });

      // ✅ NEW: Принимаем метаданные (длительность)
      socket.on('video-metadata', (data) => {
        const { roomId, duration, filename } = data;
        if (!roomId || typeof duration !== 'number') return;

        this.roomService.updateRoomState(roomId, {
          duration: duration,
          currentVideo: filename
        });

        const room = this.roomService.getRoom(roomId);
        if (room) {
          this.io.emit('room-update', {
            roomId: roomId,
            duration: duration,
            videoTitle: filename ? filename.split('/').pop() : null,
            currentTime: room.currentTime || 0,
            isPlaying: !!room.isPlaying
          });
        }
      });

      socket.on('get-rooms', (callback) => {
        const rawRooms = this.roomService.getAllRooms();
        const roomsForClient = rawRooms.map(room => {
          let videoTitle = null;
          if (room.currentVideo) {
            if (typeof room.currentVideo === 'string' && room.currentVideo.length === 11) {
              videoTitle = `YouTube: ${room.currentVideo}`;
            } else {
              videoTitle = room.currentVideo.split('/').pop();
            }
          }

          return {
            id: room.id,
            name: room.name,
            hasPassword: !!room.password,
            users: room.users || {},
            video: room.currentVideo ? {
              title: videoTitle || 'Без названия',
              currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
              isPlaying: !!room.isPlaying,
              duration: typeof room.duration === 'number' ? room.duration : 0
            } : null
          };
        });

        if (callback) callback(roomsForClient);
      });

      socket.on('delete-room', (data, callback) => {
        const { roomId } = data;
        const result = this.roomService.deleteRoom(roomId, socket.id);
        if (result.success) {
          this.io.emit('room-list', this.roomService.getAllRooms());
          if (callback) callback({ success: true, message: result.message });
        } else {
          if (callback) callback({ success: false, message: result.message });
        }
      });

      // === YouTube и остальные события без изменений ===
      socket.on('queue-add-youtube', async (data, callback) => {
        const { roomId, url } = data;
        try {
          const videoId = this.extractYouTubeId(url);
          if (!videoId) {
            const error = 'Неверная ссылка на YouTube';
            if (callback) callback({ success: false, error });
            socket.emit('notification', { type: 'error', message: error });
            return;
          }

          const info = await ytdl.getBasicInfo(videoId);
          const video = {
            id: videoId,
            title: info.videoDetails.title || 'Без названия',
            duration: this.formatDuration(info.videoDetails.lengthSeconds),
            thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
            type: 'youtube'
          };

          this.roomService.addVideoToQueue(roomId, video);
          const room = this.roomService.getRoom(roomId);
          this.io.to(roomId).emit('queue-updated', room.youtubeQueue);

          if (callback) callback({ success: true, video });
          socket.emit('notification', { type: 'success', message: 'Видео добавлено в очередь' });
        } catch (err) {
          console.error('[YouTube] Ошибка добавления видео:', err.message);
          const error = 'Не удалось загрузить видео с YouTube';
          if (callback) callback({ success: false, error });
          socket.emit('notification', { type: 'error', message: error });
        }
      });

      socket.on('skip-video', (data) => {
        const { roomId } = data;
        const next = this.roomService.getNextVideo(roomId);
        if (next && next.type === 'youtube') {
          this.roomService.updateRoomState(roomId, { currentVideo: next.id });
          this.io.to(roomId).emit('video-changed', { videoUrl: next.id, type: 'youtube' });
        } else {
          this.roomService.updateRoomState(roomId, { currentVideo: null });
          this.io.to(roomId).emit('video-changed', { videoUrl: null });
        }
        const room = this.roomService.getRoom(roomId);
        this.io.to(roomId).emit('queue-updated', room.youtubeQueue);
      });

      socket.on('queue-remove', (data) => {
        const { roomId, index } = data;
        this.roomService.removeVideoFromQueue(roomId, index);
        const room = this.roomService.getRoom(roomId);
        this.io.to(roomId).emit('queue-updated', room.youtubeQueue);
      });

      socket.on('queue-clear', (data) => {
        const { roomId } = data;
        this.roomService.clearQueue(roomId);
        this.io.to(roomId).emit('queue-updated', []);
      });

      socket.on('video-ended', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;
        const next = this.roomService.getNextVideo(roomId);
        if (next && next.type === 'youtube') {
          this.roomService.updateRoomState(roomId, { currentVideo: next.id });
          this.io.to(roomId).emit('video-changed', { videoUrl: next.id, type: 'youtube' });
        } else {
          this.roomService.updateRoomState(roomId, { currentVideo: null });
          this.io.to(roomId).emit('video-changed', { videoUrl: null });
        }
        const room = this.roomService.getRoom(roomId);
        this.io.to(roomId).emit('queue-updated', room.youtubeQueue);
      });

      socket.on('video-command', (data) => {
        if (data.roomId) {
          socket.to(data.roomId).emit('video-command', data);
        }
      });

      socket.on('select-video', (data) => {
        if (data.roomId && data.filename) {
          this.io.in(data.roomId).emit('video-updated', data.filename);
          this.roomService.updateRoomState(data.roomId, { currentVideo: data.filename });
        }
      });

      socket.on('create-room', (data, callback) => {
        const room = this.roomService.createRoom(data.name, socket.id, data.password);
        socket.join(room.id);
        socket.emit('room-created', room);
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) {
          callback({ success: true, id: room.id, name: room.name });
        }
      });

      socket.on('join-room', (data, callback) => {
        if (!data.roomId || !data.name) {
          if (callback) callback({ success: false, error: 'Missing roomId or name' });
          return;
        }

        const result = this.roomService.joinRoom(data.roomId, socket.id, data.name, data.password);
        if (!result || !result.success) {
          if (callback) callback({ success: false, error: result?.error || 'Failed to join room' });
          return;
        }

        const room = result.room;
        if (!room) {
          if (callback) callback({ success: false, error: 'Room data unavailable' });
          return;
        }

        socket.join(data.roomId);
        socket.emit('room-joined', room);
        socket.emit('room-state', {
          currentVideo: room.currentVideo || null,
          currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
          isPlaying: !!room.isPlaying,
          duration: typeof room.duration === 'number' ? room.duration : 0,
          users: room.users
        });

        socket.to(data.roomId).emit('user-joined', { 
          user: { socketId: socket.id, name: data.name },
          room: room
        });
        this.io.emit('room-list', this.roomService.getAllRooms());
        
        if (callback) {
          callback({ 
            success: true, 
            room: { id: room.id, name: room.name }
          });
        }
      });

      socket.on('leave-room', (data, callback) => {
        this.roomService.leaveRoom(data.roomId, socket.id);
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('user-left', { socketId: socket.id });
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) callback({ success: true });
      });

      socket.on('kick-user', (data, callback) => {
        const { roomId, targetUserId } = data;
        const room = this.roomService.getRoom(roomId);
        if (!room || !room.users || !room.users[targetUserId]) {
          if (callback) callback({ success: false, error: 'User not in room' });
          return;
        }

        const targetSocket = this.io.sockets.sockets.get(targetUserId);
        if (targetSocket) {
          targetSocket.emit('kicked-from-room', { message: 'You have been kicked from the room' });
          targetSocket.leave(roomId);
        }

        this.roomService.leaveRoom(roomId, targetUserId);
        socket.to(roomId).emit('user-left', { socketId: targetUserId });
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) callback({ success: true, message: 'User kicked successfully' });
      });

      socket.on('kick-all', (data, callback) => {
        const { roomId } = data;
        const room = this.roomService.getRoom(roomId);
        if (!room) {
          if (callback) callback({ success: false, error: 'Room not found' });
          return;
        }

        const usersToKick = Object.keys(room.users || {}).filter(uid => uid !== socket.id);
        if (usersToKick.length === 0) {
          if (callback) callback({ success: true, message: 'No other users to kick' });
          return;
        }

        usersToKick.forEach(uid => {
          const targetSocket = this.io.sockets.sockets.get(uid);
          if (targetSocket) {
            targetSocket.emit('kicked-from-room', { message: 'You have been kicked from the room' });
            targetSocket.leave(roomId);
          }
          this.roomService.leaveRoom(roomId, uid);
        });

        socket.to(roomId).emit('user-left', { socketId: usersToKick });
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) callback({ success: true, message: `Kicked ${usersToKick.length} users` });
      });

      socket.on('play-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { 
          isPlaying: true,
          currentTime: data.time || 0
        });
        socket.to(data.roomId).emit('video-play', data);
      });

      socket.on('pause-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { 
          isPlaying: false,
          currentTime: data.time || 0
        });
        socket.to(data.roomId).emit('video-pause', data);
      });

      socket.on('seek-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { currentTime: data.time || 0 });
        socket.to(data.roomId).emit('video-seek', data);
      });

      socket.on('change-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { currentVideo: data.videoUrl });
        socket.to(data.roomId).emit('video-changed', data);
      });

      socket.on('keepalive', (data) => {
        console.log(`[SOCKET] Received keepalive from ${socket.id} for room ${data.roomId || 'N/A'}`);
      });

      socket.on('user-state-update', (data) => {
        if (data.roomId) {
          this.roomService.updateUserState(data.roomId, socket.id, data.state);
        }
      });

      socket.on('disconnect', () => {
        console.log(`[SOCKET] User disconnected: ${socket.id}`);
        const rooms = this.roomService.getAllRooms();
        rooms.forEach(room => {
          if (room.users && room.users[socket.id]) {
            this.roomService.leaveRoom(room.id, socket.id);
            socket.to(room.id).emit('user-left', { socketId: socket.id });
          }
        });
        this.io.emit('room-list', this.roomService.getAllRooms());
      });
    });

    // Интервал для резервной рассылки (например, для YouTube)
    this.roomUpdateInterval = setInterval(() => {
      try {
        const allRooms = this.roomService.getAllRooms();
        allRooms.forEach(room => {
          if (room.id && room.currentVideo) {
            this.io.emit('room-update', {
              roomId: room.id,
              currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
              isPlaying: !!room.isPlaying,
              videoTitle: room.currentVideo ? room.currentVideo.split('/').pop() : null,
              duration: typeof room.duration === 'number' ? room.duration : 0
            });
          }
        });
      } catch (err) {
        console.error('[ROOM-UPDATE] Error:', err);
      }
    }, 1000);
  }

  setupFileUpload() {
    if (!fs.existsSync(config.videoDir)) {
      fs.mkdirSync(config.videoDir, { recursive: true });
    }
  }

  start(port = config.port || 3000) {
    this.server.listen(port, () => {
      console.log(`🚀 SyncWatch server running on port ${port}`);
      console.log(`📊 Admin panel: http://localhost:${port}/admin`);
      console.log(`📁 rooms.json: http://localhost:${port}/json/rooms.json`);
      console.log(`💾 room-states.json: http://localhost:${port}/json/room-states.json`);
      console.log(`🔑 Default admin: admin / admin`);
    });

    const shutdown = () => {
      console.log('Shutting down server...');
      if (this.roomUpdateInterval) clearInterval(this.roomUpdateInterval);
      if (this.roomStatesAutosaveInterval) {
        clearInterval(this.roomStatesAutosaveInterval);
        this.saveRoomStates();
      }
      this.roomService.shutdown();
      this.server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

if (require.main === module) {
  const server = new SyncWatchServer();
  server.start();
}

module.exports = SyncWatchServer;