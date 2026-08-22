import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

const API = '/api/v1';
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'flv', 'wmv', 'm2ts']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif']);

function ext(name) { return name.split('.').pop().toLowerCase(); }
function isVideo(name) { return VIDEO_EXTS.has(ext(name)); }
function isImage(name) { return IMAGE_EXTS.has(ext(name)); }

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const S = {
  page: { minHeight: '100dvh', background: '#09090f', color: '#e2e8f0', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  header: { background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0.6rem 1.2rem', display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 },
  logo: { fontWeight: 800, fontSize: '1rem', background: 'linear-gradient(135deg,#7c6ff7,#ff6b9d)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', cursor: 'pointer', flexShrink: 0 },
  breadcrumb: { display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)', flex: 1, flexWrap: 'wrap' },
  crumbBtn: { background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '0.82rem', padding: '0.1rem 0.2rem', borderRadius: 4 },
  toolbar: { padding: '0.6rem 1.2rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', flexShrink: 0 },
  btn: (variant = 'default') => ({
    padding: '0.38rem 0.75rem', borderRadius: '7px', fontSize: '0.78rem', fontWeight: 600,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
    background: variant === 'primary' ? 'linear-gradient(135deg,#7c6ff7,#6c5fd7)'
      : variant === 'danger' ? 'rgba(248,113,113,0.15)'
      : 'rgba(255,255,255,0.07)',
    color: variant === 'primary' ? '#fff' : variant === 'danger' ? '#f87171' : 'rgba(255,255,255,0.8)',
    border: variant === 'primary' ? 'none' : variant === 'danger' ? '1px solid rgba(248,113,113,0.3)' : '1px solid rgba(255,255,255,0.08)',
    transition: 'opacity .15s',
  }),
  input: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', padding: '0.35rem 0.65rem', fontSize: '0.78rem', outline: 'none', fontFamily: 'inherit' },
  content: { flex: 1, overflow: 'auto', padding: '0.5rem 1.2rem 1.5rem' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', fontWeight: 600, padding: '0.4rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.07)', userSelect: 'none', letterSpacing: '0.04em', textTransform: 'uppercase' },
  tr: (selected, active) => ({
    background: active ? 'rgba(124,111,247,0.12)' : selected ? 'rgba(124,111,247,0.07)' : 'transparent',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background .12s',
  }),
  td: { padding: '0.4rem 0.6rem', fontSize: '0.82rem', verticalAlign: 'middle' },
  nameCell: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  fileIcon: (name, isDir) => ({
    fontSize: '1.1rem', flexShrink: 0,
    color: isDir ? '#fbbf24' : isVideo(name) ? '#7c6ff7' : 'rgba(255,255,255,0.4)',
  }),
  actionBtn: (color = 'rgba(255,255,255,0.35)') => ({
    background: 'none', border: 'none', cursor: 'pointer', color, fontSize: '0.8rem',
    padding: '0.2rem 0.35rem', borderRadius: 4, transition: 'color .12s, background .12s',
  }),
  toast: (type) => ({
    position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)',
    background: type === 'ok' ? 'rgba(74,222,128,0.15)' : type === 'error' ? 'rgba(248,113,113,0.15)' : 'rgba(124,111,247,0.15)',
    border: `1px solid ${type === 'ok' ? 'rgba(74,222,128,0.4)' : type === 'error' ? 'rgba(248,113,113,0.4)' : 'rgba(124,111,247,0.4)'}`,
    color: type === 'ok' ? '#4ade80' : type === 'error' ? '#f87171' : '#a78bfa',
    padding: '0.5rem 1.2rem', borderRadius: 10, fontSize: '0.82rem', fontWeight: 600,
    zIndex: 9999, backdropFilter: 'blur(8px)', pointerEvents: 'none',
  }),
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' },
  modalBox: { background: '#13131f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '1.5rem', minWidth: 320, display: 'flex', flexDirection: 'column', gap: '1rem' },
  progressBar: (pct) => ({
    position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`,
    background: 'linear-gradient(90deg,#7c6ff7,#a78bfa)', borderRadius: 3, transition: 'width .2s',
  }),
};

function FileIcon({ name, isDir }) {
  if (isDir) return <span style={{ fontSize: '1.1rem' }}>📁</span>;
  const e = ext(name);
  if (VIDEO_EXTS.has(e)) return <span style={{ fontSize: '1.1rem' }}>🎬</span>;
  if (['jpg','jpeg','png','gif','webp','svg'].includes(e)) return <span style={{ fontSize: '1.1rem' }}>🖼</span>;
  return <span style={{ fontSize: '1.1rem' }}>📄</span>;
}

export default function FileManager() {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const roomId = searchParams.get('room');

  const [prefix, setPrefix] = useState('videos/');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadName, setUploadName] = useState('');
  const fileInputRef = useRef(null);

  // Create folder modal
  const [showFolder, setShowFolder] = useState(false);
  const [folderName, setFolderName] = useState('');

  // Rename
  const [renaming, setRenaming] = useState(null);
  const [renameVal, setRenameVal] = useState('');
  const renameInputRef = useRef(null);

  // Move modal
  const [moveTarget, setMoveTarget] = useState(null);
  const [moveDest, setMoveDest] = useState('');

  // DnD row-to-folder
  const [dragOverKey, setDragOverKey] = useState(null);

  // Thumbnail preview on hover
  const [hoverPreview, setHoverPreview] = useState(null);
  const bufferBarRef = useRef(null);

  const authH = useCallback(() => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  const authHJson = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  // File info panel (ffprobe on-demand)
  const [fileInfo, setFileInfo] = useState(null);  // { key, data, loading }
  const loadFileInfo = useCallback(async (key) => {
    if (fileInfo?.key === key) { setFileInfo(null); return; }
    setFileInfo({ key, data: null, loading: true });
    try {
      const r = await fetch(`${API}/files/info?key=${encodeURIComponent(key)}`, { headers: authH() });
      const data = r.ok ? await r.json() : null;
      setFileInfo({ key, data, loading: false });
    } catch { setFileInfo({ key, data: null, loading: false }); }
  }, [fileInfo, authH]);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`${API}/files?prefix=${encodeURIComponent(prefix)}`, { headers: authH() });
      if (!res.ok) return;
      const data = await res.json();
      setEntries(data.entries || []);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [prefix, authH]);

  useEffect(() => {
    load();
    setSelected(new Set());
    setSearch('');
  }, [load]);

  // Poll every 5s for real-time sync
  useEffect(() => {
    const id = setInterval(() => load(true), 5000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  // Breadcrumbs
  const crumbs = React.useMemo(() => {
    const parts = prefix.replace(/\/$/, '').split('/').filter(Boolean);
    const result = [{ label: '/', path: 'videos/' }];
    let acc = '';
    for (const p of parts) {
      acc += p + '/';
      result.push({ label: p, path: acc });
    }
    return result;
  }, [prefix]);

  const goTo = (p) => { setPrefix(p); setSelected(new Set()); setSearch(''); };

  const goUp = () => {
    const parts = prefix.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length <= 1) return;
    parts.pop();
    goTo(parts.join('/') + '/');
  };

  // Upload
  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    uploadFiles(files);
    e.target.value = '';
  };

  const uploadFiles = (files) => {
    let idx = 0;
    const uploadNext = () => {
      if (idx >= files.length) { load(); return; }
      const file = files[idx++];
      setUploading(true);
      setUploadProgress(0);
      setUploadName(file.name);
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('file', file);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
      };
      const finish = (ok, msg) => {
        setUploading(false);
        setUploadName('');
        setUploadProgress(0);
        showToast(msg, ok ? 'ok' : 'error');
        uploadNext();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          finish(true, `${file.name} загружен`);
        } else {
          let detail = `HTTP ${xhr.status}`;
          try {
            const body = JSON.parse(xhr.responseText);
            detail = body.message || body.error || detail;
          } catch (_) {}
          console.error('[FM upload error]', xhr.status, xhr.responseText);
          finish(false, `Ошибка загрузки ${file.name}: ${detail}`);
        }
      };
      xhr.onerror = () => {
        console.error('[FM upload network error]', file.name);
        finish(false, `Сетевая ошибка при загрузке ${file.name}`);
      };
      xhr.ontimeout = () => {
        console.error('[FM upload timeout]', file.name);
        finish(false, `Таймаут загрузки ${file.name} — файл слишком большой или соединение медленное`);
      };
      // No explicit timeout — rely on server/proxy timeout (Kong write_timeout=300s)
      xhr.open('POST', `${API}/files/fm-upload?prefix=${encodeURIComponent(prefix)}`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(fd);
    };
    uploadNext();
  };

  // Drag-and-drop on page (file upload from OS)
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOverKey(null);
    if (e.dataTransfer.getData('application/fm-key')) return; // internal row DnD — handled by folder rows
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  }, [prefix, token, load, showToast]);

  const onDragOver = (e) => e.preventDefault();

  // Create folder
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    const path = prefix + name + '/';
    const res = await fetch(`${API}/files/folder`, { method: 'POST', headers: authHJson(), body: JSON.stringify({ path }) });
    if (res.ok) { showToast('Папка создана', 'ok'); setShowFolder(false); setFolderName(''); load(); }
    else showToast('Ошибка создания папки', 'error');
  };

  // Delete
  const deleteFile = async (entry) => {
    if (!window.confirm(`Удалить «${entry.name}»?`)) return;
    const res = await fetch(`${API}/files?key=${encodeURIComponent(entry.key)}`, { method: 'DELETE', headers: authH() });
    if (res.ok) { showToast('Файл удалён', 'ok'); load(); }
    else showToast('Ошибка удаления', 'error');
  };

  const deleteFolder = async (entry) => {
    if (!window.confirm(`Удалить папку «${entry.name}» и всё содержимое?`)) return;
    const res = await fetch(`${API}/files/folder?prefix=${encodeURIComponent(entry.key)}`, { method: 'DELETE', headers: authH() });
    if (res.ok) { showToast('Папка удалена', 'ok'); load(); }
    else showToast('Ошибка удаления', 'error');
  };

  const deleteSelected = async () => {
    if (!selected.size || !window.confirm(`Удалить ${selected.size} объект(ов)?`)) return;
    for (const key of selected) {
      const entry = entries.find(e => e.key === key);
      if (!entry) continue;
      if (entry.is_dir) {
        await fetch(`${API}/files/folder?prefix=${encodeURIComponent(key)}`, { method: 'DELETE', headers: authH() });
      } else {
        await fetch(`${API}/files?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: authH() });
      }
    }
    setSelected(new Set());
    showToast('Удалено', 'ok');
    load();
  };

  // Rename (inline)
  const startRename = (entry, e) => { e.stopPropagation(); setRenaming(entry.key); setRenameVal(entry.name); };
  const commitRename = async (entry) => {
    const newName = renameVal.trim();
    setRenaming(null);
    if (!newName || newName === entry.name) return;
    const dest = entry.is_dir
      ? prefix + newName + '/'
      : prefix + newName;
    const res = await fetch(`${API}/files/move`, { method: 'POST', headers: authHJson(), body: JSON.stringify({ source: entry.key, destination: dest }) });
    if (res.ok) { showToast('Переименовано', 'ok'); load(); }
    else showToast('Ошибка переименования', 'error');
  };

  // Move
  const openMove = (entry, e) => { e.stopPropagation(); setMoveTarget(entry); setMoveDest(entry.key); };
  const commitMove = async () => {
    if (!moveTarget || !moveDest.trim() || moveDest === moveTarget.key) { setMoveTarget(null); return; }
    const res = await fetch(`${API}/files/move`, { method: 'POST', headers: authHJson(), body: JSON.stringify({ source: moveTarget.key, destination: moveDest.trim() }) });
    if (res.ok) { showToast('Перемещено', 'ok'); load(); }
    else showToast('Ошибка перемещения', 'error');
    setMoveTarget(null);
  };

  // DnD move to folder
  const dndMoveToFolder = async (srcKey, folderKey) => {
    const name = srcKey.split('/').pop();
    const dest = folderKey + name;
    if (dest === srcKey) return;
    const res = await fetch(`${API}/files/move`, { method: 'POST', headers: authHJson(), body: JSON.stringify({ source: srcKey, destination: dest }) });
    if (res.ok) { showToast(`Перемещено в ${folderKey.split('/').filter(Boolean).pop() || '/'}`, 'ok'); load(); }
    else showToast('Ошибка перемещения', 'error');
  };

  // Copy
  const copyFile = async (entry, e) => {
    e.stopPropagation();
    const dotIdx = entry.key.lastIndexOf('.');
    const dest = dotIdx > 0
      ? entry.key.slice(0, dotIdx) + '_copy' + entry.key.slice(dotIdx)
      : entry.key + '_copy';
    const res = await fetch(`${API}/files/copy`, { method: 'POST', headers: authHJson(), body: JSON.stringify({ source: entry.key, destination: dest }) });
    if (res.ok) { showToast(`Скопировано → ${dest.split('/').pop()}`, 'ok'); load(); }
    else showToast('Ошибка копирования', 'error');
  };

  // Add to queue
  const addToQueue = async (entry, e) => {
    e?.stopPropagation();
    if (!roomId) { showToast('Откройте файловый менеджер из комнаты', 'error'); return; }
    const res = await fetch(`${API}/rooms/${roomId}/queue`, {
      method: 'POST',
      headers: authHJson(),
      body: JSON.stringify({ video_source: 'direct', video_url: entry.url, title: entry.name }),
    });
    if (res.ok) showToast(`«${entry.name}» добавлено в очередь`, 'ok');
    else showToast('Ошибка добавления в очередь', 'error');
  };

  const addSelectedToQueue = async () => {
    if (!roomId) { showToast('Откройте файловый менеджер из комнаты', 'error'); return; }
    const toAdd = entries.filter(e => selected.has(e.key) && !e.is_dir);
    for (const entry of toAdd) await addToQueue(entry);
    showToast(`${toAdd.length} файл(ов) добавлено в очередь`, 'ok');
  };

  const toggleSelect = (key, e) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === entries.length) setSelected(new Set());
    else setSelected(new Set(entries.map(e => e.key)));
  };

  const filtered = entries.filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()));

  // Sort: folders first, then by name
  const sorted = [...filtered].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });

  return (
    <div style={S.page} onDrop={onDrop} onDragOver={onDragOver}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.logo} onClick={() => navigate('/')}>WatchSync</div>
        <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.8rem' }}>/</div>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'rgba(255,255,255,0.7)' }}>Файловый менеджер</div>

        {/* Breadcrumbs */}
        <div style={S.breadcrumb}>
          {crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i > 0 && <span style={{ color: 'rgba(255,255,255,0.2)' }}>/</span>}
              <button style={S.crumbBtn} onClick={() => goTo(c.path)}>{c.label}</button>
            </React.Fragment>
          ))}
        </div>

        {roomId && (
          <div style={{ fontSize: '0.72rem', color: '#a78bfa', background: 'rgba(124,111,247,0.1)', border: '1px solid rgba(124,111,247,0.25)', borderRadius: 6, padding: '0.2rem 0.5rem', flexShrink: 0 }}>
            Комната {roomId.slice(0, 8)}…
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div style={S.toolbar}>
        {prefix !== 'videos/' && (
          <button style={S.btn()} onClick={goUp}>← Назад</button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button style={S.btn('primary')} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          ↑ Загрузить
        </button>

        <button style={S.btn()} onClick={() => { setShowFolder(true); setFolderName(''); }}>
          + Папка
        </button>

        {selected.size > 0 && (
          <>
            <button style={S.btn('danger')} onClick={deleteSelected}>
              🗑 Удалить ({selected.size})
            </button>
            {roomId && (
              <button style={S.btn()} onClick={addSelectedToQueue}>
                ▶ В очередь ({selected.size})
              </button>
            )}
          </>
        )}

        <div style={{ flex: 1 }} />

        <input
          style={{ ...S.input, width: 160 }}
          placeholder="Поиск…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <button style={S.btn()} onClick={() => load()} title="Обновить">↻</button>
      </div>

      {/* Upload progress bar */}
      {uploading && (
        <div style={{ padding: '0.4rem 1.2rem', background: 'rgba(124,111,247,0.06)', borderBottom: '1px solid rgba(124,111,247,0.15)', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
          <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
            ↑ {uploadName}
          </span>
          <div style={{ flex: 1, position: 'relative', height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={S.progressBar(uploadProgress)} />
          </div>
          <span style={{ fontSize: '0.75rem', color: '#a78bfa', flexShrink: 0 }}>{uploadProgress}%</span>
        </div>
      )}

      {/* Drag-and-drop hint */}
      {!uploading && entries.length === 0 && !loading && (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.2)', padding: '3rem 1rem', fontSize: '0.85rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📂</div>
          Папка пуста — перетащите файлы сюда или нажмите «Загрузить»
        </div>
      )}

      {/* File table */}
      <div style={S.content}>
        {(loading && entries.length === 0) ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', padding: '2rem', fontSize: '0.8rem' }}>Загрузка…</div>
        ) : sorted.length > 0 ? (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{ ...S.th, width: 30 }}>
                  <input type="checkbox" checked={selected.size === entries.length && entries.length > 0} onChange={selectAll} style={{ cursor: 'pointer', accentColor: '#7c6ff7' }} />
                </th>
                <th style={S.th}>Имя</th>
                <th style={{ ...S.th, width: 90 }}>Размер</th>
                <th style={{ ...S.th, width: 130 }}>Дата</th>
                <th style={{ ...S.th, width: 140, textAlign: 'right' }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(entry => (
                <tr
                  key={entry.key}
                  style={{
                    ...S.tr(selected.has(entry.key), false),
                    ...(entry.is_dir && dragOverKey === entry.key ? { background: 'rgba(124,111,247,0.25)', outline: '2px dashed rgba(124,111,247,0.6)' } : {}),
                  }}
                  draggable={!entry.is_dir}
                  onDragStart={e => { e.dataTransfer.setData('application/fm-key', entry.key); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={e => { if (!entry.is_dir) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverKey(entry.key); }}
                  onDragLeave={e => { if (entry.is_dir) setDragOverKey(null); }}
                  onDrop={e => {
                    if (!entry.is_dir) return;
                    e.preventDefault(); e.stopPropagation();
                    setDragOverKey(null);
                    const srcKey = e.dataTransfer.getData('application/fm-key');
                    if (srcKey) dndMoveToFolder(srcKey, entry.key);
                  }}
                  onClick={() => entry.is_dir ? goTo(entry.key) : toggleSelect(entry.key, { stopPropagation: () => {} })}
                  onMouseEnter={e => { if (!selected.has(entry.key) && dragOverKey !== entry.key) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = selected.has(entry.key) ? 'rgba(124,111,247,0.07)' : 'transparent'; }}
                >
                  <td style={S.td} onClick={e => { e.stopPropagation(); if (!entry.is_dir) toggleSelect(entry.key, e); }}>
                    {!entry.is_dir && (
                      <input type="checkbox" checked={selected.has(entry.key)} onChange={() => {}} onClick={e => { e.stopPropagation(); toggleSelect(entry.key, e); }} style={{ cursor: 'pointer', accentColor: '#7c6ff7' }} />
                    )}
                  </td>
                  <td
                    style={S.td}
                    onMouseEnter={e => { if (!entry.is_dir && (isVideo(entry.name) || isImage(entry.name))) setHoverPreview({ entry, x: e.clientX + 18, y: e.clientY - 80 }); }}
                    onMouseMove={e => { if (hoverPreview?.entry.key === entry.key) setHoverPreview(h => ({ ...h, x: e.clientX + 18, y: e.clientY - 80 })); }}
                    onMouseLeave={() => setHoverPreview(null)}
                  >
                    <div style={S.nameCell}>
                      <FileIcon name={entry.name} isDir={entry.is_dir} />
                      {!entry.is_dir && entry.is_supported === false && (
                        <span title="Требуется транскодирование для воспроизведения в браузере" style={{ fontSize: '0.65rem', color: '#f87171', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 3, padding: '0px 4px', flexShrink: 0 }}>⚠ Транскод</span>
                      )}
                      {renaming === entry.key ? (
                        <input
                          ref={renameInputRef}
                          value={renameVal}
                          onChange={e => setRenameVal(e.target.value)}
                          onBlur={() => commitRename(entry)}
                          onKeyDown={e => { if (e.key === 'Enter') commitRename(entry); if (e.key === 'Escape') setRenaming(null); }}
                          onClick={e => e.stopPropagation()}
                          style={{ ...S.input, padding: '0.15rem 0.4rem', fontSize: '0.82rem', flex: 1 }}
                        />
                      ) : (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }} title={entry.name}>
                          {entry.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...S.td, color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }}>
                    {entry.is_dir ? '—' : formatSize(entry.size)}
                  </td>
                  <td style={{ ...S.td, color: 'rgba(255,255,255,0.35)', fontSize: '0.72rem' }}>
                    {entry.is_dir ? '' : formatDate(entry.last_modified)}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.1rem' }}>
                      {!entry.is_dir && roomId && isVideo(entry.name) && (
                        <button style={S.actionBtn('#a78bfa')} title="В очередь" onClick={e => addToQueue(entry, e)}>▶</button>
                      )}
                      <button style={S.actionBtn()} title="Переименовать" onClick={e => startRename(entry, e)}>✏</button>
                      <button style={S.actionBtn()} title="Переместить" onClick={e => openMove(entry, e)}>→</button>
                      {!entry.is_dir && (
                        <>
                          <button style={S.actionBtn()} title="Копировать" onClick={e => copyFile(entry, e)}>⧉</button>
                          <a href={entry.url} download={entry.name} onClick={e => e.stopPropagation()} style={{ ...S.actionBtn(), textDecoration: 'none', fontSize: '0.85rem' }} title="Скачать">↓</a>
                          {isVideo(entry.name) && (
                            <button
                              style={{ ...S.actionBtn(fileInfo?.key === entry.key ? '#a78bfa' : undefined) }}
                              title="Метаданные файла"
                              onClick={e => { e.stopPropagation(); loadFileInfo(entry.key); }}
                            >ℹ</button>
                          )}
                        </>
                      )}
                      <button
                        style={S.actionBtn('#f87171')}
                        title={entry.is_dir ? 'Удалить папку' : 'Удалить файл'}
                        onClick={e => { e.stopPropagation(); entry.is_dir ? deleteFolder(entry) : deleteFile(entry); }}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {/* Status bar */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '0.35rem 1.2rem', fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', display: 'flex', gap: '1.5rem', flexShrink: 0 }}>
        <span>{entries.length} объект(ов)</span>
        {selected.size > 0 && <span>{selected.size} выбрано</span>}
        <span>{formatSize(entries.filter(e => !e.is_dir).reduce((s, e) => s + (e.size || 0), 0))} всего</span>
        <span style={{ marginLeft: 'auto' }}>Обновление каждые 5с</span>
      </div>

      {/* File info panel */}
      {fileInfo && (
        <div style={{ position: 'fixed', bottom: '3.5rem', right: '1.5rem', zIndex: 8000, background: '#13131f', border: '1px solid rgba(124,111,247,0.3)', borderRadius: 12, padding: '1rem 1.2rem', minWidth: 240, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.82rem', color: '#a78bfa' }}>ℹ Метаданные</span>
            <button style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }} onClick={() => setFileInfo(null)}>×</button>
          </div>
          {fileInfo.loading ? (
            <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.78rem' }}>Загрузка…</div>
          ) : fileInfo.data ? (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              {[
                ['Разрешение', fileInfo.data.resolution],
                ['Битрейт', fileInfo.data.bitrate],
                ['Длительность', fileInfo.data.duration],
                ['Видеокодек', fileInfo.data.video_codec],
                ['Аудиокодек', fileInfo.data.audio_codec],
                ['Размер', fileInfo.data.size],
              ].map(([label, val]) => (
                <tr key={label}>
                  <td style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', paddingRight: '0.8rem', paddingBottom: '0.2rem', whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ fontSize: '0.78rem', color: '#e2e8f0', fontWeight: 500, paddingBottom: '0.2rem' }}>{val}</td>
                </tr>
              ))}
            </table>
          ) : (
            <div style={{ color: '#f87171', fontSize: '0.78rem' }}>Не удалось получить метаданные</div>
          )}
        </div>
      )}

      {/* Create folder modal */}
      {showFolder && (
        <div style={S.modal} onClick={() => setShowFolder(false)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>Новая папка</div>
            <input
              style={{ ...S.input, padding: '0.5rem 0.75rem' }}
              placeholder="Название папки"
              value={folderName}
              onChange={e => setFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowFolder(false); }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button style={S.btn()} onClick={() => setShowFolder(false)}>Отмена</button>
              <button style={S.btn('primary')} onClick={createFolder}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {/* Move modal */}
      {moveTarget && (
        <div style={S.modal} onClick={() => setMoveTarget(null)}>
          <div style={S.modalBox} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>Переместить / переименовать</div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>Источник: <code style={{ color: '#a78bfa' }}>{moveTarget.key}</code></div>
            <input
              style={{ ...S.input, padding: '0.5rem 0.75rem', fontSize: '0.82rem', fontFamily: 'monospace' }}
              value={moveDest}
              onChange={e => setMoveDest(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitMove(); if (e.key === 'Escape') setMoveTarget(null); }}
              autoFocus
            />
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)' }}>
              Укажите полный путь объекта в MinIO. Для папки путь должен заканчиваться на /.
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button style={S.btn()} onClick={() => setMoveTarget(null)}>Отмена</button>
              <button style={S.btn('primary')} onClick={commitMove}>Переместить</button>
            </div>
          </div>
        </div>
      )}

      {/* Thumbnail preview tooltip */}
      {hoverPreview && (
        <div style={{ position: 'fixed', top: Math.min(hoverPreview.y, window.innerHeight - 160), left: Math.min(hoverPreview.x, window.innerWidth - 260), zIndex: 9990, background: '#13131f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, overflow: 'hidden', pointerEvents: 'none', boxShadow: '0 8px 32px rgba(0,0,0,0.7)', minWidth: 60, minHeight: 40 }}>
          {isImage(hoverPreview.entry.name) ? (
            <img src={hoverPreview.entry.url} alt="" style={{ maxWidth: 240, maxHeight: 160, display: 'block', objectFit: 'contain' }} />
          ) : (
            <div style={{ position: 'relative' }}>
              <video
                src={hoverPreview.entry.url}
                muted
                preload="metadata"
                onLoadedMetadata={e => { e.target.currentTime = 1; }}
                onProgress={e => {
                  const v = e.target;
                  if (bufferBarRef.current && v.duration > 0 && v.buffered.length > 0) {
                    const pct = (v.buffered.end(v.buffered.length - 1) / v.duration) * 100;
                    bufferBarRef.current.style.width = pct.toFixed(1) + '%';
                  }
                }}
                style={{ maxWidth: 240, height: 135, display: 'block', background: '#000' }}
              />
              {/* Buffer progress bar */}
              <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', position: 'relative' }}>
                <div ref={bufferBarRef} style={{ height: '100%', width: '0%', background: 'rgba(124,111,247,0.7)', transition: 'width 0.3s' }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && <div style={S.toast(toast.type)}>{toast.msg}</div>}
    </div>
  );
}
