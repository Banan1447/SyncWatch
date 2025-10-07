// routes/admin/stats.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const ROOMS_FILE = path.join(__dirname, '../../js/rooms.json');

function readRooms() {
  try {
    const data = fs.readFileSync(ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get('/stats', (req, res) => {
  const rooms = readRooms();
  const activeRooms = rooms.filter(r => r.users > 0).length;
  const totalRooms = rooms.length;

  res.json({
    success: true,
    stats: {
      rooms: {
        active: activeRooms,
        total: totalRooms
      },
      users: {
        active: 5,
        registered: 12
      },
      transcode: {
        activeJobs: 0,
        totalJobs: 0,
        templates: 0
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage()
      }
    }
  });
});

module.exports = router;