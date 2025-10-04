// server/socket/index.js
// Принимает io и roomService из server.js
module.exports = (io, roomService) => {

  io.on('connection', (socket) => {
    const clientIP = socket.request.connection.remoteAddress;
    console.log(`[SOCKET] User connected: ${socket.id} from IP: ${clientIP}`);

    let joinedRoom = null;
    let userName = `User${Math.floor(Math.random()*10000)}`;

    // --- ROOM EVENTS ---
    socket.on('create-room', ({ name }, cb) => {
      const { logClientRequest } = require('../middleware/logging'); // Импорт внутри обработчика
      logClientRequest(clientIP, socket.id, 'SOCKET create-room', `Name: ${name}`);

      const room = roomService.createRoom(name, socket.id); // socket.id используется как ownerId
      cb && cb({ id: room.id, name: room.name });
      io.emit('room-list', roomService.getAllRooms());
    });

    socket.on('get-rooms', (cb) => {
      const { logClientRequest } = require('../middleware/logging');
      logClientRequest(clientIP, socket.id, 'SOCKET get-rooms', '');
      cb && cb(roomService.getAllRooms());
    });

    socket.on('join-room', ({ roomId, name }, cb) => {
      const { logClientRequest } = require('../middleware/logging');
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
      io.to(roomId).emit('room-state', roomService.getRoom(joinedRoom));
      io.emit('room-list', roomService.getAllRooms());
    });

    socket.on('leave-room', (cb) => {
      const { logClientRequest } = require('../middleware/logging');
      logClientRequest(clientIP, socket.id, 'SOCKET leave-room', `RoomID: ${joinedRoom}`);

      if (joinedRoom) {
        roomService.leaveRoom(joinedRoom, socket.id);
        socket.leave(joinedRoom);
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
        io.emit('room-list', roomService.getAllRooms());
      }

      joinedRoom = null;
      cb && cb({ success: true });
    });

    socket.on('delete-room', ({ roomId }, cb) => {
      const { logClientRequest } = require('../middleware/logging');
      logClientRequest(clientIP, socket.id, 'SOCKET delete-room', `RoomID: ${roomId}`);

      const success = roomService.deleteRoom(roomId, socket.id); // socket.id как requestingSocketId
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
        const { logClientRequest } = require('../middleware/logging');
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

        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('select-video', (filename) => {
      if (joinedRoom) {
        const { logClientRequest } = require('../middleware/logging');
        logClientRequest(clientIP, socket.id, 'SOCKET select-video',
          `RoomID: ${joinedRoom}, Filename: ${filename}`);

        roomService.updateRoomState(joinedRoom, {
          currentVideo: filename,
          isPlaying: false
        });

        io.to(joinedRoom).emit('video-updated', filename);
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('update-room-state', (stateUpdates) => {
      if (joinedRoom) {
        const { logClientRequest } = require('../middleware/logging');
        logClientRequest(clientIP, socket.id, 'SOCKET update-room-state',
          `RoomID: ${joinedRoom}, Updates: ${JSON.stringify(stateUpdates)}`);

        roomService.updateRoomState(joinedRoom, stateUpdates);
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
      }
    });

    socket.on('update-user-state', (stateUpdates) => {
      if (joinedRoom) {
        roomService.updateUserState(joinedRoom, socket.id, stateUpdates);
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
              roomService.updateUserState(joinedRoom, socket.id, { ping: latency }); // Используем updateUserState
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
              io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
            }
        }
      }
    });

    socket.on('disconnect', () => {
      if (joinedRoom) {
        const { logClientRequest } = require('../middleware/logging');
        logClientRequest(clientIP, socket.id, 'SOCKET disconnect', `RoomID: ${joinedRoom}`);
        roomService.leaveRoom(joinedRoom, socket.id);
        io.to(joinedRoom).emit('room-state', roomService.getRoom(joinedRoom));
        io.emit('room-list', roomService.getAllRooms());
      }
      console.log(`[SOCKET] User disconnected: ${socket.id} from IP: ${clientIP}`);
    });
  });
};
