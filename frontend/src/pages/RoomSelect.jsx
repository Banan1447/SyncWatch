import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import { useTranslation } from 'react-i18next';

const API = '/api/v1';

export default function RoomSelect() {
  const { user, token, login, loginTOTP, register, logout, loginAsGuest, loginAnonymous, refreshUser, enableTOTPForced } = useAuth();
  const { theme, themes, setTheme } = useTheme();
  const { t, i18n } = useTranslation(['common', 'rooms', 'auth']);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const [rooms, setRooms] = useState([]);
  const [error, setError] = useState('');

  // Auth modal
  const [authModal, setAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '', email: '', isAdult: false });
  const [authError, setAuthError] = useState('');

  // Translate raw network failures (fetch TypeError: "Failed to fetch") into a
  // human-readable message — the client can't reach the server at all
  // (operator DPI block, no VPN, offline), not a wrong-password problem.
  const authErrorMessage = (err) => {
    if (err instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(err?.message || '')) {
      return 'Нет соединения с сервером — включи VPN или проверь интернет';
    }
    return err.message || 'Ошибка авторизации';
  };
  const [authLoading, setAuthLoading] = useState(false);
  const [totpStep, setTotpStep] = useState(null); // { temp_token }
  const [totpCode, setTotpCode] = useState('');
  // TOTP setup modal
  const [totpModal, setTotpModal] = useState(false);
  const [totpSetup, setTotpSetup] = useState(null); // { secret, qr_url }
  const [totpSetupCode, setTotpSetupCode] = useState('');
  const [totpDisableCode, setTotpDisableCode] = useState('');
  const [totpModalError, setTotpModalError] = useState('');
  const [totpForcedTemp, setTotpForcedTemp] = useState(null); // temp_token for admin-forced setup

  // Guest modal
  const [guestModal, setGuestModal] = useState(false);
  const [guestName, setGuestName] = useState('');

  // Create room modal
  const [createModal, setCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', roomType: 1, password: '', persistent: false, isAdult: false });
  const [createLoading, setCreateLoading] = useState(false);

  // Join password modal
  const [joinModal, setJoinModal] = useState(null);
  const [joinPassword, setJoinPassword] = useState('');

  // Email verification banner
  const [emailVerifiedToast, setEmailVerifiedToast] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  useEffect(() => {
    if (searchParams.get('email_verified') === '1') {
      setEmailVerifiedToast(true);
      // Clean URL without reloading
      window.history.replaceState({}, '', '/');
    }
  }, [searchParams]);

  const handleResendVerification = async () => {
    if (!token || resendLoading) return;
    setResendLoading(true);
    try {
      await fetch(`${API}/auth/resend-verification`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      setResendDone(true);
    } catch { /* ignore */ } finally {
      setResendLoading(false);
    }
  };

  const fetchRooms = useCallback(async () => {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API}/rooms`, { headers });
      if (res.ok) setRooms(await res.json() || []);
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => {
    fetchRooms();
    const interval = setInterval(fetchRooms, 10000);
    return () => clearInterval(interval);
  }, [fetchRooms]);

  useEffect(() => {
    const roomId = searchParams.get('room');
    if (roomId && !user) setGuestModal(true);
  }, [searchParams, user]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      if (authMode === 'login') {
        const result = await login(authForm.username, authForm.password);
        if (result?.totp_required) {
          setTotpStep({ temp_token: result.temp_token });
          setAuthLoading(false);
          return;
        }
        if (result?.totp_setup_required) {
          // Admin requires 2FA — open the setup modal in forced mode.
          setTotpForcedTemp(result.temp_token);
          setAuthModal(false);
          setAuthForm({ username: '', password: '' });
          setTotpModal(true);
          setAuthLoading(false);
          return;
        }
      } else {
        if (!authForm.isAdult) {
          setAuthError('Подтвердите, что вам есть 18 лет — это требуется для комнат 18+');
          setAuthLoading(false);
          return;
        }
        await register(authForm.username, authForm.password, authForm.email, authForm.isAdult);
        await login(authForm.username, authForm.password);
      }
      setAuthModal(false);
      setAuthForm({ username: '', password: '' });
    } catch (err) {
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTOTPSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      await loginTOTP(totpStep.temp_token, totpCode);
      setAuthModal(false);
      setTotpStep(null);
      setTotpCode('');
    } catch (err) {
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGuestJoin = (e) => {
    e.preventDefault();
    loginAsGuest(guestName || 'Гость');
    setGuestModal(false);
    const roomId = searchParams.get('room');
    if (roomId) navigate(`/room/${roomId}`);
  };

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (!user) { setGuestModal(true); return; }
    if (user.is_guest) { setError('Гости не могут создавать комнаты. Войдите в аккаунт.'); return; }
    setCreateLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: createForm.name,
          room_type: createForm.roomType,
          is_public: createForm.roomType !== 3,
          password: createForm.password || '',
          persistent: createForm.persistent,
          is_adult: createForm.isAdult,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Ошибка создания комнаты');
      }
      const room = await res.json();
      navigate(`/room/${room.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreateLoading(false);
      setCreateModal(false);
    }
  };

  const handleDeleteRoom = async (e, roomId) => {
    e.stopPropagation();
    if (!confirm('Удалить комнату?')) return;
    try {
      const res = await fetch(`${API}/rooms/${roomId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.message || 'Не удалось удалить комнату');
        return;
      }
      setRooms(prev => prev.filter(r => r.id !== roomId));
    } catch {
      setError('Не удалось удалить комнату');
    }
  };

  const roomType = (room) => room.room_type || (room.settings?.password ? 2 : room.settings?.is_public === false ? 3 : 1);

  const handleJoinRoom = (room) => {
    if (!user) { setGuestModal(true); return; }
    const rt = roomType(room);
    if (rt === 3 && user.is_guest) { setError('Эта комната требует аккаунт.'); return; }
    // 18+ gate: adult rooms require a user who confirmed being 18+
    if (room.settings?.is_adult && user?.preferences?.is_adult !== true) {
      setError('Эта комната 18+ 🔞 — подтвердите возраст (18+) в профиле, чтобы войти.');
      return;
    }
    if (rt === 2) { setJoinModal({ room }); return; }
    navigate(`/room/${room.id}`);
  };

  const handleJoinWithPassword = async (e) => {
    e.preventDefault();
    if (!joinModal) return;
    setError('');
    try {
      const res = await fetch(`${API}/rooms/${joinModal.room.id}/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ password: joinPassword }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.code === 'adult_required') setError(err.message || 'Комната 18+ — подтвердите возраст');
        else setError('Неверный пароль');
        return;
      }
    } catch { /* allow */ }
    setJoinModal(null);
    navigate(`/room/${joinModal.room.id}`);
  };

  const roomTypeLabel = (t) => ({ 1: 'Публичная', 2: 'Пароль', 3: 'Приватная' }[t] || 'Публичная');
  const roomTypeColor = (t) => ({ 1: '#4ade80', 2: '#fbbf24', 3: '#f87171' }[t] || '#4ade80');

  return (
    <div style={{ minHeight: '100dvh', padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Email verified toast */}
      {emailVerifiedToast && (
        <div style={{ background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.35)', borderRadius: 10, padding: '0.75rem 1.1rem', marginBottom: '1.2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <span style={{ color: '#4ade80', fontWeight: 600, fontSize: '0.88rem' }}>✓ Email успешно подтверждён!</span>
          <button onClick={() => setEmailVerifiedToast(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
        </div>
      )}

      {/* Email verification reminder */}
      {user && !user.is_guest && user.email && !user.email_verified && !resendDone && (
        <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 10, padding: '0.75rem 1.1rem', marginBottom: '1.2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ color: '#fbbf24', fontSize: '0.85rem' }}>⚠ Подтвердите email <b>{user.email}</b> — проверьте почту</span>
          <button onClick={handleResendVerification} disabled={resendLoading} style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '0.3rem 0.8rem', color: '#fbbf24', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 500 }}>
            {resendLoading ? '...' : 'Отправить снова'}
          </button>
        </div>
      )}
      {resendDone && (
        <div style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 10, padding: '0.6rem 1.1rem', marginBottom: '1.2rem', color: '#4ade80', fontSize: '0.85rem' }}>
          ✓ Письмо отправлено — проверьте почту
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2.5rem' }}>
        <div>
          <h1 style={{
            fontSize: '2rem', fontWeight: 700,
            background: 'linear-gradient(135deg, #7c6ff7, #ff6b9d)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>WatchSync</h1>
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.9rem', marginTop: '0.2rem' }}>
            Синхронизированный просмотр видео в группах
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {user ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {user.is_guest && (
                  <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '10px', background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                    гость
                  </span>
                )}
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.9rem' }}>{user.username}</span>
              </div>
              {user.subscription_tier === 'admin' && (
                <button className="btn-primary" style={{ fontSize: '0.82rem', background: 'rgba(124,111,247,0.2)' }} onClick={() => navigate('/admin')}>
                  Админ
                </button>
              )}
              <div style={{ position: 'relative' }}>
                <button onClick={() => setThemeMenuOpen(v => !v)} title="Тема"
                  style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem' }}>
                  {themes.find(x => x.id === theme)?.icon || '🎨'}
                </button>
                {themeMenuOpen && (
                  <>
                    <div onClick={() => setThemeMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 61, background: '#13131c', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', padding: '0.35rem', display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                      {themes.map((th) => (
                        <button key={th.id} onClick={() => { setTheme(th.id); setThemeMenuOpen(false); }}
                          style={{ background: theme === th.id ? 'rgba(124,111,247,0.2)' : 'none', border: 'none', borderRadius: '6px', padding: '0.45rem 0.75rem', cursor: 'pointer', color: theme === th.id ? '#a78bfa' : 'rgba(255,255,255,0.7)', fontSize: '0.82rem', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span>{th.icon}</span> {th.label}
                          {theme === th.id && <span style={{ marginLeft: 'auto', color: '#a78bfa' }}>✓</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => i18n.changeLanguage(i18n.language === 'ru' ? 'en' : 'ru')}
                title={i18n.language === 'ru' ? t('lang_en') : t('lang_ru')}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.02em' }}>
                {i18n.language === 'ru' ? 'EN' : 'RU'}
              </button>
              {user.is_guest ? (
                <button className="btn-primary" style={{ fontSize: '0.82rem' }} onClick={() => { logout(); setAuthModal(true); }}>
                  Войти
                </button>
              ) : (
                <>
                  <button className="btn-primary" style={{ background: 'rgba(124,111,247,0.15)', fontSize: '0.82rem', border: '1px solid rgba(124,111,247,0.25)' }} onClick={() => navigate('/profile')}
                    title="Личный кабинет">
                    👤 Профиль
                  </button>
                  <button className="btn-primary" style={{ background: 'rgba(255,255,255,0.06)', fontSize: '0.78rem', border: '1px solid rgba(255,255,255,0.1)' }} onClick={() => setTotpModal(true)} title="Двухфакторная аутентификация">
                    🔐 2FA
                  </button>
                  <button className="btn-primary" style={{ background: 'rgba(255,255,255,0.1)', fontSize: '0.82rem' }} onClick={logout}>
                    Выйти
                  </button>
                </>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn-primary" style={{ background: 'rgba(255,255,255,0.1)', fontSize: '0.82rem' }} onClick={() => setGuestModal(true)}>
                Войти как гость
              </button>
              <button
                className="btn-primary"
                style={{ background: 'rgba(124,111,247,0.18)', fontSize: '0.82rem', border: '1px solid rgba(124,111,247,0.35)' }}
                onClick={async () => { try { await loginAnonymous(); } catch (e) { setError(e.message); } }}
                title="Войти без регистрации — без email и пароля"
              >
                Анонимно
              </button>
              <button className="btn-primary" style={{ fontSize: '0.82rem' }} onClick={() => setAuthModal(true)}>
                Войти
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', color: '#f87171', fontSize: '0.9rem' }}>
          {error}
          <button style={{ float: 'right', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }} onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* Rooms */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <h2 style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>Комнаты</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.35rem 0.75rem', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '0.8rem' }} onClick={fetchRooms}>
            Обновить
          </button>
          <button className="btn-primary" style={{ fontSize: '0.82rem' }} onClick={() => {
            if (!user) setGuestModal(true);
            else if (user.is_guest) setError('Гости не могут создавать комнаты. Войдите в аккаунт.');
            else setCreateModal(true);
          }}>
            + Создать комнату
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {rooms.length === 0 && (
          <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'rgba(255,255,255,0.3)', gridColumn: '1 / -1' }}>
            Комнат нет. Создайте первую!
          </div>
        )}
        {rooms.map((room) => {
          const rt = roomType(room);
          return (
            <div
              key={room.id}
              className="glass"
              style={{ padding: '1.25rem', cursor: 'pointer', transition: 'border-color 0.2s', position: 'relative' }}
              onClick={() => handleJoinRoom(room)}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'rgba(124,111,247,0.4)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <h3 style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '1rem', flex: 1, marginRight: '0.5rem' }}>{room.name}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                  <span style={{
                    fontSize: '0.7rem', fontWeight: 500, padding: '0.2rem 0.5rem', borderRadius: '4px',
                    background: `${roomTypeColor(rt)}22`, color: roomTypeColor(rt),
                    border: `1px solid ${roomTypeColor(rt)}44`,
                  }}>
                    {roomTypeLabel(rt)}
                  </span>
                  {room.settings?.is_adult && (
                    <span style={{
                      fontSize: '0.7rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '4px',
                      background: 'rgba(255,107,157,0.12)', color: '#ff6b9d',
                      border: '1px solid rgba(255,107,157,0.35)',
                    }}>
                      🔞 18+
                    </span>
                  )}
                  {user && (user.owner_id === room.owner_id || room.owner_id === user.id || user.subscription_tier === 'admin') && (
                    <button
                      onClick={(e) => handleDeleteRoom(e, room.id)}
                      title="Удалить комнату"
                      style={{
                        background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)',
                        borderRadius: '4px', color: '#f87171', cursor: 'pointer',
                        fontSize: '0.75rem', padding: '0.15rem 0.4rem', lineHeight: 1.2,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(248,113,113,0.3)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(248,113,113,0.15)'; }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>{room.member_count ?? 0} смотрят</span>
                {!room.expires_at && (
                  <span title="Постоянная комната" style={{ fontSize: '0.7rem', color: '#7c6ff7', opacity: 0.7 }}>∞</span>
                )}
              </div>
              {rt === 3 && (
                <div style={{ fontSize: '0.72rem', color: '#f87171', marginTop: '0.3rem' }}>Требуется аккаунт</div>
              )}
              <div style={{ marginTop: '1rem' }}>
                <span className="btn-primary" style={{ display: 'inline-block', fontSize: '0.82rem', padding: '0.4rem 1rem' }}>
                  Войти
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Guest Modal ── */}
      {guestModal && (
        <Modal onClose={() => setGuestModal(false)}>
          <h2 style={{ fontWeight: 700, fontSize: '1.25rem', marginBottom: '0.5rem', color: '#e2e8f0' }}>Войти как гость</h2>
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
            Аккаунт не нужен. Доступны публичные и комнаты с паролем.<br />
            <span style={{ color: 'rgba(255,255,255,0.25)' }}>Гости не могут создавать комнаты и входить в приватные.</span>
          </p>
          <form onSubmit={handleGuestJoin} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <input
              className="input-base"
              placeholder="Ваше имя (необязательно)"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              maxLength={32}
              autoFocus
            />
            <button className="btn-primary" type="submit" style={{ background: '#fbbf24', color: '#09090f' }}>
              Войти как гость
            </button>
          </form>
          <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.82rem', color: 'rgba(255,255,255,0.35)' }}>
            Есть аккаунт?{' '}
            <button style={{ color: '#7c6ff7', background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => { setGuestModal(false); setAuthModal(true); }}>
              Войти
            </button>
          </div>
        </Modal>
      )}

      {/* ── Auth Modal ── */}
      {authModal && (
        <Modal onClose={() => { setAuthModal(false); setTotpStep(null); setTotpCode(''); }}>
          {totpStep ? (
            <>
              <h2 style={{ fontWeight: 700, fontSize: '1.25rem', marginBottom: '0.5rem', color: '#e2e8f0' }}>Двухфакторная аутентификация</h2>
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
                Введите 6-значный код из приложения-аутентификатора
              </p>
              {authError && <div style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '1rem' }}>{authError}</div>}
              <form onSubmit={handleTOTPSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <input
                  className="input-base"
                  placeholder="000000"
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  inputMode="numeric"
                  autoFocus
                  required
                  style={{ textAlign: 'center', letterSpacing: '0.3em', fontSize: '1.4rem' }}
                />
                <button className="btn-primary" type="submit" disabled={authLoading || totpCode.length !== 6}>
                  {authLoading ? 'Проверка...' : 'Подтвердить'}
                </button>
              </form>
              <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
                <button style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => { setTotpStep(null); setTotpCode(''); setAuthError(''); }}>
                  ← Назад
                </button>
              </div>
            </>
          ) : (
            <>
          <h2 style={{ fontWeight: 700, fontSize: '1.25rem', marginBottom: '1.5rem', color: '#e2e8f0' }}>
            {authMode === 'login' ? 'Вход' : 'Регистрация'}
          </h2>
          {authError && <div style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '1rem' }}>{authError}</div>}
          <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input className="input-base" placeholder="Логин" value={authForm.username}
              onChange={(e) => setAuthForm(f => ({ ...f, username: e.target.value }))} required autoFocus />
            {authMode === 'register' && (
              <input className="input-base" placeholder="Email (необязательно)" type="email" value={authForm.email}
                onChange={(e) => setAuthForm(f => ({ ...f, email: e.target.value }))} />
            )}
            <input className="input-base" placeholder="Пароль" type="password" value={authForm.password}
              onChange={(e) => setAuthForm(f => ({ ...f, password: e.target.value }))} required />
            {authMode === 'register' && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', userSelect: 'none',
                background: authForm.isAdult ? 'rgba(255,107,157,0.12)' : 'rgba(255,255,255,0.04)',
                border: authForm.isAdult ? '1px solid rgba(255,107,157,0.55)' : '1px solid rgba(255,107,157,0.25)',
                borderRadius: '8px', padding: '0.65rem 0.75rem',
              }}>
                <input
                  type="checkbox"
                  checked={authForm.isAdult}
                  onChange={(e) => setAuthForm(f => ({ ...f, isAdult: e.target.checked }))}
                  style={{ width: 20, height: 20, accentColor: '#ff6b9d', cursor: 'pointer', flexShrink: 0 }}
                />
                <span style={{ fontSize: '0.85rem', color: authForm.isAdult ? '#ff8db5' : 'rgba(255,255,255,0.7)', fontWeight: 600 }}>
                  Мне есть 18 лет 🔞
                  <span style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', fontWeight: 400, marginTop: '0.1rem' }}>
                    Требуется для просмотра контента 18+
                  </span>
                </span>
              </label>
            )}
            <button className="btn-primary" type="submit" disabled={authLoading}>
              {authLoading ? 'Загрузка...' : authMode === 'login' ? 'Войти' : 'Зарегистрироваться'}
            </button>
          </form>
          <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.85rem', color: 'rgba(255,255,255,0.4)' }}>
            {authMode === 'login' ? (
              <span>Нет аккаунта?{' '}
                <button style={{ color: '#7c6ff7', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setAuthMode('register')}>Регистрация</button>
              </span>
            ) : (
              <span>Уже есть аккаунт?{' '}
                <button style={{ color: '#7c6ff7', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setAuthMode('login')}>Войти</button>
              </span>
            )}
          </div>
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
            <button style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => { setAuthModal(false); setGuestModal(true); }}>
              или войти как гость →
            </button>
          </div>
            </>
          )}
        </Modal>
      )}

      {/* ── TOTP Setup Modal ── */}
      {totpModal && (
        <Modal onClose={() => { setTotpModal(false); setTotpSetup(null); setTotpSetupCode(''); setTotpDisableCode(''); setTotpModalError(''); setTotpForcedTemp(null); }}>
          <h2 style={{ fontWeight: 700, fontSize: '1.2rem', marginBottom: '0.5rem', color: '#e2e8f0' }}>Двухфакторная аутентификация</h2>
          {totpForcedTemp && (
            <div style={{ background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '0.5rem 0.75rem', color: '#fbbf24', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
              Администратор требует включить 2FA. Настройте её для входа.
            </div>
          )}
          {totpModalError && <div style={{ color: '#f87171', fontSize: '0.82rem', marginBottom: '0.75rem' }}>{totpModalError}</div>}
          {!totpSetup ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.82rem' }}>
                {totpForcedTemp
                  ? 'Настройте приложение-аутентификатор, чтобы продолжить вход.'
                  : (user?.totp_enabled
                      ? '2FA включена. Можно отключить.'
                      : '2FA не настроена. Подключите TOTP-аутентификатор (Google Authenticator, Authy и т.д.)')}
              </p>
              {user?.totp_enabled && !totpForcedTemp ? (
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  setTotpModalError('');
                  try {
                    const res = await fetch('/api/v1/auth/totp/disable', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ code: totpDisableCode }),
                    });
                    if (!res.ok) { const d = await res.json(); throw new Error(d.message); }
                    await refreshUser();
                    setTotpModal(false);
                    setTotpDisableCode('');
                  } catch (err) { setTotpModalError(err.message); }
                }} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <input className="input-base" placeholder="Код из приложения" value={totpDisableCode}
                    onChange={e => setTotpDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric" maxLength={6} style={{ textAlign: 'center', letterSpacing: '0.25em' }} />
                  <button className="btn-primary" type="submit" style={{ background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.4)', color: '#f87171' }}>
                    Отключить 2FA
                  </button>
                </form>
              ) : (
                <button className="btn-primary" onClick={async () => {
                  setTotpModalError('');
                  const headers = totpForcedTemp
                    ? { 'Content-Type': 'application/json' }
                    : { Authorization: `Bearer ${token}` };
                  const body = totpForcedTemp ? JSON.stringify({ temp_token: totpForcedTemp }) : undefined;
                  const res = await fetch('/api/v1/auth/totp/setup', { method: 'POST', headers, body });
                  if (res.ok) setTotpSetup(await res.json());
                  else { const d = await res.json(); setTotpModalError(d.message); }
                }}>
                  Настроить 2FA →
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.82rem' }}>
                Отсканируйте QR-код в приложении-аутентификаторе, затем введите код для подтверждения.
              </p>
              <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '0.75rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                <span style={{ color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: '0.25rem' }}>otpauth URI (вставьте в приложение):</span>
                {totpSetup.qr_url}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.78rem', background: 'rgba(255,255,255,0.05)', padding: '0.5rem 0.75rem', borderRadius: '6px', color: '#a78bfa', wordBreak: 'break-all' }}>
                {totpSetup.secret}
              </div>
              <form onSubmit={async (e) => {
                e.preventDefault();
                setTotpModalError('');
                try {
                  if (totpForcedTemp) {
                    await enableTOTPForced(totpForcedTemp, totpSetupCode);
                  } else {
                    const res = await fetch('/api/v1/auth/totp/enable', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ code: totpSetupCode }),
                    });
                    if (!res.ok) { const d = await res.json(); throw new Error(d.message); }
                    await refreshUser();
                  }
                  setTotpModal(false);
                  setTotpSetup(null);
                  setTotpSetupCode('');
                  setTotpForcedTemp(null);
                } catch (err) { setTotpModalError(err.message); }
              }} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <input className="input-base" placeholder="000000" value={totpSetupCode}
                  onChange={e => setTotpSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" maxLength={6} autoFocus style={{ textAlign: 'center', letterSpacing: '0.25em', fontSize: '1.2rem' }} />
                <button className="btn-primary" type="submit" disabled={totpSetupCode.length !== 6}>
                  {totpForcedTemp ? 'Подтвердить и войти' : 'Подтвердить и включить'}
                </button>
              </form>
            </div>
          )}
        </Modal>
      )}

      {/* ── Create Room Modal ── */}
      {createModal && (
        <Modal onClose={() => setCreateModal(false)}>
          <h2 style={{ fontWeight: 700, fontSize: '1.25rem', marginBottom: '1.5rem', color: '#e2e8f0' }}>Создать комнату</h2>
          <form onSubmit={handleCreateRoom} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input className="input-base" placeholder="Название комнаты" value={createForm.name}
              onChange={(e) => setCreateForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {[['Публичная', 1], ['С паролем', 2], ['Приватная', 3]].map(([label, type]) => (
                <button key={type} type="button"
                  onClick={() => setCreateForm(f => ({ ...f, roomType: type }))}
                  style={{
                    flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid',
                    borderColor: createForm.roomType === type ? '#7c6ff7' : 'rgba(255,255,255,0.12)',
                    background: createForm.roomType === type ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.05)',
                    color: createForm.roomType === type ? '#7c6ff7' : 'rgba(255,255,255,0.5)',
                    cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500,
                  }}>
                  {label}
                </button>
              ))}
            </div>
            {createForm.roomType === 2 && (
              <input className="input-base" placeholder="Пароль комнаты" type="password"
                value={createForm.password} onChange={(e) => setCreateForm(f => ({ ...f, password: e.target.value }))} required />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={createForm.persistent}
                onChange={(e) => setCreateForm(f => ({ ...f, persistent: e.target.checked }))}
                style={{ width: 16, height: 16, accentColor: '#7c6ff7', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)' }}>
                Постоянная комната
                <span style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', marginTop: '0.1rem' }}>
                  Не удаляется автоматически через 24 часа
                </span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={createForm.isAdult}
                onChange={(e) => setCreateForm(f => ({ ...f, isAdult: e.target.checked }))}
                style={{ width: 16, height: 16, accentColor: '#ff6b9d', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.6)' }}>
                🔞 Комната 18+
                <span style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', marginTop: '0.1rem' }}>
                  Войти могут только пользователи с подтверждённым возрастом 18+
                </span>
              </span>
            </label>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button type="button" className="btn-primary" style={{ flex: 1, background: 'rgba(255,255,255,0.1)' }} onClick={() => setCreateModal(false)}>Отмена</button>
              <button className="btn-primary" type="submit" disabled={createLoading} style={{ flex: 1 }}>
                {createLoading ? 'Создание...' : 'Создать'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Join Password Modal ── */}
      {joinModal && (
        <Modal onClose={() => setJoinModal(null)}>
          <h2 style={{ fontWeight: 700, fontSize: '1.25rem', marginBottom: '0.5rem', color: '#e2e8f0' }}>Введите пароль</h2>
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
            Комната «{joinModal.room.name}» защищена паролем.
          </p>
          <form onSubmit={handleJoinWithPassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input className="input-base" placeholder="Пароль" type="password"
              value={joinPassword} onChange={(e) => setJoinPassword(e.target.value)} autoFocus required />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="button" className="btn-primary" style={{ flex: 1, background: 'rgba(255,255,255,0.1)' }} onClick={() => setJoinModal(null)}>Отмена</button>
              <button className="btn-primary" type="submit" style={{ flex: 1 }}>Войти</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass" style={{
        width: '100%', maxWidth: '400px', padding: '2rem', margin: '1rem', position: 'relative',
        maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1 }}>×</button>
        {children}
      </div>
    </div>
  );
}
