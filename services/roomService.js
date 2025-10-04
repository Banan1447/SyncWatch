// services/roomService.js

class RoomService {
  constructor() {
    this.rooms = new Map(); // Хранилище комнат: Map<roomId, RoomObject>
    this.keepaliveIntervalMs = 3000; // 3 секунды для keepalive
  }

  // Метод для обновления времени последней активности пользователя
  updateLastSeen(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      user.lastSeen = Date.now();
    }
  }

  // Метод для проверки, жив ли пользователь (lastSeen в пределах keepaliveIntervalMs)
  isUserAlive(user) {
    return user && (Date.now() - user.lastSeen) < this.keepaliveIntervalMs;
  }

  // Метод для получения "живых" пользователей в комнате (НЕ вызывает getRoom)
  getAliveUsersInRoom(roomId) {
    const room = this.rooms.get(roomId); // Работаем напрямую с this.rooms
    if (!room) return null;

    const aliveUsers = new Map();
    for (const [socketId, userData] of room.users.entries()) {
      if (this.isUserAlive(userData)) {
        aliveUsers.set(socketId, userData);
      }
    }
    return aliveUsers;
  }

  // Метод для получения состояния комнаты с "живыми" пользователями
  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Получаем "живых" пользователей, используя метод, который НЕ вызывает getRoom
    const aliveUsers = this.getAliveUsersInRoom(roomId);
    if (!aliveUsers) return null; // Если комната существует, но все пользователи "мертвы", можно вернуть null или объект без пользователей

    // Создаем копию комнаты с "живыми" пользователями
    return {
      ...room,
      users: aliveUsers // Подменяем пользователей на "живых"
    };
  }

  // Метод для получения всех комнат, исключая пустые (только с "живыми" пользователями)
  getAllRooms() {
    const allRooms = [];
    for (const [id, room] of this.rooms.entries()) {
      const aliveUsers = this.getAliveUsersInRoom(id); // Используем исправленный метод
      if (aliveUsers && aliveUsers.size > 0) { // Проверяем, есть ли "живые" пользователи
        allRooms.push({
          ...room,
          users: aliveUsers
        });
      } else if (room.users.size === 0) { // Если в комнате изначально нет никого, она все равно отображается
          allRooms.push(room);
      }
    }
    return allRooms;
  }

  // Метод для удаления пользователя из комнаты
  leaveRoom(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.users.delete(socketId);
      // УДАЛЕНО: Удаление комнаты, когда из неё выходит последний пользователь
      // if (room.users.size === 0) {
      //   this.rooms.delete(roomId);
      // }
    }
  }

  // Метод для удаления комнаты администратором
  deleteRoom(roomId, requestingSocketId) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Проверяем, является ли запрашивающий владельцем комнаты
      if (room.ownerSocketId === requestingSocketId) {
        this.rooms.delete(roomId);
        return true;
      }
    }
    return false;
  }

  // Метод для обновления состояния комнаты
  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      Object.assign(room.state, updates);
    }
  }

  // Метод для обновления состояния пользователя
  updateUserState(roomId, socketId, updates) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      Object.assign(user, updates);
      // Обновляем lastSeen при любом обновлении состояния пользователя
      user.lastSeen = Date.now();
    }
  }

  // Метод для подключения пользователя к комнате
  joinRoom(roomId, socketId, name) {
    const room = this.rooms.get(roomId);
    if (room) {
      // Обновляем lastSeen при подключении
      room.users.set(socketId, {
        name: name,
        socketId: socketId,
        lastSeen: Date.now(), // Устанавливаем время подключения
        // ... другие пользовательские данные ...
      });
      return room;
    }
    return null;
  }

  // Метод для создания комнаты
  createRoom(name, ownerSocketId) {
    const id = this.generateRoomId(); // Предполагается, что у вас есть такой метод
    const newRoom = {
      id,
      name,
      ownerSocketId, // Сохраняем владельца
      users: new Map(), // Используем Map для пользователей
      state: {
        currentVideo: null,
        currentTime: 0,
        isPlaying: false,
        // ... другие состояния комнаты ...
      }
    };
    this.rooms.set(id, newRoom);
    return newRoom;
  }

  // Вспомогательный метод для генерации ID комнаты
  generateRoomId() {
    // Простая генерация ID, можно улучшить
    return Math.random().toString(36).substr(2, 9);
  }
}

module.exports = RoomService;
