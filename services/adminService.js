// services/adminService.js
const fs = require('fs');
const path = require('path');

class AdminService {
  constructor() {
    this.roomsFilePath = path.join(__dirname, '..', 'rooms.json');
    this.usersFilePath = path.join(__dirname, '..', 'users.json');
    this.transcodeQueuePath = path.join(__dirname, '..', 'transcode-queue.json');
    this.transcodeTemplatesPath = path.join(__dirname, '..', 'transcode-templates.json');
  }

  // Получение реальной статистики
  getStats() {
    try {
      const rooms = this.loadRooms();
      const users = this.loadUsers();
      const transcodeQueue = this.loadTranscodeQueue();
      const transcodeTemplates = this.loadTranscodeTemplates();

      // Подсчет активных пользователей
      let activeUsers = 0;
      Object.values(rooms).forEach(room => {
        activeUsers += Object.keys(room.users || {}).length;
      });

      // Подсчет активных заданий транскодирования
      const activeJobs = transcodeQueue.filter(job => 
        job.status === 'processing' || job.status === 'pending'
      ).length;

      return {
        rooms: {
          total: Object.keys(rooms).length,
          active: Object.keys(rooms).filter(roomId => 
            Object.keys(rooms[roomId].users || {}).length > 0
          ).length
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
      const rooms = this.loadRooms();
      return Object.entries(rooms).map(([id, room]) => ({
        id,
        name: room.name,
        users: Object.keys(room.users || {}).length,
        currentVideo: room.currentVideo,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        state: room.state
      }));
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения списка комнат:', error);
      return [];
    }
  }

  // Получение детальной информации о комнате
  getRoomDetails(roomId) {
    try {
      const rooms = this.loadRooms();
      const room = rooms[roomId];
      if (!room) return null;

      return {
        id: roomId,
        name: room.name,
        users: room.users ? Object.entries(room.users).map(([socketId, user]) => ({
          socketId,
          name: user.name,
          status: user.status,
          position: user.position,
          lastUpdated: user.userState?.lastUpdated
        })) : [],
        currentVideo: room.currentVideo,
        state: room.state,
        chat: room.chat || [],
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения деталей комнаты:', error);
      return null;
    }
  }

  // Удаление комнаты
  deleteRoom(roomId) {
    try {
      const rooms = this.loadRooms();
      if (!rooms[roomId]) {
        return { success: false, error: 'Комната не найдена' };
      }

      delete rooms[roomId];
      this.saveRooms(rooms);
      
      console.log(`[ADMIN SERVICE] Комната ${roomId} удалена администратором`);
      return { success: true, message: 'Комната успешно удалена' };
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка удаления комнаты:', error);
      return { success: false, error: 'Ошибка при удалении комнаты' };
    }
  }

  // Получение списка пользователей
  getAllUsers() {
    try {
      const users = this.loadUsers();
      return users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      }));
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения списка пользователей:', error);
      return [];
    }
  }

  // Получение очереди транскодирования
  getTranscodeQueue() {
    try {
      return this.loadTranscodeQueue();
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения очереди транскодирования:', error);
      return [];
    }
  }

  // Получение шаблонов транскодирования
  getTranscodeTemplates() {
    try {
      return this.loadTranscodeTemplates();
    } catch (error) {
      console.error('[ADMIN SERVICE] Ошибка получения шаблонов транскодирования:', error);
      return [];
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