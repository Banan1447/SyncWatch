// routes/transcode.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
// const { isLocalhostOnly } = require('../middleware/auth'); // или где там находится
const config = require('../config'); // или '../config' если используете config/index.js
const TranscodeService = require('../services/transcodeService'); // Импортируем сервис

// Создаём экземпляр сервиса
const transcodeService = new TranscodeService();

// --- ОЧЕРЕДЬ ---

// Получить очередь (использует новый метод)
router.get('/queue', (req, res) => {
  try {
    const queue = transcodeService.getQueueWithNames();
    res.json({ success: true, queue });
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка получения очереди:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ШАБЛОНЫ ---

// Получить шаблоны (использует новый метод)
router.get('/templates', (req, res) => {
  try {
    const templates = transcodeService.getTemplatesAsArray();
    res.json({ success: true, templates });
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка получения шаблонов:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- БЫСТРОЕ ТРАНСКОДИРОВАНИЕ ---

// Выполнить быстрое транскодирование
router.post('/quick-transcode', async (req, res) => {
  const { inputFile, outputFile, templateId } = req.body; // Пример входных данных
  if (!inputFile || !outputFile || !templateId) {
    return res.status(400).json({ success: false, error: 'Missing required fields: inputFile, outputFile, templateId' });
  }

  try {
    // Вызываем метод quickTranscode из сервиса
    const result = await transcodeService.quickTranscode(inputFile, outputFile, templateId);
    res.json(result); // Возвращаем результат из сервиса
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка быстрого транскодирования:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ОСТАЛЬНЫЕ МАРШРУТЫ (примеры, могут отличаться) ---
// Добавить задание в очередь
router.post('/queue', (req, res) => {
  const { inputFile, outputFile, templateId, userId } = req.body; // Пример входных данных
  if (!inputFile || !outputFile || !templateId || !userId) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const success = transcodeService.addToQueue(inputFile, outputFile, templateId, userId);
    if (success) {
      res.json({ success: true, message: 'Job added to queue' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to add job to queue' });
    }
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка добавления задания в очередь:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Отменить задание
router.delete('/queue/:jobId', (req, res) => {
  const { jobId } = req.params;
  try {
    const success = transcodeService.cancelJob(jobId);
    if (success) {
      res.json({ success: true, message: 'Job cancelled' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to cancel job' });
    }
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка отмены задания:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Сохранить/обновить шаблон
router.post('/templates', (req, res) => {
  const { id, templateData } = req.body; // Пример входных данных
  if (!id || !templateData) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    transcodeService.saveTemplate(id, templateData);
    res.json({ success: true, message: 'Template saved' });
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка сохранения шаблона:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удалить шаблон
router.delete('/templates/:id', (req, res) => {
  const { id } = req.params;
  try {
    transcodeService.deleteTemplate(id);
    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    console.error('[TRANSCODE ROUTES] Ошибка удаления шаблона:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
