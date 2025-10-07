const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class FileService {
  constructor(videoDirectory) {
    // Нормализуем и разрешаем абсолютный путь к базовой директории
    this.videoDirectory = path.resolve(videoDirectory || config.videoDirectory);
  }

  // Вспомогательный метод: безопасное разрешение пути внутри videoDirectory
  _resolveSafePath(relativePath) {
    // Убираем начальные ./ и ../, нормализуем
    const normalized = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/g, '');
    const resolved = path.join(this.videoDirectory, normalized);

    // Защита от directory traversal
    if (!resolved.startsWith(this.videoDirectory)) {
      throw new Error('Access denied: Path outside base directory');
    }

    return resolved;
  }

  // Метод для получения структуры директории
  async getDirectoryStructure(dirPath = '') {
    const fullPath = this._resolveSafePath(dirPath);
    try {
      const items = await fs.readdir(fullPath);
      const structure = [];

      for (const item of items) {
        const itemPath = path.join(fullPath, item);
        const relativePath = path.join(dirPath, item).replace(/\\/g, '/'); // Для веба — слэши
        const stat = await fs.stat(itemPath);

        if (stat.isDirectory()) {
          structure.push({
            name: item,
            path: relativePath,
            type: 'folder',
            children: await this.getDirectoryStructure(relativePath)
          });
        } else {
          const ext = path.extname(item).toLowerCase();
          structure.push({
            name: relativePath,
            path: relativePath,
            type: 'file',
            extension: ext,
          });
        }
      }

      return structure;
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка получения структуры директории ${fullPath}:`, error);
      throw error;
    }
  }

  // Получение содержимого конкретной папки
  async getFolderContents(folderPath = '') {
    const fullPath = this._resolveSafePath(folderPath);
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path ${fullPath} is not a directory`);
      }

      const items = await fs.readdir(fullPath);
      const contents = [];

      for (const item of items) {
        const itemPath = path.join(fullPath, item);
        const relativePath = path.join(folderPath, item).replace(/\\/g, '/');
        const itemStats = await fs.stat(itemPath);

        if (itemStats.isDirectory()) {
          contents.push({
            name: item,
            path: relativePath,
            type: 'folder',
            size: itemStats.size,
            modified: itemStats.mtime.toISOString()
          });
        } else {
          const ext = path.extname(item).toLowerCase();
          contents.push({
            name: item,
            path: relativePath,
            type: 'file',
            extension: ext,
            size: itemStats.size,
            modified: itemStats.mtime.toISOString()
          });
        }
      }

      return contents;
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка получения содержимого папки ${fullPath}:`, error);
      throw error;
    }
  }

  // Создание папки
  async createFolder(folderPath) {
    const fullPath = this._resolveSafePath(folderPath);
    try {
      await fs.mkdir(fullPath, { recursive: true });
      console.log(`[FILE SERVICE] Создана папка: ${fullPath}`);
      return { success: true, message: `Folder ${folderPath} created successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка создания папки ${fullPath}:`, error);
      throw error;
    }
  }

  // Удаление файла или папки
  async deleteItem(itemPath) {
    const fullPath = this._resolveSafePath(itemPath);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        await fs.rmdir(fullPath, { recursive: true });
        console.log(`[FILE SERVICE] Удалена папка: ${fullPath}`);
      } else {
        await fs.unlink(fullPath);
        console.log(`[FILE SERVICE] Удален файл: ${fullPath}`);
      }
      return { success: true, message: `Item ${itemPath} deleted successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка удаления элемента ${fullPath}:`, error);
      throw error;
    }
  }

  // Переименование
  async renameItem(oldPath, newPath) {
    const fullOldPath = this._resolveSafePath(oldPath);
    const fullNewPath = this._resolveSafePath(newPath);
    try {
      await fs.rename(fullOldPath, fullNewPath);
      console.log(`[FILE SERVICE] Переименован элемент: ${fullOldPath} -> ${fullNewPath}`);
      return { success: true, message: `Item renamed from ${oldPath} to ${newPath} successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка переименования элемента ${fullOldPath} -> ${fullNewPath}:`, error);
      throw error;
    }
  }

  // ✅ ИСПРАВЛЕННЫЙ МЕТОД ПЕРЕМЕЩЕНИЯ
  async moveItem(sourcePath, destinationPath) {
    const fullSourcePath = this._resolveSafePath(sourcePath);
    let fullDestinationPath = this._resolveSafePath(destinationPath);

    try {
      // Проверяем, существует ли destination и является ли он директорией
      let isDestinationDir = false;
      try {
        const destStat = await fs.stat(fullDestinationPath);
        if (destStat.isDirectory()) {
          isDestinationDir = true;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // Если destination не существует — это нормально (будет новое имя файла)
      }

      // Если destination — директория, перемещаем ВНУТРЬ неё
      if (isDestinationDir) {
        const fileName = path.basename(fullSourcePath);
        fullDestinationPath = path.join(fullDestinationPath, fileName);
      }

      // Проверка: не существует ли уже целевой файл (защита от перезаписи)
      try {
        await fs.stat(fullDestinationPath);
        throw new Error(`Destination already exists: ${fullDestinationPath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // Выполняем перемещение
      await fs.rename(fullSourcePath, fullDestinationPath);
      console.log(`[FILE SERVICE] Перемещен элемент: ${fullSourcePath} -> ${fullDestinationPath}`);
      return { success: true, message: `Item moved from ${sourcePath} to ${destinationPath} successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка перемещения элемента ${fullSourcePath} -> ${fullDestinationPath}:`, error);
      throw error;
    }
  }
}

module.exports = FileService;