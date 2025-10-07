// services/roomService.js
const fs = require('fs');
const path = require('path');

class RoomService {
  constructor() {
    this.rooms = new Map();
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json');
    this.loadRoomsFromFile();
    // ❌ УДАЛЁН: this.saveRoomsToFile() — он не нужен при старте
  }

  loadRoomsFromFile() {
    try {
      if (fs.existsSync(this.roomsFilePath)) {
        const data = fs.readFileSync(this.roomsFilePath, 'utf8');
        const roomsData = JSON.parse(data);

        if (Array.isArray(roomsData)) {
          roomsData.forEach(roomData => {
            // Восстанавливаем пользователей как Map
            const usersMap = new Map();
            if (roomData.users && typeof roomData.users === 'object' && !Array.isArray(roomData.users)) {
              Object.entries(roomData.users).forEach(([socketId, userData]) => {
                usersMap.set(socketId, userData);
              });
            }

            // ВАЖНО: копируем ВСЕ поля из файла, включая currentVideo, currentTime, isPlaying
            this.rooms.set(roomData.id, {
              id: roomData.id,
              name: roomData.name,
              ownerId: roomData.ownerId,
              users: usersMap,
              currentVideo: roomData.currentVideo || null,
              currentTime: typeof roomData.currentTime === 'number' ? roomData.currentTime : 0,
              isPlaying: !!roomData.isPlaying
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
      this.rooms = new Map(); // сбрасываем в пустое состояние при ошибке
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
        room.users.forEach((userData, socketId) => {
          usersObject[socketId] = userData;
        });

        return {
          id: room.id,
          name: room.name,
          ownerId: room.ownerId,
          users: usersObject,
          currentVideo: room.currentVideo,
          currentTime: room.currentTime,
          isPlaying: room.isPlaying
        };
      });

      fs.writeFileSync(this.roomsFilePath, JSON.stringify(roomsArray, null, 2), 'utf8');
      console.log(`[RoomService] Сохранено ${roomsArray.length} комнат в файл.`);
    } catch (error) {
      console.error(`[RoomService] Ошибка при сохранении комнат в файл:`, error.message);
    }
  }

  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const usersObject = {};
    room.users.forEach((userData, socketId) => {
      usersObject[socketId] = userData;
    });

    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      users: usersObject,
      currentVideo: room.currentVideo,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying
    };
  }

  getAllRooms() {
    const allRooms = [];
    for (const [id, room] of this.rooms.entries()) {
      const usersObject = {};
      room.users.forEach((userData, socketId) => {
        usersObject[socketId] = userData;
      });

      allRooms.push({
        id: room.id,
        name: room.name,
        ownerId: room.ownerId,
        users: usersObject,
        currentVideo: room.currentVideo,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying
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

  // ✅ КЛЮЧЕВОЙ МЕТОД: сохраняет изменения на диск
  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Обновляем только разрешённые поля
      if (updates.hasOwnProperty('currentVideo')) room.currentVideo = updates.currentVideo;
      if (updates.hasOwnProperty('currentTime')) room.currentTime = updates.currentTime;
      if (updates.hasOwnProperty('isPlaying')) room.isPlaying = updates.isPlaying;

      this.saveRoomsToFile(); // 🔥 Сохраняем сразу!
    }
  }

  updateUserState(roomId, socketId, updates) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      Object.assign(user, updates);
      // Состояние пользователя — временное, не сохраняем в файл
    }
  }

  joinRoom(roomId, socketId, name) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.users.set(socketId, {
      name: name,
      socketId: socketId
    });

    return room;
  }

  createRoom(name, ownerSocketId) {
    const id = this.generateRoomId();
    const newRoom = {
      id,
      name,
      ownerId: ownerSocketId,
      users: new Map(),
      currentVideo: null,
      currentTime: 0,
      isPlaying: false
    };
    this.rooms.set(id, newRoom);
    this.saveRoomsToFile();
    console.log(`[RoomService] Создана комната ${id} пользователем ${ownerSocketId}`);
    return newRoom;
  }

  generateRoomId() {
    return Math.random().toString(36).substring(2, 11);
  }

  shutdown() {
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;