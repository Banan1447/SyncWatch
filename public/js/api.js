// public/js/api.js

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ ===
window.selectedFiles = new Set(); // Имена выбранных файлов

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

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
async function apiCall(url, method = 'POST', data = null) {
  try {
    const config = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
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
  let successCount = 0;

  for (const fileId of filesArray) {
    const res = await apiCall('/api/transcode/add-to-queue', 'POST', { fileId, templateId });
    if (res.success) successCount++;
  }

  showNotification(`Added ${successCount} of ${filesArray.length} files to queue`, 'success');
  window.selectedFiles.clear();
  updateApplyButtons();
  loadFiles(); // Сбросит чекбоксы
  loadQueue();
}

// Быстрое транскодирование
async function quickTranscode(filename) {
  if (!confirm(`Start quick transcode (copy stream) for "${filename}"?\nThis will create an MP4 without re-encoding.`)) return;

  try {
    const res = await fetch('/api/transcode/quick-transcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, command: '-c copy -map 0' })
    });
    const data = await res.json();
    if (data.success) {
      showNotification(`✅ Quick transcode completed: ${data.output}`, 'success');
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
            <div class="queue-template">${item.templateName || 'Unknown'}</div>
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
    }
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

  // Кнопка добавления шаблона (временно)
  document.getElementById('addTemplateBtn')?.addEventListener('click', () => {
    alert('Template creation UI is not implemented in this demo.\nUse system "Copy Stream" or contact admin.');
  });

  // Кнопка обновления файлов
  document.getElementById('refreshFilesBtn')?.addEventListener('click', loadFiles);

  // Загрузка данных
  loadTemplates();
  loadFiles();
  loadQueue();
  setInterval(loadQueue, 2000);
});