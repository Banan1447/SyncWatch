---
title: Desktop Application (Electron)
status: in_progress
progress: 90
last_audited: 2026-08-07
tags: [desktop, electron, windows, client]
---

# Desktop Application (Electron)

## Описание
Windows-приложение на Electron 32, оборачивающее веб-клиент WatchSync. Кастомный тайтлбар, системный трей, deep links (`watchsync://`), поддержка self-signed сертификатов, захват экрана, авто-сохранение позиции окна.

**Путь:** `desktop/`  
**Сборка:** `@electron/packager` (portable + NSIS инсталлятор)  
**Конфиг:** `%APPDATA%\watchsync-desktop\config.json`

## Реализовано

### Основная функциональность
- [x] Frameless window с кастомным тайтлбаром (inject CSS + JS на каждой странице)
- [x] Кнопки: свернуть, развернуть/восстановить, закрыть — синхронизированы с состоянием окна
- [x] Сохранение размера и позиции окна (`windowState.js` + `store.js`), восстановление при следующем запуске
- [x] Один экземпляр (`requestSingleInstanceLock`) — фокус при повторном запуске

### Настройки (store.js — кастомный JSON store вместо electron-store)
- [x] `serverUrl` — адрес WatchSync сервера (по умолчанию `https://localhost:8443`)
- [x] `launchMinimized` — запуск в свёрнутом виде
- [x] `minimizeToTray` — сворачивать в трей вместо закрытия
- [x] `hardwareAcceleration` — аппаратное ускорение (с предупреждением о перезапуске)
- [x] `notifications` — системные уведомления

### Setup-окно (`setup.html`)
- [x] Ввод адреса сервера с валидацией URL
- [x] Presets: localhost / LAN IP (автодетект из сохранённого URL)
- [x] Переключатели настроек: автозапуск с Windows, сворачивание в трей, уведомления
- [x] Показывается при первом запуске или при `serverUrl === 'https://localhost'`

### Системный трей
- [x] Иконка в трее с контекстным меню: Показать / Настройки сервера / Завершить
- [x] Клик по иконке — показать/сфокусировать окно
- [x] `app.isQuiting` флаг — разграничение «закрыть в трей» vs «завершить»

### Сетевые возможности
- [x] Trust self-signed SSL сертификатов от сервера (через `certificate-error` хук для хоста из `serverUrl`)
- [x] `webSecurity: false` + `allowRunningInsecureContent: true` для работы с локальными серверами
- [x] Страница ошибки (`error.html`) при недоступности сервера — кнопки Retry / Изменить адрес

### Медиа и захват экрана
- [x] `setPermissionRequestHandler` — разрешает `media`, `audioCapture`, `videoCapture`, `display-capture`, `notifications`, `fullscreen`
- [x] `setPermissionCheckHandler` — аналогично для проверки разрешений
- [x] `setDisplayMediaRequestHandler` — обработка `getDisplayMedia()` (screen share), `useSystemPicker: true`
- [x] `ipcMain.handle('screen:getSources')` → `desktopCapturer.getSources()` для кастомного пикера

### Deep links
- [x] Протокол `watchsync://` зарегистрирован в системе
- [x] Single instance: второй запуск передаёт URL первому через `second-instance` event
- [x] `open-url` (macOS) + `second-instance` (Windows) → `mainWindow.webContents.send('deep-link', url)`

### Дочерние окна (FileManager, etc.)
- [x] `setWindowOpenHandler` — внутренние URL (того же origin, что serverUrl) открываются в новом Electron BrowserWindow с preload.js, frameless, тёмный фон
- [x] `did-create-window` — инжектирует кастомный тайтлбар и устанавливает разрешения в дочерних окнах
- [x] `certificate-error` в дочерних окнах — аналогично трастит self-signed серт
- [x] Внешние ссылки — через `shell.openExternal()`

### IPC API (`preload.js`)
- [x] `electronAPI.minimize/maximize/close/isMaximized/onMaximizeChange` — управление окном
- [x] `electronAPI.getServerUrl/setServerUrl` — адрес сервера
- [x] `electronAPI.getSetting/setSetting` — настройки
- [x] `electronAPI.notify(title, body)` — системное уведомление
- [x] `electronAPI.onDeepLink(cb)` — callback на deep link
- [x] `electronAPI.getVersion()` — версия приложения
- [x] `electronAPI.openSetup()` — открыть setup-окно
- [x] `electronAPI.getScreenSources()` — источники для screen share (с превью 320×180)

### Сборка
- [x] `@electron/packager` — portable и NSIS инсталлятор
- [x] Иконка: `assets/icon.ico` (256×256, создана через PIL)
- [x] Трей: `assets/tray.png`
- [x] `package.json` без runtime зависимостей (electron-store заменён custom store.js)
- [x] Протоколы: `watchsync://` в NSIS инсталляторе

### Electron/Web совместимость
- [x] Player.jsx root height использует `calc(100vh - var(--titlebar-height, 0px))` — нижние 32px не обрезаются при инжекте тайтлбара (в браузере `--titlebar-height` не установлена → 0px → `100vh`)
- [x] Автозапуск с Windows: `app.setLoginItemSettings()` вызывается при изменении тоггла в setup.html, и при старте синхронизируется с системой
- [x] `autostart:get` IPC handler + `electronAPI.getAutostart()` — setup.html читает реальный статус из системного реестра вместо store
- [x] `autostart:set` направлен через существующий `settings:set` handler

### Auto-updater (кастомный)
- [x] На старте (8 сек задержка) проверяет `{serverUrl}/downloads/latest.json`
- [x] Сравнение semver версий — если сервер новее, предлагает скачать
- [x] Скачивает zip в `%TEMP%` через http/https (без external зависимостей)
- [x] Диалог подтверждения → запускает PowerShell-скрипт: распаковывает поверх, перезапускает exe
- [x] nginx раздаёт `/downloads/` из `./downloads/` (volume), `latest.json` + zip там же
- [x] `GET /api/v1/auth/desktop/version` — альтернативный эндпоинт версии через Kong (без авторизации)

## TODO

### 🔊 System Audio Capture — трансляция звука системы в комнату

Позволяет хосту захватить WASAPI loopback (то, что играет через колонки/наушники) и транслировать его другим участникам как отдельный аудиотрек через SFU.

#### Шаг 1 — Electron main process (`desktop/src/main.go`)

- [ ] **`ipcMain.handle('audio:getSystemSourceId')`** — вызывает `desktopCapturer.getSources({ types: ['screen'] })`, возвращает `sources[0].id` первого монитора. Этот ID используется как `chromeMediaSourceId` для WASAPI loopback.
- [ ] **Расширить `setDisplayMediaRequestHandler`** — добавить режим audio-only: если `request.audioRequested && !request.videoRequested`, вернуть `callback({ audio: 'loopback' })` без `video`. Нужно для захвата системного аудио без лишнего видеотрека.
- [ ] **Добавить `'loopback-desktop'` в `setPermissionRequestHandler`** — Electron 28+ требует явного разрешения для `desktopCapturer` audio loopback.

#### Шаг 2 — IPC bridge (`desktop/src/preload.js`)

- [ ] **`electronAPI.getSystemAudioSourceId()`** → `ipcRenderer.invoke('audio:getSystemSourceId')` — возвращает `chromeMediaSourceId` первого экрана.
- [ ] **`electronAPI.isElectron = true`** — явный флаг (сейчас только `electronAPI.platform` есть). Фронт проверяет `window.electronAPI?.isElectron` чтобы показывать кнопку системного аудио только в десктопе.

#### Шаг 3 — Захват аудио во фронте (`frontend/src/hooks/useSFUVoice.js`)

- [ ] **Метод `startSystemAudio()`**:
  1. `const sourceId = await window.electronAPI.getSystemAudioSourceId()`
  2. `const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } })` — Chromium требует video track даже для audio loopback; сразу останавливаем видео: `stream.getVideoTracks().forEach(t => t.stop())`
  3. `const audioTrack = stream.getAudioTracks()[0]`
  4. `const producer = await sendTransport.produce({ track: audioTrack, appData: { source: 'system' } })` — публикуем в SFU как второй producer с маркером `source: 'system'`
  5. Сохранить `sysAudioProducerRef` + `sysAudioStreamRef`

- [ ] **Метод `stopSystemAudio()`** — `sysAudioProducerRef.current?.close()`, `sysAudioStreamRef.current?.getTracks().forEach(t => t.stop())`, уведомить WS `{ type: 'system_audio_stop' }`

- [ ] **Состояние `isSystemAudio: bool`** — экспортировать из хука наружу для UI.

- [ ] **macOS (опционально, сложно)** — macOS 12 и ниже не поддерживают системное аудио без виртуального устройства (BlackHole/Soundflower). На macOS 13+ `getDisplayMedia` c `systemAudio: 'include'` работает нативно. Добавить проверку: `if (platform === 'darwin')` → использовать `getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })` вместо WASAPI-пути. Требует добавить `com.apple.security.screen-recording = true` в `desktop/assets/entitlements.mac.plist`.

- [ ] **Linux** — PulseAudio monitor source доступен как обычное аудиоустройство. `enumerateDevices()` → ищем `device.label.includes('.monitor')`. Если найден — `getUserMedia({ audio: { deviceId: monitorDevice.deviceId } })` без десктопного захвата.

#### Шаг 4 — UI (`frontend/src/pages/Player.jsx` + voice panel)

- [ ] **Кнопка «🔊 Системный звук»** — показывается только если `window.electronAPI?.isElectron`. Находится рядом с кнопкой микрофона в панели голосового чата. Состояния: inactive → active (пульсирующая иконка динамика, цвет `#4ade80`).
- [ ] **Индикатор в списке участников** — если у участника `appData.source === 'system'` у одного из его треков, показывать иконку 🔊 рядом с именем (не путать с аватаркой микрофона).
- [ ] **WS событие `system_audio_start / system_audio_stop`** — отправлять через `sendMessage` при включении/выключении, чтобы другие участники увидели статус до того как SFU подключит трек (latency ~200ms).

#### Шаг 5 — Получение у других участников (уже работает через SFU)

- [ ] В `consumeProducer()` — если `consumer.appData?.source === 'system'`, создать `<audio>` с `id="sys-audio-{peerId}"` и добавить его в `sysAudioEls` map (отдельно от голоса). Это позволит в будущем управлять громкостью системного аудио независимо от микрофона.
- [ ] Убедиться что SFU-сервис (`services/media`) пробрасывает `appData` от producer к consumer при consume — стандартное поведение Mediasoup, но нужно проверить в `handleConsume` на беке.

#### Зависимости и риски

- [ ] **Нет новых npm пакетов** — WASAPI loopback работает через встроенный Chromium без нативных модулей.
- [ ] **Windows only гарантировано** — WASAPI loopback работает в Electron на Windows без доп. настроек. macOS и Linux — отдельные ветки с деградацией.
- [ ] Проверить что `services/media` (Mediasoup) пробрасывает `appData` — если нет, нужен 1 строчный фикс в Go SFU сервисе.

---

## Не реализовано

- [x] **macOS / Linux сборки** — добавлены конфиги в `desktop/package.json`: `mac` (DMG + ZIP, x64 + arm64, hardened runtime, `entitlements.mac.plist`), `linux` (AppImage + DEB, x64). GitHub Actions workflow `.github/workflows/desktop-build.yml`: матрица `windows-latest` / `macos-latest` / `ubuntu-latest`, триггер по тегу `v*` и `workflow_dispatch`, авто-создание GitHub Release со всеми артефактами. (`desktop/package.json`, `.github/workflows/desktop-build.yml`, `desktop/assets/entitlements.mac.plist`)
- [ ] Код-подпись (Windows Authenticode) — требует платный сертификат EV/OV ($200–500/год)

## Связанные фичи

- [FEATURE_frontend](./FEATURE_frontend.md) — веб-клиент, загружаемый в Electron WebView
- [FEATURE_file_manager](./FEATURE_file_manager.md) — открывается в новом дочернем Electron-окне через `setWindowOpenHandler`
- [FEATURE_infra](./FEATURE_infra.md) — self-signed SSL сертификат nginx, порты 8443/8080

## Связанные файлы

- `desktop/src/main.js` — главный процесс Electron
- `desktop/src/preload.js` — contextBridge IPC API
- `desktop/src/store.js` — кастомный JSON store (замена electron-store)
- `desktop/src/windowState.js` — сохранение/восстановление позиции окна
- `desktop/src/setup.html` — страница настройки сервера
- `desktop/src/error.html` — страница ошибки подключения
- `desktop/package.json` — конфиг Electron + builder
- `desktop/assets/icon.ico`, `desktop/assets/tray.png`
