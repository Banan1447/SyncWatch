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
function tryAutoJoinRoomFromUrl(password = null) {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (!room) {
    window.location.href = '/select-room.html';
    return;
  }

  const name = localStorage.getItem('userName') || prompt('Введите ваше имя:') || `User${Math.floor(Math.random() * 10000)}`;
  const finalPassword = password !== null ? password : (document.getElementById('roomPassword')?.value.trim() || '');

  // Для script.js группы не доступны, передаем пустой массив
  socket.emit('join-room', { roomId: room, name, password: finalPassword, userGroups: [] }, res => {
    if (!(res && res.success)) {
      if (res?.error === 'Invalid password') {
        const newPass = prompt('Неверный пароль. Введите правильный пароль:');
        if (newPass !== null) {
          tryAutoJoinRoomFromUrl(newPass); // рекурсивно пробуем снова
        } else {
          window.location.href = '/select-room.html';
        }
      } else {
        alert(res?.error || 'Ошибка входа в комнату');
        window.location.href = '/select-room.html';
      }
    }
  });
}

// Инициализация сокета
const socket = io();

// Ожидание DOM
window.addEventListener('DOMContentLoaded', () => {
  // Добавляем поле ввода пароля, если его нет
  const uploadSection = document.querySelector('.upload-section');
  if (uploadSection && !document.getElementById('roomPassword')) {
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.id = 'roomPassword';
    passwordInput.placeholder = 'Пароль комнаты (если есть)';
    passwordInput.style.cssText = `
      width: 100%;
      padding: 0.5rem;
      margin: 0.5rem 0;
      border: 1px solid var(--border);
      background: var(--secondary);
      color: white;
      border-radius: 4px;
    `;
    uploadSection.insertBefore(passwordInput, uploadSection.firstChild);
  }

  tryAutoJoinRoomFromUrl();
});

// --- ОСТАЛЬНОЙ КОД БЕЗ ИЗМЕНЕНИЙ ---
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
  videoList.innerHTML = '';
  fetch('/api/videos')
    .then(res => res.json())
    .then(videos => {
      console.log('API returned videos:', videos);
      console.log('Total videos from API:', videos.length);
      videos.forEach(video => {
        const ext = video.name.split('.').pop().toLowerCase();
        const isSupported = ['mp4', 'webm', 'ogg'].includes(ext);
        const div = document.createElement('div');
        div.className = 'video-item';
        div.innerHTML = `
          <div class="video-info">
            <strong class="video-title">${video.name}</strong>
            ${!isSupported ? '<br><small style="color: #ff6b6b;">(Не поддерживается браузером)</small>' : ''}
            <br>
            <small>${video.resolution || 'N/A'} | ${video.bitrate || 'N/A'}</small>
          </div>
          <i class="fas fa-play-circle preview-icon"></i>
        `;
        div.addEventListener('click', () => {
          if (!isSupported) {
            if (!confirm('Этот формат видео может не воспроизводиться в браузере. Продолжить?')) {
              return;
            }
          }
          socket.emit('select-video', video.name);
          currentVideoFile = video.name;
        });
        videoList.appendChild(div);
      });
    })
    .catch(err => {
      console.error('Error fetching videos:', err);
      showNotification('Failed to load video list', 'error');
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
          renderRoomVideoList();
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
  console.log('Room state received:', state);
  if (state.currentVideo) {
    video.src = `/videos/${state.currentVideo}`;
    statusEl.innerHTML = `Video loaded: ${state.currentVideo}`;
    currentVideoFile = state.currentVideo;
    isVideoReady = false;
  }
  document.getElementById('onlineCount').textContent = Object.keys(state.users).length;
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

socket.on('video-added', (newVideo) => {
  console.log('Video added:', newVideo);
  renderRoomVideoList();
});

socket.on('video-removed', (removedVideoName) => {
  console.log('Video removed:', removedVideoName);
  renderRoomVideoList();
});

video.addEventListener('loadedmetadata', () => {
  isVideoReady = true;
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

socket.on('video-command', (data) => {
  if (isVideoReady && video.readyState >= 1) {
    if (data.type === 'play') {
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
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

document.getElementById('sendCommentBtn').addEventListener('click', () => {
  const text = document.getElementById('commentInput').value.trim();
  if (text) {
    socket.emit('send-comment', { user: localStorage.getItem('userName') || 'Anonymous', text });
    document.getElementById('commentInput').value = '';
  }
});

socket.on('new-comment', () => {
  // room-state придёт отдельно
});

function showNotification(message, type) {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.getElementById('notifications').appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
  const rightPanel = document.querySelector('.right-panel');
  const videosHeader = rightPanel.querySelector('h3');
  
  if (!videosHeader) return;

  const refreshBtn = document.createElement('button');
  refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
  refreshBtn.style = `
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
    margin-left: 0.5rem;
    transition: background 0.2s ease;
  `;
  refreshBtn.onclick = renderRoomVideoList;
  videosHeader.appendChild(refreshBtn);

  const debugApiBtn = document.createElement('button');
  debugApiBtn.innerHTML = '<i class="fas fa-bug"></i> Debug API';
  debugApiBtn.style = `
    background: #ffc107;
    color: black;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
    margin-left: 0.5rem;
    transition: background 0.2s ease;
  `;
  debugApiBtn.onclick = () => {
    fetch('/api/videos')
      .then(res => res.json())
      .then(videos => {
        console.log('API videos:', videos);
        alert(`API returned ${videos.length} videos. Check console for details.`);
      })
      .catch(err => {
        console.error('API error:', err);
        alert('Error fetching API videos');
      });
  };
  videosHeader.appendChild(debugApiBtn);
});