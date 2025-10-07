const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('fs-extra');
const multer = require('multer');
const config = require('./config');

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
const sessionsRoutes = require('./routes/sessions');
const statsRoutes = require('./routes/stats');

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
    this.roomStatesAutosaveInterval = null; // ← ДОБАВЛЕНО: интервал автосохранения

    // ← ДОБАВЛЕНО: путь к файлу состояний
    this.ROOM_STATES_FILE = path.join(__dirname, 'json', 'room-states.json');

    this.setupMiddleware();
    this.setupRoutes();
    this.loadRoomStates(); // ← ДОБАВЛЕНО: загрузка состояний при старте
    this.setupSocketIO();
    this.startRoomStatesAutosave(); // ← ДОБАВЛЕНО: запуск автосохранения
    this.setupFileUpload();
  }

  // === НОВЫЕ МЕТОДЫ ДЛЯ СОХРАНЕНИЯ СОСТОЯНИЙ ===

  loadRoomStates() {
    try {
      if (fs.existsSync(this.ROOM_STATES_FILE)) {
        const data = fs.readFileSync(this.ROOM_STATES_FILE, 'utf8');
        const savedStates = JSON.parse(data);
        // Применяем сохранённые состояния к существующим комнатам
        for (const [roomId, state] of Object.entries(savedStates)) {
          this.roomService.updateRoomState(roomId, {
            currentVideo: state.currentVideo,
            currentTime: state.currentTime,
            isPlaying: state.isPlaying
          });
        }
        console.log('✅ Состояния комнат загружены из room-states.json');
      } else {
        console.log('ℹ️ Файл room-states.json не найден — будет создан при первом сохранении');
      }
    } catch (err) {
      console.error('❌ Ошибка загрузки состояний комнат:', err);
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
            isPlaying: !!room.isPlaying
          };
        }
      }

      // Создаём папку json, если её нет
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
    // Сохраняем каждые 5 секунд
    this.roomStatesAutosaveInterval = setInterval(() => {
      this.saveRoomStates();
    }, 5000);
    console.log('🔁 Автосохранение состояний комнат запущено (каждые 5 сек)');
  }

  // === КОНЕЦ НОВЫХ МЕТОДОВ ===

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
    this.app.use('/api/sessions', sessionsRoutes);
    this.app.use('/api/stats', statsRoutes);

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

      socket.on('get-rooms', (callback) => {
        console.log(`[SOCKET] ${socket.id} requested room list`);
        if (callback) {
          callback(this.roomService.getAllRooms());
        }
      });

      socket.on('delete-room', (data, callback) => {
        const { roomId } = data;
        console.log(`[SOCKET] ${socket.id} requested deletion of room ${roomId}`);
        const result = this.roomService.deleteRoom(roomId, socket.id);
        console.log(`[SOCKET] Result of deleting room ${roomId}:`, result);
        if (result.success) {
          console.log(`[SOCKET] Room ${roomId} deleted by ${socket.id}`);
          this.io.emit('room-list', this.roomService.getAllRooms());
          if (callback && typeof callback === 'function') {
            const response = { success: true, message: result.message };
            console.log(`[SOCKET] Sending success response to ${socket.id}:`, response);
            callback(response);
          }
        } else {
          console.log(`[SOCKET] Error deleting room ${roomId} by ${socket.id}:`, result.message);
          if (callback && typeof callback === 'function') {
            const response = { success: false, message: result.message };
            console.log(`[SOCKET] Sending error response to ${socket.id}:`, response);
            callback(response);
          }
        }
      });

      socket.on('video-command', (data) => {
        console.log(`[SOCKET] Received video-command from ${socket.id}:`, data);
        if (data.roomId) {
          console.log(`[SOCKET] Broadcasting video-command to room ${data.roomId}`);
          socket.to(data.roomId).emit('video-command', data);
        } else {
          console.warn(`[SOCKET] video-command received without roomId from ${socket.id}`);
        }
      });

      socket.on('select-video', (data) => {
        console.log(`[SOCKET] Received select-video from ${socket.id}:`, data);
        if (data.roomId && data.filename) {
          console.log(`[SOCKET] Broadcasting video-updated to room ${data.roomId} with file ${data.filename}`);
          this.io.in(data.roomId).emit('video-updated', data.filename);
          this.roomService.updateRoomState(data.roomId, { currentVideo: data.filename });
        } else {
          console.warn(`[SOCKET] select-video received without roomId or filename from ${socket.id}`);
        }
      });

      socket.on('create-room', (data, callback) => {
        const room = this.roomService.createRoom(data.name, socket.id);
        socket.join(room.id);
        socket.emit('room-created', room);
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) {
          callback({ success: true, id: room.id, name: room.name });
        }
      });

      socket.on('join-room', (data, callback) => {
        console.log(`[SOCKET] ${socket.id} attempting to join room ${data.roomId} as ${data.name || 'Anonymous'}`);
        const room = this.roomService.joinRoom(data.roomId, socket.id, data.name);
        if (room) {
          console.log(`[SOCKET] ${socket.id} successfully joined room ${data.roomId}`);
          socket.join(data.roomId);
          socket.emit('room-joined', room);

          socket.emit('room-state', {
            currentVideo: room.currentVideo || null,
            currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
            isPlaying: !!room.isPlaying,
            users: Object.fromEntries(room.users)
          });

          socket.to(data.roomId).emit('user-joined', { 
            user: { socketId: socket.id, name: data.name },
            room: room
          });
          this.io.emit('room-list', this.roomService.getAllRooms());
          if (callback) {
            callback({ 
              success: true, 
              room: {
                id: room.id,
                name: room.name,
              } 
            });
          }
        } else {
          console.log(`[SOCKET] ${socket.id} failed to join room ${data.roomId} - room not found`);
          if (callback) {
            callback({ success: false, error: 'Room not found' });
          }
        }
      });

      socket.on('leave-room', (data, callback) => {
        this.roomService.leaveRoom(data.roomId, socket.id);
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('user-left', { socketId: socket.id });
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) {
          callback({ success: true });
        }
      });

      socket.on('kick-user', (data, callback) => {
        const { roomId, targetUserId } = data;
        console.log(`[SOCKET] ${socket.id} requested to kick user ${targetUserId} from room ${roomId}`);

        const room = this.roomService.getRoom(roomId);
        if (!room) {
          if (callback) callback({ success: false, error: 'Room not found' });
          return;
        }

        if (!room.users || !room.users[targetUserId]) {
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

        console.log(`[SOCKET] User ${targetUserId} kicked from room ${roomId} by ${socket.id}`);
        if (callback) callback({ success: true, message: 'User kicked successfully' });
      });

      socket.on('kick-all', (data, callback) => {
        const { roomId } = data;
        console.log(`[SOCKET] ${socket.id} requested to kick ALL users from room ${roomId}`);

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

        console.log(`[SOCKET] Kicked ${usersToKick.length} users from room ${roomId} by ${socket.id}`);
        if (callback) callback({ success: true, message: `Kicked ${usersToKick.length} users` });
      });

      socket.on('play-video', (data) => {
        console.log(`[VIDEO] 🟢 play-video from ${socket.id}:`, JSON.stringify(data, null, 2));
        if (data.time === undefined) {
          console.warn(`[VIDEO] ⚠️ WARNING: 'time' is missing in play-video event!`);
        }
        this.roomService.updateRoomState(data.roomId, { 
          isPlaying: true,
          currentTime: data.time || 0
        });
        socket.to(data.roomId).emit('video-play', data);
      });

      socket.on('pause-video', (data) => {
        console.log(`[VIDEO] ⏸️ pause-video from ${socket.id}:`, JSON.stringify(data, null, 2));
        if (data.time === undefined) {
          console.warn(`[VIDEO] ⚠️ WARNING: 'time' is missing in pause-video event!`);
        }
        this.roomService.updateRoomState(data.roomId, { 
          isPlaying: false,
          currentTime: data.time || 0
        });
        socket.to(data.roomId).emit('video-pause', data);
      });

      socket.on('seek-video', (data) => {
        console.log(`[VIDEO] 🔍 seek-video from ${socket.id}:`, JSON.stringify(data, null, 2));
        if (data.time === undefined) {
          console.warn(`[VIDEO] ⚠️ WARNING: 'time' is missing in seek-video event!`);
        }
        this.roomService.updateRoomState(data.roomId, { currentTime: data.time || 0 });
        socket.to(data.roomId).emit('video-seek', data);
      });

      socket.on('change-video', (data) => {
        console.log(`[VIDEO] 📼 change-video from ${socket.id}:`, JSON.stringify(data, null, 2));
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
            console.log(`[SOCKET CLEANUP] Removing disconnected user ${socket.id} from room ${room.id}`);
            this.roomService.leaveRoom(room.id, socket.id);
            socket.to(room.id).emit('user-left', { socketId: socket.id });
          }
        });
        this.io.emit('room-list', this.roomService.getAllRooms());
      });
    });

    this.roomUpdateInterval = setInterval(() => {
      try {
        const allRooms = this.roomService.getAllRooms();
        
        const roomsData = allRooms.map(room => ({
          id: room.id,
          name: room.name,
          users: room.users ? Object.keys(room.users).length : 0,
          currentVideo: room.currentVideo || null,
          currentTime: typeof room.currentTime === 'number' ? room.currentTime : 0,
          isPlaying: !!room.isPlaying
        }));

        const jsonDir = path.join(__dirname, 'json');
        const roomsJsonPath = path.join(jsonDir, 'rooms.json');

        roomsData.forEach(room => {
          if (room.id) {
            this.io.emit('room-update', {
              roomId: room.id,
              videoId: room.currentVideo,
              currentTime: room.currentTime
            });
          }
        });

        console.log(`[ROOMS.JSON] Updated at ${new Date().toISOString()}`);

      } catch (err) {
        console.error('[ROOMS.JSON] Error updating rooms.json:', err);
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
      console.log(`💾 room-states.json: http://localhost:${port}/json/room-states.json`); // ← ДОБАВЛЕНО
      console.log(`🔑 Default admin: admin / admin`);
    });

    const shutdown = () => {
      console.log('Shutting down server...');
      if (this.roomUpdateInterval) {
        clearInterval(this.roomUpdateInterval);
      }
      if (this.roomStatesAutosaveInterval) { // ← ДОБАВЛЕНО
        clearInterval(this.roomStatesAutosaveInterval);
        this.saveRoomStates(); // Сохраняем в последний раз
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