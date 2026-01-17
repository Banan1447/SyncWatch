// public/js/api.js

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ ===
window.selectedFiles = new Set(); // Имена выбранных файлов
window.authToken = null; // JWT токен пользователя

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Получить JWT токен из localStorage
function getAuthToken() {
  if (!window.authToken) {
    window.authToken = localStorage.getItem('authToken');
  }
  return window.authToken;
}

// Установить JWT токен
function setAuthToken(token) {
  window.authToken = token;
  if (token) {
    localStorage.setItem('authToken', token);
  } else {
    localStorage.removeItem('authToken');
  }
}

// Проверить, авторизован ли пользователь
function isAuthenticated() {
  return !!getAuthToken();
}

function showNotification(message, type = 'info') {
  const notifications = document.getElementById('notifications');
  if (!notifications) return;

  const notification = document.createElement('div');
  notification.className = `notification status-${type}`;
  notification.textContent = message;
  notifications.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 300);
  }, 2700);
}

// === API CALLS ===
async function apiCall(url, method = 'GET', data = null) {
  try {
    const config = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    // Добавляем JWT токен в headers, если он есть
    const token = getAuthToken();
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      config.body = JSON.stringify(data);
    }

    const res = await fetch(url, config);
    if (!res.ok) {
      let errorText;
      try {
        const errorJson = await res.json();
        errorText = errorJson.error || 'Unknown server error';
      } catch (e) {
        errorText = await res.text();
      }
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }
    return await res.json();
  } catch (err) {
    console.error('API Error:', err);
    showNotification('API Error: ' + err.message, 'error');
    return { success: false, error: err.message };
  }
}

// === ФУНКЦИИ ДЛЯ ТРАНСКОДИРОВАНИЯ ===

// Загрузка шаблонов
async function loadTemplates() {
  const res = await apiCall('/api/transcode/templates', 'GET');
  const container = document.getElementById('templatesList');
  if (!container) return;

  const templates = res.success && Array.isArray(res.templates) ? res.templates : [];

  container.innerHTML = '';
  if (templates.length > 0) {
    templates.forEach(template => {
      const isSystem = template.id === 'copy-stream';
      const div = document.createElement('div');
      div.className = `template-item ${isSystem ? 'template-system' : ''}`;
      div.innerHTML = `
        <div class="template-header">
          <div class="template-name">${template.name}</div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-sm apply-template-btn" data-template-id="${template.id}"
              ${window.selectedFiles.size === 0 ? 'disabled' : ''} 
              title="${window.selectedFiles.size === 0 ? 'Select files first' : 'Apply to selected files'}">
              <i class="fas fa-check"></i> Apply
            </button>
            ${isSystem ? '' : `
              <button class="btn btn-sm btn-danger delete-template-btn" data-template-id="${template.id}" title="Delete template">
                <i class="fas fa-trash"></i>
              </button>
            `}
          </div>
        </div>
        <div class="template-desc">${template.description || 'N/A'}</div>
        <div class="template-desc" style="font-family: monospace; font-size: 0.7rem; margin-top: 0.5rem;">
          ${template.command}
        </div>
      `;
      container.appendChild(div);
    });
  } else {
    container.innerHTML = '<div class="template-item">No templates found</div>';
  }

  // Обновляем состояние кнопок Apply после загрузки шаблонов
  updateApplyButtons();
}

// Загрузка файлов
async function loadFiles() {
  const container = document.getElementById('filesList');
  if (!container) return;
  container.innerHTML = '<div class="file-item">Loading files...</div>';

  try {
    const res = await fetch('/api/videos');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const files = await res.json();

    if (!Array.isArray(files)) {
      throw new Error('Invalid response: expected array of files');
    }

    container.innerHTML = '';

    if (files.length === 0) {
      container.innerHTML = '<div class="file-item">No videos found</div>';
      return;
    }

    files.forEach(file => {
      if (!file || typeof file.name !== 'string') {
        console.warn('Skipping invalid file entry:', file);
        return;
      }

      const ext = file.name.split('.').pop().toLowerCase();
      const supportedFormats = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi'];
      const isSupported = supportedFormats.includes(ext);
      const copyFriendly = ['mp4', 'm4v', 'mov'].includes(ext);
      let copyWarning = '';
      if (isSupported && !copyFriendly) {
        copyWarning = `
          <div class="unsupported-warning">
            <i class="fas fa-info-circle"></i>
            Copy stream may fail. Re-encode recommended.
          </div>
        `;
      }

      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `
        <div class="file-info" style="display: flex; align-items: center; gap: 0.75rem; width: 100%;">
          <input type="checkbox" class="file-checkbox" data-file="${file.name}">
          <div style="flex: 1; min-width: 0;">
            <div class="file-name">${file.name}</div>
            <div class="file-meta">${file.resolution || 'N/A'} | ${file.bitrate || 'N/A'}</div>
            ${!isSupported ? `
              <div class="unsupported-warning">
                <i class="fas fa-exclamation-triangle"></i>
                Requires conversion
              </div>
            ` : copyWarning}
          </div>
          <button class="quick-transcode-btn" data-file="${file.name}" title="Quick transcode (Copy Stream)">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      `;
      container.appendChild(div);

      // Восстанавливаем состояние чекбокса
      const checkbox = div.querySelector('.file-checkbox');
      checkbox.checked = window.selectedFiles.has(file.name);
      checkbox.addEventListener('change', (e) => {
        const filename = e.target.dataset.file;
        if (e.target.checked) {
          window.selectedFiles.add(filename);
        } else {
          window.selectedFiles.delete(filename);
        }
        updateApplyButtons();
      });

      // Кнопка быстрого транскодирования
      const quickBtn = div.querySelector('.quick-transcode-btn');
      quickBtn.addEventListener('click', () => {
        quickTranscode(file.name);
      });
    });
  } catch (err) {
    console.error('[TRANSCODE] Error loading files:', err);
    container.innerHTML = `<div class="file-item">Error: ${err.message}</div>`;
    showNotification('Failed to load files: ' + err.message, 'error');
  }
}

// Обновление кнопок Apply
function updateApplyButtons() {
  document.querySelectorAll('.apply-template-btn').forEach(btn => {
    const isEnabled = window.selectedFiles.size > 0;
    btn.disabled = !isEnabled;
    btn.title = isEnabled ? 'Apply to selected files' : 'Select files first';
  });
}

// Применить шаблон ко всем выбранным
async function applyTemplateToSelected(templateId) {
  if (window.selectedFiles.size === 0) {
    showNotification('No files selected', 'warning');
    return;
  }

  const filesArray = Array.from(window.selectedFiles);
  const useCuda = getCudaEnabled();
  let successCount = 0;

  for (const fileId of filesArray) {
    const res = await apiCall('/api/transcode/add-to-queue', 'POST', {
      fileId,
      templateId,
      useCuda
    });
    if (res.success) successCount++;
  }

  const cudaMsg = useCuda ? ' (with CUDA)' : '';
  showNotification(`Added ${successCount} of ${filesArray.length} files to queue${cudaMsg}`, 'success');
  window.selectedFiles.clear();
  updateApplyButtons();
  loadFiles(); // Сбросит чекбоксы
  loadQueue();
}

// Получить состояние CUDA чекбокса
function getCudaEnabled() {
  const checkbox = document.getElementById('useCudaCheckbox');
  return checkbox ? checkbox.checked : false;
}

// Быстрое транскодирование
async function quickTranscode(filename) {
  const useCuda = getCudaEnabled();
  const confirmMessage = useCuda
    ? `Start quick transcode with CUDA acceleration for "${filename}"?\nThis will use GPU for faster processing.`
    : `Start quick transcode (copy stream) for "${filename}"?\nThis will create an MP4 without re-encoding.`;

  if (!confirm(confirmMessage)) return;

  try {
    // Формируем команду с учетом CUDA
    let command = '-c copy -map 0';
    if (useCuda) {
      command = '-hwaccel cuda -hwaccel_device 0 -c:v h264_nvenc -preset fast -c:a aac -b:a 128k';
    }

    const res = await fetch('/api/transcode/quick-transcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, command, useCuda })
    });
    const data = await res.json();
    if (data.success) {
      const cudaMsg = useCuda ? ' (CUDA)' : '';
      showNotification(`✅ Quick transcode completed${cudaMsg}: ${data.output}`, 'success');
      loadFiles();
      loadQueue();
    } else {
      showNotification('❌ Quick transcode failed: ' + data.error, 'error');
    }
  } catch (err) {
    console.error('[TRANSCODE] Quick transcode error:', err);
    showNotification('❌ Connection error: ' + err.message, 'error');
  }
}

// Загрузка очереди
async function loadQueue() {
  const res = await apiCall('/api/transcode/queue', 'GET');
  const container = document.getElementById('queueList');
  if (!container) return;
  container.innerHTML = '';

  if (res.success && Array.isArray(res.queue) && res.queue.length > 0) {
    res.queue.forEach(item => {
      let statusClass = 'status-' + item.status;
      let statusText = item.status;
      let isCancellable = false;

      if (item.isCancelled) {
        statusClass = 'status-cancelled';
        statusText = 'cancelled';
      } else if (item.status === 'pending' || item.status === 'processing') {
        isCancellable = true;
      }

      const div = document.createElement('div');
      div.className = 'queue-item';
      let progressHtml = '';
      if (item.progress != null && !item.isCancelled) {
        const etaText = item.eta ? `(~${Math.ceil(item.eta / 60)} min)` : '';
        progressHtml = `
          <div class="progress-bar">
            <div class="progress-bar-fill" style="width: ${item.progress}%"></div>
          </div>
          <div style="font-size: 0.8rem; text-align: center;">
            ${Math.round(item.progress)}% ${etaText}
          </div>
        `;
      }

      const errorHtml = (item.error && item.status === 'error') 
        ? `<div style="color: var(--danger); font-size: 0.8rem; margin-top: 0.25rem;">Error: ${item.error}</div>`
        : '';

      div.innerHTML = `
        <div class="queue-header">
          <div>
            <div class="queue-file">${item.fileId}</div>
            <div class="queue-template">${item.templateName || 'Unknown'} ${item.useCuda ? '<i class="fas fa-microchip" title="CUDA acceleration" style="color: #007bff; margin-left: 0.25rem;"></i>' : ''}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="status-badge ${statusClass}">${statusText}</span>
            ${isCancellable ? `
              <button class="btn btn-sm btn-danger cancel-job-btn" data-job-id="${item.id}" title="Cancel job">
                <i class="fas fa-times"></i>
              </button>
            ` : ''}
          </div>
        </div>
        ${progressHtml}
        ${errorHtml}
      `;
      container.appendChild(div);
    });

    // Навешиваем обработчики отмены (можно также через делегирование)
    container.querySelectorAll('.cancel-job-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Cancel job ${btn.dataset.jobId}?`)) return;
        const cancelRes = await fetch('/api/transcode/cancel-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: btn.dataset.jobId })
        });
        const cancelData = await cancelRes.json();
        if (cancelData.success) {
          showNotification(`Job ${btn.dataset.jobId} cancelled`, 'success');
          loadQueue();
        } else {
          showNotification('Cancel failed: ' + (cancelData.error || 'Unknown'), 'error');
        }
      });
    });
  } else {
    container.innerHTML = '<div class="queue-item">Queue is empty</div>';
  }
}

// Удаление шаблона
async function deleteTemplate(templateId) {
  if (confirm(`Delete this template?`)) {
    const res = await apiCall('/api/transcode/delete-template', 'POST', { id: templateId });
    if (res.success) {
      showNotification('Template deleted', 'success');
      loadTemplates();
    } else {
      showNotification('Failed to delete template: ' + (res.error || 'Unknown error'), 'error');
    }
  }
}

// ✅ НОВОЕ: Открытие модального окна для создания шаблона
function openTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) {
    modal.style.display = 'flex';
    // Очищаем поля
    document.getElementById('templateName').value = '';
    document.getElementById('templateDescription').value = '';
    document.getElementById('templateCommand').value = '';
  }
}

// ✅ НОВОЕ: Закрытие модального окна
function closeTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// ✅ НОВОЕ: Заполнение примера
function fillExample(type) {
  const nameInput = document.getElementById('templateName');
  const descInput = document.getElementById('templateDescription');
  const commandInput = document.getElementById('templateCommand');

  switch(type) {
    case '720p':
      nameInput.value = 'HD 720p';
      descInput.value = 'High quality 720p MP4 for web playback';
      commandInput.value = '-vf scale=1280:720 -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k';
      break;
    case '1080p':
      nameInput.value = 'Full HD 1080p';
      descInput.value = 'Full HD 1080p MP4 with high quality';
      commandInput.value = '-vf scale=1920:1080 -c:v libx264 -crf 20 -preset slow -c:a aac -b:a 192k';
      break;
    case '480p':
      nameInput.value = 'SD 480p';
      descInput.value = 'Standard definition 480p MP4 for smaller file size';
      commandInput.value = '-vf scale=854:480 -c:v libx264 -crf 25 -preset fast -c:a aac -b:a 96k';
      break;
  }
}

// ✅ НОВОЕ: Сохранение шаблона
async function saveTemplate() {
  const name = document.getElementById('templateName').value.trim();
  const description = document.getElementById('templateDescription').value.trim();
  const command = document.getElementById('templateCommand').value.trim();

  if (!name) {
    showNotification('Template name is required', 'error');
    return;
  }

  if (!command) {
    showNotification('FFmpeg command is required', 'error');
    return;
  }

  try {
    const res = await apiCall('/api/transcode/save-template', 'POST', {
      name,
      description,
      command
    });

    if (res.success) {
      showNotification(`Template "${name}" saved successfully!`, 'success');
      closeTemplateModal();
      loadTemplates();
    } else {
      showNotification('Failed to save template: ' + (res.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    console.error('[TRANSCODE] Save template error:', err);
    showNotification('Error saving template: ' + err.message, 'error');
  }
}

// === ИНИЦИАЛИЗАЦИЯ ===
document.addEventListener('DOMContentLoaded', () => {
  const templatesContainer = document.getElementById('templatesList');
  const filesContainer = document.getElementById('filesList');

  // Делегирование для шаблонов (Apply и Delete)
  if (templatesContainer) {
    templatesContainer.addEventListener('click', (e) => {
      if (e.target.closest('.apply-template-btn')) {
        const btn = e.target.closest('.apply-template-btn');
        applyTemplateToSelected(btn.dataset.templateId);
      } else if (e.target.closest('.delete-template-btn')) {
        const btn = e.target.closest('.delete-template-btn');
        deleteTemplate(btn.dataset.templateId);
      }
    });
  }

  // ✅ ИСПРАВЛЕНО: Кнопка добавления шаблона открывает модальное окно
  document.getElementById('addTemplateBtn')?.addEventListener('click', openTemplateModal);

  // Закрытие модального окна при клике вне его
  document.getElementById('templateModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'templateModal') {
      closeTemplateModal();
    }
  });

  // Закрытие модального окна по Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('templateModal');
      if (modal && modal.style.display === 'flex') {
        closeTemplateModal();
      }
    }
  });

  // Кнопка обновления файлов
  document.getElementById('refreshFilesBtn')?.addEventListener('click', loadFiles);

  // Управление очередью транскодирования
  document.getElementById('refreshQueueBtn')?.addEventListener('click', loadQueue);

  document.getElementById('clearCompletedBtn')?.addEventListener('click', async () => {
    if (!confirm('Clear all completed jobs from queue?')) return;

    try {
      // This would need a backend endpoint to clear completed jobs
      showNotification('Clear completed jobs feature not implemented yet', 'info');
    } catch (err) {
      showNotification('Error clearing completed jobs: ' + err.message, 'error');
    }
  });

  document.getElementById('clearFailedBtn')?.addEventListener('click', async () => {
    if (!confirm('Clear all failed jobs from queue?')) return;

    try {
      // This would need a backend endpoint to clear failed jobs
      showNotification('Clear failed jobs feature not implemented yet', 'info');
    } catch (err) {
      showNotification('Error clearing failed jobs: ' + err.message, 'error');
    }
  });

  // Массовые операции с файлами
  document.getElementById('selectAllFilesBtn')?.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#filesList .file-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = true;
      const filename = checkbox.dataset.file;
      window.selectedFiles.add(filename);
    });
    updateBulkButtons();
  });

  document.getElementById('clearSelectionBtn')?.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('#filesList .file-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = false;
      const filename = checkbox.dataset.file;
      window.selectedFiles.delete(filename);
    });
    updateBulkButtons();
  });

  document.getElementById('bulkDeleteBtn')?.addEventListener('click', async () => {
    if (window.selectedFiles.size === 0) return;

    const filesToDelete = Array.from(window.selectedFiles);
    const confirmMessage = `Are you sure you want to delete ${filesToDelete.length} file(s)?\n\n${filesToDelete.join('\n')}`;

    if (!confirm(confirmMessage)) return;

    let successCount = 0;
    let failCount = 0;

    for (const filePath of filesToDelete) {
      try {
        const res = await apiCall('/api/files/delete', 'DELETE', {
          path: filePath
        });
        if (res.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
        console.error('Delete error:', err);
      }
    }

    if (failCount === 0) {
      showNotification(`Successfully deleted ${successCount} file(s)`, 'success');
    } else {
      showNotification(`Deleted ${successCount} file(s). Failed to delete ${failCount} file(s).`, 'warning');
    }

    window.selectedFiles.clear();
    updateBulkButtons();
    loadFiles();
  });

  // Обновление состояния чекбоксов при изменении selectedFiles
  function updateFileCheckboxes() {
    const checkboxes = document.querySelectorAll('#filesList .file-checkbox');
    checkboxes.forEach(checkbox => {
      const filename = checkbox.dataset.file;
      checkbox.checked = window.selectedFiles.has(filename);
    });
    updateBulkButtons();
  }

  // Обновление состояния кнопок массовых операций
  function updateBulkButtons() {
    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    const hasSelection = window.selectedFiles.size > 0;
    bulkDeleteBtn.disabled = !hasSelection;
  }

  // Переопределяем updateApplyButtons чтобы он также обновлял bulk buttons
  const originalUpdateApplyButtons = window.updateApplyButtons;
  window.updateApplyButtons = function() {
    if (originalUpdateApplyButtons) originalUpdateApplyButtons();
    updateBulkButtons();
  };

  // Загрузка данных
  loadTemplates();
  loadFiles();
  loadQueue();
  setInterval(loadQueue, 2000);
});