// services/roomService.js
const fs = require('fs');
const path = require('path');
const config = require('../config'); // Предполагается, что конфигурация находится здесь

class RoomService {
  constructor() {
    this.rooms = new Map(); // Хранилище комнат: Map<roomId, RoomObject>
    // this.keepaliveIntervalMs = 3000; // УДАЛЕНО: Интервал для keepalive
    // Используем папку json в корне проекта
    this.roomsFilePath = path.join(__dirname, '..', 'json', 'rooms.json'); // Путь к файлу с комнатами
    this.loadRoomsFromFile(); // Загружаем комнаты при инициализации
    this.saveRoomsToFile(); // Сохраняем при инициализации, чтобы создать файл, если его нет

    // ИНТЕРВАЛ ДЛЯ ПРОВЕРКИ "МЕРТВЫХ" ПОЛЬЗОВАТЕЛЕЙ УДАЛЕН
    // this.cleanupInterval = setInterval(() => {
    //   this.cleanupDeadUsers();
    // }, 5000); // Проверяем каждые 5 секунд
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
                // УСТАНОВКА lastSeen УДАЛЕНА ИЗ ЭТОГО БЛОКА, ТАК КАК ОН БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ
                // if (userData.lastSeen === undefined) {
                //     userData.lastSeen = Date.now();
                // }
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
  // УДАЛЕН, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
  // updateLastSeen(roomId, socketId) {
  //   const room = this.rooms.get(roomId);
  //   if (room && room.users.has(socketId)) {
  //     const user = room.users.get(socketId);
  //     user.lastSeen = Date.now();
  //     // Не вызываем saveRoomsToFile здесь, так как lastSeen обновляется часто
  //   }
  // }

  // Метод для проверки, жив ли пользователь (lastSeen в пределах keepaliveIntervalMs)
  // УДАЛЕН, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
  // isUserAlive(user) {
  //   return user && (Date.now() - user.lastSeen) < this.keepaliveIntervalMs;
  // }

  // Метод для получения "живых" пользователей в комнате (НЕ вызывает getRoom)
  // УДАЛЕН, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
  // getAliveUsersInRoom(roomId) {
  //   const room = this.rooms.get(roomId); // Работаем напрямую с this.rooms
  //   if (!room) return null;
  //
  //   const aliveUsers = new Map();
  //   for (const [socketId, userData] of room.users.entries()) {
  //     if (this.isUserAlive(userData)) {
  //       aliveUsers.set(socketId, userData);
  //     }
  //   }
  //   return aliveUsers;
  // }

  // Метод для получения состояния комнаты БЕЗ фильтрации "живых" пользователей
  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // ВСЕГДА возвращаем комнату с ВСЕМИ пользователями, как есть
    // НЕ вызываем getAliveUsersInRoom
    return {
      ...room,
      // users остается Map, но для сериализации в JSON нужно преобразовать
      // Однако, обычно getRoom возвращает объект для внутреннего использования,
      // а для API лучше использовать getAllRooms или отдельный метод.
      // Для простоты, преобразуем users в объект при возврате.
      users: Object.fromEntries(room.users) // Преобразуем Map в объект
    };
  }


  // Метод для получения всех комнат, БЕЗ фильтрации "живых" пользователей
  getAllRooms() {
    const allRooms = [];
    for (const [id, room] of this.rooms.entries()) {
      // ВСЕГДА возвращаем комнату, преобразуя Map пользователей в объект для сериализации
      const usersObject = {};
      room.users.forEach((userData, socketId) => {
        usersObject[socketId] = userData;
      });
      
      allRooms.push({
        ...room,
        users: usersObject // Отправляем как объект
      });
    }
    return allRooms;
  }

  // Метод для очистки "мертвых" пользователей
  // УДАЛЕН, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
  // cleanupDeadUsers() {
  //   let roomsChanged = false;
  //   for (const [roomId, room] of this.rooms.entries()) {
  //     let usersChanged = false;
  //     for (const [socketId, userData] of room.users.entries()) {
  //       if (!this.isUserAlive(userData)) {
  //         console.log(`[CLEANUP] Удаляем мертвого пользователя ${socketId} из комнаты ${roomId}`);
  //         room.users.delete(socketId);
  //         usersChanged = true;
  //       }
  //     }
  //     if (usersChanged) {
  //       roomsChanged = true;
  //     }
  //   }
  //   if (roomsChanged) {
  //     this.saveRoomsToFile(); // Сохраняем изменения, если пользователи были удалены
  //   }
  // }

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
        return { success: true, message: `Комната ${roomId} удалена` };
    } else {
        console.log(`[RoomService] Попытка удаления несуществующей комнаты ${roomId}.`);
        return { success: false, message: `Комната ${roomId} не найдена` };
    }
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
      // Обновление lastSeen УДАЛЕНО, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
      // user.lastSeen = Date.now();
      // Не вызываем saveRoomsToFile здесь, так как состояние пользователя обновляется часто
    }
  }

  // Метод для подключения пользователя к комнате
  joinRoom(roomId, socketId, name) {
    let room = this.rooms.get(roomId);
    if (!room) {
      // Если комнаты нет, создаем её (или возвращаем null, если не хотим автоматически создавать)
      // В данном случае, предположим, что комната должна существовать.
      // Если нужно создавать, используйте createRoom.
      return null;
    }
    
    // Обновление lastSeen УДАЛЕНО, ТАК КАК МЕХАНИЗМ KEEPALIVE ОТКЛЮЧЕН
    // room.users.set(socketId, {
    //   name: name,
    //   socketId: socketId,
    //   lastSeen: Date.now(), // Устанавливаем время подключения
    //   // ... другие пользовательские данные ...
    // });
    
    // Добавляем пользователя без lastSeen
    room.users.set(socketId, {
      name: name,
      socketId: socketId,
      // ... другие пользовательские данные ...
    });
    
    // Не сохраняем файл при каждом подключении
    return room;
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
  // ОБНОВЛЕН: теперь просто сохраняет данные и не останавливает несуществующий интервал
  shutdown() {
    // if (this.cleanupInterval) {
    //   clearInterval(this.cleanupInterval);
    // }
    // Сохраняем перед завершением, если были изменения
    this.saveRoomsToFile();
  }
}

module.exports = RoomService;