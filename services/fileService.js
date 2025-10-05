// services/fileService.js
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class FileService {
  constructor(videoDirectory) {
    this.videoDirectory = videoDirectory || config.videoDirectory;
  }

  // Метод для получения структуры директории
  async getDirectoryStructure(dirPath = '') {
    const fullPath = path.join(this.videoDirectory, dirPath);
    try {
      const items = await fs.readdir(fullPath);
      const structure = [];

      for (const item of items) {
        const itemPath = path.join(fullPath, item);
        const relativePath = path.join(dirPath, item).replace(/\\/g, '/'); // Убедимся, что пути с '/' для веба
        const stat = await fs.stat(itemPath);

        if (stat.isDirectory()) {
          structure.push({
            name: item,
            path: relativePath,
            type: 'folder',
            children: await this.getDirectoryStructure(relativePath) // Рекурсивно получаем содержимое папки
          });
        } else {
          // Для файлов можно добавить расширение, чтобы плеер знал, поддерживаемый ли это формат
          const ext = path.extname(item).toLowerCase();
          structure.push({
            name: relativePath, // Сохраняем полный путь относительно VIDEO_DIR
            path: relativePath, // Путь для клиента
            type: 'file',
            extension: ext,
            // Опционально: можно добавить размер, дату модификации и т.д.
          });
        }
      }

      return structure;
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка получения структуры директории ${fullPath}:`, error);
      throw error;
    }
  }

  // Новый метод для получения содержимого конкретной папки
  async getFolderContents(folderPath = '') {
    const fullPath = path.join(this.videoDirectory, folderPath);
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

  // Метод для создания новой папки
  async createFolder(folderPath) {
    const fullPath = path.join(this.videoDirectory, folderPath);
    try {
      await fs.mkdir(fullPath, { recursive: true });
      console.log(`[FILE SERVICE] Создана папка: ${fullPath}`);
      return { success: true, message: `Folder ${folderPath} created successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка создания папки ${fullPath}:`, error);
      throw error;
    }
  }

  // Метод для удаления файла или папки
  async deleteItem(itemPath) {
    const fullPath = path.join(this.videoDirectory, itemPath);
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

  // Метод для переименования файла или папки
  async renameItem(oldPath, newPath) {
    const fullOldPath = path.join(this.videoDirectory, oldPath);
    const fullNewPath = path.join(this.videoDirectory, newPath);
    try {
      await fs.rename(fullOldPath, fullNewPath);
      console.log(`[FILE SERVICE] Переименован элемент: ${fullOldPath} -> ${fullNewPath}`);
      return { success: true, message: `Item renamed from ${oldPath} to ${newPath} successfully` };
    } catch (error) {
      console.error(`[FILE SERVICE] Ошибка переименования элемента ${fullOldPath} -> ${fullNewPath}:`, error);
      throw error;
    }
  }

  // Метод для перемещения файла или папки
  async moveItem(sourcePath, destinationPath) {
    const fullSourcePath = path.join(this.videoDirectory, sourcePath);
    const fullDestinationPath = path.join(this.videoDirectory, destinationPath);
    try {
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