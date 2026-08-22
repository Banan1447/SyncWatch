import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';

const API = '/api/v1';

function formatWatchTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function heatColor(seconds) {
  if (!seconds) return 'rgba(255,255,255,0.05)';
  if (seconds < 600) return 'rgba(124,111,247,0.35)';
  if (seconds < 1800) return 'rgba(124,111,247,0.55)';
  if (seconds < 3600) return 'rgba(124,111,247,0.75)';
  return '#8b7ff8';
}

const TIER_LABELS = { free: 'Бесплатный', premium: 'Premium', admin: 'Администратор' };
const TIER_COLORS = { free: 'rgba(255,255,255,0.4)', premium: '#fbbf24', admin: '#a78bfa' };

const VIDEO_TYPE_LABELS = {
  youtube: 'YouTube',
  local: 'Локальные файлы',
  hls: 'HLS',
  embed: 'Embed',
};
const VIDEO_TYPE_COLORS = {
  youtube: '#ef4444',
  local: '#4ade80',
  hls: '#38bdf8',
  embed: '#fbbf24',
};
const WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const CARD_STYLE = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  padding: '1.25rem 1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};
const SECTION_TITLE = {
  fontSize: '0.72rem',
  color: 'rgba(255,255,255,0.4)',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};
const INPUT_STYLE = {
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '0.45rem 0.7rem',
  color: '#e2e8f0',
  fontSize: '0.85rem',
  outline: 'none',
};

export default function Profile() {
  const navigate = useNavigate();
  const { user, token, logout, refreshUser } = useAuth();
  const { theme, setTheme } = useTheme();

  // ── Data ───────────────────────────────────────────────────────────────────
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState(null);
  const [achievements, setAchievements] = useState(null);
  const [favorites, setFavorites] = useState(null);
  const [continueList, setContinueList] = useState(null);
  const [profile, setProfile] = useState(null); // { badge, status, privacy }

  // ── Username / avatar ──────────────────────────────────────────────────────
  const [editUsername, setEditUsername] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveOk, setSaveOk] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const fileRef = useRef(null);

  // ── Badge / status ─────────────────────────────────────────────────────────
  const [badge, setBadge] = useState('');
  const [status, setStatus] = useState('');
  const [badgeSaving, setBadgeSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [badgeMsg, setBadgeMsg] = useState('');

  // ── Privacy ────────────────────────────────────────────────────────────────
  const [privacy, setPrivacy] = useState({ show_watch_time: true, show_history: true, show_achievements: true });
  const [privacySaving, setPrivacySaving] = useState(false);

  // ── Change password ────────────────────────────────────────────────────────
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwOk, setPwOk] = useState(false);

  const changeTheme = useCallback((t) => {
    setTheme(t);
    if (token) {
      fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: t }),
      }).catch(() => {});
    }
  }, [token, setTheme]);

  // ── Load all profile data ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token) { navigate('/'); return; }
    const h = { Authorization: `Bearer ${token}` };

    fetch(`${API}/users/me/stats`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setStats(d); })
      .catch(() => {});

    fetch(`${API}/users/me/history`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setHistory(d); })
      .catch(() => {});

    fetch(`${API}/users/me/achievements`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setAchievements(d); })
      .catch(() => {});

    fetch(`${API}/users/me/favorites`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) setFavorites(d); })
      .catch(() => {});

    fetch(`${API}/users/me/continue`, { headers: h })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) setContinueList(d); })
      .catch(() => {});

    if (user?.id) {
      fetch(`${API}/users/${user.id}`, { headers: h })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setProfile(d); })
        .catch(() => {});
    }
  }, [token, navigate, user?.id]);

  useEffect(() => {
    if (user) {
      setEditUsername(user.username || '');
      setAvatarUrl(user.avatar_url || '');
    }
  }, [user]);

  useEffect(() => {
    if (profile) {
      setBadge(profile.badge || '');
      setStatus(profile.status || '');
      if (profile.privacy) {
        setPrivacy({
          show_watch_time: profile.privacy.show_watch_time !== false,
          show_history: profile.privacy.show_history !== false,
          show_achievements: profile.privacy.show_achievements !== false,
        });
      }
    }
  }, [profile]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const saveUsername = async () => {
    if (!editUsername.trim() || editUsername === user?.username) { setEditMode(false); return; }
    setSaving(true); setSaveError(''); setSaveOk(false);
    try {
      const res = await fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: editUsername.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).message || 'Ошибка');
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
      setEditMode(false);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    setAvatarUploading(true);
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      const res = await fetch(`${API}/users/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error('Ошибка загрузки');
      const data = await res.json();
      setAvatarUrl(data.avatar_url);
    } catch (e) {
      console.error('Avatar upload failed:', e);
    } finally {
      setAvatarUploading(false);
    }
  };

  const saveBadge = async () => {
    setBadgeSaving(true); setBadgeMsg('');
    try {
      const res = await fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ badge: badge.trim() }),
      });
      if (!res.ok) throw new Error('Ошибка');
      setBadgeMsg('Сохранено');
    } catch {
      setBadgeMsg('Ошибка');
    } finally {
      setBadgeSaving(false);
      setTimeout(() => setBadgeMsg(''), 2000);
    }
  };

  const saveStatus = async () => {
    setStatusSaving(true); setBadgeMsg('');
    try {
      const res = await fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: status.trim() }),
      });
      if (!res.ok) throw new Error('Ошибка');
      setBadgeMsg('Сохранено');
    } catch {
      setBadgeMsg('Ошибка');
    } finally {
      setStatusSaving(false);
      setTimeout(() => setBadgeMsg(''), 2000);
    }
  };

  const togglePrivacy = async (key) => {
    const next = { ...privacy, [key]: !privacy[key] };
    setPrivacy(next);
    setPrivacySaving(true);
    try {
      await fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ privacy: next }),
      });
    } catch { /* revert not needed — next load will reconcile */ }
    setPrivacySaving(false);
  };

  // 18+ confirmation — required to join 18+ rooms. Updates the user context so
  // the room gate (RoomSelect handleJoinRoom) sees the new value immediately.
  const toggleAdult = async () => {
    const next = !(user?.preferences?.is_adult === true);
    try {
      const res = await fetch(`${API}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_adult: next }),
      });
      if (!res.ok) throw new Error('Ошибка сохранения');
      await refreshUser();
    } catch (e) { console.error('adult toggle failed', e); }
  };

  // ── YouTube cookies (age-restricted / 18+ videos) ────────────────────────
  const [ytCookies, setYtCookies] = useState(user?.preferences?.youtube_cookies || '');
  const [ytCookiesSaving, setYtCookiesSaving] = useState(false);
  const ytCookiesSet = !!ytCookies;

  const saveYTCookies = async () => {
    setYtCookiesSaving(true);
    try {
      const res = await fetch(`${API}/youtube/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cookies: ytCookies }),
      });
      if (!res.ok) throw new Error('Ошибка сохранения');
      await refreshUser();
    } catch (e) { console.error('yt cookies save failed', e); }
    setYtCookiesSaving(false);
  };
  const clearYTCookies = async () => {
    setYtCookies('');
    setYtCookiesSaving(true);
    try {
      await fetch(`${API}/youtube/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cookies: '' }),
      });
      await refreshUser();
    } catch (e) { console.error('yt cookies clear failed', e); }
    setYtCookiesSaving(false);
  };

  const removeFavorite = async (roomId) => {
    const prev = favorites;
    setFavorites(favorites.filter(f => f.room_id !== roomId));
    try {
      await fetch(`${API}/users/me/favorites/${roomId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      setFavorites(prev);
    }
  };

  const changePassword = async () => {
    setPwError('');
    if (pwNew !== pwConfirm) { setPwError('Пароли не совпадают'); return; }
    if (pwNew.length < 8) { setPwError('Минимум 8 символов'); return; }
    setPwSaving(true);
    try {
      const res = await fetch(`${API}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ current_password: pwCurrent, new_password: pwNew }),
      });
      if (!res.ok) throw new Error((await res.json()).message || 'Ошибка');
      setPwOk(true);
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      setTimeout(() => { setPwOk(false); setPwOpen(false); }, 2000);
    } catch (e) {
      setPwError(e.message);
    } finally {
      setPwSaving(false);
    }
  };

  if (!user) return null;

  const initials = (user.username || '?')[0].toUpperCase();
  const tier = user.subscription_tier || 'free';

  // ── Derived data ───────────────────────────────────────────────────────────
  const breakdown = stats?.breakdown || {};
  const totalWatch = stats?.watch_seconds || 0;
  const histEntries = history?.entries || [];
  const histDaily = history?.daily || [];
  const weekdayTotals = history?.weekday_totals || [];
  const achList = achievements?.achievements || [];
  const achUnlocked = achievements?.unlocked_count || 0;
  const achTotal = achievements?.total || achList.length || 6;

  // Heatmap grid: last 12 weeks (7 rows × 12 columns), Sunday..Saturday.
  const heatByDate = {};
  histDaily.forEach(d => { heatByDate[d.date] = d.seconds; });
  const heatColumns = [];
  {
    const today = new Date();
    const lastSunday = new Date(today);
    lastSunday.setDate(today.getDate() - today.getDay());
    for (let w = 11; w >= 0; w--) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        const d = new Date(lastSunday);
        d.setDate(lastSunday.getDate() - w * 7 + r);
        const date = toISODate(d);
        col.push({ date, weekday: r, seconds: heatByDate[date] || 0 });
      }
      heatColumns.push(col);
    }
  }

  const maxWeekday = Math.max(1, ...weekdayTotals.map(w => w.seconds));

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
      <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* Back */}
        <button onClick={() => navigate('/')}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '0.85rem', padding: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          ← Назад
        </button>

        {/* Card */}
        <div style={{ ...CARD_STYLE, padding: '2rem', gap: '1.5rem' }}>

          {/* Avatar + name row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div
                onClick={() => !avatarUploading && fileRef.current?.click()}
                title="Сменить аватар"
                style={{
                  width: 72, height: 72, borderRadius: '50%', cursor: 'pointer',
                  background: avatarUrl ? 'transparent' : 'linear-gradient(135deg,#7c6ff7,#ff6b9d)',
                  border: '2px solid rgba(124,111,247,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.6rem', fontWeight: 700, color: '#fff',
                  overflow: 'hidden', position: 'relative',
                  transition: 'border-color 0.2s',
                }}
              >
                {avatarUrl
                  ? <img src={avatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : initials}
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '0'}>
                  {avatarUploading ? <span style={{ fontSize: '0.7rem', color: '#fff' }}>…</span> : <span style={{ fontSize: '1rem' }}>📷</span>}
                </div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { uploadAvatar(e.target.files?.[0]); e.target.value = ''; }} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              {editMode ? (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    autoFocus
                    value={editUsername}
                    onChange={e => setEditUsername(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveUsername(); if (e.key === 'Escape') setEditMode(false); }}
                    maxLength={32}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(124,111,247,0.5)', borderRadius: 8, padding: '0.4rem 0.65rem', color: '#e2e8f0', fontSize: '1rem', fontWeight: 600, outline: 'none' }}
                  />
                  <button onClick={saveUsername} disabled={saving}
                    style={{ background: 'rgba(74,222,128,0.2)', border: '1px solid rgba(74,222,128,0.4)', borderRadius: 8, padding: '0.4rem 0.7rem', color: '#4ade80', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                    {saving ? '…' : '✓'}
                  </button>
                  <button onClick={() => { setEditMode(false); setEditUsername(user.username); }}
                    style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '0.4rem 0.7rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '0.85rem' }}>
                    ✕
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '1.15rem', fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.username}</span>
                  {badge && (
                    <span style={{ background: 'rgba(251,191,36,0.2)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 999, padding: '0.1rem 0.5rem', fontSize: '0.65rem', fontWeight: 700, color: '#fbbf24', whiteSpace: 'nowrap' }}>{badge}</span>
                  )}
                  {!user.is_guest && (
                    <button onClick={() => setEditMode(true)} title="Изменить имя"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(124,111,247,0.6)', fontSize: '0.85rem', padding: '0 2px', lineHeight: 1 }}>✎</button>
                  )}
                </div>
              )}
              {saveError && <div style={{ color: '#f87171', fontSize: '0.72rem', marginTop: '0.2rem' }}>{saveError}</div>}
              {saveOk && <div style={{ color: '#4ade80', fontSize: '0.72rem', marginTop: '0.2rem' }}>Сохранено</div>}
              {status && <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginTop: '0.2rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status}</div>}
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: TIER_COLORS[tier], marginTop: '0.2rem', display: 'block' }}>
                {TIER_LABELS[tier] || tier}
              </span>
            </div>
          </div>

          {/* Info rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {user.email && (
              <InfoRow label="Email" value={
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {user.email}
                  {user.email_verified
                    ? <span title="Подтверждён" style={{ color: '#4ade80', fontSize: '0.7rem' }}>✓</span>
                    : <span title="Не подтверждён" style={{ color: '#fbbf24', fontSize: '0.7rem' }}>⚠</span>}
                </span>
              } />
            )}
            <InfoRow label="Аккаунт создан" value={formatDate(user.created_at)} />
          </div>

          {/* Watch time + breakdown */}
          <div style={{ background: 'rgba(124,111,247,0.08)', border: '1px solid rgba(124,111,247,0.2)', borderRadius: 12, padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ fontSize: '2rem', lineHeight: 1 }}>📺</span>
              <div>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.15rem' }}>Времени просмотрено</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#a78bfa', lineHeight: 1 }}>
                  {stats == null ? '…' : formatWatchTime(totalWatch)}
                </div>
              </div>
            </div>

            {stats != null && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {Object.entries(VIDEO_TYPE_LABELS).map(([type, label]) => {
                  const secs = breakdown[type] || 0;
                  const pct = totalWatch > 0 ? Math.min(100, Math.round((secs / totalWatch) * 100)) : 0;
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ width: 104, fontSize: '0.68rem', color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}>{label}</span>
                      <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: VIDEO_TYPE_COLORS[type], borderRadius: 3, transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ width: 58, fontSize: '0.68rem', color: 'rgba(255,255,255,0.5)', textAlign: 'right', flexShrink: 0 }}>{formatWatchTime(secs)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Badge + status editing */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={SECTION_TITLE}>Бейдж и статус</div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input value={badge} onChange={e => setBadge(e.target.value)} maxLength={20} placeholder="Бейдж (до 20 символов)"
                onKeyDown={e => e.key === 'Enter' && saveBadge()}
                style={{ ...INPUT_STYLE, flex: 1 }} />
              <button onClick={saveBadge} disabled={badgeSaving}
                style={{ background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: 8, padding: '0.45rem 0.7rem', color: '#a78bfa', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', flexShrink: 0 }}>
                {badgeSaving ? '…' : 'OK'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input value={status} onChange={e => setStatus(e.target.value)} maxLength={50} placeholder="Статус (до 50 символов)"
                onKeyDown={e => e.key === 'Enter' && saveStatus()}
                style={{ ...INPUT_STYLE, flex: 1 }} />
              <button onClick={saveStatus} disabled={statusSaving}
                style={{ background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: 8, padding: '0.45rem 0.7rem', color: '#a78bfa', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', flexShrink: 0 }}>
                {statusSaving ? '…' : 'OK'}
              </button>
            </div>
            {badgeMsg && <div style={{ fontSize: '0.72rem', color: badgeMsg === 'Сохранено' ? '#4ade80' : '#f87171' }}>{badgeMsg}</div>}
          </div>

          {/* Theme picker */}
          <div>
            <div style={{ ...SECTION_TITLE, marginBottom: '0.5rem' }}>Оформление</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {[
                { id: 'dark',   label: '🌑 Тёмная',  bg: '#09090f', border: '#7c6ff7' },
                { id: 'light',  label: '☀️ Светлая', bg: '#f0f0f8', border: '#6355d8' },
                { id: 'amoled', label: '⬛ AMOLED',  bg: '#000000', border: '#8b7ff8' },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => changeTheme(t.id)}
                  style={{
                    flex: 1, padding: '0.5rem 0.4rem', borderRadius: 8, cursor: 'pointer',
                    background: theme === t.id ? 'rgba(124,111,247,0.15)' : 'rgba(255,255,255,0.04)',
                    border: theme === t.id ? `1.5px solid ${t.border}` : '1px solid rgba(255,255,255,0.1)',
                    color: theme === t.id ? '#e2e8f0' : 'rgba(255,255,255,0.45)',
                    fontSize: '0.75rem', fontWeight: theme === t.id ? 700 : 400,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                    transition: 'all 0.15s',
                  }}
                >
                  <span style={{ width: 12, height: 12, borderRadius: '50%', background: t.bg, border: `1px solid ${t.border}`, flexShrink: 0 }} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Change password */}
          {!user.is_guest && (
            <div>
              {!pwOpen ? (
                <button onClick={() => setPwOpen(true)}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '0.6rem', color: 'rgba(255,255,255,0.6)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', textAlign: 'left' }}>
                  🔒 Сменить пароль
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 }}>
                  <input type="password" placeholder="Текущий пароль" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                    style={INPUT_STYLE} />
                  <input type="password" placeholder="Новый пароль (мин. 8 символов)" value={pwNew} onChange={e => setPwNew(e.target.value)}
                    style={INPUT_STYLE} />
                  <input type="password" placeholder="Повторите новый пароль" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && changePassword()}
                    style={INPUT_STYLE} />
                  {pwError && <div style={{ color: '#f87171', fontSize: '0.75rem' }}>{pwError}</div>}
                  {pwOk && <div style={{ color: '#4ade80', fontSize: '0.75rem' }}>Пароль изменён</div>}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={changePassword} disabled={pwSaving}
                      style={{ flex: 1, background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: 8, padding: '0.45rem', color: '#a78bfa', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer' }}>
                      {pwSaving ? '…' : 'Сохранить'}
                    </button>
                    <button onClick={() => { setPwOpen(false); setPwError(''); setPwCurrent(''); setPwNew(''); setPwConfirm(''); }}
                      style={{ background: 'none', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '0.45rem 0.8rem', color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', cursor: 'pointer' }}>
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {!user.is_guest && (
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
              <button onClick={() => { logout(); navigate('/'); }}
                style={{ flex: 1, minWidth: 120, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '0.6rem', color: '#f87171', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer' }}>
                Выйти
              </button>
            </div>
          )}
        </div>

        {/* Achievements */}
        <div style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={SECTION_TITLE}>Достижения</div>
            <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>{achUnlocked} / {achTotal}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem' }}>
            {achList.length === 0 && (
              <div style={{ gridColumn: '1 / -1', fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '0.5rem 0' }}>
                Загрузка достижений…
              </div>
            )}
            {achList.map(ach => (
              <div key={ach.id}
                title={`${ach.name} — ${ach.description}`}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem', padding: '0.75rem 0.4rem',
                  borderRadius: 12, textAlign: 'center',
                  background: ach.unlocked ? 'rgba(124,111,247,0.12)' : 'rgba(255,255,255,0.03)',
                  border: ach.unlocked ? '1px solid rgba(124,111,247,0.35)' : '1px solid rgba(255,255,255,0.06)',
                  opacity: ach.unlocked ? 1 : 0.5,
                  transition: 'all 0.2s',
                }}>
                <span style={{ fontSize: '1.5rem', lineHeight: 1, filter: ach.unlocked ? 'none' : 'grayscale(1)' }}>{ach.icon}</span>
                <span style={{ fontSize: '0.68rem', color: ach.unlocked ? '#e2e8f0' : 'rgba(255,255,255,0.4)', fontWeight: 600, lineHeight: 1.2 }}>{ach.name}</span>
                {!ach.unlocked && <span style={{ fontSize: '0.7rem' }}>🔒</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Continue watching */}
        {continueList !== null && continueList.length > 0 && (
          <div style={CARD_STYLE}>
            <div style={SECTION_TITLE}>Продолжить просмотр</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {continueList.map((c, i) => (
                <button key={i} onClick={() => navigate(`/room/${c.room_id}`)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, cursor: 'pointer', color: 'inherit', textAlign: 'left', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(124,111,247,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'}>
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>▶️</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', color: '#e2e8f0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.title || `Комната ${c.room_id}`}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginTop: '0.1rem' }}>остановлено на {formatClock(c.current_time)}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Favorites */}
        {favorites !== null && (
          <div style={CARD_STYLE}>
            <div style={SECTION_TITLE}>Избранные комнаты</div>
            {favorites.length === 0 ? (
              <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.5rem 0' }}>Нет избранных комнат</div>
            ) : favorites.map((f, i) => (
              <div key={f.room_id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: i < favorites.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>⭐</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.85rem', color: '#e2e8f0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name || `Комната ${f.room_id}`}
                  </div>
                </div>
                <button onClick={() => navigate(`/room/${f.room_id}`)}
                  style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.3)', borderRadius: 8, padding: '0.3rem 0.6rem', color: '#a78bfa', fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer', flexShrink: 0 }}>
                  Войти
                </button>
                <button onClick={() => removeFavorite(f.room_id)} title="Убрать из избранного"
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '0.85rem', flexShrink: 0, padding: '0.2rem' }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Watch history + heatmap */}
        {history !== null && (
          <div style={CARD_STYLE}>
            <div style={SECTION_TITLE}>Активность по дням недели</div>

            {weekdayTotals.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {weekdayTotals.map(w => (
                  <div key={w.weekday} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ width: 24, fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{w.label}</span>
                    <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${w.seconds > 0 ? Math.max(4, Math.round((w.seconds / maxWeekday) * 100)) : 0}%`, height: '100%', background: '#7c6ff7', borderRadius: 4 }} />
                    </div>
                    <span style={{ width: 56, fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', textAlign: 'right', flexShrink: 0 }}>{formatWatchTime(w.seconds)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Heatmap grid (12 weeks × 7 days) */}
            <div>
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, paddingRight: '0.3rem' }}>
                  {WEEKDAY_LABELS.map((l, r) => (
                    <span key={r} style={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.3)', height: 12, lineHeight: '12px', textAlign: 'right' }}>{l}</span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 2, flex: 1, overflowX: 'auto' }}>
                  {heatColumns.map((col, ci) => (
                    <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {col.map(cell => (
                        <div key={cell.date}
                          title={`${cell.date}: ${formatWatchTime(cell.seconds)}`}
                          style={{ width: 12, height: 12, borderRadius: 3, background: heatColor(cell.seconds) }} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.25)', marginTop: '0.4rem' }}>Последние 12 недель</div>
            </div>

            {/* Recent history */}
            <div style={{ marginTop: '0.5rem' }}>
              <div style={{ ...SECTION_TITLE, marginBottom: '0.5rem' }}>Недавний просмотр</div>
              {histEntries.length === 0 ? (
                <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.5rem 0' }}>Нет истории просмотра</div>
              ) : histEntries.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderBottom: i < histEntries.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>📺</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', color: '#e2e8f0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title || `Комната ${item.room_id}`}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', marginTop: '0.1rem' }}>
                      {item.seconds > 0 && formatWatchTime(item.seconds)} · {item.timestamp ? new Date(item.timestamp * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Privacy */}
        <div style={CARD_STYLE}>
          <div style={SECTION_TITLE}>Приватность</div>
          <Toggle label="Показывать время просмотра другим" value={privacy.show_watch_time} onChange={() => togglePrivacy('show_watch_time')} />
          <Toggle label="Показывать историю просмотра" value={privacy.show_history} onChange={() => togglePrivacy('show_history')} />
          <Toggle label="Показывать достижения" value={privacy.show_achievements} onChange={() => togglePrivacy('show_achievements')} />
          {privacySaving && <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)' }}>Сохранение…</div>}
        </div>

        {/* Age 18+ */}
        <div style={CARD_STYLE}>
          <div style={SECTION_TITLE}>Возраст 🔞</div>
          <Toggle label="Мне есть 18 лет" value={user?.preferences?.is_adult === true} onChange={toggleAdult} />
          <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', marginTop: '0.35rem' }}>
            Требуется для входа в комнаты 18+.
          </div>
        </div>

        {/* YouTube cookies (18+) */}
        <div style={CARD_STYLE}>
          <div style={SECTION_TITLE}>YouTube cookies (для 18+) 🔞</div>
          <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.5rem' }}>
            Нужны для роликов 18+ (возрастные ограничения). Экспортируйте cookies.txt из своего аккаунта YouTube — расширение «Get cookies.txt LOCALLY» (Chrome) / «cookies.txt» (Firefox) и вставьте сюда.
          </div>
          <textarea
            value={ytCookies}
            onChange={(e) => setYtCookies(e.target.value)}
            placeholder="# Netscape HTTP Cookie File..."
            rows={6}
            style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, color: '#e2e8f0', fontSize: '0.72rem', padding: '0.5rem', fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="btn-primary" onClick={saveYTCookies} disabled={ytCookiesSaving} style={{ flex: 1, fontSize: '0.78rem' }}>
              {ytCookiesSaving ? 'Сохранение…' : ytCookiesSet ? 'Обновить' : 'Сохранить'}
            </button>
            {ytCookiesSet && (
              <button onClick={clearYTCookies} disabled={ytCookiesSaving} style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, color: '#f87171', cursor: 'pointer', fontSize: '0.78rem', padding: '0.5rem 0.9rem' }}>
                Удалить
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <button onClick={onChange}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.5rem 0', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left', width: '100%' }}>
      <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.75)' }}>{label}</span>
      <span style={{
        width: 38, height: 22, borderRadius: 11, position: 'relative', flexShrink: 0,
        background: value ? 'rgba(124,111,247,0.6)' : 'rgba(255,255,255,0.12)',
        transition: 'background 0.2s',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: value ? 18 : 2, width: 18, height: 18, borderRadius: '50%',
          background: '#fff', transition: 'left 0.2s',
        }} />
      </span>
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
      <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', minWidth: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.75)' }}>{value}</span>
    </div>
  );
}
