// server/services/fileService.js
const fs = require('fs');
const path = require('path');

class FileService {
  constructor(videoFolder) {
    this.videoFolder = videoFolder;
    this.VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|wmv|flv|mkv|mpg|mpeg|3gp|3g2|ts|mts|m2ts|vob|f4v|f4p|f4a|f4b|mp3|wav|aac|flac|wma|m4a|asf|rm|rmvb|vcd|svcd|dvd|yuv|y4m)$/i;
  }

  // Получить относительный путь от VIDEO_FOLDER
  getRelativePath(fullPath) {
    return path.relative(this.videoFolder, fullPath).split(path.sep).join('/');
  }

  // Получить абсолютный путь (с защитой от Directory Traversal)
  getAbsolutePath(relativePath) {
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.videoFolder, normalizedPath);
  }

  // Рекурсивно создать директорию с .empty файлом
  ensureDirWithEmpty(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`[FILE SERVICE] Создана папка: ${dirPath}`);
      this.createEmptyFile(dirPath);
    }
  }

  // Создать файл .empty
  createEmptyFile(dirPath) {
    const emptyFilePath = path.join(dirPath, '.empty');
    try {
      fs.writeFileSync(emptyFilePath, '');
      console.log(`[FILE SERVICE] Создан файл-пустышка: ${emptyFilePath}`);
    } catch (err) {
      console.error(`[FILE SERVICE] Ошибка создания файла-пустышки в ${dirPath}:`, err);
    }
  }

  // Получить структуру папок и файлов (рекурсивно)
  getDirectoryStructure(dir = this.videoFolder, basePath = '') {
    const result = [];
    
    try {
      const items = fs.readdirSync(dir);
      
      items.forEach(item => {
        // Игнорируем файлы-пустышки
        if (item === '.empty') return;

        const fullPath = path.join(dir, item);
        const relativePath = path.join(basePath, item).split(path.sep).join('/');
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          result.push({
            name: item,
            type: 'folder',
            path: relativePath,
            children: this.getDirectoryStructure(fullPath, relativePath)
          });
        } else if (this.VIDEO_EXTENSIONS.test(item)) {
          result.push({
            name: item,
            type: 'file',
            path: relativePath,
            size: stat.size,
            modified: stat.mtime
          });
        }
      });
    } catch (err) {
      console.error(`[FILE SERVICE] Ошибка чтения директории ${dir}:`, err);
    }
    
    return result;
  }

  // Создать папку
  createFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') {
      throw new Error('Invalid folder path');
    }

    const fullPath = this.getAbsolutePath(folderPath);
    const parentDir = path.dirname(fullPath);

    // Проверяем, что родительская директория существует
    if (!fs.existsSync(parentDir)) {
      throw new Error('Parent directory does not exist');
    }

    this.ensureDirWithEmpty(fullPath);
    console.log(`[FILE SERVICE] Папка создана: ${fullPath}`);
    return true;
  }

  // Удалить папку (рекурсивно)
  deleteFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') {
      throw new Error('Invalid folder path');
    }

    const fullPath = this.getAbsolutePath(folderPath);

    // Проверяем, что путь находится внутри VIDEO_FOLDER
    if (!fullPath.startsWith(this.videoFolder)) {
      throw new Error('Cannot delete folder outside base directory');
    }

    // Проверяем, что это действительно папка
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
      throw new Error('Path is not a directory');
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`[FILE SERVICE] Папка удалена: ${fullPath}`);
    return true;
  }

  // Переместить файл или папку
  moveItem(sourcePath, destPath) {
    if (!sourcePath || !destPath || typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('Invalid source or destination path');
    }

    const fullSourcePath = this.getAbsolutePath(sourcePath);
    const fullDestPath = this.getAbsolutePath(destPath);

    // Проверяем, что исходный путь существует
    if (!fs.existsSync(fullSourcePath)) {
      throw new Error('Source file/folder does not exist');
    }

    // Проверяем, что целевой путь существует и является папкой
    if (!fs.existsSync(fullDestPath) || !fs.statSync(fullDestPath).isDirectory()) {
      throw new Error('Destination folder does not exist or is not a folder');
    }

    // Формируем путь к новому месту
    const sourceName = path.basename(sourcePath);
    const newFullPath = path.join(fullDestPath, sourceName);

    // Проверяем, что новый путь не существует
    if (fs.existsSync(newFullPath)) {
      throw new Error('File/folder with this name already exists in destination folder');
    }

    // Проверяем, что не пытаемся переместить папку внутрь себя
    const realSource = fs.realpathSync(fullSourcePath);
    const realDest = fs.realpathSync(fullDestPath);
    
    if (realDest.startsWith(realSource + path.sep)) {
      throw new Error('Cannot move folder inside itself');
    }

    // Перемещаем файл или папку
    fs.renameSync(fullSourcePath, newFullPath);
    console.log(`[FILE SERVICE] Перемещено: ${sourcePath} → ${path.join(destPath, sourceName)}`);
    return true;
  }

  // Проверить существование пути
  pathExists(relativePath) {
    const fullPath = this.getAbsolutePath(relativePath);
    return fs.existsSync(fullPath);
  }

  // Получить информацию о файле/папке
  getItemInfo(relativePath) {
    const fullPath = this.getAbsolutePath(relativePath);
    
    if (!fs.existsSync(fullPath)) {
      throw new Error('Item does not exist');
    }

    const stat = fs.statSync(fullPath);
    
    return {
      name: path.basename(relativePath),
      path: relativePath,
      type: stat.isDirectory() ? 'folder' : 'file',
      size: stat.size,
      created: stat.birthtime,
      modified: stat.mtime,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile()
    };
  }
}

module.exports = FileService;