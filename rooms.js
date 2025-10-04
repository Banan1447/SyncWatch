// rooms.js
const fs = require('fs');
const path = require('path');

// ✅ Файл для хранения состояния комнат
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

// ✅ Загрузка комнат из файла
function getRooms() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const data = fs.readFileSync(ROOMS_FILE, 'utf8');
      console.log(`[ROOMS] Загружены комнаты из: ${ROOMS_FILE}`);
      return JSON.parse(data);
    }
    console.log(`[ROOMS] Файл комнат не найден: ${ROOMS_FILE}`);
    return {};
  } catch (err) {
    console.error('[ROOMS] Ошибка загрузки комнат:', err);
    return {};
  }
}

// ✅ Сохранение комнат в файл
function setRooms(rooms) {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
    console.log(`[ROOMS] Сохранены комнаты в: ${ROOMS_FILE}`);
    return true;
  } catch (err) {
    console.error('[ROOMS] Ошибка сохранения комнат:', err);
    return false;
  }
}

// ✅ Получить список комнат
function getRoomList() {
  const rooms = getRooms();
  return Object.keys(rooms).map(id => ({
    id,
    name: rooms[id].name,
    users: rooms[id].users || {}
  }));
}

// ✅ Создать комнату с начальным состоянием
function createRoom(name) {
  const id = 'room_' + Math.random().toString(36).substr(2, 8);
  const room = {
    id,
    name: name || id,
    users: {},
    // ✅ ГЛОБАЛЬНОЕ СОСТОЯНИЕ КОМНАТЫ
    state: {
      currentVideo: null,
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      volume: 1.0,
      muted: false,
      quality: 'original',
      subtitles: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    chat: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  const rooms = getRooms();
  rooms[id] = room;
  setRooms(rooms);
  
  console.log(`[ROOMS] Создана комната: ${name} (${id})`);
  return room;
}

// ✅ Проверить, существует ли комната
function roomExists(roomId) {
  const rooms = getRooms();
  return !!rooms[roomId];
}

// ✅ Обновить состояние комнаты
function updateRoomState(roomId, stateUpdates) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    // ✅ Объединяем старое состояние с новым
    rooms[roomId].state = {
      ...rooms[roomId].state,
      ...stateUpdates,
      updatedAt: new Date().toISOString()
    };
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Обновлено состояние комнаты: ${roomId}`);
    return rooms[roomId].state;
  }
  return null;
}

// ✅ Получить состояние комнаты
function getRoomState(roomId) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    return rooms[roomId].state;
  }
  return null;
}

// ✅ Добавить пользователя в комнату
function addUserToRoom(roomId, userId, userData) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    rooms[roomId].users[userId] = {
      id: userId,
      name: userData.name || `User${Math.floor(Math.random()*10000)}`,
      role: userData.role || 'viewer',
      joinedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      ping: 0,
      buffer: 0,
      status: 'paused',
      position: 0,
      ready: false,
      // ✅ СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЯ
      userState: {
        isReady: false,
        isBuffering: false,
        currentPosition: 0,
        currentVolume: 1.0,
        isMuted: false,
        playbackRate: 1.0,
        lastUpdated: new Date().toISOString()
      }
    };
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Пользователь добавлен в комнату: ${userData.name} (${userId}) → ${roomId}`);
    return rooms[roomId].users[userId];
  }
  return null;
}

// ✅ Удалить пользователя из комнаты
function removeUserFromRoom(roomId, userId) {
  const rooms = getRooms();
  if (rooms[roomId] && rooms[roomId].users[userId]) {
    delete rooms[roomId].users[userId];
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Пользователь удалён из комнаты: ${userId} ← ${roomId}`);
    return true;
  }
  return false;
}

// ✅ Обновить состояние пользователя
function updateUserState(roomId, userId, stateUpdates) {
  const rooms = getRooms();
  if (rooms[roomId] && rooms[roomId].users[userId]) {
    rooms[roomId].users[userId].userState = {
      ...rooms[roomId].users[userId].userState,
      ...stateUpdates,
      lastUpdated: new Date().toISOString()
    };
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Обновлено состояние пользователя: ${userId} в ${roomId}`);
    return rooms[roomId].users[userId].userState;
  }
  return null;
}

// ✅ Получить состояние пользователя
function getUserState(roomId, userId) {
  const rooms = getRooms();
  if (rooms[roomId] && rooms[roomId].users[userId]) {
    return rooms[roomId].users[userId].userState;
  }
  return null;
}

// ✅ Добавить сообщение в чат
function addChatMessage(roomId, messageData) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    const message = {
      id: 'msg_' + Math.random().toString(36).substr(2, 8),
      user: messageData.user || 'Anonymous',
      text: messageData.text || '',
      timestamp: new Date().toISOString()
    };
    
    if (!rooms[roomId].chat) {
      rooms[roomId].chat = [];
    }
    
    rooms[roomId].chat.push(message);
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    
    console.log(`[ROOMS] Сообщение добавлено в чат: ${roomId} ← ${message.user}: ${message.text}`);
    return message;
  }
  return null;
}

// ✅ Получить историю чата
function getChatHistory(roomId, limit = 50) {
  const rooms = getRooms();
  if (rooms[roomId] && rooms[roomId].chat) {
    // Возвращаем последние `limit` сообщений
    return rooms[roomId].chat.slice(-limit);
  }
  return [];
}

// ✅ Очистить чат
function clearChat(roomId) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    rooms[roomId].chat = [];
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Чат очищен: ${roomId}`);
    return true;
  }
  return false;
}

// ✅ Удалить комнату
function deleteRoom(roomId) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    delete rooms[roomId];
    setRooms(rooms);
    console.log(`[ROOMS] Удалена комната: ${roomId}`);
    return true;
  }
  return false;
}

// ✅ Получить информацию о комнате
function getRoomInfo(roomId) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    return {
      id: rooms[roomId].id,
      name: rooms[roomId].name,
      users: rooms[roomId].users,
      state: rooms[roomId].state,
      chat: rooms[roomId].chat,
      createdAt: rooms[roomId].createdAt,
      updatedAt: rooms[roomId].updatedAt
    };
  }
  return null;
}

// ✅ Обновить информацию о комнате
function updateRoomInfo(roomId, updates) {
  const rooms = getRooms();
  if (rooms[roomId]) {
    Object.keys(updates).forEach(key => {
      if (key !== 'id' && key !== 'createdAt') {
        rooms[roomId][key] = updates[key];
      }
    });
    rooms[roomId].updatedAt = new Date().toISOString();
    setRooms(rooms);
    console.log(`[ROOMS] Обновлена информация о комнате: ${roomId}`);
    return rooms[roomId];
  }
  return null;
}

module.exports = {
  getRooms,
  setRooms,
  getRoomList,
  createRoom,
  roomExists,
  updateRoomState,
  getRoomState,
  addUserToRoom,
  removeUserFromRoom,
  updateUserState,
  getUserState,
  addChatMessage,
  getChatHistory,
  clearChat,
  deleteRoom,
  getRoomInfo,
  updateRoomInfo
};