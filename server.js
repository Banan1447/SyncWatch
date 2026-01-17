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
const { authenticateToken, isAdmin, isLocalhostOnly, initializeAuthService } = require('./middleware/auth');
const { logRequests, logClientRequest } = require('./middleware/logging');
const { createRateLimit, authRateLimit, fileRateLimit } = require('./middleware/rateLimit');

// Импорт маршрутов
const authRoutes = require('./routes/auth');
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
    // Инициализируем AuthService асинхронно
    this.adminService = null; // Будет инициализирован позже
    this.videoService = new VideoService(config.videoDir);
    this.fileService = new FileService(config.videoDir);

    this.roomUpdateInterval = null;
    this.roomStatesAutosaveInterval = null;
    this.ROOM_STATES_FILE = path.join(__dirname, 'json', 'room-states.json');
    this.setupFileUpload();
  }

  async initialize() {
    // Асинхронная инициализация AuthService
    await this.authService.initialize();

    // Инициализируем AuthService в middleware
    const { initializeAuthService } = require('./middleware/auth');
    await initializeAuthService();

    // Теперь создаем AdminService с инициализированными сервисами
    this.adminService = new AdminService(this.roomService, this.authService, this.transcodeService);

    this.setupMiddleware();
    this.setupRoutes();
    this.loadRoomStates();
    this.setupSocketIO();
    this.startRoomStatesAutosave();
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
    // Rate limiting для аутентификации
    this.app.use('/api/auth/login', authRateLimit);
    this.app.use('/api/auth/register', authRateLimit);
    this.app.use('/api/admin/auth/login', authRateLimit);

    // Динамический rate limiting для API (использует значение из конфигурации)
    this.app.use('/api', (req, res, next) => {
      const rateLimitValue = config.rateLimit && config.rateLimit.apiRequestsPerMinute !== undefined
        ? config.rateLimit.apiRequestsPerMinute
        : 100; // значение по умолчанию
      const dynamicRateLimit = createRateLimit(rateLimitValue, 60000);
      return dynamicRateLimit(req, res, next);
    });

    // Rate limiting для файловых операций
    this.app.use('/api/files', fileRateLimit);

    this.app.use('/api/auth', authRoutes);
    // Admin routes are defined directly in this file
    this.app.use('/api/metrics', metricsRoutes);
    this.app.use('/api/system', healthRoutes);
    this.app.use('/api/files', filesRoutes);
    this.app.use('/api/videos', videosRoutes);
    this.app.use('/api/transcode', transcodeRoutes);
    this.app.use('/api/rooms', roomsRoutes);

    // ✅ ИСПРАВЛЕНО: Админский логин (используется админкой)
    this.app.post('/api/admin/auth/login', async (req, res) => {
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

    // ✅ Обычный логин (используется обычными пользователями)
    this.app.post('/api/auth/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        const result = await this.authService.login(username, password);
        res.json(result);
      } catch (error) {
        res.status(401).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // ✅ ИСПРАВЛЕНО: Админский профиль (используется админкой)
    this.app.get('/api/admin/auth/profile', authenticateToken, isAdmin, (req, res) => {
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

    // ✅ Обычный профиль (используется обычными пользователями)
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
        const roomId = req.params.roomId;

        // Валидация входных данных
        if (!roomId || typeof roomId !== 'string' || roomId.length === 0) {
          return res.status(400).json({ success: false, error: 'Неверный ID комнаты' });
        }

        const result = this.adminService.deleteRoom(roomId);
        if (result.success) {
          this.io.emit('room-deleted', { roomId: roomId });
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

    // ✅ НОВОЕ: Удаление пользователя
    this.app.delete('/api/admin/users/:userId', authenticateToken, isAdmin, (req, res) => {
      try {
        const userId = req.params.userId;

        // Валидация входных данных
        if (!userId || typeof userId !== 'string' || userId.length === 0) {
          return res.status(400).json({ success: false, error: 'Неверный ID пользователя' });
        }

        const result = this.adminService.deleteUser(userId);
        if (result.success) {
          res.json({ success: true, message: result.message });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка удаления пользователя:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при удалении пользователя' });
      }
    });

    // ✅ НОВОЕ: Создание пользователя
    this.app.post('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
      try {
        const result = this.authService.createUser(req.body);
        res.status(201).json({ success: true, user: result });
      } catch (error) {
        console.error('[ADMIN API] Ошибка создания пользователя:', error);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ✅ НОВОЕ: Обновление пользователя
    this.app.put('/api/admin/users/:userId', authenticateToken, isAdmin, (req, res) => {
      try {
        const userId = req.params.userId;
        console.log('[ADMIN API] Update user request:', { userId, body: req.body });

        const result = this.authService.updateUser(userId, req.body);
        console.log('[ADMIN API] Update user result:', result);

        res.json({ success: true, user: result });
      } catch (error) {
        console.error('[ADMIN API] Ошибка обновления пользователя:', error);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ✅ НОВОЕ: Переключение статуса пользователя
    this.app.patch('/api/admin/users/:userId/toggle-status', authenticateToken, isAdmin, (req, res) => {
      try {
        const userId = req.params.userId;
        const isActive = this.authService.toggleUserStatus(userId);
        res.json({ success: true, isActive });
      } catch (error) {
        console.error('[ADMIN API] Ошибка изменения статуса пользователя:', error);
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ✅ НОВОЕ: Получение списка групп
    this.app.get('/api/admin/groups', authenticateToken, isAdmin, (req, res) => {
      try {
        const groups = this.authService.getAllGroups();
        res.json({ success: true, groups });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения списка групп:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении списка групп' });
      }
    });

    // API для управления комнатами
    this.app.post('/api/admin/rooms', authenticateToken, isAdmin, (req, res) => {
      try {
        const { name, password, allowedGroups } = req.body;

        if (!name || name.trim().length === 0) {
          return res.status(400).json({ success: false, error: 'Название комнаты обязательно' });
        }

        const room = this.roomService.createRoom(name.trim(), 'admin', password || null, allowedGroups);
        res.json({ success: true, room });
      } catch (error) {
        console.error('[ADMIN API] Ошибка создания комнаты:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при создании комнаты' });
      }
    });

    this.app.put('/api/admin/rooms/:roomId', authenticateToken, isAdmin, (req, res) => {
      try {
        const { roomId } = req.params;
        const { name, password, allowedGroups } = req.body;

        const result = this.roomService.updateRoom(roomId, {
          name: name?.trim(),
          password,
          allowedGroups
        });

        if (result.success) {
          res.json({ success: true, room: result.room });
        } else {
          res.status(404).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка обновления комнаты:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при обновлении комнаты' });
      }
    });

    // API для логов комнат
    this.app.get('/api/admin/rooms/:roomId/logs', authenticateToken, isAdmin, (req, res) => {
      try {
        const { roomId } = req.params;
        const { limit = 50 } = req.query;

        const logs = this.roomService.getRoomLogs(roomId, parseInt(limit));
        res.json({ success: true, logs });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения логов комнаты:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении логов комнаты' });
      }
    });

    // Создание новой группы
    this.app.post('/api/admin/groups', authenticateToken, isAdmin, (req, res) => {
      try {
        const { id, name, description, permissions, roomAccess } = req.body;

        if (!id || !name) {
          return res.status(400).json({ success: false, error: 'ID и название группы обязательны' });
        }

        const result = this.authService.createGroup({
          id: id.toLowerCase().trim(),
          name: name.trim(),
          description: description?.trim() || '',
          permissions: permissions || [],
          roomAccess: roomAccess || [],
          createdAt: new Date().toISOString()
        });

        if (result.success) {
          res.json({ success: true, group: result.group, message: 'Группа создана успешно' });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка создания группы:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при создании группы' });
      }
    });

    // Обновление группы
    this.app.put('/api/admin/groups/:groupId', authenticateToken, isAdmin, (req, res) => {
      try {
        const { groupId } = req.params;
        const { name, description, permissions, roomAccess } = req.body;

        console.log('[ADMIN API] Update group request:', { groupId, name, description, permissions, roomAccess });

        const result = this.authService.updateGroup(groupId, {
          name: name?.trim(),
          description: description?.trim(),
          permissions,
          roomAccess
        });

        console.log('[ADMIN API] Update group result:', result);

        if (result.success) {
          res.json({ success: true, group: result.group, message: 'Группа обновлена успешно' });
        } else {
          console.log('[ADMIN API] Update group failed:', result.error);
          res.status(404).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка обновления группы:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при обновлении группы' });
      }
    });

    // Удаление группы
    this.app.delete('/api/admin/groups/:groupId', authenticateToken, isAdmin, (req, res) => {
      try {
        const { groupId } = req.params;

        // Нельзя удалять системные группы
        if (['admin', 'moderator', 'user'].includes(groupId)) {
          return res.status(400).json({ success: false, error: 'Нельзя удалять системные группы' });
        }

        const result = this.authService.deleteGroup(groupId);

        if (result.success) {
          res.json({ success: true, message: 'Группа удалена успешно' });
        } else {
          res.status(404).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка удаления группы:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при удалении группы' });
      }
    });

    // API для работы с конфигурацией
    this.app.get('/api/admin/config', authenticateToken, isAdmin, (req, res) => {
      try {
        // Возвращаем текущую конфигурацию
        const currentConfig = {
          port: config.port,
          jwtSecret: config.jwtSecret ? '[HIDDEN]' : null, // Не показываем секрет
          videoDirectory: config.videoDirectory,
          transcode: config.transcode,
          rooms: config.rooms,
          rateLimit: config.rateLimit
        };
        res.json({ success: true, config: currentConfig });
      } catch (error) {
        console.error('[ADMIN API] Ошибка получения конфигурации:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при получении конфигурации' });
      }
    });

    this.app.put('/api/admin/config', authenticateToken, isAdmin, (req, res) => {
      try {
        const { transcode, rooms } = req.body;

        // Убедимся, что объекты config существуют
        if (!config.transcode) {
          config.transcode = {};
        }
        if (!config.rooms) {
          config.rooms = {};
        }

        // Обновляем только разрешенные поля
        if (transcode) {
          if (typeof transcode.maxConcurrentJobs === 'number') {
            config.transcode.maxConcurrentJobs = transcode.maxConcurrentJobs;
          }
          if (transcode.tempDirectory && typeof transcode.tempDirectory === 'string') {
            config.transcode.tempDirectory = transcode.tempDirectory;
          }
        }

        if (rooms) {
          if (typeof rooms.cleanupInterval === 'number') {
            config.rooms.cleanupInterval = rooms.cleanupInterval;
          }
          if (typeof rooms.maxUsersPerRoom === 'number') {
            config.rooms.maxUsersPerRoom = rooms.maxUsersPerRoom;
          }
        }

        // Обработка rate limiting
        if (req.body.rateLimit) {
          if (!config.rateLimit) {
            config.rateLimit = {};
          }
          if (typeof req.body.rateLimit.apiRequestsPerMinute === 'number') {
            config.rateLimit.apiRequestsPerMinute = req.body.rateLimit.apiRequestsPerMinute;
          }
        }

        // Сохраняем конфигурацию в файл
        config.save();
        console.log('[ADMIN API] Конфигурация обновлена и сохранена:', { transcode: config.transcode, rooms: config.rooms, rateLimit: config.rateLimit });

        res.json({ success: true, message: 'Конфигурация обновлена успешно' });
      } catch (error) {
        console.error('[ADMIN API] Ошибка обновления конфигурации:', error);
        console.error('[ADMIN API] Stack trace:', error.stack);
        res.status(500).json({ success: false, error: 'Ошибка сервера при обновлении конфигурации' });
      }
    });

    this.app.post('/api/admin/config/reload', authenticateToken, isAdmin, (req, res) => {
      try {
        // Перезагрузка конфигурации - в будущем можно добавить перезапуск сервисов
        console.log('[ADMIN API] Конфигурация перезагружена');
        res.json({ success: true, message: 'Конфигурация перезагружена успешно' });
      } catch (error) {
        console.error('[ADMIN API] Ошибка перезагрузки конфигурации:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при перезагрузке конфигурации' });
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

    // ✅ НОВОЕ: Отмена задания транскодирования
    this.app.delete('/api/admin/transcode/queue/:jobId', authenticateToken, isAdmin, (req, res) => {
      try {
        const jobId = req.params.jobId;

        // Валидация входных данных
        if (!jobId || isNaN(Number(jobId))) {
          return res.status(400).json({ success: false, error: 'Неверный ID задания' });
        }

        const result = this.adminService.cancelTranscodeJob(jobId);
        if (result.success) {
          res.json({ success: true, message: result.message });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка отмены задания транскодирования:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при отмене задания транскодирования' });
      }
    });

    // ✅ НОВОЕ: Удаление шаблона транскодирования
    this.app.delete('/api/admin/transcode/templates/:templateId', authenticateToken, isAdmin, (req, res) => {
      try {
        const templateId = req.params.templateId;

        // Валидация входных данных
        if (!templateId || typeof templateId !== 'string' || templateId.length === 0) {
          return res.status(400).json({ success: false, error: 'Неверный ID шаблона' });
        }

        const result = this.adminService.deleteTranscodeTemplate(templateId);
        if (result.success) {
          res.json({ success: true, message: result.message });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        console.error('[ADMIN API] Ошибка удаления шаблона транскодирования:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера при удалении шаблона транскодирования' });
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
        fileSize: 1024 * 1024 * 1024 * 1024 // 1TB limit
      },
      fileFilter: (req, file, cb) => {
        if (file.fieldname !== 'video') {
          return cb(new Error('Unexpected field'), false);
        }

        // Проверяем MIME тип
        const allowedMimes = ['video/mp4', 'video/mpeg', 'video/avi', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
        if (!allowedMimes.includes(file.mimetype)) {
          return cb(new Error('Invalid file type. Only video files are allowed.'), false);
        }

        cb(null, true);
      }
    });

    this.app.post('/upload', upload.single('video'), (req, res) => {
      if (!req.file) {
        console.error('Upload error: No file received or file filter rejected it.');
        return res.status(400).json({ success: false, error: 'No file uploaded or invalid field name. Expected field "video".' });
      }

      // Генерируем уникальное имя файла, если файл уже существует
      const parsedPath = path.parse(req.file.originalname);
      let finalPath = path.join(config.videoDir, req.file.originalname);
      let counter = 1;

      while (fs.existsSync(finalPath)) {
        const newName = `${parsedPath.name}_${counter}${parsedPath.ext}`;
        finalPath = path.join(config.videoDir, newName);
        counter++;
      }

      fs.rename(req.file.path, finalPath, (err) => {
        if (err) {
          console.error('Upload error:', err);
          // Удаляем временный файл в случае ошибки
          fs.unlink(req.file.path, () => {});
          return res.status(500).json({ success: false, error: 'Failed to save file' });
        }

        res.json({
          success: true,
          message: 'File uploaded successfully',
          filename: path.basename(finalPath),
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

        const room = this.roomService.getRoom(roomId);
        if (!room) return;

        // ✅ ИСПРАВЛЕНО: Проверяем, не достигло ли видео конца
        const duration = room.duration || 0;
        const videoEnded = duration > 0 && currentTime >= duration - 0.5;
        
        // Если видео закончилось, устанавливаем isPlaying в false
        const actualIsPlaying = isPlaying && !videoEnded;
        const actualCurrentTime = videoEnded ? duration : currentTime;

        this.roomService.updateRoomState(roomId, {
          currentTime: actualCurrentTime,
          isPlaying: actualIsPlaying,
          currentVideo: videoFile
        });

        this.io.emit('room-update', {
          roomId: roomId,
          currentTime: actualCurrentTime,
          isPlaying: actualIsPlaying,
          videoTitle: videoFile ? videoFile.split('/').pop() : null,
          duration: duration
        });
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

      // ✅ ИСПРАВЛЕНО: используем room.hasPassword напрямую
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
            hasPassword: room.hasPassword, // ← ЕДИНСТВЕННОЕ ИЗМЕНЕНИЕ
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
        
        // ✅ ИСПРАВЛЕНО: Останавливаем воспроизведение при окончании видео
        const room = this.roomService.getRoom(roomId);
        if (room) {
          this.roomService.updateRoomState(roomId, { 
            isPlaying: false,
            currentTime: room.duration || 0
          });
        }
        
        // Проверяем очередь YouTube (если есть)
        const next = this.roomService.getNextVideo(roomId);
        if (next && next.type === 'youtube') {
          this.roomService.updateRoomState(roomId, { currentVideo: next.id });
          this.io.to(roomId).emit('video-changed', { videoUrl: next.id, type: 'youtube' });
        } else {
          // Для обычных видео просто останавливаем воспроизведение
          this.io.to(roomId).emit('video-pause', { roomId: roomId, time: room?.duration || 0 });
        }
        const updatedRoom = this.roomService.getRoom(roomId);
        if (updatedRoom) {
          this.io.to(roomId).emit('queue-updated', updatedRoom.youtubeQueue || []);
        }
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
        const room = this.roomService.getRoom(data.roomId);
        if (!room) return;
        
        // ✅ ИСПРАВЛЕНО: Проверяем, не достигло ли видео конца
        const duration = room.duration || 0;
        const currentTime = data.time || room.currentTime || 0;
        const videoEnded = duration > 0 && currentTime >= duration - 0.5;
        
        if (videoEnded) {
          // Видео закончилось - не воспроизводим
          this.roomService.updateRoomState(data.roomId, { 
            isPlaying: false,
            currentTime: duration
          });
          socket.to(data.roomId).emit('video-pause', { roomId: data.roomId, time: duration });
        } else {
          this.roomService.updateRoomState(data.roomId, { 
            isPlaying: true,
            currentTime: currentTime
          });
          socket.to(data.roomId).emit('video-play', data);
        }
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
            // ✅ ИСПРАВЛЕНО: Проверяем, не достигло ли видео конца
            const duration = typeof room.duration === 'number' ? room.duration : 0;
            const currentTime = typeof room.currentTime === 'number' ? room.currentTime : 0;
            const videoEnded = duration > 0 && currentTime >= duration - 0.5;
            const actualIsPlaying = !!room.isPlaying && !videoEnded;
            const actualCurrentTime = videoEnded ? duration : currentTime;

            this.io.emit('room-update', {
              roomId: room.id,
              currentTime: actualCurrentTime,
              isPlaying: actualIsPlaying,
              videoTitle: room.currentVideo ? room.currentVideo.split('/').pop() : null,
              duration: duration
            });

            // ✅ ИСПРАВЛЕНО: Если видео закончилось, обновляем состояние на сервере
            if (videoEnded && room.isPlaying) {
              this.roomService.updateRoomState(room.id, {
                isPlaying: false,
                currentTime: duration
              });
            }
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

  async start(port = config.port || 3000) {
    // Инициализируем асинхронно
    await this.initialize();

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