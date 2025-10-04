// services/transcodeService.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class TranscodeService extends EventEmitter {
  constructor() {
    super();
    // Путь к файлу очереди
    this.queueFilePath = path.join(__dirname, '..', 'json', 'transcode-queue.json');
    // Путь к файлу шаблонов
    this.templatesFilePath = path.join(__dirname, '..', 'json', 'transcode-templates.json');
    // Загружаем очередь и шаблоны при инициализации
    this.queue = this.loadQueue();
    this.templates = this.loadTemplates();
    // Добавляем переменную для отслеживания состояния очереди
    this.wasQueueEmpty = this.queue.length === 0;
    // Запускаем обработчик очереди
    this.startProcessing();
  }

  // --- СУЩЕСТВУЮЩИЕ МЕТОДЫ (без изменений) ---
  loadQueue() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const data = fs.readFileSync(this.queueFilePath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (error) {
      console.error('[TRANSCODE SERVICE] Ошибка загрузки очереди:', error.message);
    }
    return [];
  }

  saveQueue() {
    try {
      const dir = path.dirname(this.queueFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.queue, null, 2));
    } catch (error) {
      console.error('[TRANSCODE SERVICE] Ошибка сохранения очереди:', error.message);
    }
  }

  loadTemplates() {
    try {
      if (fs.existsSync(this.templatesFilePath)) {
        const data = fs.readFileSync(this.templatesFilePath, 'utf8');
        const parsed = JSON.parse(data);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      }
    } catch (error) {
      console.error('[TRANSCODE SERVICE] Ошибка загрузки шаблонов:', error.message);
    }
    return {};
  }

  saveTemplates() {
    try {
      const dir = path.dirname(this.templatesFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.templatesFilePath, JSON.stringify(this.templates, null, 2));
    } catch (error) {
      console.error('[TRANSCODE SERVICE] Ошибка сохранения шаблонов:', error.message);
    }
  }

  getQueueWithNames() {
    return this.queue.map(job => ({
      id: job.id,
      inputFile: job.inputFile,
      outputFile: job.outputFile,
      templateId: job.templateId,
      userId: job.userId,
      status: job.status,
      progress: job.progress,
      startTime: job.startTime,
      endTime: job.endTime,
      log: job.log
    }));
  }

  getTemplatesAsArray() {
    return Object.entries(this.templates).map(([id, templateData]) => ({
      id: id,
      ...templateData
    }));
  }

  addToQueue(inputFile, outputFile, templateId, userId) {
    const template = this.templates[templateId];
    if (!template) {
      console.error(`[TRANSCODE SERVICE] Шаблон ${templateId} не найден`);
      return false;
    }

    const job = {
      id: Date.now() + Math.random(),
      inputFile,
      outputFile,
      templateId,
      userId,
      status: 'pending',
      progress: 0,
      startTime: null,
      endTime: null,
      log: []
    };

    this.queue.push(job);
    this.saveQueue();
    console.log(`[TRANSCODE SERVICE] Задание ${job.id} добавлено в очередь.`);
    this.emit('queue-updated', this.getQueue());
    return true;
  }

  getQueue() {
    return [...this.queue];
  }

  getTemplates() {
    return { ...this.templates };
  }

  saveTemplate(id, templateData) {
    this.templates[id] = templateData;
    this.saveTemplates();
    console.log(`[TRANSCODE SERVICE] Шаблон ${id} сохранён.`);
  }

  deleteTemplate(id) {
    delete this.templates[id];
    this.saveTemplates();
    console.log(`[TRANSCODE SERVICE] Шаблон ${id} удалён.`);
  }

  cancelJob(jobId) {
    const job = this.queue.find(j => j.id === jobId);
    if (job && (job.status === 'pending' || job.status === 'processing')) {
      job.status = 'cancelled';
      this.saveQueue();
      console.log(`[TRANSCODE SERVICE] Задание ${jobId} отменено.`);
      this.emit('queue-updated', this.getQueue());
      return true;
    }
    return false;
  }

  startProcessing() {
    setInterval(() => {
      this.processQueue();
    }, 5000);
  }

  processQueue() {
    const nextJob = this.queue.find(job => job.status === 'pending');

    if (nextJob) {
      if (this.wasQueueEmpty) {
        this.wasQueueEmpty = false;
        console.log('[TRANSCODE SERVICE] Найдено новое задание для обработки.');
      }
      this.runTranscodeJob(nextJob);
    } else {
      if (!this.wasQueueEmpty) {
        console.log('[TRANSCODE SERVICE] Очередь пуста или все задания отменены/обработаны');
        this.wasQueueEmpty = true;
      }
    }
  }

  runTranscodeJob(job) {
    if (job.status !== 'pending') {
      return;
    }

    console.log(`[TRANSCODE SERVICE] Начинаем транскодирование задания ${job.id}`);
    job.status = 'processing';
    job.startTime = new Date().toISOString();
    this.saveQueue();
    this.emit('queue-updated', this.getQueue());

    const template = this.templates[job.templateId];
    if (!template) {
      console.error(`[TRANSCODE SERVICE] Шаблон ${job.templateId} для задания ${job.id} не найден!`);
      job.status = 'error';
      job.log.push(`Ошибка: Шаблон ${job.templateId} не найден`);
      job.endTime = new Date().toISOString();
      this.saveQueue();
      this.emit('queue-updated', this.getQueue());
      return;
    }

    const args = ['-i', job.inputFile, ...template.args, job.outputFile];

    const process = spawn('ffmpeg', args);

    let stderrData = '';

    process.stdout.on('data', (data) => {
      // FFmpeg обычно выводит прогресс в stderr
    });

    process.stderr.on('data', (data) => {
      stderrData += data.toString();
      const match = stderrData.match(/frame=(.*)/);
      if (match) {
        job.log.push(data.toString());
      }
    });

    process.on('close', (code) => {
      if (code === 0) {
        console.log(`[TRANSCODE SERVICE] Задание ${job.id} завершено успешно.`);
        job.status = 'completed';
      } else {
        console.error(`[TRANSCODE SERVICE] Задание ${job.id} завершено с ошибкой, код: ${code}`);
        job.status = 'error';
        job.log.push(`FFmpeg завершился с кодом: ${code}`);
      }
      job.endTime = new Date().toISOString();
      this.saveQueue();
      this.emit('queue-updated', this.getQueue());
    });

    process.on('error', (err) => {
      console.error(`[TRANSCODE SERVICE] Ошибка при запуске FFmpeg для задания ${job.id}:`, err.message);
      job.status = 'error';
      job.log.push(`Ошибка запуска процесса: ${err.message}`);
      job.endTime = new Date().toISOString();
      this.saveQueue();
      this.emit('queue-updated', this.getQueue());
    });
  }
  // --- КОНЕЦ СУЩЕСТВУЮЩИХ МЕТОДОВ ---

  // --- НОВЫЙ МЕТОД: быстрое транскодирование ---
  quickTranscode(inputFile, outputFile, templateId) {
    return new Promise((resolve, reject) => {
      const template = this.templates[templateId];
      if (!template) {
        console.error(`[TRANSCODE SERVICE] Шаблон ${templateId} не найден для быстрого транскодирования`);
        return reject(new Error(`Шаблон ${templateId} не найден`));
      }

      const args = ['-i', inputFile, ...template.args, outputFile];

      const process = spawn('ffmpeg', args);

      let stderrOutput = '';
      let stdoutOutput = '';

      process.stdout.on('data', (data) => {
        stdoutOutput += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        // Пытаемся извлечь прогресс из лога FFmpeg (опционально, для демонстрации)
        const match = stderrOutput.match(/frame=(.*)/);
        if (match) {
          // console.log(`Прогресс: ${match[1]}`); // Можно использовать для обновления прогресса
        }
      });

      process.on('close', (code) => {
        if (code === 0) {
          console.log(`[TRANSCODE SERVICE] Быстрое транскодирование успешно завершено: ${outputFile}`);
          resolve({ success: true, message: 'Транскодирование успешно завершено', outputFile });
        } else {
          console.error(`[TRANSCODE SERVICE] Быстрое транскодирование завершено с ошибкой, код: ${code}`);
          console.error(`STDERR: ${stderrOutput}`);
          console.error(`STDOUT: ${stdoutOutput}`);
          reject(new Error(`FFmpeg завершился с кодом: ${code}`));
        }
      });

      process.on('error', (err) => {
        console.error(`[TRANSCODE SERVICE] Ошибка при запуске FFmpeg для быстрого транскодирования:`, err.message);
        reject(new Error(`Ошибка запуска процесса: ${err.message}`));
      });
    });
  }
  // --- КОНЕЦ НОВОГО МЕТОДА ---
}

module.exports = TranscodeService;
