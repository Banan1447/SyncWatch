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

    // Создаём комнату через RoomService
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
   * Но с флагом hasPassword: true/false
   */
  router.get('/', (req, res) => {
    // Получаем все комнаты от RoomService
    const rawRooms = roomService.getAllRooms(); // Предполагается, что это массив/итерируемый объект комнат

    // Формируем публичные данные: НИКАКОГО пароля, только hasPassword
    const publicRooms = (Array.isArray(rawRooms) ? rawRooms : Object.values(rawRooms)).map(room => {
      // Убедимся, что у комнаты есть id и name как минимум
      return {
        id: room.id,
        name: room.name,
        users: room.users || {},
        video: room.video || null,
        // 🔑 Ключевая строка: определяем, есть ли пароль (без раскрытия самого пароля!)
        hasPassword: !!room.password
      };
    });

    res.json({ success: true, rooms: publicRooms });
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