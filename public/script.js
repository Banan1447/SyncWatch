// --- КНОПКА ВЫХОДА ИЗ КОМНАТЫ ---
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
if (leaveRoomBtn) {
  leaveRoomBtn.onclick = function() {
    socket.emit('leave-room', () => {
      window.location.href = '/select-room.html';
    });
  };
}
// --- ROOM JOIN LOGIC ---

function tryAutoJoinRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (!room) {
    window.location.href = '/select-room.html';
    return;
  }
  // join room
  const name = localStorage.getItem('userName') || '';
  socket.emit('join-room', { roomId: room, name }, res => {
    if (!(res && res.success)) {
      alert(res && res.error ? res.error : 'Ошибка входа в комнату');
      window.location.href = '/select-room.html';
    }
  });
}

window.addEventListener('DOMContentLoaded', tryAutoJoinRoomFromUrl);
const socket = io();

const video = document.getElementById('videoPlayer');
const statusEl = document.getElementById('status');
const videoList = document.getElementById('videoList');
const userNameInput = document.getElementById('userName');
const saveNameBtn = document.getElementById('saveNameBtn');
const uploadBtn = document.getElementById('uploadBtn');
const uploadInput = document.getElementById('uploadInput');
const qualityBtn = document.getElementById('qualityBtn');
const qualityDropdown = document.getElementById('qualityDropdown');

let currentVideoFile = null;
let isVideoReady = false; // Флаг готовности видео

// Загрузка имени из localStorage
if (localStorage.getItem('userName')) {
  userNameInput.value = localStorage.getItem('userName');
}

// Установка имени
saveNameBtn.addEventListener('click', () => {
  const name = userNameInput.value.trim();
  if (name) {
    localStorage.setItem('userName', name);
    socket.emit('set-name', name);
  }
});

// Меню качества
qualityBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  qualityDropdown.classList.toggle('show');
});

// Закрытие меню при клике вне его
document.addEventListener('click', (e) => {
  if (!qualityBtn.contains(e.target) && !qualityDropdown.contains(e.target)) {
    qualityDropdown.classList.remove('show');
  }
});

// Смена качества
qualityDropdown.querySelectorAll('a').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const quality = item.dataset.quality;

    if (!currentVideoFile) return;

    if (quality === 'original') {
      socket.emit('select-video', currentVideoFile);
      qualityDropdown.classList.remove('show');
      return;
    }

    // Проверяем, существует ли перекодированное видео
    fetch(`/api/check-quality/${currentVideoFile}/${quality}`)
      .then(res => res.json())
      .then(data => {
        if (data.exists) {
          socket.emit('select-video', data.filename);
          qualityDropdown.classList.remove('show');
        } else {
          if (confirm(`Quality ${quality} not available. Start transcoding?`)) {
            window.location.href = '/transcode';
          }
        }
      });
  });
});


// --- ROOM-AWARE VIDEO LIST ---
let roomState = null;
function renderRoomVideoList() {
  if (!roomState) return;
  videoList.innerHTML = '';
  fetch('/api/videos')
    .then(res => res.json())
    .then(videos => {
      videos.forEach(video => {
        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
          <i class="fas fa-film"></i>
          <div class="video-info">
            <strong>${video.name}</strong><br>
            <small>${video.resolution} | ${video.bitrate}</small>
          </div>
          <i class="fas fa-play-circle preview-icon"></i>
        `;
        div.addEventListener('click', () => {
          socket.emit('select-video', video.name);
          currentVideoFile = video.name;
        });
        videoList.appendChild(div);
      });
    });
}

// Загрузка видео
uploadBtn.addEventListener('click', () => {
  uploadInput.click();
});


uploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const formData = new FormData();
    formData.append('video', file);

    // Показать прогресс-бар
    const progressBar = document.querySelector('.progress-bar');
    progressBar.style.display = 'block';
    const progressBarFill = document.querySelector('.progress-bar-fill');

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = (e.loaded / e.total) * 100;
        progressBarFill.style.width = `${percentComplete}%`;
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        if (data.success) {
          showNotification(`Video uploaded: ${data.file}`, 'success');
          progressBar.style.display = 'none';
          progressBarFill.style.width = '0';
          // После загрузки не обновляем список локально, а ждём событие video-updated/room-state
        } else {
          showNotification('Upload failed', 'error');
          progressBar.style.display = 'none';
        }
      } else {
        showNotification('Upload failed', 'error');
        progressBar.style.display = 'none';
      }
    });

    xhr.open('POST', '/upload');
    xhr.send(formData);
  }
});


// --- ROOM STATE ---
socket.on('room-state', (state) => {
  roomState = state;
  // Видео
  if (state.currentVideo) {
    video.src = `/videos/${state.currentVideo}`;
    statusEl.innerHTML = `Video loaded: ${state.currentVideo}`;
    currentVideoFile = state.currentVideo;
    isVideoReady = false;
  }
  // Пользователи
  document.getElementById('onlineCount').textContent = Object.keys(state.users).length;
  // Чат
  const commentsList = document.getElementById('commentsList');
  commentsList.innerHTML = '';
  (state.chat || []).forEach(comment => {
    const div = document.createElement('div');
    div.className = 'comment';
    div.innerHTML = `<strong>${comment.user}:</strong> ${comment.text}`;
    commentsList.appendChild(div);
  });
  renderRoomVideoList();
});

// Управление видео — только после загрузки
video.addEventListener('loadedmetadata', () => {
  isVideoReady = true;
  // ✅ Не вызываем video.play() автоматически
});

video.addEventListener('play', () => {
  if (isVideoReady) {
    socket.emit('video-command', { type: 'play' });
  }
});

video.addEventListener('pause', () => {
  if (isVideoReady) {
    socket.emit('video-command', { type: 'pause' });
  }
});

// === ПРОСТОЙ ФУНКЦИОНАЛ ПЕРЕМАТЫВАНИЯ ===
let lastSeekSent = 0;
video.addEventListener('seeked', () => {
  if (isVideoReady) {
    const now = Date.now();
    if (now - lastSeekSent > 500) {
      socket.emit('video-command', { type: 'seek', time: video.currentTime });
      lastSeekSent = now;
    }
  }
});

// Приём команды от других пользователей
socket.on('video-command', (data) => {
  if (isVideoReady && video.readyState >= 1) {
    if (data.type === 'play') {
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {}).catch(error => {
            console.warn('Play command blocked by browser:', error);
          });
        }
      }
    } else if (data.type === 'pause') {
      if (!video.paused) {
        video.pause();
      }
    } else if (data.type === 'seek' && typeof data.time === 'number') {
      if (Math.abs(video.currentTime - data.time) > 0.5) {
        lastSeekSent = Date.now();
        video.currentTime = data.time;
      }
    }
  }
});

// Прогресс буфера
video.addEventListener('progress', () => {
  const buffered = video.buffered;
  if (buffered.length > 0) {
    const bufferedEnd = buffered.end(0);
    const duration = video.duration;
    const percent = (bufferedEnd / duration) * 100;

    let bufferBar = document.querySelector('.buffer-progress');
    if (!bufferBar) {
      bufferBar = document.createElement('div');
      bufferBar.className = 'buffer-progress';
      bufferBar.innerHTML = '<div class="buffer-progress-fill"></div>';
      video.parentNode.insertBefore(bufferBar, video.nextSibling);
    }

    bufferBar.querySelector('.buffer-progress-fill').style.width = `${percent}%`;
  }
});


// setInterval buffer-update отключён для предотвращения сброса видео и лишних событий


// user-list больше не нужен, всё через room-state

// Комментарии
document.getElementById('sendCommentBtn').addEventListener('click', () => {
  const text = document.getElementById('commentInput').value.trim();
  if (text) {
    socket.emit('send-comment', { user: localStorage.getItem('userName') || 'Anonymous', text });
    document.getElementById('commentInput').value = '';
  }
});


// new-comment: просто обновим room-state, чтобы не было гонок
socket.on('new-comment', () => {
  // room-state придёт отдельно
});

// Функция уведомлений
function showNotification(message, type) {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.getElementById('notifications').appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 3000);
}