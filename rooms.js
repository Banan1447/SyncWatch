// rooms.js — хранение и управление комнатами

const fs = require('fs');
const path = require('path');

const ROOMS_FILE = path.join(__dirname, 'rooms.json');

let rooms = {};

function loadRooms() {
  if (fs.existsSync(ROOMS_FILE)) {
    try {
      rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    } catch (e) {
      rooms = {};
    }
  }
}

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
}

function getRooms() {
  return rooms;
}

function setRooms(newRooms) {
  rooms = newRooms;
  saveRooms();
}

function getRoomList() {
  return Object.keys(rooms).map(id => ({
    id,
    name: rooms[id].name,
    userCount: Object.keys(rooms[id].users).length,
    currentVideo: rooms[id].currentVideo
  }));
}

// Инициализация
loadRooms();

module.exports = {
  getRooms,
  setRooms,
  getRoomList,
  saveRooms,
  ROOMS_FILE,
  rooms
};
