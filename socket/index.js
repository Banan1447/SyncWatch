// server/socket/index.js
const RoomService = require('../services/roomService');
const { logClientRequest } = require('../middleware/logging');

module.exports = (io) => {
  const roomService = new RoomService();

  // Интервал для проверки "мертвых" пользователей
  const cleanupInterval = setInterval(() => {
    // Проходим по всем комнатам
    for (const [roomId, room] of roomService.rooms.entries()) {
      let usersChanged = false;
      // Проверяем каждого пользователя в комнате
      for (const [socketId, userData] of room.users.entries()) {
        if (!roomService.isUserAlive(userData)) {
          console.log(`[CLEANUP] Удаляем мертвого пользователя ${socketId} из комнаты ${roomId}`);
          room.users.delete(socketId);
          usersChanged = true;
        }
      }
      // Если пользователи были удалены, отправляем обновленное состояние комнаты
      if (usersChanged) {
        // Отправляем обновленное состояние только этой комнате
        io.to(roomId).emit('room-state', roomService.getRoom(roomId));
        // Также обновляем общий список комнат, если это нужно
        io.emit('room-list', roomService.getAllRooms());
      }
    }
  }, 5000); // Проверяем каждые 5 секунд (чуть чаще, чем keepalive)

  io.on('connection', (socket) => {
    const clientIP = socket.request.connection.remoteAddress;
    console.log(`[SOCKET] User connected: ${socket.id} from IP: ${clientIP}`);

    let joinedRoom = null;
    let userName = `User${Math.floor(Math.random()*10000)}`;

    // --- ROOM EVENTS ---

    socket.on('create-room', ({ name }, cb) => {
      logClientRequest(clientIP, socket.id, 'SOCKET create-room', `Name: ${name}`);

      const room = roomService.createRoom(name, socket.id);
      cb && cb({ id: room.id, name: room.name });
      io.emit('room-list', roomService.getAllRooms());
    });

    socket.on('get-rooms', (cb) => {
      logClientRequest(clientIP, socket.id, 'SOCKET get-rooms', '');
      // Возвращаем только комнаты с "живыми" пользователями или пустые комнаты
      cb && cb(roomService.getAllRooms());
    });

    socket.on('join-room', ({ roomId, name }, cb) => {
      logClientRequest(clientIP, socket.id, 'SOCKET join-room', `RoomID: ${roomId}, Name: ${name}`);

      if (joinedRoom) {
        roomService.leaveRoom(joinedRoom, socket.id);
        socket.leave(joinedRoom);
      }

      const room = roomService.joinRoom(roomId, socket.id, name || userName);
      if (!room) {
        cb && cb({ error: 'Room not found' });
        return;
      }

      joinedRoom = roomId;
      userName = name || userName;
      socket.join(roomId);

      cb && cb({ success: true, room: { id: roomId, name: room.name } });
      // Отправляем обновленное состояние комнаты только участникам комнаты
      io.to(roomId).emit('room-state', roomService.getRoom(roomId));
      // Отправляем обновленный список комнат всем
      io.emit('room-list', roomService.getAllRooms());
    });

    socket.on('leave-room', (cb) => {
      logClientRequest(clientIP, socket.id, 'SOCKET leave-room', `RoomID: ${joinedRoom}`);

      if (joinedRoom) {
        roomService.leaveRoom(joinedRoom, socket.id);
        socket.leave(joinedRoom);
        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
        // Отправляем обновленный список комнат всем
        io.emit('room-list', roomService.getAllRooms());
      }

      joinedRoom = null;
      cb && cb({ success: true });
    });

    socket.on('delete-room', ({ roomId }, cb) => {
      logClientRequest(clientIP, socket.id, 'SOCKET delete-room', `RoomID: ${roomId}`);

      const success = roomService.deleteRoom(roomId, socket.id); // Передаем socket.id, а не ownerSocketId напрямую
      if (success) {
        io.emit('room-list', roomService.getAllRooms());
        cb && cb({ success: true });
      } else {
        cb && cb({ success: false, error: 'Room not found or not authorized' });
      }
    });

    // --- VIDEO COMMANDS ---
    socket.on('video-command', (data) => {
      if (joinedRoom) {
        logClientRequest(clientIP, socket.id, 'SOCKET video-command',
          `RoomID: ${joinedRoom}, Type: ${data.type}, Time: ${data.time}`);

        socket.to(joinedRoom).emit('video-command', data);

        // Обновляем состояние комнаты
        if (data.type === 'play') {
          roomService.updateRoomState(joinedRoom, { isPlaying: true });
        } else if (data.type === 'pause') {
          roomService.updateRoomState(joinedRoom, { isPlaying: false });
        } else if (data.type === 'seek' && typeof data.time === 'number') {
          roomService.updateRoomState(joinedRoom, { currentTime: data.time });
        }

        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('select-video', (filename) => {
      if (joinedRoom) {
        logClientRequest(clientIP, socket.id, 'SOCKET select-video',
          `RoomID: ${joinedRoom}, Filename: ${filename}`);

        roomService.updateRoomState(joinedRoom, {
          currentVideo: filename,
          isPlaying: false
        });

        io.to(joinedRoom).emit('video-updated', filename);
        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('update-room-state', (stateUpdates) => {
      if (joinedRoom) {
        logClientRequest(clientIP, socket.id, 'SOCKET update-room-state',
          `RoomID: ${joinedRoom}, Updates: ${JSON.stringify(stateUpdates)}`);

        roomService.updateRoomState(joinedRoom, stateUpdates);
        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('update-user-state', (stateUpdates) => {
      if (joinedRoom) {
        // updateLastSeen вызывается внутри updateUserState
        roomService.updateUserState(joinedRoom, socket.id, stateUpdates);
        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    // --- PING/PONG ---
    socket.on('ping', () => {
      if (joinedRoom) {
        const start = Date.now();
        socket.emit('pong', start);
        // Обновляем lastSeen при ping
        roomService.updateLastSeen(joinedRoom, socket.id);
      }
    });

    socket.on('pong-response', (start) => {
      if (joinedRoom) {
        const latency = Date.now() - start;
        const room = roomService.getRoom(joinedRoom);
        if (room) { // Проверяем, что комната и пользователь ещё существуют
            const user = room.users.get(socket.id);
            if (user) {
              user.ping = latency;
              // lastSeen обновляется в updateUserState, но pong-response косвенно подтверждает активность
              // roomService.updateLastSeen(joinedRoom, socket.id); // Можно не вызывать, если update-user-state уже обновляет
              roomService.updateUserState(joinedRoom, socket.id, { ping: latency }); // Используем updateUserState
              // Отправляем обновленное состояние комнаты только участникам комнаты
              io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
            }
        }
      }
    });

    socket.on('buffer-update', (data) => {
      if (joinedRoom) {
        const room = roomService.getRoom(joinedRoom);
        if (room) { // Проверяем, что комната и пользователь ещё существуют
            const user = room.users.get(socket.id);
            if (user) {
              // Обновляем lastSeen при buffer-update
              roomService.updateUserState(joinedRoom, socket.id, {
                buffer: data.buffer,
                position: data.position,
                status: data.status,
                currentPosition: data.position,
                isBuffering: data.status === 'buffering',
                isPlaying: data.status === 'playing'
              });
              // Отправляем обновленное состояние комнаты только участникам комнаты
              io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
            }
        }
      }
    });

    socket.on('disconnect', () => {
      if (joinedRoom) {
        logClientRequest(clientIP, socket.id, 'SOCKET disconnect', `RoomID: ${joinedRoom}`);
        roomService.leaveRoom(joinedRoom, socket.id);
        // Отправляем обновленное состояние комнаты только участникам комнаты
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
        // Отправляем обновленный список комнат всем
        io.emit('room-list', roomService.getAllRooms());
      }
      console.log(`[SOCKET] User disconnected: ${socket.id} from IP: ${clientIP}`);
    });
  });

  // Очищаем интервал при отключении сервера (опционально, если сервер завершает работу корректно)
  // process.on('SIGINT', () => {
  //   clearInterval(cleanupInterval);
  //   process.exit(0);
  // });
};
