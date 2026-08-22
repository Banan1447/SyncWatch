import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

const API = '/api/v1';

const TABS = ['dashboard', 'rooms', 'users', 'services', 'docker', 'logs', 'templates', 'proxy', 'groups'];
const TAB_LABELS = {
  dashboard: 'Обзор',
  rooms: 'Комнаты',
  users: 'Пользователи',
  services: 'Сервисы',
  docker: 'Контейнеры',
  logs: 'Логи',
  templates: '⚙ Шаблоны',
  proxy: '🛡 Прокси',
  groups: '👥 Группы',
};

const SERVICES = [
  { name: 'Auth',       path: '/api/health/auth',       port: 8081 },
  { name: 'User',       path: '/api/health/user',       port: 8082 },
  { name: 'Room',       path: '/api/health/room',       port: 8083 },
  { name: 'Video',      path: '/api/health/video',      port: 8084 },
  { name: 'WS Gateway', path: '/api/health/ws',         port: 8085 },
  { name: 'Sync',       path: '/api/health/sync',       port: 8086 },
  { name: 'Chat',       path: '/api/health/chat',       port: 8087 },
  { name: 'Kong',       path: '/api/health/kong',       port: 8000 },
  { name: 'Grafana',    path: '/api/health/grafana',    port: 3001, link: 'http://localhost:3001' },
  { name: 'Prometheus', path: '/api/health/prometheus', port: 9090, link: 'http://localhost:9090' },
  { name: 'Jaeger',     path: '/api/health/jaeger',     port: 16686, link: 'http://localhost:16686' },
  { name: 'MinIO',      path: '/api/health/minio',      port: 9001, link: 'http://localhost:9001' },
];

// Custom interval hook (Dan Abramov pattern)
function useInterval(callback, delay) {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

// Shared button style factory
const mkBtn = (color, bg) => ({
  background: bg || `${color}18`,
  border: `1px solid ${color}44`,
  borderRadius: '6px',
  padding: '0.28rem 0.65rem',
  color,
  cursor: 'pointer',
  fontSize: '0.75rem',
  fontWeight: 500,
  transition: 'opacity .15s',
  whiteSpace: 'nowrap',
});

const card = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '10px',
};

export default function Admin() {
  const navigate = useNavigate();
  const { user, token } = useAuth();

  // ── Tab
  const [activeTab, setActiveTab] = useState('dashboard');

  // ── Data
  const [rooms, setRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [serviceStatus, setServiceStatus] = useState({});

  // ── Feedback
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [actionLoading, setActionLoading] = useState(null);

  // ── Docker
  const [containers, setContainers] = useState([]);
  const [dockerError, setDockerError] = useState('');
  const [containerFilter, setContainerFilter] = useState('all');
  const [containerAutoRefresh, setContainerAutoRefresh] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // ── Broadcast
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastSent, setBroadcastSent] = useState(false);

  // ── NATS stats
  const [natsStats, setNatsStats] = useState(null);
  const [natsError, setNatsError] = useState('');

  // ── Redis stats
  const [redisStats, setRedisStats] = useState(null);
  const [redisError, setRedisError] = useState('');
  const [redisFlushLoading, setRedisFlushLoading] = useState(false);

  // ── ScyllaDB stats
  const [scyllaStats, setScyllaStats] = useState(null);
  const [scyllaError, setScyllaError] = useState('');

  // ── Users management
  const [userSearch, setUserSearch] = useState('');
  const [userModal, setUserModal] = useState(null); // null | 'create' | 'resetpw' | 'edit'
  const [userModalTarget, setUserModalTarget] = useState(null);
  const [userForm, setUserForm] = useState({ username: '', email: '', password: '', role: 'free' });
  const [userFormError, setUserFormError] = useState('');
  const [userFormLoading, setUserFormLoading] = useState(false);

  // ── Logs
  const [selectedContainer, setSelectedContainer] = useState('');
  const [logLines, setLogLines] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logTail, setLogTail] = useState(200);
  const [logFilter, setLogFilter] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logAutoRefresh, setLogAutoRefresh] = useState(false);
  const [collectingAll, setCollectingAll] = useState(false);

  const logsEndRef = useRef(null);
  const mountedRef = useRef(true);

  const isAdmin = user?.is_admin || user?.subscription_tier === 'admin';

  const authHeader = useCallback(() => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }), [token]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!user || !isAdmin) navigate('/');
  }, [user, isAdmin, navigate]);

  // ── Fetch functions

  const fetchRooms = useCallback(async () => {
    try {
      const res = await fetch(`${API}/rooms`, { headers: authHeader() });
      if (res.ok && mountedRef.current) setRooms(await res.json() || []);
    } catch { /* ignore */ }
  }, [authHeader]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API}/auth/users`, { headers: authHeader() });
      if (res.ok && mountedRef.current) setUsers(await res.json() || []);
    } catch { /* ignore */ }
  }, [authHeader]);

  const checkServices = useCallback(async () => {
    const results = await Promise.allSettled(
      SERVICES.map(async (svc) => {
        try {
          const res = await fetch(svc.path, { signal: AbortSignal.timeout(3000) });
          return { name: svc.name, ok: res.status < 500 };
        } catch {
          return { name: svc.name, ok: false };
        }
      })
    );
    if (!mountedRef.current) return;
    const s = {};
    results.forEach(r => { if (r.status === 'fulfilled') s[r.value.name] = r.value.ok; });
    setServiceStatus(s);
  }, []);

  const fetchNatsStats = useCallback(async () => {
    try {
      const res = await fetch('/api/infra/nats/varz', { signal: AbortSignal.timeout(4000) });
      if (res.ok && mountedRef.current) {
        setNatsStats(await res.json());
        setNatsError('');
      } else if (mountedRef.current) {
        setNatsError(res.status >= 502 ? 'Сервис не запущен (контейнер watchsync-nats остановлен)' : `Ошибка ${res.status}`);
      }
    } catch (e) {
      if (mountedRef.current) setNatsError(e.name === 'TimeoutError' ? 'Таймаут — NATS не отвечает' : 'Нет соединения с NATS');
    }
  }, []);

  const fetchRedisStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/auth/admin/redis/info`, { headers: authHeader(), signal: AbortSignal.timeout(4000) });
      if (res.ok && mountedRef.current) {
        setRedisStats(await res.json());
        setRedisError('');
      } else if (mountedRef.current) {
        setRedisError(res.status >= 502 ? 'Сервис не запущен (контейнер watchsync-redis остановлен)' : res.status === 401 ? 'Нет авторизации' : `Ошибка ${res.status}`);
      }
    } catch (e) {
      if (mountedRef.current) setRedisError(e.name === 'TimeoutError' ? 'Таймаут — Redis не отвечает' : 'Нет соединения с Redis');
    }
  }, [authHeader]);

  const flushRedis = useCallback(async (db) => {
    if (!confirm(db === 'all' ? 'Очистить ВСЕ базы Redis? Это удалит все сессии и кеш!' : 'Очистить текущую базу Redis?')) return;
    setRedisFlushLoading(true);
    try {
      const res = await fetch(`${API}/auth/admin/redis/flush`, {
        method: 'POST', headers: authHeader(), body: JSON.stringify({ db }),
      });
      if (res.ok) { setSuccess('Redis очищен'); fetchRedisStats(); }
      else setError('Ошибка очистки Redis');
    } catch { setError('Ошибка сети'); }
    setRedisFlushLoading(false);
  }, [authHeader, fetchRedisStats]);

  const fetchScyllaStats = useCallback(async () => {
    try {
      const res = await fetch('/api/infra/scylla/storage_service/keyspaces', { signal: AbortSignal.timeout(4000) });
      if (res.ok && mountedRef.current) {
        const keyspaces = await res.json();
        setScyllaStats({ keyspaces });
        setScyllaError('');
      } else if (mountedRef.current) {
        setScyllaError(res.status >= 502 ? 'Сервис не запущен (контейнер watchsync-scylla остановлен)' : `Ошибка ${res.status}`);
      }
    } catch (e) {
      if (mountedRef.current) setScyllaError(e.name === 'TimeoutError' ? 'Таймаут — ScyllaDB не отвечает' : 'Нет соединения с ScyllaDB');
    }
  }, []);

  const fetchContainers = useCallback(async () => {
    setDockerError('');
    try {
      const res = await fetch(`${API}/auth/admin/docker/containers`, { headers: authHeader() });
      if (res.ok && mountedRef.current) {
        setContainers(await res.json() || []);
        setLastRefreshed(new Date());
      } else {
        let msg;
        if (res.status === 404) {
          msg = 'Эндпоинт не найден — пересоберите auth-service:\ndocker compose build auth-service && docker compose up -d auth-service';
        } else if (res.status === 503) {
          msg = 'Docker socket недоступен внутри контейнера. Проверьте volume mount /var/run/docker.sock в docker-compose.yml для auth-service и пересоберите сервис.';
        } else if (res.status === 403) {
          msg = 'Доступ запрещён — требуются права администратора.';
        } else {
          const d = await res.json().catch(() => ({}));
          msg = d.message || `HTTP ${res.status}`;
        }
        if (mountedRef.current) setDockerError(msg);
      }
    } catch (e) {
      if (mountedRef.current) setDockerError(`Ошибка сети: ${e.message}`);
    }
  }, [authHeader]);

  const fetchLogs = useCallback(async (name, tail) => {
    if (!name) return;
    setLogsLoading(true);
    try {
      const res = await fetch(
        `${API}/auth/admin/docker/containers/${encodeURIComponent(name)}/logs?tail=${tail ?? 200}`,
        { headers: authHeader() }
      );
      if (res.ok && mountedRef.current) {
        const data = await res.json();
        setLogLines(data.lines || []);
        setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
      } else {
        const d = await res.json().catch(() => ({}));
        if (mountedRef.current) setError(d.message || 'Ошибка загрузки логов');
      }
    } catch (e) {
      if (mountedRef.current) setError(`Ошибка сети: ${e.message}`);
    }
    if (mountedRef.current) setLogsLoading(false);
  }, [authHeader]);

  const downloadLogs = useCallback((filename, lines) => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }, []);

  const collectAllLogs = useCallback(async () => {
    if (!containers.length) return;
    setCollectingAll(true);
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const parts = [`=== WatchSync Log Bundle — ${ts} ===\n`];
    for (const c of containers) {
      try {
        const res = await fetch(
          `${API}/auth/admin/docker/containers/${encodeURIComponent(c.name)}/logs?tail=500`,
          { headers: authHeader() }
        );
        if (res.ok) {
          const data = await res.json();
          parts.push(`\n${'='.repeat(60)}\n CONTAINER: ${c.name} (${c.state})\n${'='.repeat(60)}`);
          parts.push((data.lines || []).join('\n'));
        }
      } catch { /* skip */ }
    }
    downloadLogs(`watchsync-logs-${ts}.txt`, parts);
    setCollectingAll(false);
    setSuccess(`Логи ${containers.length} контейнеров скачаны`);
  }, [containers, authHeader, downloadLogs]);

  // ── Intervals
  useInterval(fetchContainers, containerAutoRefresh ? 15000 : null);
  useInterval(
    () => { if (selectedContainer) fetchLogs(selectedContainer, logTail); },
    logAutoRefresh && selectedContainer ? 10000 : null
  );

  // ── Initial load
  useEffect(() => {
    if (!user || !isAdmin) return;
    fetchRooms();
    fetchUsers();
    checkServices();
    fetchContainers();
    fetchNatsStats();
    fetchRedisStats();
    fetchScyllaStats();
  }, [user, isAdmin, fetchRooms, fetchUsers, checkServices, fetchContainers, fetchNatsStats, fetchRedisStats, fetchScyllaStats]);

  // ── Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Actions

  const deleteRoom = useCallback(async (id) => {
    if (!confirm('Удалить эту комнату?')) return;
    setActionLoading(`room-${id}`);
    try {
      const res = await fetch(`${API}/rooms/${id}`, { method: 'DELETE', headers: authHeader() });
      if (res.ok) { setRooms(r => r.filter(x => x.id !== id)); setSuccess('Комната удалена'); }
      else setError('Ошибка удаления комнаты');
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
  }, [authHeader]);

  const deleteUser = useCallback(async (id, username) => {
    if (!confirm(`Удалить пользователя «${username}»?`)) return;
    setActionLoading(`user-del-${id}`);
    try {
      const res = await fetch(`${API}/auth/users/${id}`, { method: 'DELETE', headers: authHeader() });
      if (res.ok) { setUsers(u => u.filter(x => x.id !== id)); setSuccess('Пользователь удалён'); }
      else { const e = await res.json(); setError(e.message || 'Ошибка удаления'); }
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
  }, [authHeader]);

  const toggleRole = useCallback(async (id, tier) => {
    const newRole = tier === 'admin' ? 'free' : 'admin';
    const label = newRole === 'admin' ? 'Повысить до администратора' : 'Понизить до обычного пользователя';
    if (!confirm(`${label}?`)) return;
    setActionLoading(`user-role-${id}`);
    try {
      const res = await fetch(`${API}/auth/users/${id}`, {
        method: 'PATCH', headers: authHeader(), body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        setUsers(us => us.map(u => u.id === id ? { ...u, subscription_tier: newRole } : u));
        setSuccess(`Роль изменена на ${newRole}`);
      } else { const e = await res.json(); setError(e.message || 'Ошибка'); }
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
  }, [authHeader]);

  const createUser = useCallback(async () => {
    setUserFormError('');
    if (!userForm.username.trim() || !userForm.password.trim()) { setUserFormError('Логин и пароль обязательны'); return; }
    setUserFormLoading(true);
    try {
      const res = await fetch(`${API}/auth/users`, {
        method: 'POST', headers: authHeader(),
        body: JSON.stringify({ username: userForm.username.trim(), password: userForm.password, email: userForm.email, role: userForm.role }),
      });
      if (res.ok) {
        setSuccess('Пользователь создан');
        setUserModal(null);
        setUserForm({ username: '', email: '', password: '', role: 'free' });
        fetchUsers();
      } else { const e = await res.json(); setUserFormError(e.message || 'Ошибка'); }
    } catch { setUserFormError('Ошибка сети'); }
    setUserFormLoading(false);
  }, [authHeader, userForm, fetchUsers]);

  const resetPassword = useCallback(async () => {
    setUserFormError('');
    if (!userForm.password.trim()) { setUserFormError('Введите новый пароль'); return; }
    setUserFormLoading(true);
    try {
      const res = await fetch(`${API}/auth/users/${userModalTarget.id}/password`, {
        method: 'PATCH', headers: authHeader(),
        body: JSON.stringify({ password: userForm.password }),
      });
      if (res.ok) { setSuccess(`Пароль изменён для ${userModalTarget.username}`); setUserModal(null); setUserForm({ username: '', email: '', password: '', role: 'free' }); }
      else { const e = await res.json(); setUserFormError(e.message || 'Ошибка'); }
    } catch { setUserFormError('Ошибка сети'); }
    setUserFormLoading(false);
  }, [authHeader, userForm.password, userModalTarget]);

  const toggleBan = useCallback(async (u) => {
    const banning = !u.is_banned;
    if (!confirm(`${banning ? 'Заблокировать' : 'Разблокировать'} пользователя «${u.username}»?`)) return;
    setActionLoading(`user-ban-${u.id}`);
    try {
      const res = await fetch(`${API}/auth/users/${u.id}`, {
        method: 'PATCH', headers: authHeader(),
        body: JSON.stringify({ banned: banning }),
      });
      if (res.ok) {
        setUsers(us => us.map(x => x.id === u.id ? { ...x, is_banned: banning } : x));
        setSuccess(banning ? `${u.username} заблокирован` : `${u.username} разблокирован`);
      } else { const e = await res.json(); setError(e.message || 'Ошибка'); }
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
  }, [authHeader]);

  const openResetPw = useCallback((u) => {
    setUserModalTarget(u);
    setUserForm({ username: '', email: '', password: '', role: 'free' });
    setUserFormError('');
    setUserModal('resetpw');
  }, []);

  const adminTOTP = useCallback(async (u, action) => {
    const label = action === 'require'
      ? `Требовать настройку 2FA для «${u.username}»? Его текущая 2FA будет сброшена, и при следующем входе он обязан её настроить.`
      : `Отключить 2FA для «${u.username}»?`;
    if (!confirm(label)) return;
    setActionLoading(`user-totp-${action}-${u.id}`);
    try {
      const res = await fetch(`${API}/auth/users/${u.id}/totp/${action}`, {
        method: 'POST', headers: authHeader(),
      });
      if (res.ok) {
        const d = await res.json();
        setUsers(us => us.map(x => x.id === u.id ? { ...x, totp_enabled: !!d.totp_enabled, totp_required: !!d.totp_required } : x));
        setSuccess(action === 'require' ? `Для ${u.username} включено требование 2FA` : `2FA для ${u.username} отключена`);
      } else { const e = await res.json(); setError(e.message || 'Ошибка'); }
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
  }, [authHeader]);

  const dockerAction = useCallback(async (name, action) => {
    const labels = { start: 'Запустить', stop: 'Остановить', restart: 'Перезапустить' };
    if ((action === 'stop' || action === 'restart') && !confirm(`${labels[action]} контейнер «${name}»?`)) return;
    setActionLoading(`docker-${name}-${action}`);
    try {
      const res = await fetch(
        `${API}/auth/admin/docker/containers/${encodeURIComponent(name)}/${action}`,
        { method: 'POST', headers: authHeader() }
      );
      if (res.ok) setSuccess(`«${name}» — ${labels[action].toLowerCase()} выполнено`);
      else { const e = await res.json().catch(() => ({})); setError(e.message || `Ошибка ${action}`); }
    } catch { setError('Ошибка сети'); }
    setActionLoading(null);
    setTimeout(fetchContainers, 1500);
  }, [authHeader, fetchContainers]);

  // ── Derived
  const roomType = r => r.room_type || (r.settings?.password ? 2 : r.settings?.is_public === false ? 3 : 1);
  const rtLabel = t => ({ 1: 'Публичная', 2: 'Пароль', 3: 'Приватная' }[t] || 'Публичная');
  const rtColor = t => ({ 1: '#4ade80', 2: '#fbbf24', 3: '#f87171' }[t] || '#4ade80');

  const totalMembers = rooms.reduce((s, r) => s + (r.member_count || 0), 0);
  const onlineCount  = Object.values(serviceStatus).filter(Boolean).length;
  const runningCount = containers.filter(c => c.state === 'running').length;

  const visibleContainers = containers.filter(c =>
    containerFilter === 'running' ? c.state === 'running' :
    containerFilter === 'stopped' ? c.state !== 'running' : true
  );

  const visibleLogs = logLines.filter(line => {
    if (logFilter === 'error' && !/\b(error|fatal|panic)\b/i.test(line)) return false;
    if (logFilter === 'warn'  && !/\b(warn|warning|error|fatal|panic)\b/i.test(line)) return false;
    if (logSearch && !line.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });

  if (!user || !isAdmin) return null;

  return (
    <div style={{ minHeight: '100dvh', padding: '1.5rem 2rem', maxWidth: '1100px', margin: '0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{
            fontSize: '1.5rem', fontWeight: 700, margin: 0,
            background: 'linear-gradient(135deg, #7c6ff7, #ff6b9d)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>Панель администратора</h1>
          <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: '0.78rem', marginTop: '0.2rem' }}>WatchSync Platform</p>
        </div>
        <button onClick={() => navigate('/')} style={mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)')}>
          ← На главную
        </button>
      </div>

      {/* ── Notifications ── */}
      {error && (
        <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '8px', padding: '0.65rem 1rem', marginBottom: '1rem', color: '#f87171', fontSize: '0.83rem', display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
          <span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
          <button onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
      )}
      {success && (
        <div style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '8px', padding: '0.65rem 1rem', marginBottom: '1rem', color: '#4ade80', fontSize: '0.83rem' }}>
          ✓ {success}
        </div>
      )}

      {/* ── Stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.6rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Комнаты',      value: rooms.length,                          color: '#7c6ff7', tab: 'rooms' },
          { label: 'Пользователи', value: users.length,                          color: '#a78bfa', tab: 'users' },
          { label: 'Смотрят',      value: totalMembers,                          color: '#ff6b9d', tab: null },
          {
            label: 'Контейнеры',
            value: containers.length === 0 ? '—' : `${runningCount}/${containers.length}`,
            color: containers.length === 0 ? '#6b7280' : runningCount === containers.length ? '#4ade80' : runningCount > 0 ? '#fbbf24' : '#f87171',
            tab: 'docker',
          },
          {
            label: 'Сервисы',
            value: Object.keys(serviceStatus).length === 0 ? '—' : `${onlineCount}/${SERVICES.length}`,
            color: onlineCount === SERVICES.length ? '#4ade80' : onlineCount > 0 ? '#fbbf24' : '#f87171',
            tab: 'services',
          },
        ].map(({ label, value, color, tab }) => (
          <div
            key={label}
            onClick={() => tab && setActiveTab(tab)}
            style={{ ...card, padding: '0.85rem 1rem', textAlign: 'center', cursor: tab ? 'pointer' : 'default' }}
          >
            <div style={{ fontSize: '1.35rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.32)', marginTop: '0.2rem' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '1.5rem' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '0.55rem 1.05rem', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: '0.84rem', fontWeight: 500, marginBottom: '-1px',
            color: activeTab === tab ? '#7c6ff7' : 'rgba(255,255,255,0.38)',
            borderBottom: activeTab === tab ? '2px solid #7c6ff7' : '2px solid transparent',
          }}>
            {TAB_LABELS[tab]}
          </button>
        ))}
        <a href="/files" target="_blank" style={{
          padding: '0.55rem 1.05rem', border: 'none', background: 'none', cursor: 'pointer',
          fontSize: '0.84rem', fontWeight: 500, marginBottom: '-1px', marginLeft: 'auto',
          color: 'rgba(255,255,255,0.38)', borderBottom: '2px solid transparent',
          textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.3rem',
        }}>
          📁 Файловый менеджер ↗
        </a>
      </div>

      {/* ════════════════════════════════════════
          DASHBOARD
      ════════════════════════════════════════ */}
      {activeTab === 'dashboard' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>Статус сервисов</h2>
            <button onClick={() => { fetchRooms(); fetchUsers(); checkServices(); fetchContainers(); }}
              style={mkBtn('#7c6ff7')}>
              Обновить всё
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.55rem', marginBottom: '1.5rem' }}>
            {SERVICES.map(svc => {
              const checked = svc.name in serviceStatus;
              const online = serviceStatus[svc.name];
              const dot = !checked ? '#6b7280' : online ? '#4ade80' : '#f87171';
              return (
                <div key={svc.name} style={{ ...card, padding: '0.65rem 0.85rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot, boxShadow: online ? `0 0 5px ${dot}` : 'none', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e2e8f0', fontSize: '0.8rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svc.name}</div>
                    <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '0.68rem' }}>:{svc.port}</div>
                  </div>
                  {svc.link && (
                    <a href={svc.link} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#7c6ff7', fontSize: '0.7rem', textDecoration: 'none', opacity: online ? 1 : 0.35 }}
                      title="Открыть в новой вкладке">↗</a>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
            {[
              { label: 'Управление контейнерами', desc: 'Start / Stop / Restart', tab: 'docker', color: '#4ade80' },
              { label: 'Просмотр логов', desc: 'По контейнеру, с фильтрацией', tab: 'logs', color: '#ff6b9d' },
              { label: 'Управление комнатами', desc: `${rooms.length} комнат, ${totalMembers} онлайн`, tab: 'rooms', color: '#7c6ff7' },
              { label: 'Управление пользователями', desc: `${users.length} пользователей`, tab: 'users', color: '#a78bfa' },
            ].map(({ label, desc, tab, color }) => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                ...card, padding: '1rem 1.25rem', textAlign: 'left', cursor: 'pointer',
                border: `1px solid ${color}22`, display: 'block', width: '100%',
              }}>
                <div style={{ color, fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.2rem' }}>{label} →</div>
                <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem' }}>{desc}</div>
              </button>
            ))}
          </div>

          {/* Push broadcast form */}
          <div style={{ ...card, padding: '1.25rem', marginTop: '1rem' }}>
            <h3 style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 600, fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
              Push-уведомление всем подписчикам
            </h3>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!broadcastMsg.trim()) return;
              try {
                const res = await fetch(`${API}/auth/admin/broadcast`, {
                  method: 'POST',
                  headers: authHeader(),
                  body: JSON.stringify({ title: broadcastTitle || 'WatchSync', message: broadcastMsg }),
                });
                if (res.ok) {
                  setBroadcastSent(true);
                  setBroadcastTitle('');
                  setBroadcastMsg('');
                  setTimeout(() => setBroadcastSent(false), 3000);
                }
              } catch { /* ignore */ }
            }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <input
                value={broadcastTitle}
                onChange={e => setBroadcastTitle(e.target.value)}
                placeholder="Заголовок (необязательно)"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#e2e8f0', fontSize: '0.82rem' }}
              />
              <input
                value={broadcastMsg}
                onChange={e => setBroadcastMsg(e.target.value)}
                placeholder="Текст сообщения..."
                required
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#e2e8f0', fontSize: '0.82rem' }}
              />
              <button type="submit" style={mkBtn('#ff6b9d')}>
                {broadcastSent ? '✓ Отправлено' : 'Разослать'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          ROOMS
      ════════════════════════════════════════ */}
      {activeTab === 'rooms' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>Комнаты ({rooms.length})</h2>
            <button onClick={fetchRooms} style={mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)')}>Обновить</button>
          </div>
          <div style={{ ...card, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Название', 'Тип', 'Онлайн', 'Создана', ''].map(h => (
                    <th key={h} style={{ padding: '0.6rem 1rem', textAlign: 'left', color: 'rgba(255,255,255,0.32)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rooms.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(255,255,255,0.18)' }}>Нет комнат</td></tr>
                )}
                {rooms.map(r => {
                  const rt = roomType(r);
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '0.6rem 1rem', color: '#e2e8f0', fontWeight: 500 }}>{r.name}</td>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <span style={{ fontSize: '0.68rem', padding: '0.15rem 0.45rem', borderRadius: '4px', background: `${rtColor(rt)}1a`, color: rtColor(rt), border: `1px solid ${rtColor(rt)}33` }}>
                          {rtLabel(rt)}
                        </span>
                      </td>
                      <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.42)' }}>{r.member_count ?? 0}</td>
                      <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.28)', fontSize: '0.73rem' }}>
                        {r.created_at ? new Date(r.created_at).toLocaleDateString('ru-RU') : '—'}
                      </td>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <button onClick={() => deleteRoom(r.id)} disabled={actionLoading === `room-${r.id}`}
                          style={{ ...mkBtn('#f87171'), opacity: actionLoading === `room-${r.id}` ? 0.5 : 1 }}>
                          {actionLoading === `room-${r.id}` ? '...' : 'Удалить'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          USERS
      ════════════════════════════════════════ */}
      {activeTab === 'users' && (
        <div>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h2 style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>
              Пользователи ({users.length})
            </h2>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={userSearch} onChange={e => setUserSearch(e.target.value)}
                placeholder="Поиск по логину / email..."
                style={{ padding: '0.3rem 0.7rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#fff', fontSize: '0.78rem', width: '200px', outline: 'none' }}
              />
              <button onClick={fetchUsers} style={mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)')}>Обновить</button>
              <button onClick={() => { setUserForm({ username: '', email: '', password: '', role: 'free' }); setUserFormError(''); setUserModal('create'); }}
                style={mkBtn('#4ade80')}>+ Создать</button>
            </div>
          </div>

          {/* Table */}
          <div style={{ ...card, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Логин', 'Email', 'Роль', '2FA', 'Статус', 'Регистрация', 'Последний вход', ''].map(h => (
                    <th key={h} style={{ padding: '0.6rem 1rem', textAlign: 'left', color: 'rgba(255,255,255,0.32)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const q = userSearch.toLowerCase();
                  const filtered = users.filter(u => !q || u.username?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
                  if (filtered.length === 0)
                    return <tr><td colSpan={8} style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(255,255,255,0.18)' }}>
                      {userSearch ? 'Ничего не найдено' : 'Нет пользователей'}
                    </td></tr>;
                  return filtered.map(u => {
                    const isSelf = u.id === user.id;
                    const isUA = u.subscription_tier === 'admin';
                    const isBanned = u.is_banned;
                    return (
                      <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: isBanned ? 0.5 : 1 }}>
                        <td style={{ padding: '0.6rem 1rem', color: '#e2e8f0', fontWeight: 500 }}>
                          {u.username}
                          {isSelf && <span style={{ marginLeft: '0.4rem', fontSize: '0.66rem', color: 'rgba(255,255,255,0.22)' }}>(вы)</span>}
                        </td>
                        <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.38)' }}>{u.email || '—'}</td>
                        <td style={{ padding: '0.6rem 1rem' }}>
                          <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 600,
                            background: isUA ? 'rgba(124,111,247,0.18)' : 'rgba(255,255,255,0.06)',
                            color: isUA ? '#7c6ff7' : 'rgba(255,255,255,0.32)' }}>
                            {u.subscription_tier || 'free'}
                          </span>
                        </td>
                        <td style={{ padding: '0.6rem 1rem' }}>
                          {u.totp_required ? (
                            <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 600,
                              background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>Требуется</span>
                          ) : u.totp_enabled ? (
                            <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 600,
                              background: 'rgba(74,222,128,0.12)', color: '#4ade80' }}>Включена</span>
                          ) : (
                            <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 600,
                              background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.32)' }}>Выключена</span>
                          )}
                        </td>
                        <td style={{ padding: '0.6rem 1rem' }}>
                          <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 600,
                            background: isBanned ? 'rgba(248,113,113,0.15)' : 'rgba(74,222,128,0.12)',
                            color: isBanned ? '#f87171' : '#4ade80' }}>
                            {isBanned ? 'Заблокирован' : 'Активен'}
                          </span>
                        </td>
                        <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.28)', fontSize: '0.73rem' }}>
                          {u.created_at ? new Date(u.created_at).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.28)', fontSize: '0.73rem' }}>
                          {u.last_seen ? new Date(u.last_seen).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td style={{ padding: '0.6rem 1rem' }}>
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                            <button onClick={() => adminTOTP(u, 'require')} disabled={!!actionLoading}
                              style={{ ...mkBtn('#fbbf24'), opacity: actionLoading ? 0.5 : 1 }}>
                              {actionLoading === `user-totp-require-${u.id}` ? '...' : '⚑ Требовать 2FA'}
                            </button>
                            <button onClick={() => adminTOTP(u, 'reset')} disabled={!!actionLoading}
                              style={{ ...mkBtn('#94a3b8'), opacity: actionLoading ? 0.5 : 1 }}>
                              {actionLoading === `user-totp-reset-${u.id}` ? '...' : '↺ Сбросить 2FA'}
                            </button>
                            {!isSelf && (
                              <>
                                <button onClick={() => toggleRole(u.id, u.subscription_tier)} disabled={!!actionLoading}
                                  style={{ ...mkBtn(isUA ? '#f87171' : '#7c6ff7'), opacity: actionLoading ? 0.5 : 1 }}>
                                  {actionLoading === `user-role-${u.id}` ? '...' : isUA ? '↓ Понизить' : '↑ Admin'}
                                </button>
                                <button onClick={() => openResetPw(u)} disabled={!!actionLoading}
                                  style={mkBtn('#fbbf24')}>Пароль</button>
                                <button onClick={() => toggleBan(u)} disabled={!!actionLoading}
                                  style={{ ...mkBtn(isBanned ? '#4ade80' : '#fb923c'), opacity: actionLoading ? 0.5 : 1 }}>
                                  {actionLoading === `user-ban-${u.id}` ? '...' : isBanned ? '✓ Разбан' : '⊘ Бан'}
                                </button>
                                <button onClick={() => deleteUser(u.id, u.username)} disabled={!!actionLoading}
                                  style={{ ...mkBtn('#f87171'), opacity: actionLoading ? 0.5 : 1 }}>
                                  {actionLoading === `user-del-${u.id}` ? '...' : '× Удалить'}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>

          {/* Create / Reset password modal */}
          {userModal && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
              onClick={e => { if (e.target === e.currentTarget) setUserModal(null); }}>
              <div style={{ ...card, padding: '1.75rem', width: '360px', background: '#0f0f1a' }}>
                <h3 style={{ margin: '0 0 1.25rem', fontSize: '1rem', color: '#e2e8f0' }}>
                  {userModal === 'create' ? 'Создать пользователя' : `Сброс пароля — ${userModalTarget?.username}`}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  {userModal === 'create' && <>
                    <input placeholder="Логин *" value={userForm.username} onChange={e => setUserForm(f => ({ ...f, username: e.target.value }))}
                      style={{ padding: '0.55rem 0.8rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', fontSize: '0.85rem', outline: 'none' }} />
                    <input placeholder="Email" value={userForm.email} onChange={e => setUserForm(f => ({ ...f, email: e.target.value }))}
                      style={{ padding: '0.55rem 0.8rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', fontSize: '0.85rem', outline: 'none' }} />
                    <select value={userForm.role} onChange={e => setUserForm(f => ({ ...f, role: e.target.value }))}
                      style={{ padding: '0.55rem 0.8rem', background: '#0f0f1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', fontSize: '0.85rem', outline: 'none' }}>
                      <option value="free">free</option>
                      <option value="admin">admin</option>
                    </select>
                  </>}
                  <input placeholder="Пароль *" type="password" value={userForm.password} onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))}
                    style={{ padding: '0.55rem 0.8rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', color: '#fff', fontSize: '0.85rem', outline: 'none' }} />
                  {userFormError && <div style={{ color: '#f87171', fontSize: '0.78rem' }}>{userFormError}</div>}
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <button onClick={userModal === 'create' ? createUser : resetPassword} disabled={userFormLoading}
                      style={{ ...mkBtn('#7c6ff7'), flex: 1, padding: '0.55rem', opacity: userFormLoading ? 0.6 : 1 }}>
                      {userFormLoading ? '...' : userModal === 'create' ? 'Создать' : 'Сохранить'}
                    </button>
                    <button onClick={() => setUserModal(null)}
                      style={{ ...mkBtn('rgba(255,255,255,0.4)', 'rgba(255,255,255,0.05)'), flex: 1, padding: '0.55rem' }}>
                      Отмена
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════
          SERVICES
      ════════════════════════════════════════ */}
      {activeTab === 'services' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>
              Сервисы — {onlineCount}/{SERVICES.length} online
            </h2>
            <button onClick={checkServices} style={mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)')}>Проверить</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.55rem' }}>
            {SERVICES.map(svc => {
              const checked = svc.name in serviceStatus;
              const online = serviceStatus[svc.name];
              const dot = !checked ? '#6b7280' : online ? '#4ade80' : '#f87171';
              return (
                <div key={svc.name} style={{ ...card, padding: '0.85rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: dot, boxShadow: online ? `0 0 7px ${dot}` : 'none', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#e2e8f0', fontWeight: 500, fontSize: '0.84rem' }}>{svc.name}</div>
                    <div style={{ color: 'rgba(255,255,255,0.28)', fontSize: '0.7rem' }}>
                      :{svc.port} {checked ? (online ? '— online' : '— offline') : '— не проверен'}
                    </div>
                  </div>
                  {svc.link && (
                    <a href={svc.link} target="_blank" rel="noopener noreferrer"
                      style={{ ...mkBtn('#7c6ff7'), textDecoration: 'none', opacity: online ? 1 : 0.3 }}>
                      ↗
                    </a>
                  )}
                </div>
              );
            })}
          </div>
          <p style={{ marginTop: '0.75rem', fontSize: '0.73rem', color: 'rgba(255,255,255,0.2)' }}>
            Кнопка ↗ — открыть UI сервиса (Grafana, Prometheus, Jaeger, MinIO).
          </p>

          {/* NATS stats */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>⚡ NATS JetStream</span>
              <button onClick={fetchNatsStats} style={mkBtn('rgba(255,255,255,0.4)', 'rgba(255,255,255,0.05)')}>Обновить</button>
            </div>
            {natsError ? (
              <div style={{ fontSize: '0.78rem', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '8px', padding: '0.6rem 1rem' }}>
                {natsError}
              </div>
            ) : natsStats ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.55rem' }}>
                {[
                  { label: 'Версия', value: natsStats.version },
                  { label: 'Соединения', value: natsStats.connections },
                  { label: 'Подписки', value: natsStats.subscriptions },
                  { label: 'Сообщений in', value: natsStats.in_msgs?.toLocaleString() || '—' },
                  { label: 'Сообщений out', value: natsStats.out_msgs?.toLocaleString() || '—' },
                  { label: 'Байт in', value: natsStats.in_bytes ? `${(natsStats.in_bytes / 1024 / 1024).toFixed(1)} MB` : '—' },
                  { label: 'CPU', value: natsStats.cpu ? `${natsStats.cpu.toFixed(1)}%` : '—' },
                  { label: 'Память', value: natsStats.mem ? `${(natsStats.mem / 1024 / 1024).toFixed(1)} MB` : '—' },
                ].map(({ label, value }) => (
                  <div key={label} style={{ ...card, padding: '0.6rem 0.85rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.3)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#e2e8f0' }}>{value ?? '—'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.75rem' }}>Загрузка...</div>
            )}
          </div>

          {/* Redis stats */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>🔴 Redis</span>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button onClick={fetchRedisStats} style={mkBtn('rgba(255,255,255,0.4)', 'rgba(255,255,255,0.05)')}>Обновить</button>
                <button onClick={() => flushRedis('current')} disabled={redisFlushLoading} style={mkBtn('#fbbf24')}>Flush DB</button>
                <button onClick={() => flushRedis('all')} disabled={redisFlushLoading} style={mkBtn('#f87171')}>Flush ALL</button>
              </div>
            </div>
            {redisError ? (
              <div style={{ fontSize: '0.78rem', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '8px', padding: '0.6rem 1rem' }}>
                {redisError}
              </div>
            ) : redisStats ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.55rem' }}>
                {[
                  { label: 'Версия', value: redisStats.version },
                  { label: 'Роль', value: redisStats.role },
                  { label: 'Клиентов', value: redisStats.connected_clients },
                  { label: 'Ключей', value: redisStats.dbsize?.toLocaleString() || '—' },
                  { label: 'Память', value: redisStats.used_memory_human },
                  { label: 'Пик памяти', value: redisStats.used_memory_peak },
                  { label: 'Команд', value: Number(redisStats.total_commands || 0).toLocaleString() },
                  { label: 'Hit rate', value: (() => {
                    const h = Number(redisStats.keyspace_hits || 0);
                    const m = Number(redisStats.keyspace_misses || 0);
                    return h + m > 0 ? `${((h / (h + m)) * 100).toFixed(1)}%` : '—';
                  })() },
                ].map(({ label, value }) => (
                  <div key={label} style={{ ...card, padding: '0.6rem 0.85rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.3)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#e2e8f0' }}>{value ?? '—'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.75rem' }}>Загрузка...</div>
            )}
          </div>

          {/* ScyllaDB stats */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>🔷 ScyllaDB</span>
              <button onClick={fetchScyllaStats} style={mkBtn('rgba(255,255,255,0.4)', 'rgba(255,255,255,0.05)')}>Обновить</button>
            </div>
            {scyllaError ? (
              <div style={{ fontSize: '0.78rem', color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '8px', padding: '0.6rem 1rem' }}>
                {scyllaError}
              </div>
            ) : scyllaStats ? (
              <div style={{ ...card, padding: '0.85rem 1rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.38)', marginBottom: '0.4rem' }}>Keyspaces</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  {(scyllaStats.keyspaces || []).map(ks => (
                    <span key={ks} style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: '4px', background: 'rgba(124,111,247,0.12)', color: '#a78bfa', border: '1px solid rgba(124,111,247,0.25)' }}>
                      {ks}
                    </span>
                  ))}
                  {(!scyllaStats.keyspaces || scyllaStats.keyspaces.length === 0) && (
                    <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.78rem' }}>Нет keyspace</span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.75rem' }}>Загрузка...</div>
            )}
          </div>

          {/* Embedded Grafana dashboard */}
          <div style={{ marginTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
                📊 Метрики (Grafana)
              </span>
              <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.72rem', color: '#7c6ff7', textDecoration: 'none' }}>
                Открыть в Grafana ↗
              </a>
            </div>
            <iframe
              src="http://localhost:3001/d/watchsync/watchsync?orgId=1&refresh=30s&kiosk=tv"
              style={{ width: '100%', height: 420, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', background: '#111' }}
              title="Grafana Dashboard"
              allow="fullscreen"
            />
            <p style={{ marginTop: '0.4rem', fontSize: '0.68rem', color: 'rgba(255,255,255,0.18)' }}>
              Требует анонимный доступ Grafana (GF_AUTH_ANONYMOUS_ENABLED=true) — уже включён в docker-compose.
            </p>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          DOCKER CONTAINERS
      ════════════════════════════════════════ */}
      {activeTab === 'docker' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.6rem' }}>
            <div>
              <h2 style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>
                Контейнеры — {runningCount} running / {containers.length} total
              </h2>
              {lastRefreshed && (
                <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.22)', marginTop: '0.15rem' }}>
                  Обновлено: {lastRefreshed.toLocaleTimeString('ru-RU')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {['all', 'running', 'stopped'].map(f => (
                <button key={f} onClick={() => setContainerFilter(f)} style={{
                  ...mkBtn(containerFilter === f ? '#7c6ff7' : 'rgba(255,255,255,0.3)',
                           containerFilter === f ? 'rgba(124,111,247,0.15)' : 'rgba(255,255,255,0.04)'),
                  fontSize: '0.72rem',
                }}>
                  {{ all: 'Все', running: '▶ Running', stopped: '■ Stopped' }[f]}
                </button>
              ))}
              <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)', margin: '0 0.15rem' }} />
              <button onClick={() => setContainerAutoRefresh(v => !v)} style={{
                ...mkBtn(containerAutoRefresh ? '#4ade80' : 'rgba(255,255,255,0.3)',
                         containerAutoRefresh ? 'rgba(74,222,128,0.1)' : 'rgba(255,255,255,0.04)'),
                fontSize: '0.72rem',
              }}>
                {containerAutoRefresh ? '● Auto 15s' : '○ Авто'}
              </button>
              <button onClick={fetchContainers} style={mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)')}>
                Обновить
              </button>
            </div>
          </div>

          {dockerError && (
            <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.22)', borderRadius: '8px', padding: '0.85rem 1rem', marginBottom: '1rem', color: '#fbbf24', fontSize: '0.8rem', lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>Docker недоступен</div>
              <div style={{ whiteSpace: 'pre-wrap', color: 'rgba(251,191,36,0.8)' }}>{dockerError}</div>
            </div>
          )}

          <div style={{ ...card, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Контейнер', 'Состояние', 'Подробности', 'Действия'].map(h => (
                    <th key={h} style={{ padding: '0.6rem 1rem', textAlign: 'left', color: 'rgba(255,255,255,0.32)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!dockerError && containers.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: '2.5rem', textAlign: 'center', color: 'rgba(255,255,255,0.2)' }}>
                      {lastRefreshed ? 'Нет контейнеров' : 'Загрузка...'}
                    </td>
                  </tr>
                )}
                {visibleContainers.map(c => {
                  const running = c.state === 'running';
                  const stColor = running ? '#4ade80' : c.state === 'exited' ? '#f87171' : '#fbbf24';
                  const lp = `docker-${c.name}`;
                  return (
                    <tr key={c.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <div style={{ color: '#e2e8f0', fontWeight: 500 }}>{c.name}</div>
                        <div style={{ color: 'rgba(255,255,255,0.22)', fontSize: '0.68rem', fontFamily: 'monospace' }}>{c.id}</div>
                      </td>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: stColor, boxShadow: running ? `0 0 5px ${stColor}` : 'none', flexShrink: 0 }} />
                          <span style={{ color: stColor, fontWeight: 600, fontSize: '0.78rem' }}>{c.state}</span>
                        </div>
                      </td>
                      <td style={{ padding: '0.6rem 1rem', color: 'rgba(255,255,255,0.32)', fontSize: '0.75rem' }}>{c.status}</td>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {!running && (
                            <button onClick={() => dockerAction(c.name, 'start')} disabled={!!actionLoading}
                              style={{ ...mkBtn('#4ade80'), opacity: actionLoading === `${lp}-start` ? 0.5 : 1 }}>
                              {actionLoading === `${lp}-start` ? '...' : '▶ Start'}
                            </button>
                          )}
                          {running && (
                            <button onClick={() => dockerAction(c.name, 'stop')} disabled={!!actionLoading}
                              style={{ ...mkBtn('#f87171'), opacity: actionLoading === `${lp}-stop` ? 0.5 : 1 }}>
                              {actionLoading === `${lp}-stop` ? '...' : '■ Stop'}
                            </button>
                          )}
                          <button onClick={() => dockerAction(c.name, 'restart')} disabled={!!actionLoading}
                            style={{ ...mkBtn('#7c6ff7'), opacity: actionLoading === `${lp}-restart` ? 0.5 : 1 }}>
                            {actionLoading === `${lp}-restart` ? '...' : '↺ Restart'}
                          </button>
                          <button
                            onClick={() => { setSelectedContainer(c.name); setActiveTab('logs'); fetchLogs(c.name, logTail); }}
                            style={mkBtn('rgba(255,255,255,0.38)', 'rgba(255,255,255,0.05)')}>
                            Логи
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          LOGS
      ════════════════════════════════════════ */}
      {activeTab === 'logs' && (
        <div>
          {/* Toolbar row 1 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>
              Логи контейнеров
            </h2>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Container picker */}
              <select value={selectedContainer}
                onChange={e => { setSelectedContainer(e.target.value); setLogLines([]); if (e.target.value) fetchLogs(e.target.value, logTail); }}
                style={{ background: '#13131f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.28rem 0.55rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.78rem', outline: 'none', maxWidth: 220, colorScheme: 'dark' }}>
                <option value="" style={{ background: '#13131f', color: 'rgba(255,255,255,0.5)' }}>— выберите контейнер —</option>
                {containers.map(c => (
                  <option key={c.id} value={c.name} style={{ background: '#13131f', color: c.state === 'running' ? '#4ade80' : 'rgba(255,255,255,0.5)' }}>
                    {c.state === 'running' ? '● ' : '○ '}{c.name.replace('watchsync-', '')}
                  </option>
                ))}
              </select>

              {/* Tail */}
              <select value={logTail} onChange={e => { const v = Number(e.target.value); setLogTail(v); if (selectedContainer) fetchLogs(selectedContainer, v); }}
                style={{ background: '#13131f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.28rem 0.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.78rem', outline: 'none', colorScheme: 'dark' }}>
                {[100, 200, 500, 1000].map(n => <option key={n} value={n} style={{ background: '#13131f' }}>{n} строк</option>)}
              </select>

              {/* Level filter */}
              <select value={logFilter} onChange={e => setLogFilter(e.target.value)}
                style={{ background: '#13131f', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.28rem 0.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.78rem', outline: 'none', colorScheme: 'dark' }}>
                <option value="all" style={{ background: '#13131f' }}>Все</option>
                <option value="warn" style={{ background: '#13131f' }}>Warn+</option>
                <option value="error" style={{ background: '#13131f' }}>Error</option>
              </select>

              <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)' }} />

              {/* Auto-refresh */}
              <button onClick={() => setLogAutoRefresh(v => !v)} style={{
                ...mkBtn(logAutoRefresh ? '#4ade80' : 'rgba(255,255,255,0.3)',
                         logAutoRefresh ? 'rgba(74,222,128,0.1)' : 'rgba(255,255,255,0.04)'),
              }}>
                {logAutoRefresh ? '● 10s' : '○ Авто'}
              </button>

              {/* Refresh */}
              <button onClick={() => { if (containers.length === 0) fetchContainers(); if (selectedContainer) fetchLogs(selectedContainer, logTail); else fetchContainers(); }}
                disabled={logsLoading}
                style={{ ...mkBtn('rgba(255,255,255,0.45)', 'rgba(255,255,255,0.05)'), opacity: logsLoading ? 0.4 : 1 }}>
                {logsLoading ? '...' : 'Обновить'}
              </button>

              {/* Download current */}
              <button onClick={() => downloadLogs(`${selectedContainer || 'logs'}-${Date.now()}.txt`, logLines)}
                disabled={!logLines.length}
                style={{ ...mkBtn('#7c6ff7'), opacity: logLines.length ? 1 : 0.35 }}
                title="Скачать текущие логи">
                ↓ Скачать
              </button>

              {/* Collect ALL */}
              <button onClick={collectAllLogs} disabled={collectingAll || !containers.length}
                style={{ ...mkBtn('#ff6b9d'), opacity: (collectingAll || !containers.length) ? 0.4 : 1 }}
                title="Собрать логи всех контейнеров и скачать одним файлом">
                {collectingAll ? '⏳ Сбор...' : '⬇ Все логи'}
              </button>
            </div>
          </div>

          {/* Search row */}
          <div style={{ marginBottom: '0.6rem' }}>
            <input
              value={logSearch} onChange={e => setLogSearch(e.target.value)}
              placeholder="Поиск в логах..."
              style={{ width: '100%', padding: '0.35rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#fff', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>

          {/* Log viewer */}
          <div style={{
            ...card,
            padding: '0.75rem',
            minHeight: '420px', maxHeight: '600px',
            overflowY: 'auto',
            fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
            fontSize: '0.74rem',
            lineHeight: 1.55,
          }}>
            {!selectedContainer && !logsLoading && (
              <div style={{ color: 'rgba(255,255,255,0.16)', textAlign: 'center', paddingTop: '6rem' }}>
                {containers.length === 0
                  ? 'Загрузка контейнеров...'
                  : `${containers.length} контейнеров — выберите один для просмотра логов`}
              </div>
            )}
            {selectedContainer && logsLoading && (
              <div style={{ color: 'rgba(255,255,255,0.22)', textAlign: 'center', paddingTop: '6rem' }}>Загрузка...</div>
            )}
            {selectedContainer && !logsLoading && visibleLogs.length === 0 && (
              <div style={{ color: 'rgba(255,255,255,0.16)', textAlign: 'center', paddingTop: '6rem' }}>
                {logLines.length > 0 ? `Нет строк по фильтру (всего ${logLines.length})` : 'Лог пустой'}
              </div>
            )}
            {visibleLogs.map((line, i) => {
              const isErr  = /\b(error|fatal|panic|ERR)\b/i.test(line);
              const isWarn = !isErr && /\b(warn|warning|WARN)\b/i.test(line);
              const isInfo = !isErr && !isWarn && /\b(info|INFO)\b/.test(line);
              const hiSearch = logSearch && line.toLowerCase().includes(logSearch.toLowerCase());
              return (
                <div key={i} style={{
                  color: isErr ? '#f87171' : isWarn ? '#fbbf24' : isInfo ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.45)',
                  padding: '0.07rem 0.3rem',
                  borderRadius: '2px',
                  background: isErr ? 'rgba(248,113,113,0.07)' : hiSearch ? 'rgba(124,111,247,0.12)' : 'transparent',
                  wordBreak: 'break-all',
                  borderLeft: isErr ? '2px solid #f87171' : isWarn ? '2px solid #fbbf24' : '2px solid transparent',
                  paddingLeft: '0.5rem',
                }}>
                  {line}
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.4rem', fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)' }}>
            <span>
              {visibleLogs.length} строк показано
              {logLines.length !== visibleLogs.length && ` из ${logLines.length}`}
              {selectedContainer && ` · ${selectedContainer}`}
            </span>
            <span>■ красный — ошибки · ■ жёлтый — warnings · ■ подсветка — поиск</span>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════
          TEMPLATES — Transcode presets management
      ════════════════════════════════════════ */}
      {activeTab === 'templates' && <TemplatesTab token={token} />}
      {activeTab === 'proxy' && <ProxyTab token={token} />}
      {activeTab === 'groups' && <GroupsTab token={token} />}

    </div>
  );
}

// ── Templates sub-component ──────────────────────────────────────────────────
const RESOLUTIONS = ['426x240','640x360','854x480','1280x720','1920x1080','2560x1440','3840x2160'];
const PRESETS     = ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower'];

const PERMISSION_KEYS = [
  ['can_join_room', 'Вход в комнату'],
  ['can_chat', 'Чат'],
  ['can_add_to_queue', 'Очередь'],
  ['can_use_mic', 'Микрофон'],
  ['can_stream', 'Трансляция'],
  ['can_upload_file', 'Загрузка файлов'],
  ['can_create_room', 'Создание комнат'],
  ['can_use_proxy', 'Прокси'],
  ['can_invite', 'Приглашения'],
];

function GroupsTab({ token }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [newName, setNewName] = useState('');
  const [assign, setAssign] = useState({ groupId: '', userId: '' });

  const authH = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3200); };

  const fetchGroups = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/groups`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); setGroups(Array.isArray(d) ? d : []); }
      else setGroups([]);
    } catch { setGroups([]); }
    setLoading(false);
  }, [token]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const createGroup = async () => {
    if (!newName.trim()) return;
    const r = await fetch(`${API}/admin/groups`, {
      method: 'POST', headers: authH(),
      body: JSON.stringify({ name: newName.trim(), permissions: {} }),
    });
    if (r.ok) { showToast('Группа создана'); setNewName(''); fetchGroups(); }
    else { const d = await r.json().catch(() => ({})); showToast('Ошибка: ' + (d.message || r.status)); }
  };

  const togglePerm = async (g, key) => {
    const perms = { ...(g.permissions || {}) };
    perms[key] = !perms[key];
    const r = await fetch(`${API}/admin/groups/${g.id}`, { method: 'PATCH', headers: authH(), body: JSON.stringify({ permissions: perms }) });
    if (r.ok) fetchGroups();
    else showToast('Ошибка сохранения');
  };

  const deleteGroup = async (g) => {
    if (g.is_global) { showToast('Глобальную группу нельзя удалить'); return; }
    if (!confirm(`Удалить группу «${g.name}»?`)) return;
    const r = await fetch(`${API}/admin/groups/${g.id}`, { method: 'DELETE', headers: authH() });
    if (r.ok) { showToast('Удалено'); fetchGroups(); }
    else { const d = await r.json().catch(() => ({})); showToast('Ошибка: ' + (d.message || r.status)); }
  };

  const assignUser = async () => {
    if (!assign.groupId || !assign.userId.trim()) return;
    const r = await fetch(`${API}/admin/groups/${assign.groupId}/assign-user`, {
      method: 'POST', headers: authH(), body: JSON.stringify({ user_id: assign.userId.trim() }),
    });
    if (r.ok) { showToast('Пользователь назначен'); setAssign({ groupId: '', userId: '' }); fetchGroups(); }
    else { const d = await r.json().catch(() => ({})); showToast('Ошибка: ' + (d.message || r.status)); }
  };

  const inp = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#e2e8f0', padding: '0.35rem 0.6rem', fontSize: '0.8rem', outline: 'none', fontFamily: 'inherit' };

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.75rem', color: '#e2e8f0' }}>Группы прав доступа</h3>
        <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginBottom: '1rem' }}>
          Глобальные группы (anonymous / registered) нельзя удалить. Права применяются к пользователям, назначенным на группу.
        </p>

        {toast && <div style={{ background: 'rgba(124,111,247,0.18)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: 6, padding: '0.4rem 0.7rem', fontSize: '0.78rem', marginBottom: '0.8rem' }}>{toast}</div>}

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Название новой группы" style={{ ...inp, width: '220px' }} />
          <button onClick={createGroup} style={mkBtn('#4ade80', '#4ade8018')}>+ Создать</button>
        </div>

        {loading ? <div style={{ color: 'rgba(255,255,255,0.3)' }}>Загрузка…</div> : groups.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.3)' }}>Групп нет</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            {groups.map(g => (
              <div key={g.id} style={{ ...card, padding: '0.9rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{g.name}</span>
                  {g.is_global && <span style={{ fontSize: '0.65rem', color: '#7c6ff7', background: 'rgba(124,111,247,0.15)', borderRadius: 4, padding: '0 5px' }}>global</span>}
                  {g.is_anonymous_default && <span style={{ fontSize: '0.65rem', color: '#fbbf24', background: 'rgba(251,191,36,0.15)', borderRadius: 4, padding: '0 5px' }}>анонимные</span>}
                  {!g.is_global && (
                    <button onClick={() => deleteGroup(g)} style={{ ...mkBtn('#f87171', '#f8717118'), marginLeft: 'auto' }}>Удалить</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {PERMISSION_KEYS.map(([key, label]) => {
                    const on = !!g.permissions?.[key];
                    return (
                      <button key={key} onClick={() => togglePerm(g, key)} title={key} style={{
                        background: on ? 'rgba(74,222,128,0.16)' : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${on ? 'rgba(74,222,128,0.5)' : 'rgba(255,255,255,0.1)'}`,
                        borderRadius: 6, padding: '0.22rem 0.55rem', cursor: 'pointer',
                        color: on ? '#4ade80' : 'rgba(255,255,255,0.45)', fontSize: '0.72rem',
                      }}>
                        {on ? '✓ ' : ''}{label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '1rem' }}>
          <h4 style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)', marginBottom: '0.6rem' }}>Назначить пользователя на группу</h4>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <select value={assign.groupId} onChange={(e) => setAssign({ ...assign, groupId: e.target.value })} style={{ ...inp, width: '180px', cursor: 'pointer' }}>
              <option value="">— группа —</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <input value={assign.userId} onChange={(e) => setAssign({ ...assign, userId: e.target.value })} placeholder="User ID (UUID)" style={{ ...inp, width: '240px' }} />
            <button onClick={assignUser} style={mkBtn('#7c6ff7', '#7c6ff718')}>Назначить</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplatesTab({ token }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', resolution: '1280x720', video_bitrate: '2500k', crf: 23, preset: 'fast' });
  const [toast, setToast] = useState('');

  const authH = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const fetchTemplates = useCallback(async () => {
    const r = await fetch('/api/v1/transcode/templates', { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { const d = await r.json(); setTemplates(d || []); }
    setLoading(false);
  }, [token]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const r = await fetch('/api/v1/transcode/templates', {
        method: 'POST', headers: authH(),
        body: JSON.stringify({ ...form, crf: Number(form.crf), format: 'mp4' }),
      });
      if (r.ok) { showToast('Шаблон создан'); fetchTemplates(); setForm({ name: '', description: '', resolution: '1280x720', video_bitrate: '2500k', crf: 23, preset: 'fast' }); }
      else { const d = await r.json(); showToast('Ошибка: ' + (d.message || r.status)); }
    } finally { setCreating(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить шаблон?')) return;
    const r = await fetch(`/api/v1/transcode/templates/${id}`, { method: 'DELETE', headers: authH() });
    if (r.ok) { showToast('Удалено'); fetchTemplates(); }
    else showToast('Ошибка удаления');
  };

  const inp = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#e2e8f0', padding: '0.35rem 0.6rem', fontSize: '0.8rem', outline: 'none', width: '100%', fontFamily: 'inherit' };
  const sel = { ...inp, cursor: 'pointer' };

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.75rem', color: '#e2e8f0' }}>Шаблоны транскодирования</h3>
        <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)', marginBottom: '1rem' }}>
          Встроенные шаблоны нельзя удалить. Кастомные хранятся в Redis (TTL 30 дней).
        </p>

        {loading ? <div style={{ color: 'rgba(255,255,255,0.3)' }}>Загрузка…</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
            <thead>
              <tr>
                {['Название', 'Формат', 'Разрешение', 'Битрейт', 'Пресет', 'CRF', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', padding: '0.3rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.07)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {templates.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.82rem' }}>
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                    {!t.custom && <span style={{ marginLeft: 6, fontSize: '0.65rem', color: '#7c6ff7', background: 'rgba(124,111,247,0.15)', borderRadius: 4, padding: '0 4px' }}>built-in</span>}
                    {t.description && <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{t.description}</div>}
                  </td>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>{t.format?.toUpperCase()}</td>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>{t.resolution || '—'}</td>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>{t.video_bitrate || '—'}</td>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>{t.preset || '—'}</td>
                  <td style={{ padding: '0.45rem 0.6rem', fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>{t.crf || '—'}</td>
                  <td style={{ padding: '0.45rem 0.6rem' }}>
                    {t.custom && (
                      <button onClick={() => handleDelete(t.id)} style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 5, color: '#f87171', cursor: 'pointer', fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}>Удалить</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h4 style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.75rem', color: '#e2e8f0' }}>Создать шаблон</h4>
        <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', maxWidth: 560 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>Название *</label>
            <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Мой шаблон 720p" required />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>Описание</label>
            <input style={inp} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Краткое описание" />
          </div>
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>Разрешение</label>
            <select style={sel} value={form.resolution} onChange={e => setForm(f => ({ ...f, resolution: e.target.value }))}>
              {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>Битрейт видео</label>
            <input style={inp} value={form.video_bitrate} onChange={e => setForm(f => ({ ...f, video_bitrate: e.target.value }))} placeholder="2500k" />
          </div>
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>Пресет скорости</label>
            <select style={sel} value={form.preset} onChange={e => setForm(f => ({ ...f, preset: e.target.value }))}>
              {PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: 4 }}>CRF (0=лучше, 51=хуже)</label>
            <input style={inp} type="number" min={0} max={51} value={form.crf} onChange={e => setForm(f => ({ ...f, crf: e.target.value }))} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <button type="submit" disabled={creating} style={{ background: 'linear-gradient(135deg,#7c6ff7,#6c5fd7)', border: 'none', borderRadius: 7, color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, padding: '0.45rem 1.1rem' }}>
              {creating ? 'Создание…' : '+ Создать шаблон'}
            </button>
          </div>
        </form>
      </div>
      {toast && (
        <div style={{ position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)', background: '#1e1b2e', border: '1px solid rgba(124,111,247,0.35)', borderRadius: 10, padding: '0.6rem 1.1rem', color: '#fff', fontSize: '0.82rem', zIndex: 9999 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Proxy Upstreams sub-component ─────────────────────────────────────────────
const UPSTREAM_TYPES = ['direct', 'http_proxy', 'socks5', 'flaresolverr'];
const TYPE_LABELS = { direct: 'Прямое', http_proxy: 'HTTP Прокси', socks5: 'SOCKS5', flaresolverr: 'FlareSolverr' };

function ProxyTab({ token }) {
  const [upstreams, setUpstreams] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [testResults, setTestResults] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', type: 'direct', endpoint: '', priority: 0, enabled: true, chain_ids: [] });

  const authH = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/proxy/upstreams', { headers: authH() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUpstreams(data.upstreams || []);
    } catch (e) { showToast('Ошибка загрузки: ' + e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    try {
      const res = await fetch('/api/v1/proxy/upstreams', {
        method: 'POST', headers: authH(),
        body: JSON.stringify({ ...form, priority: Number(form.priority), auth: {}, rules: [], chain_ids: form.chain_ids }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.message || `HTTP ${res.status}`); }
      showToast('Upstream создан');
      setShowForm(false);
      setForm({ name: '', description: '', type: 'direct', endpoint: '', priority: 0, enabled: true, chain_ids: [] });
      load();
    } catch (e) { showToast('Ошибка: ' + e.message); }
  };

  const toggle = async (u) => {
    try {
      const res = await fetch(`/api/v1/proxy/upstreams/${u.id}`, {
        method: 'PUT', headers: authH(),
        body: JSON.stringify({ ...u, enabled: !u.enabled, auth: u.auth || {}, rules: u.rules || [], chain_ids: u.chain_ids || [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load();
    } catch (e) { showToast('Ошибка: ' + e.message); }
  };

  const remove = async (id) => {
    if (!window.confirm('Удалить upstream?')) return;
    try {
      const res = await fetch(`/api/v1/proxy/upstreams/${id}`, { method: 'DELETE', headers: authH() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast('Удалено');
      load();
    } catch (e) { showToast('Ошибка: ' + e.message); }
  };

  const test = async (id) => {
    setTestResults(p => ({ ...p, [id]: 'testing' }));
    try {
      const res = await fetch(`/api/v1/proxy/upstreams/${id}/test`, { method: 'POST', headers: authH() });
      const data = await res.json();
      setTestResults(p => ({ ...p, [id]: data }));
    } catch (e) {
      setTestResults(p => ({ ...p, [id]: { ok: false, error: e.message } }));
    }
  };

  const cellStyle = { padding: '0.5rem 0.75rem', fontSize: '0.82rem', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap' };
  const inputStyle = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#e2e8f0', padding: '0.35rem 0.6rem', fontSize: '0.82rem', width: '100%' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0' }}>Proxy Upstreams</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={load} style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', padding: '0.3rem 0.7rem', cursor: 'pointer', fontSize: '0.8rem' }}>↻</button>
          <button onClick={() => setShowForm(v => !v)} style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.3)', borderRadius: 6, color: '#a78bfa', padding: '0.3rem 0.7rem', cursor: 'pointer', fontSize: '0.8rem' }}>+ Добавить</button>
        </div>
      </div>

      {showForm && (
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
            <div><label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Название</label><input style={inputStyle} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="My Proxy" /></div>
            <div><label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Тип</label>
              <select style={inputStyle} value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
                {UPSTREAM_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}><label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Endpoint (для http_proxy/socks5)</label><input style={inputStyle} value={form.endpoint} onChange={e => setForm(p => ({ ...p, endpoint: e.target.value }))} placeholder="http://proxy:3128 или socks5://host:1080" /></div>
            <div><label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Описание</label><input style={inputStyle} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} /></div>
            <div><label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>Приоритет (0 = первый)</label><input type="number" style={inputStyle} value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} /></div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>
                Цепочка (tunnel через) — Ctrl+клик для мультивыбора
              </label>
              <select multiple style={{ ...inputStyle, height: 80, marginTop: 4 }}
                value={form.chain_ids}
                onChange={e => setForm(p => ({ ...p, chain_ids: Array.from(e.target.selectedOptions).map(o => o.value) }))}>
                {upstreams.filter(u => u.type !== 'flaresolverr' && u.type !== 'direct').map(u => (
                  <option key={u.id} value={u.id} style={{ background: '#09090f' }}>{u.name} ({TYPE_LABELS[u.type]})</option>
                ))}
              </select>
              <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.25)', marginTop: 3 }}>
                Выбранные апстримы будут использованы как транспорт до текущего (напр. SOCKS5 → FlareSolverr)
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowForm(false)} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: 'rgba(255,255,255,0.5)', padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.8rem' }}>Отмена</button>
            <button onClick={create} style={{ background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: 6, color: '#a78bfa', padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>Создать</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.85rem' }}>Загрузка...</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {['Название', 'Тип', 'Endpoint', 'Цепочка', 'Приор.', 'Статус', 'Тест', ''].map(h => (
                  <th key={h} style={{ ...cellStyle, color: 'rgba(255,255,255,0.35)', fontSize: '0.72rem', textTransform: 'uppercase', fontWeight: 600, textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {upstreams.map(u => {
                const tr = testResults[u.id];
                return (
                  <tr key={u.id} style={{ opacity: u.enabled ? 1 : 0.45 }}>
                    <td style={cellStyle}><span style={{ fontWeight: 600 }}>{u.name}</span>{u.description && <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{u.description}</div>}</td>
                    <td style={cellStyle}><span style={{ background: 'rgba(124,111,247,0.15)', color: '#a78bfa', borderRadius: 4, padding: '0.15rem 0.4rem', fontSize: '0.72rem' }}>{TYPE_LABELS[u.type] || u.type}</span></td>
                    <td style={{ ...cellStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', color: 'rgba(255,255,255,0.45)', fontSize: '0.75rem' }}>{u.endpoint || '—'}</td>
                    <td style={cellStyle}>
                      {Array.isArray(u.chain_ids) && u.chain_ids.length > 0
                        ? u.chain_ids.map(cid => {
                            const cu = upstreams.find(x => x.id === cid);
                            return <span key={cid} style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', borderRadius: 4, padding: '0.1rem 0.35rem', fontSize: '0.68rem', marginRight: 3, display: 'inline-block' }}>{cu ? cu.name : cid.slice(0, 8)}</span>;
                          })
                        : <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: '0.72rem' }}>—</span>}
                    </td>
                    <td style={{ ...cellStyle, textAlign: 'center' }}>{u.priority}</td>
                    <td style={cellStyle}>
                      <button onClick={() => toggle(u)} style={{ background: u.enabled ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)', border: `1px solid ${u.enabled ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`, borderRadius: 4, color: u.enabled ? '#4ade80' : '#f87171', padding: '0.15rem 0.5rem', cursor: 'pointer', fontSize: '0.72rem' }}>
                        {u.enabled ? 'Вкл' : 'Выкл'}
                      </button>
                    </td>
                    <td style={cellStyle}>
                      <button onClick={() => test(u.id)} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'rgba(255,255,255,0.5)', padding: '0.15rem 0.5rem', cursor: 'pointer', fontSize: '0.72rem' }}>
                        {tr === 'testing' ? '...' : 'Проверить'}
                      </button>
                      {tr && tr !== 'testing' && (
                        <span style={{ marginLeft: 6, fontSize: '0.72rem', color: tr.ok ? '#4ade80' : '#f87171' }}>
                          {tr.ok ? `✓ ${tr.latency_ms}мс` : `✗ ${tr.error || 'fail'}`}
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {u.name !== 'Direct' && (
                        <button onClick={() => remove(u.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.85rem' }} title="Удалить">🗑</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {upstreams.length === 0 && (
                <tr><td colSpan={7} style={{ ...cellStyle, textAlign: 'center', color: 'rgba(255,255,255,0.2)', padding: '2rem' }}>Нет upstream-провайдеров</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {toast && <div style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.3)', borderRadius: 8, padding: '0.5rem 0.85rem', color: '#a78bfa', fontSize: '0.82rem' }}>{toast}</div>}
    </div>
  );
}
