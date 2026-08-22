import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ruCommon from './locales/ru/common.json';
import ruRooms  from './locales/ru/rooms.json';
import ruAuth   from './locales/ru/auth.json';
import ruPlayer from './locales/ru/player.json';
import enCommon from './locales/en/common.json';
import enRooms  from './locales/en/rooms.json';
import enAuth   from './locales/en/auth.json';
import enPlayer from './locales/en/player.json';

const savedLang = (() => {
  try { return localStorage.getItem('ws_language') || 'ru'; } catch { return 'ru'; }
})();

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ru: { common: ruCommon, rooms: ruRooms, auth: ruAuth, player: ruPlayer },
      en: { common: enCommon, rooms: enRooms, auth: enAuth, player: enPlayer },
    },
    lng: savedLang,
    fallbackLng: 'ru',
    defaultNS: 'common',
    ns: ['common', 'rooms', 'auth', 'player'],
    initImmediate: false,
    interpolation: { escapeValue: false },
  });

i18n.on('languageChanged', (lng) => {
  try { localStorage.setItem('ws_language', lng); } catch {}
});

export default i18n;
