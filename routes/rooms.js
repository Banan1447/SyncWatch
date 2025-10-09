// routes/rooms.js
const express = require('express');

/**
 * Фабрика маршрутов комнат
 * @param {import('../services/roomService').default} roomService - Единый экземпляр RoomService
 * @returns {express.Router}
 */
module.exports = (roomService) => {
  const router = express.Router();

  /**
   * POST /api/rooms
   * Создаёт новую комнату
   * Тело запроса: { name: string, password?: string }
   */
  router.post('/', (req, res) => {
    const { name, password } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Название комнаты обязательно'
      });
    }

    // Создаём комнату через RoomService (единая точка управления)
    const newRoom = roomService.createRoom(name.trim(), 'rest-api-user', password ? password.trim() : null);

    res.status(201).json({
      success: true,
      id: newRoom.id,
      name: newRoom.name
    });
  });

  /**
   * GET /api/rooms
   * Возвращает список всех комнат (без паролей!)
   */
  router.get('/', (req, res) => {
    const allRooms = roomService.getAllRooms();
    // RoomService.getAllRooms() уже возвращает комнаты без паролей (см. hasPassword)
    res.json({ success: true, rooms: allRooms });
  });

  /**
   * DELETE /api/rooms/:id
   * Удаляет комнату по ID
   */
  router.delete('/:id', (req, res) => {
    const { id } = req.params;
    const result = roomService.deleteRoom(id, 'rest-api-user');

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.message || 'Комната не найдена'
      });
    }

    res.json({ success: true, message: 'Комната успешно удалена' });
  });

  return router;
};