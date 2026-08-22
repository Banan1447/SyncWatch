import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

const API = '/api/v1';

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

function truncate(str, n = 60) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

const STATUS_LABEL = { pending: 'Ожидание', downloading: 'Загрузка', done: 'Готово', error: 'Ошибка' };
const STATUS_COLOR = { pending: '#94a3b8', downloading: '#7c6ff7', done: '#4ade80', error: '#f87171' };

const S = {
  page: { minHeight: '100dvh', background: '#09090f', color: '#e2e8f0', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  header: { background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0.6rem 1.2rem', display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 },
  logo: { fontWeight: 800, fontSize: '1rem', background: 'linear-gradient(135deg,#7c6ff7,#ff6b9d)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', cursor: 'pointer', flexShrink: 0 },
  title: { fontWeight: 700, fontSize: '1rem', color: '#e2e8f0' },
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
  input: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', padding: '0.35rem 0.65rem', fontSize: '0.78rem', outline: 'none', fontFamily: 'inherit', flex: 1, minWidth: '240px' },
  content: { flex: 1, overflow: 'auto', padding: '0.5rem 1.2rem 1.5rem' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', fontWeight: 600, padding: '0.4rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.07)', userSelect: 'none', letterSpacing: '0.04em', textTransform: 'uppercase' },
  td: { padding: '0.45rem 0.6rem', fontSize: '0.82rem', verticalAlign: 'middle' },
  progressBar: (pct, color) => ({
    height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginTop: '3px',
  }),
  progressFill: (pct, color) => ({
    height: '100%', width: pct + '%', background: color, borderRadius: '2px', transition: 'width .4s',
  }),
  statusBadge: (status) => ({
    display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600,
    color: STATUS_COLOR[status] || '#94a3b8', background: (STATUS_COLOR[status] || '#94a3b8') + '18',
    border: `1px solid ${(STATUS_COLOR[status] || '#94a3b8')}30`,
    borderRadius: '12px', padding: '0.12rem 0.5rem',
  }),
  toast: { position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#1e1b2e', border: '1px solid rgba(124,111,247,0.35)', borderRadius: '10px', padding: '0.6rem 1.1rem', color: '#fff', fontSize: '0.82rem', fontWeight: 500, pointerEvents: 'none', whiteSpace: 'nowrap' },
};

export default function CacheManager() {
  const navigate = useNavigate();
  const { token } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addTitle, setAddTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const authHeaders = useCallback(() => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }), [token]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const fetchJobs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/cache`, { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      setJobs(data.jobs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [authHeaders]);

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 3000);
    return () => clearInterval(t);
  }, [fetchJobs]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!addUrl.trim()) return;
    setAdding(true);
    try {
      const r = await fetch(`${API}/cache`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ url: addUrl.trim(), title: addTitle.trim() || undefined }),
      });
      if (!r.ok) { showToast('Ошибка запуска кеширования'); return; }
      showToast('Кеширование запущено');
      setAddUrl('');
      setAddTitle('');
      fetchJobs();
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить кеш и файл?')) return;
    const r = await fetch(`${API}/cache?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (r.ok) { showToast('Удалено'); fetchJobs(); }
    else showToast('Ошибка удаления');
  };

  const handleDeleteAll = async () => {
    const done = jobs.filter(j => j.status === 'done' || j.status === 'error');
    if (!done.length) return;
    if (!confirm(`Удалить ${done.length} завершённых/ошибочных записей?`)) return;
    await Promise.all(done.map(j => fetch(`${API}/cache?id=${encodeURIComponent(j.id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })));
    showToast(`Удалено ${done.length}`);
    fetchJobs();
  };

  const handleDeleteEverything = async () => {
    if (!jobs.length) return;
    if (!confirm(`Удалить ВСЕ ${jobs.length} записей (включая активные)?`)) return;
    await Promise.all(jobs.map(j => fetch(`${API}/cache?id=${encodeURIComponent(j.id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })));
    showToast(`Удалено всё (${jobs.length})`);
    fetchJobs();
  };

  const handlePlayInRoom = (job, roomId) => {
    if (!roomId || !job.cached_url) return;
    navigate(`/room/${roomId}?cached=${encodeURIComponent(job.cached_url)}`);
  };

  const filtered = jobs.filter(j => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (j.title || '').toLowerCase().includes(q) || (j.url || '').toLowerCase().includes(q);
  });

  const roomId = new URLSearchParams(window.location.search).get('room');

  const activeCount = jobs.filter(j => j.status === 'downloading' || j.status === 'pending').length;
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const errorCount = jobs.filter(j => j.status === 'error').length;

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <span style={S.logo} onClick={() => navigate('/')}>WatchSync</span>
        <span style={{ color: 'rgba(255,255,255,0.2)' }}>›</span>
        <span style={S.title}>💾 Кеш видео</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {activeCount > 0 && <span style={{ fontSize: '0.75rem', color: '#7c6ff7', fontWeight: 600 }}>{activeCount} активных</span>}
          <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)' }}>
            {doneCount} готово · {errorCount} ошибок
          </span>
          {roomId && (
            <button style={S.btn()} onClick={() => navigate(`/room/${roomId}`)}>← В комнату</button>
          )}
        </span>
      </div>

      {/* Add URL form */}
      <form onSubmit={handleAdd} style={{ ...S.toolbar, gap: '0.5rem' }}>
        <input
          style={S.input}
          type="url"
          placeholder="URL видео (YouTube, HLS, прямая ссылка...)"
          value={addUrl}
          onChange={e => setAddUrl(e.target.value)}
        />
        <input
          style={{ ...S.input, minWidth: '160px', flex: 0 }}
          type="text"
          placeholder="Название (опционально)"
          value={addTitle}
          onChange={e => setAddTitle(e.target.value)}
        />
        <button type="submit" style={S.btn('primary')} disabled={adding || !addUrl.trim()}>
          {adding ? '…' : '💾 Кешировать'}
        </button>
      </form>

      {/* Toolbar */}
      <div style={S.toolbar}>
        <input
          style={{ ...S.input, minWidth: '180px', flex: 0 }}
          type="text"
          placeholder="Поиск..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <span style={{ flex: 1 }} />
        <button style={S.btn()} onClick={fetchJobs}>↻ Обновить</button>
        {(doneCount > 0 || errorCount > 0) && (
          <button style={S.btn('danger')} onClick={handleDeleteAll}>🗑 Очистить завершённые</button>
        )}
        {jobs.length > 0 && (
          <button style={{ ...S.btn('danger'), background: 'rgba(239,68,68,0.25)' }} onClick={handleDeleteEverything}>🗑 Удалить всё</button>
        )}
      </div>

      {/* Table */}
      <div style={S.content}>
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.3)', padding: '2rem', textAlign: 'center' }}>Загрузка…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.25)', padding: '3rem', textAlign: 'center', fontSize: '0.88rem' }}>
            {jobs.length === 0 ? 'Нет кешированных видео. Добавьте URL выше.' : 'Нет результатов по запросу.'}
          </div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Видео</th>
                <th style={S.th}>Статус</th>
                <th style={S.th}>Прогресс</th>
                <th style={S.th}>Создано</th>
                <th style={S.th}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(job => (
                <tr key={job.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={S.td}>
                    <div style={{ fontWeight: 500, fontSize: '0.83rem', color: '#e2e8f0' }}>
                      {job.title || truncate(job.url, 50) || job.id}
                    </div>
                    {job.title && (
                      <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>
                        {truncate(job.url, 55)}
                      </div>
                    )}
                    {job.error && (
                      <div style={{ fontSize: '0.7rem', color: '#f87171', marginTop: '2px' }}>
                        {truncate(job.error, 80)}
                      </div>
                    )}
                  </td>
                  <td style={S.td}>
                    <span style={S.statusBadge(job.status)}>
                      {job.status === 'downloading' && '⬇ '}
                      {job.status === 'done' && '✓ '}
                      {job.status === 'error' && '✗ '}
                      {STATUS_LABEL[job.status] || job.status}
                    </span>
                  </td>
                  <td style={{ ...S.td, minWidth: '120px' }}>
                    {(job.status === 'downloading' || job.status === 'done') && (
                      <div>
                        <span style={{ fontSize: '0.75rem', color: STATUS_COLOR[job.status] }}>{job.progress ?? 0}%</span>
                        <div style={S.progressBar()}>
                          <div style={S.progressFill(job.progress ?? 0, STATUS_COLOR[job.status])} />
                        </div>
                      </div>
                    )}
                    {job.status === 'pending' && <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>В очереди</span>}
                    {job.status === 'error' && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>—</span>}
                  </td>
                  <td style={{ ...S.td, color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem' }}>
                    {formatDate(job.created_at)}
                  </td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      {job.status === 'done' && job.cached_url && roomId && (
                        <button
                          style={S.btn('primary')}
                          onClick={() => handlePlayInRoom(job, roomId)}
                          title="Воспроизвести в комнате"
                        >▶ Играть</button>
                      )}
                      {job.status === 'done' && job.cached_url && (
                        <a
                          href={job.cached_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ ...S.btn(), textDecoration: 'none' }}
                          title="Открыть файл"
                        >🔗 Открыть</a>
                      )}
                      {job.status === 'error' && (
                        <button
                          style={S.btn()}
                          onClick={async () => {
                            await fetch(`${API}/cache`, {
                              method: 'POST',
                              headers: authHeaders(),
                              body: JSON.stringify({ url: job.url, title: job.title }),
                            });
                            fetchJobs();
                          }}
                          title="Повторить"
                        >↺ Повтор</button>
                      )}
                      <button
                        style={S.btn('danger')}
                        onClick={() => handleDelete(job.id)}
                        title="Удалить"
                      >🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}
