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

// Добавить в очередь (фронтенд: { fileId, templateId, outputFile?, useCuda? })
router.post('/add-to-queue', (req, res) => {
  const { fileId, templateId, outputFile, useCuda } = req.body;

  // Валидация входных данных
  if (!fileId || typeof fileId !== 'string' || fileId.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing fileId' });
  }

  if (!templateId || typeof templateId !== 'string' || templateId.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing templateId' });
  }

  if (outputFile && (typeof outputFile !== 'string' || outputFile.length === 0)) {
    return res.status(400).json({ success: false, error: 'Invalid outputFile format' });
  }

  if (useCuda !== undefined && typeof useCuda !== 'boolean') {
    return res.status(400).json({ success: false, error: 'useCuda must be a boolean' });
  }

  try {
    const success = transcodeService.addToQueue(fileId, outputFile, templateId, 'default_user', useCuda);
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

// Быстрое транскодирование (фронтенд: { filename, command, useCuda? })
router.post('/quick-transcode', async (req, res) => {
  const { filename, command, useCuda } = req.body;

  // Валидация входных данных
  if (!filename || typeof filename !== 'string' || filename.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing filename' });
  }

  if (!command || typeof command !== 'string' || command.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing command' });
  }

  if (useCuda !== undefined && typeof useCuda !== 'boolean') {
    return res.status(400).json({ success: false, error: 'useCuda must be a boolean' });
  }

  // Проверка на потенциально опасные команды
  if (command.includes('rm ') || command.includes('del ') || command.includes('unlink') ||
      command.includes('mv ') || command.includes('cp ') || command.includes('chmod') ||
      command.includes('chown') || command.includes('sudo') || command.includes('su ')) {
    return res.status(400).json({ success: false, error: 'Command contains potentially dangerous operations' });
  }

  try {
    const outputFile = getOutputPath(filename, '_quick');
    await transcodeService.quickTranscodeWithCommand(filename, outputFile, command, useCuda);
    res.json({ success: true, output: outputFile });
  } catch (error) {
    console.error('[TRANSCODE] Quick transcode error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Отмена задания (фронтенд: { jobId })
router.post('/cancel-job', (req, res) => {
  const { jobId } = req.body;

  // Валидация входных данных
  if (!jobId || isNaN(Number(jobId))) {
    return res.status(400).json({ success: false, error: 'Invalid or missing jobId' });
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

  // Валидация входных данных
  if (!id || typeof id !== 'string' || id.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing template id' });
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

  // Валидация входных данных
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing template name' });
  }

  if (name.length > 100) {
    return res.status(400).json({ success: false, error: 'Template name too long (max 100 characters)' });
  }

  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid or missing command' });
  }

  if (command.length > 1000) {
    return res.status(400).json({ success: false, error: 'Command too long (max 1000 characters)' });
  }

  // Проверка на потенциально опасные команды
  if (command.includes('rm ') || command.includes('del ') || command.includes('unlink') ||
      command.includes('mv ') || command.includes('cp ') || command.includes('chmod') ||
      command.includes('chown') || command.includes('sudo') || command.includes('su ')) {
    return res.status(400).json({ success: false, error: 'Command contains potentially dangerous operations' });
  }

  if (description && typeof description !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid description format' });
  }

  if (description && description.length > 500) {
    return res.status(400).json({ success: false, error: 'Description too long (max 500 characters)' });
  }

  try {
    const id = transcodeService.saveTemplate(null, {
      name: name.trim(),
      description: description ? description.trim() : '',
      command: command.trim()
    });
    res.json({ success: true, id, message: 'Template saved' });
  } catch (error) {
    console.error('[TRANSCODE] Save template error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;