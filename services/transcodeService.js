// server/services/transcodeService.js
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

class TranscodeService {
  constructor(videoFolder) {
    this.videoFolder = videoFolder;
    this.templatesFile = path.join(__dirname, '../../transcode-templates.json');
    this.queueFile = path.join(__dirname, '../../transcode-queue.json');
    this.currentJob = null;
    
    this.initFiles();
  }

  initFiles() {
    // Инициализация файла шаблонов
    if (!fs.existsSync(this.templatesFile)) {
      const defaultTemplates = [
        {
          id: 'tmpl_1',
          name: 'Low Quality MP4',
          description: '480p MP4 for web playback',
          command: '-vf scale=854:480 -c:v libx264 -crf 23 -preset fast {output}',
          createdAt: new Date().toISOString()
        },
        {
          id: 'tmpl_2',
          name: 'High Quality MP4',
          description: '1080p MP4 with high quality',
          command: '-vf scale=1920:1080 -c:v libx264 -crf 18 -preset slow {output}',
          createdAt: new Date().toISOString()
        }
      ];
      this.saveTemplates(defaultTemplates);
    }

    // Инициализация файла очереди
    if (!fs.existsSync(this.queueFile)) {
      this.saveQueue([]);
    }
  }

  // Шаблоны
  loadTemplates() {
    try {
      if (fs.existsSync(this.templatesFile)) {
        const data = fs.readFileSync(this.templatesFile, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (err) {
      console.error('[TRANSCODE SERVICE] Ошибка загрузки шаблонов:', err);
      return [];
    }
  }

  saveTemplates(templates) {
    try {
      fs.writeFileSync(this.templatesFile, JSON.stringify(templates, null, 2));
      return true;
    } catch (err) {
      console.error('[TRANSCODE SERVICE] Ошибка сохранения шаблонов:', err);
      return false;
    }
  }

  createTemplate(name, description, command) {
    const templates = this.loadTemplates();
    const id = 'tmpl_' + Math.random().toString(36).substr(2, 8);

    const newTemplate = {
      id,
      name,
      description: description || '',
      command,
      createdAt: new Date().toISOString()
    };

    templates.push(newTemplate);
    
    if (this.saveTemplates(templates)) {
      return newTemplate;
    } else {
      throw new Error('Failed to save template');
    }
  }

  deleteTemplate(id) {
    let templates = this.loadTemplates();
    const templateIndex = templates.findIndex(t => t.id === id);
    
    if (templateIndex === -1) {
      throw new Error('Template not found');
    }

    templates.splice(templateIndex, 1);
    
    if (this.saveTemplates(templates)) {
      return true;
    } else {
      throw new Error('Failed to delete template');
    }
  }

  // Очередь
  loadQueue() {
    try {
      if (fs.existsSync(this.queueFile)) {
        const data = fs.readFileSync(this.queueFile, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (err) {
      console.error('[TRANSCODE SERVICE] Ошибка загрузки очереди:', err);
      return [];
    }
  }

  saveQueue(queue) {
    try {
      fs.writeFileSync(this.queueFile, JSON.stringify(queue, null, 2));
      return true;
    } catch (err) {
      console.error('[TRANSCODE SERVICE] Ошибка сохранения очереди:', err);
      return false;
    }
  }

  addToQueue(fileId, templateId) {
    const queue = this.loadQueue();
    const templates = this.loadTemplates();
    
    const template = templates.find(t => t.id === templateId);
    if (!template) {
      throw new Error('Template not found');
    }

    // Проверяем существование файла
    const inputFile = path.join(this.videoFolder, fileId);
    if (!fs.existsSync(inputFile)) {
      throw new Error('Input file not found');
    }

    const id = 'job_' + Math.random().toString(36).substr(2, 8);
    const newJob = {
      id,
      fileId,
      templateId,
      status: 'pending',
      progress: 0,
      isCancelled: false,
      createdAt: new Date().toISOString()
    };

    queue.push(newJob);
    
    if (this.saveQueue(queue)) {
      return newJob;
    } else {
      throw new Error('Failed to add to queue');
    }
  }

  cancelJob(jobId) {
    let queue = this.loadQueue();
    const jobIndex = queue.findIndex(item => item.id === jobId);

    if (jobIndex === -1) {
      throw new Error('Job not found');
    }

    const job = queue[jobIndex];

    if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
      throw new Error('Job cannot be cancelled (already finished)');
    }

    job.isCancelled = true;

    // Если задание еще не началось, сразу удаляем
    if (job.status === 'pending') {
      queue.splice(jobIndex, 1);
    }

    if (this.saveQueue(queue)) {
      return true;
    } else {
      throw new Error('Failed to update queue');
    }
  }

  // Быстрое транскодирование
  async quickTranscode(filename) {
    if (!filename || typeof filename !== 'string') {
      throw new Error('Invalid filename');
    }

    const inputFile = path.join(this.videoFolder, filename);
    const ext = path.extname(filename).toLowerCase();
    const name = path.basename(filename, ext);
    const outputFile = path.join(this.videoFolder, `${name}.mp4`);

    if (!fs.existsSync(inputFile)) {
      throw new Error('Input file not found');
    }

    if (fs.existsSync(outputFile)) {
      throw new Error('Output file already exists');
    }

    console.log(`[TRANSCODE SERVICE] Начало быстрого транскодирования: ${filename} → ${name}.mp4`);

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputFile)
        .output(outputFile)
        .videoCodec('h264_nvenc')
        .audioCodec('aac')
        .outputOption('-preset', 'llhq')
        .on('start', (cmd) => {
          console.log(`[TRANSCODE SERVICE] Запущена команда: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`[TRANSCODE SERVICE] Прогресс: ${filename} - ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`[TRANSCODE SERVICE] Завершено быстрое транскодирование: ${filename} → ${name}.mp4`);
          resolve({ output: `${name}.mp4` });
        })
        .on('error', (err) => {
          console.error(`[TRANSCODE SERVICE] Ошибка быстрого транскодирования: ${filename}`, err);
          
          // Fallback на CPU кодирование
          console.log(`[TRANSCODE SERVICE] Fallback: стандартное кодирование CPU для ${filename}`);
          const fallbackCommand = ffmpeg(inputFile)
            .output(outputFile)
            .videoCodec('libx264')
            .audioCodec('aac')
            .on('start', (cmd) => {
              console.log(`[TRANSCODE SERVICE] Запущена fallback команда: ${cmd}`);
            })
            .on('progress', (progress) => {
              if (progress.percent) {
                console.log(`[TRANSCODE SERVICE] Fallback прогресс: ${filename} - ${Math.round(progress.percent)}%`);
              }
            })
            .on('end', () => {
              console.log(`[TRANSCODE SERVICE] Завершено fallback транскодирование: ${filename} → ${name}.mp4`);
              resolve({ output: `${name}.mp4` });
            })
            .on('error', (fallbackErr) => {
              console.error(`[TRANSCODE SERVICE] Ошибка fallback транскодирования: ${filename}`, fallbackErr);
              reject(fallbackErr);
            });

          fallbackCommand.run();
        });

      command.run();
    });
  }

  // Обработка очереди
  async processQueue() {
    if (this.currentJob) {
      console.log('[TRANSCODE SERVICE] Уже обрабатывается задание, ожидание...');
      return;
    }

    const queue = this.loadQueue();
    const pendingJob = queue.find(item => item.status === 'pending' && !item.isCancelled);

    if (!pendingJob) {
      console.log('[TRANSCODE SERVICE] Очередь пуста или все задания отменены/обработаны');
      return;
    }

    this.currentJob = pendingJob;
    
    try {
      // Проверяем отмену перед началом обработки
      const freshQueue = this.loadQueue();
      const freshJob = freshQueue.find(item => item.id === pendingJob.id);
      
      if (freshJob && freshJob.isCancelled) {
        console.log(`[TRANSCODE SERVICE] Задание ${pendingJob.id} было отменено до начала обработки`);
        pendingJob.status = 'cancelled';
        pendingJob.completedAt = new Date().toISOString();
        this.saveQueue(queue);
        this.currentJob = null;
        setTimeout(() => this.processQueue(), 1000);
        return;
      }

      // Начинаем обработку
      pendingJob.status = 'processing';
      pendingJob.startedAt = new Date().toISOString();
      this.saveQueue(queue);

      await this.processJob(pendingJob);
      
    } catch (error) {
      console.error(`[TRANSCODE SERVICE] Ошибка обработки задания ${pendingJob.id}:`, error);
      pendingJob.status = 'error';
      pendingJob.error = error.message;
      pendingJob.completedAt = new Date().toISOString();
      this.saveQueue(queue);
    } finally {
      this.currentJob = null;
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  async processJob(job) {
    const templates = this.loadTemplates();
    const template = templates.find(t => t.id === job.templateId);
    
    if (!template) {
      throw new Error('Template not found');
    }

    const inputFile = path.join(this.videoFolder, job.fileId);
    const outputFile = path.join(this.videoFolder,
      job.fileId.replace(/\.[^/.]+$/, "") + "_" +
      template.name.toLowerCase().replace(/\s+/g, '_') + ".mp4");

    console.log(`[TRANSCODE SERVICE] Начало конвертации: ${job.fileId} → ${outputFile}`);

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputFile)
        .output(outputFile)
        .on('start', (cmd) => {
          console.log(`[TRANSCODE SERVICE] FFmpeg запущен для ${job.fileId}: ${cmd}`);
        })
        .on('progress', (progress) => {
          // Обновляем прогресс
          const queue = this.loadQueue();
          const currentJob = queue.find(item => item.id === job.id);
          
          if (currentJob && !currentJob.isCancelled && progress.percent) {
            currentJob.progress = progress.percent;
            this.saveQueue(queue);
            console.log(`[TRANSCODE SERVICE] Прогресс: ${job.fileId} - ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`[TRANSCODE SERVICE] Завершена конвертация: ${job.fileId}`);
          
          const queue = this.loadQueue();
          const completedJob = queue.find(item => item.id === job.id);
          
          if (completedJob && !completedJob.isCancelled) {
            completedJob.status = 'completed';
            completedJob.completedAt = new Date().toISOString();
            this.saveQueue(queue);
          }
          
          resolve();
        })
        .on('error', (err) => {
          console.error(`[TRANSCODE SERVICE] Ошибка конвертации: ${job.fileId}`, err);
          
          const queue = this.loadQueue();
          const failedJob = queue.find(item => item.id === job.id);
          
          if (failedJob && !failedJob.isCancelled) {
            failedJob.status = 'error';
            failedJob.error = err.message;
            failedJob.completedAt = new Date().toISOString();
            this.saveQueue(queue);
          }
          
          reject(err);
        });

      command.run();
    });
  }

  getQueueWithNames() {
    const queue = this.loadQueue();
    const templates = this.loadTemplates();

    return queue.map(item => {
      const template = templates.find(t => t.id === item.templateId);
      return {
        ...item,
        templateName: template ? template.name : 'Unknown'
      };
    });
  }
}

module.exports = TranscodeService;