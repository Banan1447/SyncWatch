// services/adminService.js
const fs = require('fs');
const path = require('path');

class AdminService {
  constructor(roomService, authService, transcodeService) {
    // ✅ ИСПРАВЛЕНО: Используем правильные пути к файлам
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json');
    this.usersFilePath = path.join(__dirname, '..', 'users.json');
    this.transcodeQueuePath = path.join(__dirname, '..', 'transcode-queue.json');
    this.transcodeTemplatesPath = path.join(__dirname, '..', 'transcode-templates.json');
    
    // ✅ НОВОЕ: Сохраняем ссылки на сервисы для получения реальных данных
    this.roomService = roomService;
    this.authService = authService;
    this.transcodeService = transcodeService;
  }

  // Получение реальной статистики
  getStats() {
    try {
      // ✅ ИСПРАВЛЕНО: Используем реальные сервисы для получения данных
      const allRooms = this.roomService ? this.roomService.getAllRooms() : [];
      const users = this.authService ? this.authService.getAllUsers() : [];
      const transcodeQueue = this.transcodeService ? this.transcodeService.getQueueWithNames() : [];
      const transcodeTemplates = this.transcodeService ? this.transcodeService.getTemplatesAsArray() : [];

      // Подсчет активных пользователей из комнат
      let activeUsers = 0;
      allRooms.forEach(room => {
        if (room.users && typeof room.users === 'object') {
          activeUsers += Object.keys(room.users).length;
        }
      });

      // Подсчет активных заданий транскодирования
      const activeJobs = transcodeQueue.filter(job => 
        job.status === 'processing' || job.status === 'pending'
      ).length;

      return {
        rooms: {
          total: allRooms.length,
          active: allRooms.filter(room => {
            if (room.users && typeof room.users === 'object') {
              return Object.keys(room.users).length > 0;
            }
            return false;
          }).length
        },
        users: {
          total: users.length,
          active: activeUsers,
          registered: users.length
        },
        transcode: {
          totalJobs: transcodeQueue.length,
          activeJobs: activeJobs,
          completedJobs: transcodeQueue.filter(job => job.status === 'completed').length,
          templates: transcodeTemplates.length
        },
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения статистики:', error);
      return {
        rooms: { total: 0, active: 0 },
        users: { total: 0, active: 0, registered: 0 },
        transcode: { totalJobs: 0, activeJobs: 0, completedJobs: 0, templates: 0 },
        system: { uptime: 0, memory: {}, timestamp: new Date().toISOString() }
      };
    }
  }

  // Получение списка всех комнат
  getAllRooms() {
    try {
      // ✅ ИСПРАВЛЕНО: Используем RoomService для получения реальных данных
      if (this.roomService) {
        const allRooms = this.roomService.getAllRooms();
        return allRooms.map(room => ({
          id: room.id,
          name: room.name,
          users: room.users && typeof room.users === 'object' ? Object.keys(room.users).length : 0,
          allowedGroups: room.allowedGroups || [],
          currentVideo: room.currentVideo || null,
          createdAt: room.createdAt || new Date().toISOString(),
          hasPassword: room.password !== null && room.password !== undefined
        }));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения списка комнат:', error);
      return [];
    }
  }

  // Получение детальной информации о комнате
  getRoomDetails(roomId) {
    try {
      // ✅ ИСПРАВЛЕНО: Используем RoomService
      if (this.roomService) {
        const room = this.roomService.getRoom(roomId);
        if (!room) return null;

        return {
          id: roomId,
          name: room.name,
          users: room.users && typeof room.users === 'object' 
            ? Object.entries(room.users).map(([socketId, user]) => ({
                socketId,
                name: user.name || user.displayName || `User-${socketId.substring(0, 8)}`,
                ...user
              }))
            : [],
          currentVideo: room.currentVideo || null,
          currentTime: room.currentTime || 0,
          isPlaying: room.isPlaying || false,
          duration: room.duration || 0,
          hasPassword: room.hasPassword || false
        };
      }
      return null;
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения деталей комнаты:', error);
      return null;
    }
  }

  // Удаление комнаты
  deleteRoom(roomId) {
    try {
      // ✅ ИСПРАВЛЕНО: Используем RoomService для удаления
      if (this.roomService) {
        const result = this.roomService.deleteRoom(roomId, 'admin');
        if (result.success) {
          console.log(`[ADMIN SERVICE] Комната ${roomId} удалена администратором`);
          return { success: true, message: 'Комната успешно удалена' };
        }
        return result;
      }
      return { success: false, error: 'RoomService недоступен' };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка удаления комнаты:', error);
      return { success: false, error: 'Ошибка при удалении комнаты' };
    }
  }

  // Получение списка пользователей
  getAllUsers() {
    try {
      // ✅ ИСПРАВЛЕНО: Используем AuthService
      if (this.authService) {
        return this.authService.getAllUsers();
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения списка пользователей:', error);
      return [];
    }
  }

  // ✅ НОВОЕ: Удаление пользователя
  deleteUser(userId) {
    try {
      if (this.authService) {
        const user = this.authService.getUserById(userId);
        if (!user) {
          return { success: false, error: 'Пользователь не найден' };
        }
        if (user.role === 'admin') {
          return { success: false, error: 'Нельзя удалить администратора' };
        }
        const deleted = this.authService.deleteUser(user.username);
        if (deleted) {
          console.log(`[ADMIN SERVICE] Пользователь ${userId} удален администратором`);
          return { success: true, message: 'Пользователь успешно удален' };
        }
        return { success: false, error: 'Ошибка при удалении пользователя' };
      }
      return { success: false, error: 'AuthService недоступен' };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка удаления пользователя:', error);
      return { success: false, error: 'Ошибка при удалении пользователя' };
    }
  }

  // Получение очереди транскодирования
  getTranscodeQueue() {
    try {
      // ✅ ИСПРАВЛЕНО: Используем TranscodeService
      if (this.transcodeService) {
        const queue = this.transcodeService.getQueueWithNames();
        return queue.map(job => ({
          id: job.id,
          fileId: job.fileId,
          outputFile: job.outputFile,
          templateId: job.templateId,
          templateName: job.templateName,
          status: job.status,
          progress: job.progress,
          error: job.error,
          createdAt: new Date().toISOString() // Добавляем дату создания
        }));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения очереди транскодирования:', error);
      return [];
    }
  }

  // Получение шаблонов транскодирования
  getTranscodeTemplates() {
    try {
      // ✅ ИСПРАВЛЕНО: Используем TranscodeService
      if (this.transcodeService) {
        const templates = this.transcodeService.getTemplatesAsArray();
        return templates.map(template => ({
          id: template.id,
          name: template.name,
          description: template.description || '',
          command: template.command,
          createdAt: new Date().toISOString()
        }));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения шаблонов транскодирования:', error);
      return [];
    }
  }

  // ✅ НОВОЕ: Отмена задания транскодирования
  cancelTranscodeJob(jobId) {
    try {
      if (this.transcodeService) {
        const cancelled = this.transcodeService.cancelJob(Number(jobId));
        if (cancelled) {
          console.log(`[ADMIN SERVICE] Задание транскодирования ${jobId} отменено администратором`);
          return { success: true, message: 'Задание успешно отменено' };
        }
        return { success: false, error: 'Задание не найдено или не может быть отменено' };
      }
      return { success: false, error: 'TranscodeService недоступен' };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка отмены задания транскодирования:', error);
      return { success: false, error: 'Ошибка при отмене задания' };
    }
  }

  // ✅ НОВОЕ: Удаление шаблона транскодирования
  deleteTranscodeTemplate(templateId) {
    try {
      if (this.transcodeService) {
        const deleted = this.transcodeService.deleteTemplate(templateId);
        if (deleted) {
          console.log(`[ADMIN SERVICE] Шаблон транскодирования ${templateId} удален администратором`);
          return { success: true, message: 'Шаблон успешно удален' };
        }
        return { success: false, error: 'Шаблон не найден или является системным' };
      }
      return { success: false, error: 'TranscodeService недоступен' };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка удаления шаблона транскодирования:', error);
      return { success: false, error: error.message || 'Ошибка при удалении шаблона' };
    }
  }

  // Вспомогательные методы для загрузки данных
  loadRooms() {
    try {
      if (fs.existsSync(this.roomsFilePath)) {
        return JSON.parse(fs.readFileSync(this.roomsFilePath, 'utf8'));
      }
      return {};
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка загрузки комнат:', error);
      return {};
    }
  }

  loadUsers() {
    try {
      if (fs.existsSync(this.usersFilePath)) {
        return JSON.parse(fs.readFileSync(this.usersFilePath, 'utf8'));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка загрузки пользователей:', error);
      return [];
    }
  }

  loadTranscodeQueue() {
    try {
      if (fs.existsSync(this.transcodeQueuePath)) {
        return JSON.parse(fs.readFileSync(this.transcodeQueuePath, 'utf8'));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка загрузки очереди транскодирования:', error);
      return [];
    }
  }

  loadTranscodeTemplates() {
    try {
      if (fs.existsSync(this.transcodeTemplatesPath)) {
        return JSON.parse(fs.readFileSync(this.transcodeTemplatesPath, 'utf8'));
      }
      return [];
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка загрузки шаблонов транскодирования:', error);
      return [];
    }
  }

  saveRooms(rooms) {
    try {
      fs.writeFileSync(this.roomsFilePath, JSON.stringify(rooms, null, 2));
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка сохранения комнат:', error);
    }
  }
}

module.exports = AdminService;