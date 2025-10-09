// services/RoomService.js
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid'); // Для генерации коротких уникальных ID

class RoomService {
  constructor() {
    this.rooms = new Map();
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json');
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
              users: usersMap,
              currentVideo: roomData.currentVideo || null,
              currentTime: typeof roomData.currentTime === 'number' ? roomData.currentTime : 0,
              isPlaying: !!roomData.isPlaying,
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
          password: room.password, // Пароль хранится в файле (в открытом виде)
          users: usersObject,
          currentVideo: room.currentVideo,
          currentTime: room.currentTime,
          isPlaying: room.isPlaying,
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
        youtubeQueue: room.youtubeQueue || []
      });
    }
    return allRooms;
  }

  leaveRoom(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.users.delete(socketId);
      this.saveRoomsToFile();
    }
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

  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      if (updates.hasOwnProperty('currentVideo')) room.currentVideo = updates.currentVideo;
      if (updates.hasOwnProperty('currentTime')) room.currentTime = updates.currentTime;
      if (updates.hasOwnProperty('isPlaying')) room.isPlaying = updates.isPlaying;
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

  joinRoom(roomId, socketId, name, providedPassword = null) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    if (room.password !== null && room.password !== undefined) {
      if (providedPassword !== room.password) {
        return { success: false, error: 'Invalid password' };
      }
    }

    room.users.set(socketId, {
      name: name,
      socketId: socketId
    });

    this.saveRoomsToFile();

    return {
      success: true,
      room: this.getRoom(roomId)
    };
  }

  createRoom(name, ownerSocketId, password = null) {
    const id = nanoid(9); // Генерируем короткий уникальный ID, например: "7UsaCq0Qf"
    const newRoom = {
      id,
      name,
      ownerId: ownerSocketId,
      password,
      users: new Map(),
      currentVideo: null,
      currentTime: 0,
      isPlaying: false,
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

  shutdown() {
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;