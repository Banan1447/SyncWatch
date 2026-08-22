/**
 * atomicWrite.js
 * 
 * Утилита для обеспечения атомарной записи файлов JSON, предотвращая потерю данных при внезапном крахе сервера (crash).
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Генерирует безопасный временный путь для записи.
 * @param {string} originalPath - Целевой, конечный путь к файлу.
 * @returns {Promise<string>} Путь к созданному temp-файлу.
 */
async function getTempFilePath(originalPath) {
    const dir = path.dirname(originalPath);
    // Генерируем уникальное имя файла на основе целевого пути и временной метки
    const tempFileName = `${path.basename(originalPath)}.temp.${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return path.join(dir, tempFileName);
}

/**
 * Выполняет атомарную запись данных в указанный файл.
 * 1. Записывает содержимое во временный файл.
 * 2. Переименовывает (rename) временный файл в целевой путь.
 * Это гарантирует, что либо весь процесс записи успешен, либо ничего не изменилось.
 * @param {string} targetPath - Абсолютный путь к файлу, который нужно обновить.
 * @param {*} dataToWrite - Данные, которые нужно записать (должны быть сериализуемыми).
 * @returns {Promise<boolean>} Promise, разрешающийся в true при успехе.
 */
async function atomicWriteFile(targetPath, dataToWrite) {
    const tempPath = await getTempFilePath(targetPath);

    let content;
    try {
        // 1. Сериализация данных
        if (typeof dataToWrite === 'object' && dataToWrite !== null) {
            content = JSON.stringify(dataToWrite, null, 2) + '\n'; // Красивый форматинг для читаемости
        } else if (typeof dataToWrite === 'string') {
            content = dataToWrite;
        } else {
             throw new Error(`Unsupported data type for atomic write: ${typeof dataToWrite}`);
        }

    } catch (e) {
         // Обработка ошибок сериализации до попытки записи на диск
         console.error(`[Persistence Error] Serialization failed for ${targetPath}:`, e.message);
         throw new Error("Failed to prepare data for file save.");
    }


    try {
        // 2. Запись во временный файл
        await fs.writeFile(tempPath, content, 'utf8');

        // 3. Атомарный rename — это операция на уровне файловой системы, которая гарантирует атомарность.
        await fs.rename(tempPath, targetPath);

        console.log(`[Persistence] Successfully wrote data atomically to: ${targetPath}`);
        return true;

    } catch (error) {
        // В случае ошибки записи/переименования, мы пытаемся очистить временный файл
        try {
            await fs.unlink(tempPath);
        } catch (cleanupError) {
            // Игнорируем ошибку очистки — это не критично для основного сбоя
        }
        console.error(`[Persistence Error] Failed to perform atomic write on ${targetPath}:`, error.message);
        throw new Error("Failed to save file atomically due to IO or FS error.");
    }
}

module.exports = {
    atomicWriteFile,
};