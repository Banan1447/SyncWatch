// services/transcodeService.js
const fsPromises = require('fs').promises;
const fs = require('fs'); // Для синхронных методов: existsSync, readFileSync
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

class TranscodeService {
  constructor() {
    this.videoDir = config.videoDir;
    this.queue = [];
    this.jobs = new Map();
    this.nextJobId = 1;
    this.running = false;

    // Системные шаблоны (только для чтения)
    this.systemTemplates = {
      'copy-stream': {
        id: 'copy-stream',
        name: 'Copy Stream (No Re-encode)',
        description: 'Fastest: Copies streams without re-encoding. Output: MP4',
        command: '-c copy -map 0'
      }
    };

    // Пользовательские шаблоны
    this.userTemplates = {};
    this.loadUserTemplates();
  }

  // Загрузка пользовательских шаблонов из файла
  loadUserTemplates() {
    const templatesPath = path.join(this.videoDir, 'templates.json');
    try {
      if (fs.existsSync(templatesPath)) {
        const data = fs.readFileSync(templatesPath, 'utf8');
        this.userTemplates = JSON.parse(data);
        // Убедимся, что все шаблоны имеют id
        for (const [id, template] of Object.entries(this.userTemplates)) {
          template.id = id;
        }
      }
    } catch (err) {
      console.warn('[TRANSCODE] Could not load user templates:', err.message);
      this.userTemplates = {};
    }
  }

  // Сохранение пользовательских шаблонов
  saveUserTemplates() {
    const templatesPath = path.join(this.videoDir, 'templates.json');
    return fsPromises.writeFile(
      templatesPath,
      JSON.stringify(this.userTemplates, null, 2),
      'utf8'
    ).catch(err => {
      console.error('[TRANSCODE] Failed to save templates:', err);
    });
  }

  // Получить все шаблоны как массив
  getTemplatesAsArray() {
    return [
      this.systemTemplates['copy-stream'],
      ...Object.values(this.userTemplates)
    ];
  }

  // Получить шаблон по ID
  getTemplateById(id) {
    if (this.systemTemplates[id]) {
      return this.systemTemplates[id];
    }
    return this.userTemplates[id] || null;
  }

  // Сохранить или создать шаблон
  saveTemplate(id, templateData) {
    if (!templateData.name || !templateData.command) {
      throw new Error('Template must have name and command');
    }

    const newId = id || 'template_' + Date.now();
    this.userTemplates[newId] = {
      id: newId,
      name: templateData.name,
      description: templateData.description || '',
      command: templateData.command
    };
    this.saveUserTemplates();
    return newId;
  }

  // Удалить шаблон
  deleteTemplate(id) {
    if (this.systemTemplates[id]) {
      throw new Error('Cannot delete system template');
    }
    if (this.userTemplates[id]) {
      delete this.userTemplates[id];
      this.saveUserTemplates();
      return true;
    }
    return false;
  }

  // Добавить задание в очередь
  addToQueue(inputFile, outputFile, templateId, userId = 'default') {
    const template = this.getTemplateById(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    const jobId = this.nextJobId++;
    const job = {
      id: jobId,
      inputFile,
      outputFile,
      templateId,
      templateName: template.name,
      userId,
      status: 'pending',
      progress: 0,
      isCancelled: false,
      error: null,
      eta: null
    };

    this.queue.push(job);
    this.jobs.set(jobId, job);
    this.processQueue();
    return true;
  }

  // Обработка очереди (по одному заданию)
  async processQueue() {
    if (this.running) return;

    const pendingJob = this.queue.find(job => job.status === 'pending');
    if (!pendingJob) return;

    this.running = true;
    const job = pendingJob;
    job.status = 'processing';

    try {
      await this.runTranscodeJob(job);
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Unknown error';
      console.error(`[TRANSCODE] Job ${job.id} failed:`, err.message);
    } finally {
      this.running = false;
      // Запустить следующее задание
      setImmediate(() => this.processQueue());
    }
  }

  // Выполнить транскодирование
  async runTranscodeJob(job) {
    const inputPath = path.join(this.videoDir, job.inputFile);
    const outputPath = path.join(this.videoDir, job.outputFile);
    const template = this.getTemplateById(job.templateId);

    // Проверка существования входного файла
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${job.inputFile}`);
    }

    // Формируем аргументы для ffmpeg
    const args = ['-i', inputPath, ...template.command.trim().split(/\s+/), outputPath];

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('close', (code) => {
        if (job.isCancelled) {
          job.status = 'cancelled';
          // Удаляем незавершённый файл
          fsPromises.unlink(outputPath).catch(() => {});
          resolve();
        } else if (code === 0) {
          job.status = 'completed';
          job.progress = 100;
          resolve();
        } else {
          job.status = 'error';
          job.error = `FFmpeg exited with code ${code}`;
          // Удаляем битый файл
          fsPromises.unlink(outputPath).catch(() => {});
          reject(new Error(job.error));
        }
      });

      ffmpeg.on('error', (err) => {
        job.status = 'error';
        job.error = err.message;
        fsPromises.unlink(outputPath).catch(() => {});
        reject(err);
      });

      // Опционально: парсинг прогресса через stderr (упрощённо)
      // ffmpeg.stderr.on('data', (data) => { ... });
    });
  }

  // Отмена задания
  cancelJob(jobId) {
    const job = this.jobs.get(Number(jobId));
    if (!job) return false;
    if (job.status !== 'pending' && job.status !== 'processing') return false;

    job.isCancelled = true;
    // Если задание в процессе — оно будет помечено как cancelled при завершении
    return true;
  }

  // Получить очередь с именами шаблонов
  getQueueWithNames() {
    return this.queue.map(job => ({
      id: job.id,
      fileId: job.inputFile,
      outputFile: job.outputFile,
      templateId: job.templateId,
      templateName: job.templateName,
      status: job.status,
      progress: job.progress,
      isCancelled: job.isCancelled,
      error: job.error,
      eta: job.eta
    }));
  }

  // Быстрое транскодирование с кастомной командой
  async quickTranscodeWithCommand(inputFile, outputFile, command) {
    const inputPath = path.join(this.videoDir, inputFile);
    const outputPath = path.join(this.videoDir, outputFile);

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const args = ['-i', inputPath, ...command.trim().split(/\s+/), outputPath];

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, output: outputFile });
        } else {
          // Удаляем неудачный файл
          fsPromises.unlink(outputPath).catch(() => {});
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        fsPromises.unlink(outputPath).catch(() => {});
        reject(err);
      });
    });
  }
}

module.exports = TranscodeService;