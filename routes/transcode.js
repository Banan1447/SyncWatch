// routes/transcode.js
const express = require('express');
const router = express.Router();
const path = require('path');
const TranscodeService = require('../services/transcodeService');

const transcodeService = new TranscodeService();

// Вспомогательная функция для генерации имени выходного файла
function getOutputPath(inputFile, suffix = '_converted') {
  const ext = path.extname(inputFile);
  const name = path.basename(inputFile, ext);
  return `${name}${suffix}.mp4`;
}

// --- МАРШРУТЫ ---

// Получить очередь
router.get('/queue', (req, res) => {
  try {
    const queue = transcodeService.getQueueWithNames();
    res.json({ success: true, queue });
  } catch (error) {
    console.error('[TRANSCODE] Error getting queue:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получить шаблоны
router.get('/templates', (req, res) => {
  try {
    const templates = transcodeService.getTemplatesAsArray();
    res.json({ success: true, templates });
  } catch (error) {
    console.error('[TRANSCODE] Error getting templates:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Добавить в очередь (фронтенд: { fileId, templateId })
router.post('/add-to-queue', (req, res) => {
  const { fileId, templateId } = req.body;

  if (!fileId || !templateId) {
    return res.status(400).json({ success: false, error: 'Missing fileId or templateId' });
  }

  try {
    const outputFile = getOutputPath(fileId);
    const success = transcodeService.addToQueue(fileId, outputFile, templateId, 'default_user');
    if (success) {
      res.json({ success: true, message: 'Job added to queue' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to add job' });
    }
  } catch (error) {
    console.error('[TRANSCODE] Error adding to queue:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Быстрое транскодирование (фронтенд: { filename, command })
router.post('/quick-transcode', async (req, res) => {
  const { filename, command } = req.body;

  if (!filename || !command) {
    return res.status(400).json({ success: false, error: 'Missing filename or command' });
  }

  try {
    const outputFile = getOutputPath(filename, '_quick');
    await transcodeService.quickTranscodeWithCommand(filename, outputFile, command);
    res.json({ success: true, output: outputFile });
  } catch (error) {
    console.error('[TRANSCODE] Quick transcode error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Отмена задания (фронтенд: { jobId })
router.post('/cancel-job', (req, res) => {
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ success: false, error: 'Missing jobId' });
  }

  try {
    const success = transcodeService.cancelJob(jobId);
    if (success) {
      res.json({ success: true, message: 'Job cancelled' });
    } else {
      res.status(404).json({ success: false, error: 'Job not found or cannot be cancelled' });
    }
  } catch (error) {
    console.error('[TRANSCODE] Cancel job error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удалить шаблон (фронтенд: { id })
router.post('/delete-template', (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing template id' });
  }

  try {
    const success = transcodeService.deleteTemplate(id);
    if (success) {
      res.json({ success: true, message: 'Template deleted' });
    } else {
      res.status(404).json({ success: false, error: 'Template not found' });
    }
  } catch (error) {
    console.error('[TRANSCODE] Delete template error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Сохранить шаблон (фронтенд: { name, description, command })
router.post('/save-template', (req, res) => {
  const { name, description, command } = req.body;

  if (!name || !command) {
    return res.status(400).json({ success: false, error: 'Name and command are required' });
  }

  try {
    const id = transcodeService.saveTemplate(null, { name, description, command });
    res.json({ success: true, id, message: 'Template saved' });
  } catch (error) {
    console.error('[TRANSCODE] Save template error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;