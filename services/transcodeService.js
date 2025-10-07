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

    // Системные шаблоны
    this.systemTemplates = {
      'copy-stream': {
        id: 'copy-stream',
        name: 'Copy Stream (No Re-encode)',
        description: 'Fastest: Copies streams without re-encoding. Output: MP4',
        command: '-c copy -map 0'
      }
    };

    this.userTemplates = {};
    this.loadUserTemplates();
  }

  loadUserTemplates() {
    const templatesPath = path.join(this.videoDir, 'templates.json');
    try {
      if (fs.existsSync(templatesPath)) {
        const data = fs.readFileSync(templatesPath, 'utf8');
        this.userTemplates = JSON.parse(data);
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
    const templatesPath = path.join(this.videoDir, 'templates.json');
    return fsPromises.writeFile(
      templatesPath,
      JSON.stringify(this.userTemplates, null, 2),
      'utf8'
    ).catch(err => {
      console.error('[TRANSCODE] Failed to save templates:', err);
    });
  }

  getTemplatesAsArray() {
    return [
      this.systemTemplates['copy-stream'],
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

    console.log(`[TRANSCODE][JOB ${jobId}] Added to queue: "${inputFile}" → "${outputFile}" (template: ${templateId})`);

    this.processQueue();
    return true;
  }

  async processQueue() {
    if (this.running) {
      console.log('[TRANSCODE] Queue processor is busy, skipping...');
      return;
    }

    const pendingJob = this.queue.find(job => job.status === 'pending');
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
      setImmediate(() => this.processQueue());
    }
  }

  async runTranscodeJob(job) {
    const inputPath = path.join(this.videoDir, job.inputFile);
    const outputPath = path.join(this.videoDir, job.outputFile);
    const template = this.getTemplateById(job.templateId);

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${job.inputFile}`);
    }

    // Удаляем старый выходной файл, если существует
    if (fs.existsSync(outputPath)) {
      await fsPromises.unlink(outputPath);
    }

    const args = ['-i', inputPath, ...template.command.trim().split(/\s+/), outputPath];

    console.log(`[TRANSCODE][JOB ${job.id}] Executing: ffmpeg ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);

      let stderrData = '';

      ffmpeg.stderr.on('data', (data) => {
        stderrData += data.toString();
        // Опционально: парсинг прогресса (упрощённо)
        const progressMatch = data.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (progressMatch) {
          const hours = parseFloat(progressMatch[1]);
          const minutes = parseFloat(progressMatch[2]);
          const seconds = parseFloat(progressMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          // Для упрощения: не считаем общий duration → прогресс не точный
          // В продакшене используй ffprobe для получения duration
          console.log(`[TRANSCODE][JOB ${job.id}] Progress: ~${Math.round(totalSeconds)}s processed`);
        }
      });

      ffmpeg.on('close', (code) => {
        if (job.isCancelled) {
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
          console.error(`[TRANSCODE][JOB ${job.id}] FFmpeg error (code ${code}). Last stderr:\n${stderrData.slice(-500)}`);
          reject(new Error(job.error));
        }
      });

      ffmpeg.on('error', (err) => {
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
    if (job.status !== 'pending' && job.status !== 'processing') {
      console.warn(`[TRANSCODE] Cancel requested for job ${jobId} in state "${job.status}" (not cancellable)`);
      return false;
    }

    job.isCancelled = true;
    console.log(`[TRANSCODE][JOB ${jobId}] Cancel requested`);
    return true;
  }

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

  async quickTranscodeWithCommand(inputFile, outputFile, command) {
    const inputPath = path.join(this.videoDir, inputFile);
    const outputPath = path.join(this.videoDir, outputFile);

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    if (fs.existsSync(outputPath)) {
      await fsPromises.unlink(outputPath);
    }

    const args = ['-i', inputPath, ...command.trim().split(/\s+/), outputPath];

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