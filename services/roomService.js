// services/RoomService.js
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid'); // Для генерации коротких уникальных ID

class RoomService {
  constructor() {
    this.rooms = new Map();
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json');
    this.roomLogs = new Map(); // Логи для каждой комнаты
    this.loadRoomsFromFile();
  }

  loadRoomsFromFile() {
    try {
      if (fs.existsSync(this.roomsFilePath)) {
        const data = fs.readFileSync(this.roomsFilePath, 'utf8');
        const roomsData = JSON.parse(data);

        if (Array.isArray(roomsData)) {
          roomsData.forEach(roomData => {
            const usersMap = new Map();
            if (roomData.users && typeof roomData.users === 'object' && !Array.isArray(roomData.users)) {
              Object.entries(roomData.users).forEach(([socketId, userData]) => {
                usersMap.set(socketId, userData);
              });
            }

            const youtubeQueue = Array.isArray(roomData.youtubeQueue)
              ? roomData.youtubeQueue
              : [];

            this.rooms.set(roomData.id, {
              id: roomData.id,
              name: roomData.name,
              ownerId: roomData.ownerId,
              password: roomData.password || null,
              allowedGroups: Array.isArray(roomData.allowedGroups) ? roomData.allowedGroups : [],
              users: usersMap,
              currentVideo: roomData.currentVideo || null,
              currentTime: typeof roomData.currentTime === 'number' ? roomData.currentTime : 0,
              isPlaying: !!roomData.isPlaying,
              duration: typeof roomData.duration === 'number' ? roomData.duration : 0, // ← добавлено
              youtubeQueue
            });
          });

          console.log(`[RoomService] Загружено ${this.rooms.size} комнат из файла.`);
        } else {
          console.warn(`[RoomService] Файл rooms.json содержит некорректные данные (ожидается массив).`);
        }
      } else {
        console.log(`[RoomService] Файл rooms.json не найден — будет создан при первой записи.`);
      }
    } catch (error) {
      console.error(`[RoomService] Ошибка при загрузке комнат из файла:`, error.message);
      this.rooms = new Map();
    }
  }

  saveRoomsToFile() {
    try {
      const dir = path.dirname(this.roomsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const roomsArray = Array.from(this.rooms.values()).map(room => {
        const usersObject = {};
        if (room.users && typeof room.users.forEach === 'function') {
          room.users.forEach((userData, socketId) => {
            usersObject[socketId] = userData;
          });
        }

        return {
          id: room.id,
          name: room.name,
          ownerId: room.ownerId,
          password: room.password,
          users: usersObject,
          currentVideo: room.currentVideo,
          currentTime: room.currentTime,
          isPlaying: room.isPlaying,
          duration: room.duration, // ← сохраняем
          youtubeQueue: room.youtubeQueue || []
        };
      });

      fs.writeFileSync(this.roomsFilePath, JSON.stringify(roomsArray, null, 2), 'utf8');
      console.log(`[ROOMS.JSON] Updated at ${new Date().toISOString()}`);
    } catch (error) {
      console.error(`[RoomService] Ошибка при сохранении комнат в файл:`, error.message);
    }
  }

  // Возвращает данные комнаты БЕЗ пароля (безопасно для клиента)
  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const usersObject = {};
    if (room.users && typeof room.users.forEach === 'function') {
      room.users.forEach((userData, socketId) => {
        usersObject[socketId] = userData;
      });
    }

    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      hasPassword: !!room.password,
      users: usersObject,
      currentVideo: room.currentVideo,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      duration: room.duration, // ← возвращаем
      youtubeQueue: room.youtubeQueue || []
    };
  }

  getAllRooms() {
    const allRooms = [];
    for (const [id, room] of this.rooms.entries()) {
      const usersObject = {};
      if (room.users && typeof room.users.forEach === 'function') {
        room.users.forEach((userData, socketId) => {
          usersObject[socketId] = userData;
        });
      }

      allRooms.push({
        id: room.id,
        name: room.name,
        ownerId: room.ownerId,
        hasPassword: !!room.password,
        users: usersObject,
        currentVideo: room.currentVideo,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
        duration: room.duration, // ← возвращаем
        youtubeQueue: room.youtubeQueue || []
      });
    }
    return allRooms;
  }

  leaveRoom(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room) {
      const user = room.users.get(socketId);
      const userName = user ? user.name : 'Unknown';

      room.users.delete(socketId);

      // Логируем выход пользователя
      this.logAction(roomId, 'user_left', socketId, userName, {
        userCount: room.users.size
      });

      this.saveRoomsToFile();
    }
  }

  // Обновление комнаты
  updateRoom(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    // Обновляем только разрешенные поля
    if (updates.name !== undefined) room.name = updates.name;
    if (updates.password !== undefined) room.password = updates.password;
    if (updates.allowedGroups !== undefined) room.allowedGroups = Array.isArray(updates.allowedGroups) ? updates.allowedGroups : [];

    this.saveRoomsToFile();

    return { success: true, room: this.getRoom(roomId) };
  }

  deleteRoom(roomId, requestingSocketId) {
    console.log(`[RoomService DEBUG] Попытка удаления комнаты ${roomId} пользователем ${requestingSocketId}`);
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      console.log(`[RoomService] Удалена комната ${roomId} пользователем ${requestingSocketId}`);
      this.saveRoomsToFile();
      return { success: true, message: `Комната ${roomId} удалена` };
    } else {
      console.log(`[RoomService] Попытка удаления несуществующей комнаты ${roomId}.`);
      return { success: false, message: `Комната ${roomId} не найдена` };
    }
  }

  // ✅ ИСПРАВЛЕНО: теперь обновляются ВСЕ поля, включая duration
  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Обновляем только разрешённые поля
      const allowedFields = ['currentVideo', 'currentTime', 'isPlaying', 'duration'];
      for (const field of allowedFields) {
        if (updates.hasOwnProperty(field)) {
          room[field] = updates[field];
        }
      }
      this.saveRoomsToFile();
    }
  }

  updateUserState(roomId, socketId, updates) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      Object.assign(user, updates);
    }
  }

  joinRoom(roomId, socketId, name, providedPassword = null, userGroups = []) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    // Проверяем пароль
    if (room.password !== null && room.password !== undefined) {
      if (providedPassword !== room.password) {
        return { success: false, error: 'Invalid password' };
      }
    }

    // Проверяем доступ по группам
    if (room.allowedGroups && room.allowedGroups.length > 0) {
      const hasAccess = room.allowedGroups.some(groupId =>
        userGroups && userGroups.includes(groupId)
      );

      if (!hasAccess) {
        return { success: false, error: 'Access denied: insufficient permissions' };
      }
    }

    room.users.set(socketId, {
      name: name,
      socketId: socketId
    });

    // Логируем присоединение пользователя
    this.logAction(roomId, 'user_joined', socketId, name, {
      userCount: room.users.size,
      userGroups: userGroups
    });

    this.saveRoomsToFile();

    return {
      success: true,
      room: this.getRoom(roomId)
    };
  }

  createRoom(name, ownerSocketId, password = null, allowedGroups = []) {
    const id = nanoid(9);
    const newRoom = {
      id,
      name,
      ownerId: ownerSocketId,
      password,
      allowedGroups: Array.isArray(allowedGroups) ? allowedGroups : [],
      users: new Map(),
      currentVideo: null,
      currentTime: 0,
      isPlaying: false,
      duration: 0, // ← инициализируем
      youtubeQueue: []
    };
    this.rooms.set(id, newRoom);
    this.saveRoomsToFile();
    console.log(`[RoomService] Создана комната ${id} пользователем ${ownerSocketId}`);
    return newRoom;
  }

  // === МЕТОДЫ ДЛЯ УПРАВЛЕНИЯ ОЧЕРЕДЬЮ YOUTUBE ===

  addVideoToQueue(roomId, video) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.youtubeQueue.push(video);
      this.saveRoomsToFile();
      return true;
    }
    return false;
  }

  removeVideoFromQueue(roomId, index) {
    const room = this.rooms.get(roomId);
    if (room && index >= 0 && index < room.youtubeQueue.length) {
      room.youtubeQueue.splice(index, 1);
      this.saveRoomsToFile();
      return true;
    }
    return false;
  }

  clearQueue(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.youtubeQueue = [];
      this.saveRoomsToFile();
      return true;
    }
    return false;
  }

  getNextVideo(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.youtubeQueue.length > 0) {
      const next = room.youtubeQueue.shift();
      this.saveRoomsToFile();
      return next;
    }
    return null;
  }

  // Логирование действий в комнате
  logAction(roomId, action, userId, userName, details = {}) {
    if (!this.roomLogs.has(roomId)) {
      this.roomLogs.set(roomId, []);
    }

    const logEntry = {
      id: nanoid(),
      timestamp: new Date().toISOString(),
      action,
      userId,
      userName,
      details
    };

    const roomLogs = this.roomLogs.get(roomId);
    roomLogs.push(logEntry);

    // Ограничиваем количество логов (последние 1000 записей)
    if (roomLogs.length > 1000) {
      roomLogs.splice(0, roomLogs.length - 1000);
    }

    console.log(`[ROOM LOG] ${roomId}: ${userName} (${userId}) - ${action}`, details);
  }

  // Получение логов комнаты
  getRoomLogs(roomId, limit = 50) {
    const roomLogs = this.roomLogs.get(roomId) || [];
    return roomLogs.slice(-limit); // Возвращаем последние логи
  }

  // Очистка логов комнаты
  clearRoomLogs(roomId) {
    this.roomLogs.delete(roomId);
  }

  shutdown() {
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;