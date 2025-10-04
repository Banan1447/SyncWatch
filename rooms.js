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

  // ... (остальные методы остаются без изменений, так как они используют this.roomsFilePath) ...

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

  // ... (остальные методы без изменений) ...

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
