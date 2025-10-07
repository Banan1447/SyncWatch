// routes/rooms.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Путь к файлу комнат: корень проекта → папка js → rooms.json
const ROOMS_FILE = path.join(__dirname, '../json/rooms.json');

/**
 * Чтение комнат из файла
 */
function readRooms() {
  try {
    const data = fs.readFileSync(ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Ошибка чтения rooms.json:', err.message);
    return [];
  }
}

/**
 * Запись комнат в файл
 */
function writeRooms(rooms) {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Ошибка записи rooms.json:', err.message);
    return false;
  }
}

/**
 * GET /api/admin/rooms
 * Возвращает список всех комнат
 */
router.get('/', (req, res) => {
  const rooms = readRooms();
  res.json({ success: true, rooms });
});

/**
 * DELETE /api/admin/rooms/:id
 * Удаляет комнату по ID
 */
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const rooms = readRooms();
  const roomIndex = rooms.findIndex(room => room.id === id);

  if (roomIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Комната не найдена'
    });
  }

  rooms.splice(roomIndex, 1);

  if (writeRooms(rooms)) {
    res.json({ success: true, message: 'Комната успешно удалена' });
  } else {
    res.status(500).json({
      success: false,
      error: 'Ошибка при сохранении файла'
    });
  }
});

module.exports = router;