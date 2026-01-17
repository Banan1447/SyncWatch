// services/transcodeService.js
const fsPromises = require('fs').promises;
const fs = require('fs');
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

    // Проверка доступности ffmpeg
    this.ffmpegAvailable = false;
    this.checkFFmpegAvailability();

    // Системные шаблоны
    this.systemTemplates = {
      'copy-stream': {
        id: 'copy-stream',
        name: 'Copy Stream (No Re-encode)',
        description: 'Fastest: Copies streams without re-encoding. Output: MP4',
        command: '-c copy -map 0'
      },
      '4k-cuda-high': {
        id: '4k-cuda-high',
        name: '4K Ultra HD CUDA (High Quality)',
        description: '4K resolution with 10Mbps bitrate using NVIDIA CUDA acceleration',
        command: '-vf scale=3840:2160 -c:v h264_nvenc -preset slow -b:v 10000k -maxrate 12000k -bufsize 20000k -c:a aac -b:a 256k'
      }
    };

    this.userTemplates = {};
    this.loadUserTemplates();
  }

  // Проверка доступности ffmpeg
  checkFFmpegAvailability() {
    try {
      const { spawn } = require('child_process');
      const ffmpeg = spawn('ffmpeg', ['-version']);

      ffmpeg.on('error', (err) => {
        console.error('[TRANSCODE] FFmpeg not available:', err.message);
        this.ffmpegAvailable = false;
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('[TRANSCODE] FFmpeg is available');
          this.ffmpegAvailable = true;
        } else {
          console.error(`[TRANSCODE] FFmpeg check failed with code ${code}`);
          this.ffmpegAvailable = false;
        }
      });

      // Timeout для проверки
      setTimeout(() => {
        if (!this.ffmpegAvailable) {
          console.error('[TRANSCODE] FFmpeg availability check timeout');
        }
      }, 5000);
    } catch (err) {
      console.error('[TRANSCODE] Error checking FFmpeg availability:', err.message);
      this.ffmpegAvailable = false;
    }
  }

  // Валидация FFmpeg команды
  validateCommand(command) {
    if (!command || typeof command !== 'string') {
      return { valid: false, error: 'Command must be a non-empty string' };
    }

    const trimmedCommand = command.trim();
    if (trimmedCommand.length === 0) {
      return { valid: false, error: 'Command cannot be empty' };
    }

    // Проверка на опасные команды
    const dangerousCommands = [
      'rm ', 'del ', 'unlink', 'mv ', 'cp ', 'chmod', 'chown', 'sudo', 'su ',
      'mkdir', 'touch', 'echo', 'cat ', 'grep', 'find ', 'ls ', 'pwd',
      'curl', 'wget', 'ssh', 'scp', 'ftp', 'telnet'
    ];

    for (const dangerous of dangerousCommands) {
      if (trimmedCommand.toLowerCase().includes(dangerous)) {
        return { valid: false, error: `Command contains potentially dangerous operation: ${dangerous.trim()}` };
      }
    }

    // Проверка на слишком длинную команду
    if (trimmedCommand.length > 1000) {
      return { valid: false, error: 'Command too long (max 1000 characters)' };
    }

    return { valid: true };
  }

  loadUserTemplates() {
    // ✅ ИСПРАВЛЕНО: Используем корневой файл для совместимости с админкой
    const templatesPath = path.join(__dirname, '..', 'transcode-templates.json');
    try {
      if (fs.existsSync(templatesPath)) {
        const data = fs.readFileSync(templatesPath, 'utf8');
        const templatesArray = JSON.parse(data);
        // Преобразуем массив в объект для совместимости
        this.userTemplates = {};
        if (Array.isArray(templatesArray)) {
          templatesArray.forEach(template => {
            if (template.id) {
              this.userTemplates[template.id] = template;
            }
          });
        } else if (typeof templatesArray === 'object') {
          this.userTemplates = templatesArray;
        }
        // Убеждаемся, что у всех шаблонов есть id
        for (const [id, template] of Object.entries(this.userTemplates)) {
          template.id = id;
        }
      }
    } catch (err) {
      console.warn('[TRANSCODE] Could not load user templates:', err.message);
      this.userTemplates = {};
    }
  }

  saveUserTemplates() {
    // ✅ ИСПРАВЛЕНО: Используем корневой файл для совместимости с админкой
    const templatesPath = path.join(__dirname, '..', 'transcode-templates.json');
    // Преобразуем объект в массив для совместимости с существующим форматом
    const templatesArray = Object.values(this.userTemplates).map(template => ({
      id: template.id,
      name: template.name,
      description: template.description || '',
      command: template.command,
      createdAt: template.createdAt || new Date().toISOString()
    }));
    return fsPromises.writeFile(
      templatesPath,
      JSON.stringify(templatesArray, null, 2),
      'utf8'
    ).catch(err => {
      console.error('[TRANSCODE] Failed to save templates:', err);
    });
  }

  getTemplatesAsArray() {
    return [
      this.systemTemplates['copy-stream'],
      this.systemTemplates['4k-cuda-high'],
      ...Object.values(this.userTemplates)
    ];
  }

  getTemplateById(id) {
    if (this.systemTemplates[id]) {
      return this.systemTemplates[id];
    }
    return this.userTemplates[id] || null;
  }

  saveTemplate(id, templateData) {
    if (!templateData.name || !templateData.command) {
      throw new Error('Template must have name and command');
    }

    // Валидация имени
    const name = templateData.name.trim();
    if (name.length === 0) {
      throw new Error('Template name cannot be empty');
    }
    if (name.length > 100) {
      throw new Error('Template name too long (max 100 characters)');
    }

    // Валидация команды
    const command = templateData.command.trim();
    const validation = this.validateCommand(command);
    if (!validation.valid) {
      throw new Error(`Invalid command: ${validation.error}`);
    }

    // Валидация описания
    const description = templateData.description ? templateData.description.trim() : '';
    if (description.length > 500) {
      throw new Error('Description too long (max 500 characters)');
    }

    const newId = id || 'tmpl_' + Math.random().toString(36).substring(2, 11);
    this.userTemplates[newId] = {
      id: newId,
      name: name,
      description: description,
      command: command,
      createdAt: new Date().toISOString()
    };
    this.saveUserTemplates();
    return newId;
  }

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

  addToQueue(inputFile, outputFile, templateId, userId = 'default', useCuda = false) {
    // Проверка доступности ffmpeg
    if (!this.ffmpegAvailable) {
      throw new Error('FFmpeg is not available on this system');
    }

    const template = this.getTemplateById(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    // Валидация команды
    const validation = this.validateCommand(template.command);
    if (!validation.valid) {
      throw new Error(`Invalid template command: ${validation.error}`);
    }

    // Генерация уникального имени выходного файла, если не указано
    let finalOutputFile = outputFile;
    if (!finalOutputFile) {
      const ext = path.extname(inputFile);
      const baseName = path.basename(inputFile, ext);
      const timestamp = Date.now();
      finalOutputFile = `${baseName}_transcoded_${timestamp}${ext}`;
    }

    const jobId = this.nextJobId++;
    const job = {
      id: jobId,
      inputFile,
      outputFile: finalOutputFile,
      templateId,
      templateName: template.name,
      userId,
      useCuda,
      status: 'pending',
      progress: 0,
      isCancelled: false,
      error: null,
      eta: null,
      startTime: null,
      endTime: null
    };

    this.queue.push(job);
    this.jobs.set(jobId, job);

    const cudaMsg = useCuda ? ' (CUDA)' : '';
    console.log(`[TRANSCODE][JOB ${jobId}] Added to queue: "${inputFile}" → "${finalOutputFile}" (template: ${templateId})${cudaMsg}`);

    this.processQueue();
    return true;
  }

  async processQueue() {
    if (this.running) {
      console.log('[TRANSCODE] Queue processor is busy, skipping...');
      return;
    }

    // Очищаем завершенные/ошибочные/отмененные задания
    this.cleanupQueue();

    // Находим следующее задание, которое не отменено
    const pendingJob = this.queue.find(job => job.status === 'pending' && !job.isCancelled);
    if (!pendingJob) {
      console.log('[TRANSCODE] No pending jobs in queue');
      return;
    }

    this.running = true;
    const job = pendingJob;
    job.status = 'processing';
    console.log(`[TRANSCODE][JOB ${job.id}] Starting processing...`);

    try {
      await this.runTranscodeJob(job);
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Unknown error';
      console.error(`[TRANSCODE][JOB ${job.id}] FAILED:`, job.error);
    } finally {
      this.running = false;
      console.log(`[TRANSCODE][JOB ${job.id}] Finished with status: ${job.status}`);
      // Очищаем завершенные/ошибочные задания из очереди
      this.cleanupQueue();
      setImmediate(() => this.processQueue());
    }
  }

  // Очистка завершенных заданий из очереди
  cleanupQueue() {
    const beforeCount = this.queue.length;
    this.queue = this.queue.filter(job => {
      // Оставляем только pending и processing задания, которые не отменены
      const keep = (job.status === 'pending' || job.status === 'processing') && !job.isCancelled;
      if (!keep) {
        console.log(`[TRANSCODE][JOB ${job.id}] Removed from queue (status: ${job.status}, cancelled: ${job.isCancelled})`);
      }
      return keep;
    });
    const afterCount = this.queue.length;
    if (beforeCount !== afterCount) {
      console.log(`[TRANSCODE] Queue cleaned up: ${beforeCount} → ${afterCount} jobs`);
    }
  }

  async runTranscodeJob(job) {
    console.log(`[TRANSCODE][JOB ${job.id}] Starting job with CUDA: ${job.useCuda}`);
    console.log(`[TRANSCODE][JOB ${job.id}] Full job object:`, JSON.stringify(job, null, 2));
    const inputPath = path.join(this.videoDir, job.inputFile);
    const outputPath = path.join(this.videoDir, job.outputFile);
    const template = this.getTemplateById(job.templateId);

    // Проверка отмены в начале
    if (job.isCancelled) {
      console.log(`[TRANSCODE][JOB ${job.id}] Cancelled before start`);
      job.status = 'cancelled';
      return;
    }

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${job.inputFile}`);
    }

    // Удаляем старый выходной файл, если существует
    if (fs.existsSync(outputPath)) {
      await fsPromises.unlink(outputPath);
    }

    // Устанавливаем время начала
    job.startTime = new Date().toISOString();

    // ✅ ИСПРАВЛЕНО: Заменяем {output} на реальный путь, если он есть в команде
    let command = template.command.trim();
    console.log(`[TRANSCODE][JOB ${job.id}] Original command: "${command}"`);

    // Добавляем CUDA параметры если включено аппаратное ускорение
    if (job.useCuda) {
      console.log(`[TRANSCODE][JOB ${job.id}] Applying CUDA transformations...`);
      // Для кодирования заменяем software кодеки на hardware
      // Убираем hwaccel параметры, так как они могут конфликтовать с NVENC
      if (command.includes('-c:v libx264') && !command.includes('nvenc')) {
        command = command.replace(/-c:v libx264/g, '-c:v h264_nvenc');
        console.log(`[TRANSCODE][JOB ${job.id}] Replaced libx264 with h264_nvenc`);
      }
      if (command.includes('-c:v libx265') && !command.includes('nvenc')) {
        command = command.replace(/-c:v libx265/g, '-c:v hevc_nvenc');
        console.log(`[TRANSCODE][JOB ${job.id}] Replaced libx265 with hevc_nvenc`);
      }
      console.log(`[TRANSCODE][JOB ${job.id}] Final CUDA command: "${command}"`);
    } else {
      console.log(`[TRANSCODE][JOB ${job.id}] CUDA not enabled`);
    }

    let args;

    if (command.includes('{output}')) {
      // Заменяем placeholder и добавляем только входной файл
      command = command.replace(/{output}/g, outputPath);
      args = ['-i', inputPath, ...command.split(/\s+/)];
    } else {
      // Если placeholder нет, добавляем выходной файл в конец
      args = ['-i', inputPath, ...command.split(/\s+/), outputPath];
    }

    console.log(`[TRANSCODE][JOB ${job.id}] Executing: ffmpeg ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderrData = '';
      let isCancelled = false;

      // Периодическая проверка отмены
      const cancelCheckInterval = setInterval(() => {
        if (job.isCancelled && !isCancelled) {
          isCancelled = true;
          console.log(`[TRANSCODE][JOB ${job.id}] Cancellation detected, terminating ffmpeg process`);
          ffmpeg.kill('SIGTERM');

          // Даем 5 секунд на graceful shutdown, затем принудительно
          setTimeout(() => {
            if (!ffmpeg.killed) {
              console.log(`[TRANSCODE][JOB ${job.id}] Force killing ffmpeg process`);
              ffmpeg.kill('SIGKILL');
            }
          }, 5000);
        }
      }, 1000);

      ffmpeg.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderrData += dataStr;

        // Парсинг прогресса
        const progressMatch = dataStr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (progressMatch) {
          const hours = parseFloat(progressMatch[1]);
          const minutes = parseFloat(progressMatch[2]);
          const seconds = parseFloat(progressMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;

          // Обновляем прогресс (примерно, без точного duration)
          job.progress = Math.min(95, totalSeconds / 10); // Упрощенная оценка
          console.log(`[TRANSCODE][JOB ${job.id}] Progress: ~${Math.round(totalSeconds)}s processed (${job.progress.toFixed(1)}%)`);
        }
      });

      ffmpeg.on('close', (code) => {
        clearInterval(cancelCheckInterval);
        job.endTime = new Date().toISOString();

        console.log(`[TRANSCODE][JOB ${job.id}] FFmpeg closed with code: ${code}`);

        if (isCancelled || job.isCancelled) {
          job.status = 'cancelled';
          fsPromises.unlink(outputPath).catch(() => {});
          console.log(`[TRANSCODE][JOB ${job.id}] Cancelled by user`);
          resolve();
        } else if (code === 0) {
          job.status = 'completed';
          job.progress = 100;
          console.log(`[TRANSCODE][JOB ${job.id}] SUCCESS: Output saved to ${job.outputFile}`);
          resolve();
        } else {
          job.status = 'error';
          job.error = `FFmpeg exited with code ${code}`;
          fsPromises.unlink(outputPath).catch(() => {});
          console.error(`[TRANSCODE][JOB ${job.id}] FFmpeg error (code ${code}). Full stderr:\n${stderrData}`);
          console.error(`[TRANSCODE][JOB ${job.id}] Command was: ffmpeg ${args.join(' ')}`);
          reject(new Error(job.error));
        }
      });

      ffmpeg.on('error', (err) => {
        clearInterval(cancelCheckInterval);
        job.endTime = new Date().toISOString();
        job.status = 'error';
        job.error = err.message;
        fsPromises.unlink(outputPath).catch(() => {});
        console.error(`[TRANSCODE][JOB ${job.id}] Spawn error:`, err.message);
        reject(err);
      });
    });
  }

  cancelJob(jobId) {
    const job = this.jobs.get(Number(jobId));
    if (!job) {
      console.warn(`[TRANSCODE] Cancel requested for non-existent job ${jobId}`);
      return false;
    }

    // Можно отменить только pending или processing задания
    if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
      console.warn(`[TRANSCODE] Cancel requested for job ${jobId} in state "${job.status}" (not cancellable)`);
      return false;
    }

    job.isCancelled = true;
    console.log(`[TRANSCODE][JOB ${jobId}] Cancel requested`);

    // Если задание в очереди, сразу помечаем как отмененное
    if (job.status === 'pending') {
      job.status = 'cancelled';
      console.log(`[TRANSCODE][JOB ${jobId}] Marked as cancelled (was pending)`);
    }

    return true;
  }

  getQueueWithNames() {
    return this.queue.map(job => ({
      id: job.id,
      fileId: job.inputFile,
      outputFile: job.outputFile,
      templateId: job.templateId,
      templateName: job.templateName,
      useCuda: job.useCuda || false,
      status: job.status,
      progress: job.progress,
      isCancelled: job.isCancelled,
      error: job.error,
      eta: job.eta
    }));
  }

  async getVideoFiles() {
    try {
      const files = await fsPromises.readdir(this.videoDir);
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.m4v', '.ts'];
      
      const videoFiles = [];
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (videoExtensions.includes(ext)) {
          const stats = await fsPromises.stat(path.join(this.videoDir, file));
          videoFiles.push({
            name: file,
            size: stats.size,
            resolution: 'N/A',
            bitrate: 'N/A'
          });
        }
      }
      videoFiles.sort((a, b) => b.size - a.size);
      return videoFiles;
    } catch (err) {
      console.error('[TRANSCODE] Error reading video directory:', err);
      throw new Error('Failed to read video files');
    }
  }

  async quickTranscodeWithCommand(inputFile, outputFile, command, useCuda = false) {
    // Проверка доступности ffmpeg
    if (!this.ffmpegAvailable) {
      throw new Error('FFmpeg is not available on this system');
    }

    // Валидация команды
    const validation = this.validateCommand(command);
    if (!validation.valid) {
      throw new Error(`Invalid command: ${validation.error}`);
    }

    const inputPath = path.join(this.videoDir, inputFile);
    const outputPath = path.join(this.videoDir, outputFile);

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    if (fs.existsSync(outputPath)) {
      await fsPromises.unlink(outputPath);
    }

    // Обработка CUDA параметров
    let processedCommand = command.trim();
    if (useCuda) {
      // Проверяем, содержит ли команда уже параметры декодирования
      if (!processedCommand.includes('-hwaccel')) {
        processedCommand = `-hwaccel cuda -hwaccel_device 0 ${processedCommand}`;
      }
      // Для кодирования заменяем software кодеки на hardware
      if (processedCommand.includes('-c:v libx264') && !processedCommand.includes('nvenc')) {
        processedCommand = processedCommand.replace(/-c:v libx264/g, '-c:v h264_nvenc');
      }
      if (processedCommand.includes('-c:v libx265') && !processedCommand.includes('nvenc')) {
        processedCommand = processedCommand.replace(/-c:v libx265/g, '-c:v hevc_nvenc');
      }
      console.log(`[TRANSCODE][QUICK] CUDA acceleration enabled`);
    }

    // Обработка {output} placeholder
    let args;

    if (processedCommand.includes('{output}')) {
      processedCommand = processedCommand.replace(/{output}/g, outputPath);
      args = ['-i', inputPath, ...processedCommand.split(/\s+/)];
    } else {
      args = ['-i', inputPath, ...processedCommand.split(/\s+/), outputPath];
    }

    console.log(`[TRANSCODE][QUICK] Executing: ffmpeg ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`[TRANSCODE][QUICK] SUCCESS: ${outputFile}`);
          resolve({ success: true, output: outputFile });
        } else {
          fsPromises.unlink(outputPath).catch(() => {});
          console.error(`[TRANSCODE][QUICK] FFmpeg failed with code ${code}`);
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        fsPromises.unlink(outputPath).catch(() => {});
        console.error(`[TRANSCODE][QUICK] Spawn error:`, err.message);
        reject(err);
      });
    });
  }
}

module.exports = TranscodeService;