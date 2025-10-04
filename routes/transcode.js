// server/routes/transcode.js
const express = require('express');
const router = express.Router();
const TranscodeService = require('../services/transcodeService');
const { isLocalhostOnly } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');
const config = require('../config');

const transcodeService = new TranscodeService(config.videoDirectory);

// Запускаем обработчик очереди
setInterval(() => {
  transcodeService.processQueue();
}, 5000);

// GET /api/transcode/templates
router.get('/templates', isLocalhostOnly, (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/transcode/templates', '');
  
  try {
    const templates = transcodeService.loadTemplates();
    console.log(`[TRANSCODE API] Отправлено ${templates.length} шаблонов`);
    res.json({ success: true, templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transcode/save-template
router.post('/save-template', isLocalhostOnly, (req, res) => {
  const { name, description, command } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/save-template', `Name: ${name}`);
  
  try {
    if (!name || !command) {
      return res.status(400).json({ success: false, error: 'Name and command required' });
    }

    const template = transcodeService.createTemplate(name, description, command);
    console.log(`[TRANSCODE API] Сохранён шаблон: ${name} (${template.id})`);
    res.json({ success: true, id: template.id, template });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transcode/delete-template
router.post('/delete-template', isLocalhostOnly, (req, res) => {
  const { id } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/delete-template', `ID: ${id}`);
  
  try {
    if (!id) {
      return res.status(400).json({ success: false, error: 'Template ID required' });
    }

    transcodeService.deleteTemplate(id);
    console.log(`[TRANSCODE API] Удалён шаблон: ${id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/transcode/queue
router.get('/queue', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/transcode/queue', '');
  
  try {
    const queue = transcodeService.getQueueWithNames();
    console.log(`[TRANSCODE API] Отправлена очередь: ${queue.length} элементов`);
    res.json({ success: true, queue });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transcode/add-to-queue
router.post('/add-to-queue', isLocalhostOnly, (req, res) => {
  const { fileId, templateId } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/add-to-queue', `File: ${fileId}, TemplateID: ${templateId}`);
  
  try {
    if (!fileId || !templateId) {
      return res.status(400).json({ success: false, error: 'File ID and template ID required' });
    }

    const job = transcodeService.addToQueue(fileId, templateId);
    console.log(`[TRANSCODE API] Добавлен в очередь: ${fileId} с шаблоном ${templateId} (${job.id})`);
    res.json({ success: true, id: job.id, item: job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transcode/cancel-job
router.post('/cancel-job', isLocalhostOnly, (req, res) => {
  const { jobId } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/cancel-job', `JobID: ${jobId}`);
  
  try {
    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Job ID required' });
    }

    transcodeService.cancelJob(jobId);
    console.log(`[TRANSCODE API] Задание отменено: ${jobId}`);
    res.json({ success: true, message: 'Job cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transcode/quick-transcode
router.post('/quick-transcode', isLocalhostOnly, (req, res) => {
  const { filename } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/transcode/quick-transcode', `Filename: ${filename}`);
  
  try {
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid filename required' });
    }

    transcodeService.quickTranscode(filename)
      .then(result => {
        res.json({ success: true, ...result });
      })
      .catch(error => {
        res.status(500).json({ success: false, error: error.message });
      });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;