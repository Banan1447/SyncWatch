// routes/files.js
const express = require('express');
const router = express.Router();
const FileService = require('../services/fileService');
const { authenticateToken } = require('../middleware/auth');
const config = require('../config');

// Создаем экземпляр FileService, передавая ему директорию с видео
const fileService = new FileService(config.videoDirectory);

// Маршрут для получения структуры файлов (папки и файлы)
router.get('/list', authenticateToken, async (req, res) => {
  try {
    console.log('[FILES ROUTE] Запрос на получение структуры файлов от пользователя:', req.user?.username);
    const structure = await fileService.getDirectoryStructure();
    console.log(`[FILES ROUTE] Успешно получена структура файлов. Найдено ${structure.length} элементов на верхнем уровне.`);
    res.json({ success: true, structure });
  } catch (error) {
    console.error('[FILES ROUTE] Ошибка получения структуры файлов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Маршрут для получения содержимого конкретной папки
router.get('/list-folder', authenticateToken, async (req, res) => {
  try {
    const { path: folderPath = '' } = req.query;
    console.log('[FILES ROUTE] Запрос на получение содержимого папки:', folderPath, 'от пользователя:', req.user?.username);
    const contents = await fileService.getFolderContents(folderPath);
    console.log(`[FILES ROUTE] Успешно получено содержимое папки ${folderPath || 'ROOT'}. Найдено ${contents.length} элементов.`);
    res.json({ success: true, contents });
  } catch (error) {
    console.error('[FILES ROUTE] Ошибка получения содержимого папки:', error);
    if (error.code === 'ENOENT' || error.message.includes('not found') || error.message.includes('does not exist')) {
       res.status(404).json({ success: false, error: 'Folder not found' });
    } else {
       res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Маршрут для создания новой папки
router.post('/create-folder', authenticateToken, async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
       return res.status(400).json({ success: false, error: 'Path is required' });
    }
    console.log('[FILES ROUTE] Запрос на создание папки:', folderPath, 'от пользователя:', req.user?.username);
    const result = await fileService.createFolder(folderPath);
    console.log('[FILES ROUTE] Папка успешно создана:', folderPath);
    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('[FILES ROUTE] Ошибка создания папки:', error);
    if (error.code === 'EEXIST') {
       res.status(409).json({ success: false, error: 'Folder already exists' });
    } else {
       res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Маршрут для удаления файла или папки
router.delete('/delete', authenticateToken, async (req, res) => {
  try {
    const { path: itemPath } = req.body;
    if (!itemPath) {
       return res.status(400).json({ success: false, error: 'Path is required' });
    }
    console.log('[FILES ROUTE] Запрос на удаление элемента:', itemPath, 'от пользователя:', req.user?.username);
    const result = await fileService.deleteItem(itemPath);
    console.log('[FILES ROUTE] Элемент успешно удален:', itemPath);
    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('[FILES ROUTE] Ошибка удаления элемента:', error);
    if (error.code === 'ENOENT') {
       res.status(404).json({ success: false, error: 'Item not found' });
    } else {
       res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Маршрут для переименования файла или папки
router.put('/rename', authenticateToken, async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
       return res.status(400).json({ success: false, error: 'Both oldPath and newPath are required' });
    }
    console.log('[FILES ROUTE] Запрос на переименование элемента:', oldPath, '->', newPath, 'от пользователя:', req.user?.username);
    const result = await fileService.renameItem(oldPath, newPath);
    console.log('[FILES ROUTE] Элемент успешно переименован:', oldPath, '->', newPath);
    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('[FILES ROUTE] Ошибка переименования элемента:', error);
    if (error.code === 'ENOENT') {
       res.status(404).json({ success: false, error: 'Item not found' });
    } else if (error.code === 'EEXIST') {
       res.status(409).json({ success: false, error: 'Destination already exists' });
    } else {
       res.status(500).json({ success: false, error: error.message });
    }
  }
});

// === ИСПРАВЛЕННЫЙ МАРШРУТ: Перемещение файлов или папок ===
router.put('/move', authenticateToken, async (req, res) => {
  try {
    const { items, destination } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
       return res.status(400).json({ success: false, error: 'Items array is required and cannot be empty' });
    }
    if (typeof destination !== 'string') {
       return res.status(400).json({ success: false, error: 'Destination must be a string (folder path)' });
    }

    console.log(`[FILES ROUTE] Запрос на перемещение ${items.length} элементов в папку: "${destination}" от пользователя:`, req.user?.username);
    console.log(`[FILES ROUTE] Элементы для перемещения:`, items);

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    for (const itemPath of items) {
        try {
            console.log(`[FILES ROUTE] Перемещение элемента: "${itemPath}" -> папка "${destination}"`);
            // ✅ ПЕРЕДАЁМ ТОЛЬКО ПАПКУ НАЗНАЧЕНИЯ
            const result = await fileService.moveItem(itemPath, destination);
            console.log(`[FILES ROUTE] Элемент успешно перемещен: "${itemPath}" в папку "${destination}"`);
            successCount++;
        } catch (itemError) {
            console.error(`[FILES ROUTE] Ошибка перемещения элемента "${itemPath}":`, itemError.message);
            errors.push({ item: itemPath, error: itemError.message });
            failCount++;
        }
    }

    if (failCount === 0) {
        res.status(200).json({ 
            success: true, 
            message: `Successfully moved ${successCount} item(s).` 
        });
    } else if (successCount === 0) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to move any items.', 
            details: errors 
        });
    } else {
        res.status(207).json({ 
            success: false, 
            message: `Operation completed with errors. Moved ${successCount}, failed ${failCount}.`, 
            details: errors 
        });
    }

  } catch (error) {
    console.error('[FILES ROUTE] Неожиданная ошибка в обработчике /move:', error);
    res.status(500).json({ success: false, error: 'Internal server error during move operation.' });
  }
});
// === КОНЕЦ ИСПРАВЛЕННОГО МАРШРУТА ===

module.exports = router;