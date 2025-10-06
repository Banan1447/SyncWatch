// services/roomService.js
const fs = require('fs');
const path = require('path');
const config = require('../config');

class RoomService {
  constructor() {
    this.rooms = new Map();
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json');
    this.loadRoomsFromFile();
    this.saveRoomsToFile();
  }

  loadRoomsFromFile() {
    try {
      if (fs.existsSync(this.roomsFilePath)) {
        const data = fs.readFileSync(this.roomsFilePath, 'utf8');
        const roomsData = JSON.parse(data);
        if (Array.isArray(roomsData)) {
          roomsData.forEach(roomData => {
            const usersMap = new Map();
            if (roomData.users && typeof roomData.users === 'object') {
              Object.entries(roomData.users).forEach(([socketId, userData]) => {
                usersMap.set(socketId, userData);
              });
            }
            const room = {
              ...roomData,
              users: usersMap
            };
            this.rooms.set(room.id, room);
          });
          console.log(`[RoomService] Загружено ${this.rooms.size} комнат из файла.`);
        } else {
          console.warn(`[RoomService] Файл ${this.roomsFilePath} содержит некорректные данные.`);
        }
      } else {
        console.log(`[RoomService] Файл ${this.roomsFilePath} не найден.`);
      }
    } catch (error) {
      console.error(`[RoomService] Ошибка загрузки комнат:`, error.message);
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
        room.users.forEach((userData, socketId) => {
          usersObject[socketId] = userData;
        });
        return {
          ...room,
          users: usersObject
        };
      });

      fs.writeFileSync(this.roomsFilePath, JSON.stringify(roomsArray, null, 2));
    } catch (error) {
      console.error(`[RoomService] Ошибка сохранения комнат:`, error.message);
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
      ...room,
      users: usersObject
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
        ...room,
        users: usersObject
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

  // 🔑 ИСПРАВЛЕНО: обновление полей на верхнем уровне комнаты
  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Обновляем поля напрямую в объекте комнаты
      Object.assign(room, updates);
      // Не сохраняем файл здесь — таймер сам сохраняет каждую секунду
    }
  }

  updateUserState(roomId, socketId, updates) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      Object.assign(user, updates);
    }
  }

  joinRoom(roomId, socketId, name) {
    let room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    
    room.users.set(socketId, {
      name: name,
      socketId: socketId
    });
    
    return room;
  }

  // 🔑 ИСПРАВЛЕНО: состояние на верхнем уровне
  createRoom(name, ownerSocketId) {
    const id = this.generateRoomId();
    const newRoom = {
      id,
      name,
      ownerId: ownerSocketId,
      users: new Map(),
      // 🔑 Состояние синхронизации на верхнем уровне!
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
    return Math.random().toString(36).substr(2, 9);
  }

  shutdown() {
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;