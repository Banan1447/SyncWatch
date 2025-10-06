// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs'); // Для синхронных методов
const fsp = require('fs').promises; // Для асинхронных методов (если нужно)
const { ensureDir } = require('fs-extra'); // Убедитесь, что fs-extra установлен: npm install fs-extra
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
    this.videoService = new VideoService(config.videoDirectory);
    this.fileService = new FileService(config.videoDirectory);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupFileUpload();
  }

  setupMiddleware() {
    // Базовые middleware
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(logRequests);

    // Статические файлы
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use('/styles', express.static(path.join(__dirname, 'styles')));
    this.app.use('/js', express.static(path.join(__dirname, 'js')));
    this.app.use('/videos', express.static(config.videoDirectory));

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  setupRoutes() {
    // Основные маршруты API
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/admin', adminRoutes);
    this.app.use('/api/metrics', metricsRoutes);
    this.app.use('/api/system', healthRoutes);
    this.app.use('/api/files', filesRoutes);
    this.app.use('/api/videos', videosRoutes);
    this.app.use('/api/transcode', transcodeRoutes);

    // Маршруты аутентификации для админки
    this.app.post('/api/auth/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        
        const result = await this.authService.login(username, password);
        
        // Проверяем, является ли пользователь администратором
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

    // Маршруты админки
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
          // Уведомляем всех клиентов через WebSocket о удалении комнаты
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

    // --- НОВОЕ: Маршрут для перемещения файлов/папок ---
    this.app.put('/api/files/move', authenticateToken, async (req, res) => {
      try {
        // Изменяем ожидаемые поля: теперь items (массив) и destination (строка)
        const { items, destination } = req.body;
        
        // Валидация входных данных
        if (!Array.isArray(items) || items.length === 0) {
           return res.status(400).json({ success: false, error: 'Items array is required and cannot be empty' });
        }
        if (typeof destination !== 'string') {
           return res.status(400).json({ success: false, error: 'Destination must be a string' });
        }

        console.log(`[FILES API] Запрос на перемещение ${items.length} элементов в папку: "${destination}" от пользователя:`, req.user?.username);
        console.log(`[FILES API] Элементы для перемещения:`, items);

        // const token = localStorage.getItem('authToken'); // <-- УДАЛЕНО: localStorage не существует на сервере
        // if (!token) {
        //     throw new Error('Authentication token not found. Please log in again.');
        // }

        let successCount = 0;
        let failCount = 0;
        const errors = [];

        // Используем оригинальный метод moveItem для каждого элемента
        // Предполагается, что fileService.moveItem может перемещать как файлы, так и папки
        for (const itemPath of items) {
            try {
                console.log(`[FILES API] Перемещение элемента: "${itemPath}" -> "${destination}"`);
                // Создаем полный путь к целевому элементу
                const targetName = itemPath.split('/').pop();
                const targetPath = destination ? `${destination}/${targetName}` : targetName;
                // Вызываем оригинальный метод перемещения из fileService
                const result = await this.fileService.moveItem(itemPath, targetPath);
                console.log(`[FILES API] Элемент успешно перемещен: "${itemPath}" -> "${targetPath}"`);
                successCount++;
            } catch (itemError) {
                console.error(`[FILES API] Ошибка перемещения элемента "${itemPath}":`, itemError.message);
                errors.push({ item: itemPath, error: itemError.message });
                failCount++;
                // Продолжаем попытки переместить остальные элементы
            }
        }

        if (failCount === 0) {
            res.status(200).json({ success: true, message: `Successfully moved ${successCount} item(s).` });
        } else if (successCount === 0) {
            // Если ни один элемент не был перемещен успешно
            res.status(500).json({ success: false, error: 'Failed to move any items.', details: errors });
        } else {
            // Частичный успех
            res.status(207).json({ success: false, message: `Operation completed with errors. Moved ${successCount}, failed ${failCount}.`, details: errors });
        }

      } catch (error) {
        console.error('[FILES API] Неожиданная ошибка в обработчике /move:', error);
        res.status(500).json({ success: false, error: 'Internal server error during move operation.' });
      }
    });
    // --- /НОВОЕ ---

    // --- ИСПРАВЛЕНО: Конфигурация multer для поля 'video' ---
    const upload = multer({ 
      dest: config.videoDirectory,
      limits: {
        fileSize: 100 * 1024 * 1024 * 1024 // 100GB
      },
      // Указываем multer, что он должен принимать файл под именем 'video'
      fileFilter: (req, file, cb) => {
         if (file.fieldname === 'video') {
             cb(null, true); // Принять файл
         } else {
             cb(new Error('Unexpected field'), false); // Отклонить файл
         }
      }
    });

    // Или можно использовать upload.single('video') в маршруте
    this.app.post('/upload', upload.single('video'), (req, res) => {
      if (!req.file) {
        console.error('Upload error: No file received or file filter rejected it.');
        return res.status(400).json({ success: false, error: 'No file uploaded or invalid field name. Expected field "video".' });
      }

      const finalPath = path.join(config.videoDirectory, req.file.originalname);
      
      // Переименовываем файл из временного в постоянное имя
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
    // --- /ИСПРАВЛЕНО ---

    // Статические страницы
    this.app.get('/admin', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    this.app.get('/admin.html', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    // Корневой маршрут
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // Обработка 404
    this.app.use('*', (req, res) => {
      res.status(404).json({ success: false, error: 'Route not found' });
    });

    // Обработка ошибок
    this.app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    });
  }

  setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log(`[SOCKET] User connected: ${socket.id}`);

      // Обработчик запроса списка комнат
      socket.on('get-rooms', (callback) => {
        console.log(`[SOCKET] ${socket.id} requested room list`);
        // Отправляем текущий список комнат клиенту через callback
        if (callback) {
          callback(this.roomService.getAllRooms());
        }
      });

      // Обработчик удаления комнаты через сокет
      socket.on('delete-room', (data, callback) => {
        const { roomId } = data;
        console.log(`[SOCKET] ${socket.id} requested deletion of room ${roomId}`); // Добавим лог
        // Удаляем комнату через RoomService
        const result = this.roomService.deleteRoom(roomId, socket.id);
        console.log(`[SOCKET] Result of deleting room ${roomId}:`, result); // Добавим лог
        if (result.success) {
          console.log(`[SOCKET] Room ${roomId} deleted by ${socket.id}`);
          // Отправляем обновленный список комнат ВСЕМ подключенным клиентам
          this.io.emit('room-list', this.roomService.getAllRooms());
          // Отправляем подтверждение вызывающему (через callback)
          if (callback && typeof callback === 'function') { // Проверим, что callback - функция
            const response = { success: true, message: result.message };
            console.log(`[SOCKET] Sending success response to ${socket.id}:`, response); // Добавим лог
            callback(response);
          } else {
            console.log(`[SOCKET] Callback is not a function or undefined for ${socket.id}`); // Добавим лог
          }
        } else {
          console.log(`[SOCKET] Error deleting room ${roomId} by ${socket.id}:`, result.message); // Добавим лог
          // Отправляем ошибку вызывающему (через callback)
          if (callback && typeof callback === 'function') { // Проверим, что callback - функция
            const response = { success: false, message: result.message };
            console.log(`[SOCKET] Sending error response to ${socket.id}:`, response); // Добавим лог
            callback(response);
          } else {
            console.log(`[SOCKET] Callback is not a function or undefined for ${socket.id}`); // Добавим лог
          }
        }
      });

      // === НОВОЕ: ОБРАБОТЧИКИ СИНХРОНИЗАЦИИ ВИДЕО ===
      socket.on('video-command', (data) => {
        console.log(`[SOCKET] Received video-command from ${socket.id}:`, data); // <-- Добавить лог
        // Убедитесь, что data.roomId передается клиентом
        if (data.roomId) {
          console.log(`[SOCKET] Broadcasting video-command to room ${data.roomId}`); // <-- Добавить лог
          // Отправляем команду ВСЕМ в комнате, кроме отправителя
          socket.to(data.roomId).emit('video-command', data);
        } else {
          console.warn(`[SOCKET] video-command received without roomId from ${socket.id}`); // <-- Добавить лог
        }
      });
      // === КОНЕЦ НОВЫХ ОБРАБОТЧИКОВ ===

      // === ИСПРАВЛЕНО/ОБНОВЛЕНО: ОБРАБОТЧИК ВЫБОРА ВИДЕО (select-video) ===
      socket.on('select-video', (data) => {
        console.log(`[SOCKET] Received select-video from ${socket.id}:`, data); // <-- Добавить лог
        // Убедитесь, что data.roomId и data.filename передаются клиентом
        if (data.roomId && data.filename) {
          console.log(`[SOCKET] Broadcasting video-updated to room ${data.roomId} with file ${data.filename}`); // <-- Добавить лог
          // Отправляем событие обновления видео ВСЕМ в комнате, включая отправителя
          // Это позволяет всем обновить src видео и выделить элемент в проводнике
          this.io.in(data.roomId).emit('video-updated', data.filename);
          // Также обновляем состояние комнаты на сервере
          this.roomService.updateRoomState(data.roomId, { currentVideo: data.filename });
        } else {
          console.warn(`[SOCKET] select-video received without roomId or filename from ${socket.id}`); // <-- Добавить лог
        }
      });
      // === КОНЕЦ ИСПРАВЛЕНИЯ ===

      // Комнаты
      socket.on('create-room', (data, callback) => {
        const room = this.roomService.createRoom(data.name, socket.id);
        socket.join(room.id);
        socket.emit('room-created', room);
        // Отправляем обновленный список комнат ВСЕМ подключенным клиентам
        this.io.emit('room-list', this.roomService.getAllRooms());
        // Возвращаем результат вызывающему (для создания с callback)
        if (callback) {
          callback({ success: true, id: room.id, name: room.name });
        }
      });

      socket.on('join-room', (data, callback) => {
        console.log(`[SOCKET] ${socket.id} attempting to join room ${data.roomId} as ${data.name || 'Anonymous'}`); // <-- Добавить лог
        const room = this.roomService.joinRoom(data.roomId, socket.id, data.name);
        if (room) {
          console.log(`[SOCKET] ${socket.id} successfully joined room ${data.roomId}`); // <-- Добавить лог
          socket.join(data.roomId);
          socket.emit('room-joined', room);
          socket.to(data.roomId).emit('user-joined', { 
            user: { socketId: socket.id, name: data.name },
            room: room
          });
          // Отправляем обновленный список комнат ВСЕМ подключенным клиентам
          this.io.emit('room-list', this.roomService.getAllRooms());
          // callback должен возвращать данные для КОНКРЕТНОГО клиента
          if (callback) {
            callback({ 
              success: true, 
              room: {
                id: room.id,
                name: room.name,
                // ... другие поля комнаты, если нужны ...
              } 
            });
          }
        } else {
          console.log(`[SOCKET] ${socket.id} failed to join room ${data.roomId} - room not found`); // <-- Добавить лог
          if (callback) {
            callback({ success: false, error: 'Room not found' });
          }
        }
      });

      socket.on('leave-room', (data, callback) => {
        this.roomService.leaveRoom(data.roomId, socket.id);
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('user-left', { socketId: socket.id });
        // Отправляем обновленный список комнат ВСЕМ подключенным клиентам
        this.io.emit('room-list', this.roomService.getAllRooms());
        if (callback) {
          callback({ success: true });
        }
      });

      // Синхронизация видео (устаревшие обработчики, можно удалить)
      socket.on('play-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { isPlaying: true });
        socket.to(data.roomId).emit('video-play', data);
      });

      socket.on('pause-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { isPlaying: false });
        socket.to(data.roomId).emit('video-pause', data);
      });

      socket.on('seek-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { currentTime: data.time });
        socket.to(data.roomId).emit('video-seek', data);
      });

      socket.on('change-video', (data) => {
        this.roomService.updateRoomState(data.roomId, { currentVideo: data.videoUrl });
        socket.to(data.roomId).emit('video-changed', data);
      });

      // Keep-alive
      socket.on('keepalive', (data) => {
        // МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
        // if (data.roomId) {
        //   this.roomService.updateLastSeen(data.roomId, socket.id);
        // }
        console.log(`[SOCKET] Received keepalive from ${socket.id} for room ${data.roomId || 'N/A'}`);
      });

      // Обновление состояния пользователя
      socket.on('user-state-update', (data) => {
        // МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
        // if (data.roomId) {
        //   this.roomService.updateUserState(data.roomId, socket.id, data.state);
        //   // updateLastSeen вызывается внутри updateUserState, но теперь не нужен
        // }
        if (data.roomId) {
          this.roomService.updateUserState(data.roomId, socket.id, data.state);
          // updateLastSeen больше не вызывается
        }
      });

      // Отключение
      socket.on('disconnect', () => {
        console.log(`[SOCKET] User disconnected: ${socket.id}`);
        
        // Удаляем пользователя из всех комнат
        const rooms = this.roomService.getAllRooms();
        rooms.forEach(room => {
          if (room.users && room.users[socket.id]) { // Проверяем по объекту users
            console.log(`[SOCKET CLEANUP] Removing disconnected user ${socket.id} from room ${room.id}`);
            this.roomService.leaveRoom(room.id, socket.id);
            socket.to(room.id).emit('user-left', { socketId: socket.id });
          }
        });
        
        // Отправляем обновленный список комнат ВСЕМ подключенным клиентам
        this.io.emit('room-list', this.roomService.getAllRooms());
      });
    });
  }

  setupFileUpload() {
    // Папка для загрузок уже настроена в маршруте /upload
    // Создаем папку если не существует
    if (!fs.existsSync(config.videoDirectory)) {
      fs.mkdirSync(config.videoDirectory, { recursive: true });
    }
  }

  start(port = config.port || 3000) {
    this.server.listen(port, () => {
      console.log(`🚀 SyncWatch server running on port ${port}`);
      console.log(`📊 Admin panel available at: http://localhost:${port}/admin`);
      console.log(`🎥 Video directory: ${config.videoDirectory}`);
      console.log(`🔑 Default admin credentials: admin / admin`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('Shutting down server...');
      this.roomService.shutdown();
      this.server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  }
}

// Запуск сервера
if (require.main === module) {
  const server = new SyncWatchServer();
  server.start();
}

module.exports = SyncWatchServer;