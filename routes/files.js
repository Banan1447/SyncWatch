// server/routes/files.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const FileService = require('../services/fileService');
const { isLocalhostOnly } = require('../middleware/auth');
const { logClientRequest } = require('../middleware/logging');
const config = require('../config');

const fileService = new FileService(config.videoDirectory);

// Настройка multer для загрузки с поддержкой папок
const folderAwareStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let relativeFolderPath = req.headers['x-folder-path'] || req.body.folderPath || '';
    relativeFolderPath = path.normalize(relativeFolderPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absoluteFolderPath = path.join(config.videoDirectory, relativeFolderPath);
    
    fileService.ensureDirWithEmpty(absoluteFolderPath);
    cb(null, absoluteFolderPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const folderAwareUpload = multer({ storage: folderAwareStorage });

// GET /api/files/list
router.get('/list', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  logClientRequest(clientIP, 'N/A', 'GET /api/files/list', '');
  
  try {
    const structure = fileService.getDirectoryStructure();
    res.json({ success: true, structure });
  } catch (error) {
    console.error('[FILES API] Ошибка получения структуры:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/create-folder
router.post('/create-folder', isLocalhostOnly, (req, res) => {
  const { folderPath } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/files/create-folder', `Path: ${folderPath}`);
  
  try {
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid folder path' });
    }

    fileService.createFolder(folderPath);
    res.json({ success: true });
  } catch (error) {
    console.error('[FILES API] Ошибка создания папки:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/delete-folder
router.post('/delete-folder', isLocalhostOnly, (req, res) => {
  const { folderPath } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/files/delete-folder', `Path: ${folderPath}`);
  
  try {
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid folder path' });
    }

    fileService.deleteFolder(folderPath);
    res.json({ success: true });
  } catch (error) {
    console.error('[FILES API] Ошибка удаления папки:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/move
router.post('/move', isLocalhostOnly, (req, res) => {
  const { sourcePath, destPath } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'POST /api/files/move', `Source: ${sourcePath}, Dest: ${destPath}`);
  
  try {
    if (!sourcePath || !destPath || typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid source or destination path' });
    }

    fileService.moveItem(sourcePath, destPath);
    res.json({ success: true });
  } catch (error) {
    console.error('[FILES API] Ошибка перемещения:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/upload/to-folder
router.post('/upload/to-folder', folderAwareUpload.single('video'), (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  const folderPath = req.headers['x-folder-path'] || req.body.folderPath || '';
  
  logClientRequest(clientIP, 'N/A', 'POST /api/files/upload/to-folder', 
    `File: ${req.file ? req.file.filename : 'N/A'}, Folder: ${folderPath}`);
  
  if (req.file) {
    const relativeFilePath = path.join(folderPath, req.file.filename).split(path.sep).join('/');
    res.json({ success: true, file: req.file.filename, path: relativeFilePath });
  } else {
    res.status(400).json({ success: false, error: 'File not uploaded' });
  }
});

// GET /api/files/info
router.get('/info', (req, res) => {
  const { path: itemPath } = req.query;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  logClientRequest(clientIP, 'N/A', 'GET /api/files/info', `Path: ${itemPath}`);
  
  try {
    if (!itemPath) {
      return res.status(400).json({ success: false, error: 'Path parameter required' });
    }

    const info = fileService.getItemInfo(itemPath);
    res.json({ success: true, info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;