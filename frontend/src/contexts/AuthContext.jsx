import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

const API_BASE = '/api/v1';

// Retry a network fetch on transient failures (flaky mobile connections,
// operator DPI resets). Only retries when the request never got a response
// (TypeError = network error); real server responses (4xx/5xx) return as-is.
async function fetchRetry(url, options, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const g = localStorage.getItem('ws_guest');
    return g ? JSON.parse(g) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('ws_token'));
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async (accessToken) => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  // Restore session on mount: try stored token → if expired try refresh → give up
  useEffect(() => {
    const restore = async () => {
      const storedToken = localStorage.getItem('ws_token');
      const storedRefresh = localStorage.getItem('ws_refresh');

      if (!storedToken) { setLoading(false); return; }

      // Try existing access token first (fast path — no network round-trip if valid)
      let u = await fetchMe(storedToken);
      if (u) {
        setUser(u);
        setToken(storedToken);
        localStorage.removeItem('ws_guest');
        setLoading(false);
        return;
      }

      // Access token expired — try to refresh silently
      if (storedRefresh) {
        try {
          const res = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: storedRefresh }),
          });
          if (res.ok) {
            const data = await res.json();
            localStorage.setItem('ws_token', data.access_token);
            if (data.refresh_token) localStorage.setItem('ws_refresh', data.refresh_token);
            u = await fetchMe(data.access_token);
            if (u) {
              setUser(u);
              setToken(data.access_token);
              localStorage.removeItem('ws_guest');
            }
          }
        } catch { /* network error — stay logged out */ }
      }

      // If anon_token stored but refresh also failed, try silent anonymous re-login
      const anonUsername = localStorage.getItem('ws_anon_username');
      const anonToken = localStorage.getItem('ws_anon_token');
      if (anonUsername && anonToken) {
        try {
          const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: anonUsername, password: anonToken }),
          });
          if (res.ok) {
            const data = await res.json();
            localStorage.setItem('ws_token', data.access_token);
            if (data.refresh_token) localStorage.setItem('ws_refresh', data.refresh_token);
            const u2 = await fetchMe(data.access_token);
            if (u2) { setUser(u2); setToken(data.access_token); }
          }
        } catch { /* ignore */ }
      }

      setLoading(false);
    };
    restore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const subscribePush = useCallback(async (accessToken) => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const keyRes = await fetch('/api/v1/push/vapid-key');
      if (!keyRes.ok) return;
      const { public_key: vapidKey } = await keyRes.json();

      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });

      await fetch('/api/v1/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(sub),
      });
    } catch (e) {
      console.warn('Push subscription failed:', e);
    }
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await fetchRetry(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Login failed');
    }
    const data = await res.json();
    // Admin-forced 2FA setup required — return marker so caller opens the setup modal.
    if (data.totp_setup_required) return { totp_setup_required: true, temp_token: data.temp_token };
    // 2FA required — return special marker for caller to handle TOTP step
    if (data.totp_required) return { totp_required: true, temp_token: data.temp_token };

    localStorage.setItem('ws_token', data.access_token);
    localStorage.setItem('ws_refresh', data.refresh_token);
    setToken(data.access_token);
    const me = await fetchMe(data.access_token);
    setUser(me);
    subscribePush(data.access_token);
    return me;
  }, [fetchMe, subscribePush]);

  const loginTOTP = useCallback(async (tempToken, code) => {
    const res = await fetch(`${API_BASE}/auth/totp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp_token: tempToken, code }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Invalid code');
    }
    const data = await res.json();
    localStorage.setItem('ws_token', data.access_token);
    localStorage.setItem('ws_refresh', data.refresh_token);
    setToken(data.access_token);
    const me = await fetchMe(data.access_token);
    setUser(me);
    subscribePush(data.access_token);
    return me;
  }, [fetchMe, subscribePush]);

  // Complete forced 2FA setup (admin-required): returns full auth tokens.
  const enableTOTPForced = useCallback(async (tempToken, code) => {
    const res = await fetch(`${API_BASE}/auth/totp/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp_token: tempToken, code }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Invalid code');
    }
    const data = await res.json();
    localStorage.setItem('ws_token', data.access_token);
    localStorage.setItem('ws_refresh', data.refresh_token);
    setToken(data.access_token);
    const me = await fetchMe(data.access_token);
    setUser(me);
    subscribePush(data.access_token);
    return me;
  }, [fetchMe, subscribePush]);

  // Re-fetch current user (used after enabling/disabling 2FA to refresh totp_enabled).
  const refreshUser = useCallback(async () => {
    const t = localStorage.getItem('ws_token');
    if (!t) return null;
    const u = await fetchMe(t);
    if (u) setUser(u);
    return u;
  }, [fetchMe]);

  const register = useCallback(async (username, password, email = '', isAdult = false) => {
    const res = await fetchRetry(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, ...(email ? { email } : {}), is_adult: isAdult }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Registration failed');
    }
    return await res.json();
  }, []);

  const loginAsGuest = useCallback((username) => {
    const guestUser = {
      id: 'guest_' + Math.random().toString(36).slice(2, 10),
      username: (username || 'Guest').trim().slice(0, 32),
      is_guest: true,
    };
    localStorage.setItem('ws_guest', JSON.stringify(guestUser));
    setUser(guestUser);
    return guestUser;
  }, []);

  const loginAnonymous = useCallback(async () => {
    const res = await fetchRetry(`${API_BASE}/auth/anonymous`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Anonymous login failed');
    }
    const data = await res.json();
    localStorage.setItem('ws_token', data.access_token);
    localStorage.setItem('ws_refresh', data.refresh_token);
    // Store anon credentials so session can be restored after token expiry
    if (data.anon_token) {
      localStorage.setItem('ws_anon_username', data.username);
      localStorage.setItem('ws_anon_token', data.anon_token);
    }
    localStorage.removeItem('ws_guest');
    setToken(data.access_token);
    const me = await fetchMe(data.access_token);
    setUser(me || { id: data.user_id, username: data.username, is_anonymous: true });
    return me;
  }, [fetchMe]);

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem('ws_refresh');
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // ignore
    }
    localStorage.removeItem('ws_token');
    localStorage.removeItem('ws_refresh');
    localStorage.removeItem('ws_guest');
    localStorage.removeItem('ws_anon_username');
    localStorage.removeItem('ws_anon_token');
    setToken(null);
    setUser(null);
  }, [token]);

  const refreshToken = useCallback(async () => {
    const rt = localStorage.getItem('ws_refresh');
    if (!rt) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem('ws_token', data.access_token);
      setToken(data.access_token);
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, loginTOTP, register, logout, refreshToken, loginAsGuest, loginAnonymous, subscribePush, refreshUser, enableTOTPForced }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
