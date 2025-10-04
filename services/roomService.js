// services/roomService.js
const fs = require('fs');
const path = require('path');

class RoomService {
  constructor() {
    this.rooms = new Map(); // Хранилище комнат: Map<roomId, RoomObject>
    this.keepaliveIntervalMs = 3000; // 3 секунды для keepalive
    // Используем папку json в корне проекта
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json'); // Путь к файлу с комнатами
    this.loadRoomsFromFile(); // Загружаем комнаты при инициализации
    this.saveRoomsToFile(); // Сохраняем при инициализации, чтобы создать файл, если его нет

    // Интервал для проверки "мертвых" пользователей
    this.cleanupInterval = setInterval(() => {
      this.cleanupDeadUsers();
    }, 5000); // Проверяем каждые 5 секунд
  }

  // Метод для загрузки комнат из файла
  loadRoomsFromFile() {
    try {
      if (fs.existsSync(this.roomsFilePath)) {
        const data = fs.readFileSync(this.roomsFilePath, 'utf8');
        const roomsData = JSON.parse(data);
        if (Array.isArray(roomsData)) {
          roomsData.forEach(roomData => {
            // Воссоздаем Map пользователей
            const usersMap = new Map();
            if (roomData.users && typeof roomData.users === 'object') {
              Object.entries(roomData.users).forEach(([socketId, userData]) => {
                // Устанавливаем lastSeen, если его нет (для совместимости со старыми файлами)
                if (userData.lastSeen === undefined) {
                    userData.lastSeen = Date.now();
                }
                usersMap.set(socketId, userData);
              });
            }
            // Воссоздаем комнату и добавляем в Map
            const room = {
              ...roomData,
              users: usersMap
            };
            this.rooms.set(room.id, room);
          });
          console.log(`[RoomService] Загружено ${this.rooms.size} комнат из файла.`);
        } else {
          console.warn(`[RoomService] Файл ${this.roomsFilePath} содержит некорректные данные, используется пустой список.`);
        }
      } else {
        console.log(`[RoomService] Файл ${this.roomsFilePath} не найден, используется пустой список.`);
      }
    } catch (error) {
      console.error(`[RoomService] Ошибка загрузки комнат из файла:`, error.message);
      // Используем пустой список, если файл повреждён
      this.rooms = new Map();
    }
  }

  // Метод для сохранения комнат в файл
  saveRoomsToFile() {
    try {
      // Создаём папку, если она не существует
      const dir = path.dirname(this.roomsFilePath);
      if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
      }

      // Преобразуем Map в объект/массив для JSON
      const roomsArray = Array.from(this.rooms.values()).map(room => {
        // Преобразуем Map пользователей в объект
        const usersObject = {};
        room.users.forEach((userData, socketId) => {
          usersObject[socketId] = userData;
        });
        return {
          ...room,
          // Заменяем Map на объект перед сохранением
          users: usersObject
        };
      });

      fs.writeFileSync(this.roomsFilePath, JSON.stringify(roomsArray, null, 2));
      // console.log(`[RoomService] Сохранено ${this.rooms.size} комнат в файл.`); // Лог можно отключить, если слишком часто срабатывает
    } catch (error) {
      console.error(`[RoomService] Ошибка сохранения комнат в файл:`, error.message);
    }
  }

  // Метод для обновления времени последней активности пользователя
  updateLastSeen(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room && room.users.has(socketId)) {
      const user = room.users.get(socketId);
      user.lastSeen = Date.now();
      // Не вызываем saveRoomsToFile здесь, так как lastSeen обновляется часто
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

  // Метод для очистки "мертвых" пользователей
  cleanupDeadUsers() {
    let roomsChanged = false;
    for (const [roomId, room] of this.rooms.entries()) {
      let usersChanged = false;
      for (const [socketId, userData] of room.users.entries()) {
        if (!this.isUserAlive(userData)) {
          console.log(`[CLEANUP] Удаляем мертвого пользователя ${socketId} из комнаты ${roomId}`);
          room.users.delete(socketId);
          usersChanged = true;
        }
      }
      if (usersChanged) {
        roomsChanged = true;
      }
    }
    if (roomsChanged) {
      this.saveRoomsToFile(); // Сохраняем изменения, если пользователи были удалены
    }
  }

  // Метод для удаления пользователя из комнаты
  leaveRoom(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.users.delete(socketId);
      // Не удаляем комнату, если вышел последний пользователь
      // Сохраняем изменения в файле
      this.saveRoomsToFile();
    }
  }

  // Метод для удаления комнаты администратором
  // ТЕПЕРЬ: Удаляет комнату, если она существует, без проверки владельца
  deleteRoom(roomId, requestingSocketId) {
    console.log(`[RoomService DEBUG] Попытка удаления комнаты ${roomId} пользователем ${requestingSocketId}`);
    const room = this.rooms.get(roomId);
    if (room) {
        // Удаляем комнату независимо от владельца
        this.rooms.delete(roomId);
        console.log(`[RoomService] Удалена комната ${roomId} пользователем ${requestingSocketId}`);
        this.saveRoomsToFile(); // Сохраняем изменения
        return true;
    } else {
        console.log(`[RoomService] Попытка удаления несуществующей комнаты ${roomId}.`);
    }
    return false;
  }

  // Метод для обновления состояния комнаты
  updateRoomState(roomId, updates) {
    const room = this.rooms.get(roomId);
    if (room) {
      Object.assign(room.state, updates);
      this.saveRoomsToFile(); // Сохраняем изменения
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
      // Не вызываем saveRoomsToFile здесь, так как состояние пользователя обновляется часто
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
      // Не сохраняем файл при каждом подключении
      return room;
    }
    return null;
  }

  // Метод для создания комнаты
  createRoom(name, ownerSocketId) { // ownerSocketId теперь используется как ownerId
    const id = this.generateRoomId(); // Предполагается, что у вас есть такой метод
    const newRoom = {
      id,
      name,
      ownerId: ownerSocketId, // Сохраняем ID владельца (может быть произвольной строкой)
      users: new Map(), // Используем Map для пользователей
      state: {
        currentVideo: null,
        currentTime: 0,
        isPlaying: false,
        // ... другие состояния комнаты ...
      }
    };
    this.rooms.set(id, newRoom);
    this.saveRoomsToFile(); // Сохраняем изменения
    console.log(`[RoomService] Создана комната ${id} пользователем ${ownerSocketId}`);
    return newRoom;
  }

  // Вспомогательный метод для генерации ID комнаты
  generateRoomId() {
    // Простая генерация ID, можно улучшить
    return Math.random().toString(36).substr(2, 9);
  }

  // Метод для остановки интервала при завершении работы (опционально)
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    // Сохраняем перед завершением, если были изменения
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;
