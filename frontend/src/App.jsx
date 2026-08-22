import React, { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from './i18n.js';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { ThemeProvider } from './contexts/ThemeContext.jsx';
import ParticlesBackground from './components/ParticlesBackground.jsx';

const RoomSelect = lazy(() => import('./pages/RoomSelect.jsx'));
const Player = lazy(() => import('./pages/Player.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const FileManager = lazy(() => import('./pages/FileManager.jsx'));
const CacheManager = lazy(() => import('./pages/CacheManager.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      // Show banner only once per session
      if (!sessionStorage.getItem('pwa-dismissed')) {
        setVisible(true);
      }
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setVisible(false);
    setDeferredPrompt(null);
  };

  const dismiss = () => {
    sessionStorage.setItem('pwa-dismissed', '1');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', bottom: '1.2rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, display: 'flex', alignItems: 'center', gap: '0.75rem',
      background: 'rgba(18,18,30,0.96)', border: '1px solid rgba(124,111,247,0.35)',
      borderRadius: '12px', padding: '0.75rem 1.1rem',
      backdropFilter: 'blur(12px)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      maxWidth: '90vw',
    }}>
      <img src="/icons/icon.svg" alt="" style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#fff', fontWeight: 600, fontSize: '0.85rem', lineHeight: 1.3 }}>Установить WatchSync</div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.73rem' }}>Смотрите без браузера</div>
      </div>
      <button
        onClick={install}
        style={{ background: '#7c6ff7', color: '#fff', border: 'none', borderRadius: 8, padding: '0.4rem 0.85rem', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', flexShrink: 0 }}
      >
        Установить
      </button>
      <button
        onClick={dismiss}
        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '1.1rem', cursor: 'pointer', padding: '0.2rem', lineHeight: 1, flexShrink: 0 }}
        aria-label="Закрыть"
      >
        ×
      </button>
    </div>
  );
}

function App() {
  const isMobile = window.innerWidth < 768;
  return (
    <I18nextProvider i18n={i18n}>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          {!isMobile && <ParticlesBackground />}
          <div style={{ position: 'relative', zIndex: 1, minHeight: '100dvh' }}>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<RoomSelect />} />
                <Route path="/room/:roomId" element={<Player />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/files" element={<FileManager />} />
                <Route path="/cache" element={<CacheManager />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </div>
          <InstallPrompt />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
    </I18nextProvider>
  );
}

export default App;
