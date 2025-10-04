// server/services/videoService.js
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

class VideoService {
  constructor(videoFolder) {
    this.videoFolder = videoFolder;
    this.VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|wmv|flv|mkv|mpg|mpeg|3gp|3g2|ts|mts|m2ts|vob|f4v|f4p|f4a|f4b|mp3|wav|aac|flac|wma|m4a|asf|rm|rmvb|vcd|svcd|dvd|yuv|y4m)$/i;
  }

  getVideoFiles() {
    try {
      return fs.readdirSync(this.videoFolder).filter(file => this.VIDEO_EXTENSIONS.test(file));
    } catch (err) {
      console.error('Ошибка доступа к папке с видео:', err);
      return [];
    }
  }

  async getVideoInfo(file) {
    return new Promise((resolve, reject) => {
      const filePath = path.join(this.videoFolder, file);
      
      if (!fs.existsSync(filePath)) {
        console.warn(`[FFPROBE] Файл не существует: ${filePath}`);
        resolve({ resolution: 'N/A', bitrate: 'N/A' });
        return;
      }

      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.warn(`[FFPROBE] Ошибка для ${file}:`, err.message);
          resolve({ resolution: 'N/A', bitrate: 'N/A' });
          return;
        }

        try {
          const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
          if (videoStream) {
            resolve({
              resolution: `${videoStream.width || 'N/A'}x${videoStream.height || 'N/A'}`,
              bitrate: videoStream.bit_rate || 'N/A'
            });
          } else {
            console.warn(`[FFPROBE] Нет видеопотока в ${file}`);
            resolve({ resolution: 'N/A', bitrate: 'N/A' });
          }
        } catch (parseErr) {
          console.error(`[FFPROBE] Ошибка парсинга метаданных для ${file}:`, parseErr);
          resolve({ resolution: 'N/A', bitrate: 'N/A' });
        }
      });
    });
  }

  async getAllVideos() {
    const files = this.getVideoFiles();
    if (files.length === 0) {
      console.log(`[VIDEO SERVICE] В папке ${this.videoFolder} нет видеофайлов.`);
      return [];
    }

    console.log(`[VIDEO SERVICE] Найдено ${files.length} видеофайлов. Получаем метаданные...`);

    const promises = files.map(async (file) => {
      const info = await this.getVideoInfo(file);
      const ext = file.split('.').pop().toLowerCase();
      const supportedFormats = ['mp4', 'webm', 'ogg'];
      const isSupported = supportedFormats.includes(ext);
      
      return { 
        name: file, 
        ...info, 
        isSupported 
      };
    });

    const videos = await Promise.all(promises);
    console.log(`[VIDEO SERVICE] Метаданные получены для ${videos.length} файлов.`);
    
    return videos;
  }

  deleteVideo(filename) {
    if (!filename || typeof filename !== 'string') {
      throw new Error('Неверное имя файла');
    }

    const filePath = path.join(this.videoFolder, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error('Файл не существует');
    }

    fs.unlinkSync(filePath);
    console.log(`[VIDEO SERVICE] Файл удалён: ${filename}`);
    return true;
  }

  renameVideo(oldName, newName) {
    if (!oldName || !newName || typeof oldName !== 'string' || typeof newName !== 'string') {
      throw new Error('Неверные имена файлов');
    }

    const oldPath = path.join(this.videoFolder, oldName);
    const newPath = path.join(this.videoFolder, newName);

    if (!fs.existsSync(oldPath)) {
      throw new Error('Старый файл не существует');
    }

    if (fs.existsSync(newPath)) {
      throw new Error('Новый файл уже существует');
    }

    fs.renameSync(oldPath, newPath);
    console.log(`[VIDEO SERVICE] Файл переименован: ${oldName} → ${newName}`);
    return true;
  }

  checkQuality(file, quality) {
    const ext = path.extname(file);
    const name = path.basename(file, ext);
    const qualityFile = `${name}_${quality}${ext}`;
    const filePath = path.join(this.videoFolder, qualityFile);

    return {
      exists: fs.existsSync(filePath),
      filename: qualityFile
    };
  }
}

module.exports = VideoService;