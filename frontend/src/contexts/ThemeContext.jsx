import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

const ThemeContext = createContext(null);

const THEMES = ['dark', 'light', 'amoled', 'custom'];

const THEME_META = {
  dark:   { label: 'Тёмная', icon: '🌙' },
  light:  { label: 'Светлая', icon: '☀️' },
  amoled: { label: 'AMOLED', icon: '⬛' },
  custom: { label: 'Кастомная', icon: '🎨' },
};

// Default custom palette — editable via CSS variables (persisted in localStorage).
// Profile sync is out of scope for now (deferred until the personal account lands).
const DEFAULT_CUSTOM = {
  '--bg': '#0f1419',
  '--bg2': '#1a2029',
  '--primary': '#22d3ee',
  '--accent': '#f472b6',
  '--success': '#34d399',
  '--danger': '#fb7185',
  '--text': '#e6edf3',
};

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    const saved = localStorage.getItem('ws_theme');
    return THEMES.includes(saved) ? saved : 'dark';
  });

  const [customTheme, setCustomTheme] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ws_theme_custom') || 'null');
      if (saved && typeof saved === 'object') return { ...DEFAULT_CUSTOM, ...saved };
    } catch { /* ignore malformed saved theme */ }
    return { ...DEFAULT_CUSTOM };
  });

  // Apply the theme attribute + custom CSS-variable overrides
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ws_theme', theme);

    const root = document.documentElement;
    if (theme === 'custom') {
      Object.entries(customTheme).forEach(([k, v]) => root.style.setProperty(k, v));
    }

    // Cleanup runs before the next theme change: remove inline custom vars when
    // switching away from the custom theme so CSS defaults take over again.
    return () => {
      if (theme !== 'custom') return;
      Object.keys(customTheme).forEach(k => root.style.removeProperty(k));
    };
  }, [theme, customTheme]);

  useEffect(() => {
    localStorage.setItem('ws_theme_custom', JSON.stringify(customTheme));
  }, [customTheme]);

  const setTheme = useCallback((t) => {
    if (THEMES.includes(t)) setThemeState(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(t => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }, []);

  const setCustomThemeVar = useCallback((name, value) => {
    setCustomTheme(prev => ({ ...prev, [name]: value }));
  }, []);

  const resetCustomTheme = useCallback(() => {
    setCustomTheme({ ...DEFAULT_CUSTOM });
  }, []);

  const themes = useMemo(() => THEMES.map(id => ({ id, ...THEME_META[id] })), []);

  return (
    <ThemeContext.Provider value={{
      theme,
      themes,
      setTheme,
      toggleTheme,
      customTheme,
      setCustomThemeVar,
      resetCustomTheme,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
