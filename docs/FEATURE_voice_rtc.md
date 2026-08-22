---
title: Voice Chat & WebRTC
status: done
progress: 100
last_audited: 2026-08-07
tags: [frontend, backend, webrtc, mediasoup, sfu, voice, screenshare]
---

# Voice Chat & WebRTC

## Описание
Голосовой чат через WebRTC P2P (mesh) для небольших комнат + Mediasoup SFU (Selective Forwarding Unit) для масштабирования. Screen share — поток экрана напрямую в видеоплеер. Сигнализация через WS Gateway.

**Mediasoup порт:** 8088 (HTTP), 40000-40099 (UDP/TCP RTC media)

## TODO

- [x] **60fps для всех разрешений трансляции** — добавлено 2026-04-26. В `STREAM_QUALITY_MAP` (`Player.jsx:25`) добавлены `480p60` (2.5Mbps), `1440p60` (16Mbps), `4k60` (35Mbps). Обновлён `<select>` в voice-вкладке — теперь каждое разрешение имеет пары 30/60fps. Итого 10 пресетов качества. (`frontend/src/pages/Player.jsx`)

- [x] **P2P WebRTC — голос не работал ни в P2P ни SFU режиме** — исправлено 2026-04-26 (3 итерации). Корневые причины: (1) **Glare condition**: оба участника отправляли offer одновременно, PC попадал в `have-local-offer` → `setRemoteDescription` падал. Исправление: убран `createPeerConn(user_id, true)` из `voice_state` handler. (2) **Stale closure**: `voice_offer` проверял `!inVoice` из устаревшего замыкания → offer дропался. Исправление: заменено на `!inVoiceRef.current`. (3) **inVoiceRef timing**: ref обновлялся через `useEffect` (после рендера), но offer мог прийти до рендера — тогда `inVoiceRef.current` был ещё false. Исправление: `inVoiceRef.current = true` установлен синхронно в `joinVoice` до `sendMessage`. (4) **Autoplay blocked**: `audio.autoplay = true` без `play()` — Chrome блокирует. Добавлен явный `audio.play().catch(()=>{})`. (5) **ICE reconnect glare**: при `failed` оба участника делали `createPeerConn(peerId, true)` — снова glare. Исправление: детерминированный выбор инициатора по `myId < peerId`. (`frontend/src/hooks/useVoiceChat.js`)

- [x] **Голосовой чат: участники не отображаются в списке, хотя слышно** — в голосовой вкладке не видно других пользователей в группе, хотя аудио P2P работает. Вероятная причина: `voicePeers` state не обновляется при получении `voice_join` / `voice_state` событий, или WS-сообщение с составом участников голоса не приходит при первом подключении. Нужно: (a) проверить что `voice_join` broadcast'ится всем в комнате (ws-gateway), (b) проверить что `voicePeers` обновляется в `handleMessage` при `voice_join`/`voice_leave`, (c) добавить логирование входящих voice-событий для диагностики. (`frontend/src/pages/Player.jsx`, `frontend/src/hooks/useVoiceChat.js`, `services/ws-gateway/main.go`)

- [x] **Screen share: нет звука, нет полноэкранного режима, нет регулятора громкости, поток не встроен в основной плеер** — при трансляции экрана: (a) звук не воспроизводится у зрителей (`<video muted>` не снимается автоматически — кнопка «🔇 Включить звук» есть, но может не работать стабильно), (b) нет кнопки fullscreen для просматриваемого стрима, (c) нет слайдера громкости для стрима, (d) стрим показывается в отдельном элементе, а не интегрирован в VideoPlayer с его controls. Нужно: встроить `srcObject` в VideoPlayer как отдельный `srcType='screen'`, добавить controls (volume slider, fullscreen, mute-toggle) в overlay плеера для этого типа источника. (`frontend/src/pages/Player.jsx`, `frontend/src/components/VideoPlayer.jsx`)

- [x] **Звук на screen share отсутствует** — исправлено повторно. Корневая причина: React JSX атрибут `muted` не снимается динамически при ре-рендере (известный баг React/Chrome). Решение: убран `muted` из JSX атрибутов `<video>`, вместо него `useEffect` синхронизирует `streamMuted`/`streamVolume` с DOM-элементом. Добавлен overlay «Нажмите чтобы включить звук» (`needsInteraction` state) — срабатывает при `NotAllowedError` в `video.play()`. Overlay при клике вызывает `setStreamMuted(false)` + unmute всех `<video>/<audio>`. (`Player.jsx`)

- [x] **Нет аудио от вкладки браузера при трансляции экрана** — после `getDisplayMedia` проверяется `stream.getAudioTracks().length === 0`; если треков нет — показывается toast «Аудио недоступно — выберите «Вкладку» (не «Окно»/«Экран») в диалоге трансляции» (6 сек). Браузер передаёт аудио только при выборе «Вкладка» в системном диалоге. (`Player.jsx`)
- [x] **Низкое качество видео на screen share (P2P)** — `STREAM_QUALITY_MAP` и `getDisplayMedia` constraints уже используют дефолт `'1080p30'` → `{width:1920, height:1080, frameRate:30, maxBitrate:5_000_000}`. Динамическая смена через `applyConstraints` + `sender.setParameters`. Mediasoup SFU bitrate — отдельный TODO при SFU-интеграции. (`Player.jsx`)
- [x] **Speaking indicator (колечко) не срабатывает корректно** — исправлено. Основная причина: Chrome автоматически suspend-ит AudioContext пока нет пользовательского взаимодействия. Добавлен `audioCtxRef.current.resume()` в `ensureAudioCtx()` — теперь VAD начинает работать сразу. Local и remote VAD используют одинаковые параметры (fftSize=512/256, smoothingTimeConstant=0.3/0.4, порог `vadThreshold` из `audioSettings`). (`useVoiceChat.js`)
- [x] **Сохранение настроек голосового чата** — реализовано. `selectedInput`/`selectedOutput` читаются из `localStorage.sw_voice_input`/`sw_voice_output` при mount. `audioSettings` (echoCancellation/noiseSuppression/autoGainControl/gain/vadThreshold) сохраняется в `localStorage.sw_voice_settings` JSON через useEffect. (`useVoiceChat.js`)
- [x] **Пользователи пропадают из голосового чата — ICE reconnect** — добавлен `inVoiceRef` для стабильного чтения `inVoice` в замыканиях. `oniceconnectionstatechange`: при `failed` — сразу `closePeerConn` + `createPeerConn(peerId, true)` через 1с; при `disconnected` — ждёт 5с и если всё ещё disconnected — то же. (`useVoiceChat.js`)

- [x] **Выбор качества трансляции экрана/камеры** — реализован `STREAM_QUALITY_MAP` (480p..4K), `startStreaming` теперь передаёт `{width/height/frameRate}` constraints в `getDisplayMedia`/`getUserMedia`, `createScreenOffer` применяет `RTCRtpSender.setParameters({encodings[0].maxBitrate})`. Селектор качества в voice-вкладке (disabled во время трансляции). Аудио для screen: выключены `echoCancellation/noiseSuppression/autoGainControl`. Сохранение в `localStorage.sw_stream_quality`. ([Player.jsx](frontend/src/pages/Player.jsx))
  - *TODO (осталось):* адаптивная деградация по `packetsLost/packetsSent > 5%`
  - [x] Динамическая смена качества без переоффера — `useEffect` на `streamQuality`: вызывает `videoTrack.applyConstraints({width,height,frameRate})` + `sender.setParameters({encodings[0].maxBitrate/maxFramerate})` для всех senders в `broadcastVideoSendersRef`. Quality selector разблокирован во время трансляции. (`frontend/src/pages/Player.jsx`)

- [x] **Баг: локальный preview трансляции дёргается и торчит внизу** — исправлено. Inline-блок заменён на `position:fixed` floating PiP-thumbnail (`width:200px`, `aspectRatio:16/9`, `right:16/bottom:80` по умолчанию). Draggable через mousedown/mousemove, позиция в `localStorage.sw_preview_pos`. `will-change:transform`+`translateZ(0)` для GPU-ускорения, `object-fit:cover`. По умолчанию скрыт (broadcaster видит источник), включается кнопкой 👁 рядом с quality-selector во время трансляции. Кнопка ⏹ в углу превью. ([Player.jsx](frontend/src/pages/Player.jsx))


## Реализовано

### Голосовой чат
- [x] WebRTC P2P mesh — прямое соединение между участниками
- [x] Mediasoup SFU (`services/media/server.js`) — Node.js сервис
- [x] Поддержка кодеков: Opus (аудио), VP8, H264 (видео)
- [x] ICE / NAT traversal через Coturn TURN сервер
- [x] UDP + TCP transports
- [x] Speaking indicators — визуальное отображение кто говорит
- [x] WS события: `voice_join`, `voice_leave`, `voice_offer`, `voice_answer`, `voice_ice`
- [x] useVoiceChat hook (~19KB) — управление микрофоном, peer connections, UI

### Screen Share
- [x] Захват экрана (`getDisplayMedia`)
- [x] Передача потока через WebRTC (stream chunks)
- [x] Отображение экрана в основном видеоплеере
- [x] WS события: `stream_start`, `stream_stop`, `stream_active`, `stream_chunk`
- [x] Echo guard — `client_id` для избежания самофильтрации

### WebRTC (общая сигнализация)
- [x] `webrtc_offer`, `webrtc_answer`, `webrtc_ice` — через WS Gateway
- [x] ICE servers от TURN сервиса

## Не реализовано

- [x] **Видео-камера в комнате**: кнопка «📷 Камера» в хедере Player.jsx → `startStreaming('camera')` → `getUserMedia({ video:true, audio:true })` вместо `getDisplayMedia`. WebRTC P2P поток идёт тем же путём что и screen-share (stream_type:'screen' в сигнализации). `stream_start` с `stream_type:'camera'` уведомляет зрителей. `videoTrack.onended` авто-стоп.
- [x] **Локальная запись трансляции**: кнопка «⏺ Запись» рядом с LIVE-индикатором. MediaRecorder пишет в chunks (1с), при стопе собирает Blob → авто-скачивание `watchsync-{timestamp}.webm`. Поддержка: vp9+opus → vp8+opus → webm (проверка `isTypeSupported`). Кнопка «⏹ Стоп» с анимацией pulse. Запись идёт из `screenStreamRef.current` (тот же поток что транслируется).
- [x] **Комнаты без лимита через SFU** — `useSFUVoice.js` хук (mediasoup-client): Device.load → createSendTransport → produce audio → createRecvTransport → consumeProducer. Интегрирован в Player.jsx: режим-переключатель P2P/SFU (localStorage `sw_voice_mode`), единый интерфейс `activeVoice`. SFU-события (`new_producer`, `consumer_closed`) маршрутизируются через `sfuListenersRef`. VAD через AudioContext AnalyserNode. (`frontend/src/hooks/useSFUVoice.js`, `frontend/src/pages/Player.jsx`)
- [x] **Отображение пинга между клиентами в трансляции** — `pollPings()` каждые 2с вызывает `pc.getStats()`, ищет `candidate-pair` с `nominated:true`, берёт `currentRoundTripTime * 1000` мс. `peerPings` state (`{peerId → ms}`) передаётся из хука. В voice-панели рядом с именем: зелёный <100мс, жёлтый <250мс, красный >250мс. (`frontend/src/hooks/useVoiceChat.js`, `frontend/src/pages/Player.jsx`)
- [x] **Per-user volume sliders** — реализован 2026-04-27. В P2P-режиме под каждым участником (кроме себя) появляется слайдер 🔊 0–100%. Меняет `audio.volume` на живом `HTMLAudioElement` без рекоммита. State `peerVolumes` в `useVoiceChat`, функция `setPeerVolume(peerId, vol)`. При закрытии peer-соединения entry чистится. SFU-заглушка (no-op). (`frontend/src/hooks/useVoiceChat.js`, `frontend/src/pages/Player.jsx`)
- [x] **Локальный файл**: кнопка «▶ Смотреть только локально» → мгновенный `URL.createObjectURL()` для хоста, без ожидания. «Загрузить и добавить в очередь» → XHR с прогрессом + сразу играет локально + автодобавление в очередь после загрузки (все viewers получают прямой MinIO URL). Cleanup blob URL на unmount.
- [x] **Трансляция плеера (captureStream API)** — кнопка «▶ Плеер» в voice-вкладке. Вместо `getDisplayMedia` (захват экрана) вызывает `videoRef.current.captureStream()` на `<video>` элементе плеера. Работает для любых источников в нативном `<video>`: прямые URL, HLS через hls.js, MinIO. Не работает для YouTube/Kodik/embed (cross-origin iframe) — кнопка `disabled` с tooltip. `stream_type: 'player'` в `stream_start`. WebRTC сигнализация использует тот же `stream_type: 'screen'`-фильтр. У зрителей бейдж «▶ стрим». VideoPlayer.jsx: prop `captureStreamRef` (ref → функция `() => videoRef.current?.captureStream()`). (`frontend/src/pages/Player.jsx`, `frontend/src/components/VideoPlayer.jsx`)

## Связанные фичи

- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — сигнализация `webrtc_offer/answer/ice`, `voice_*`, `stream_*`
- [FEATURE_frontend](./FEATURE_frontend.md) — useVoiceChat hook, вкладка Voice, screen share в VideoPlayer
- [FEATURE_infra](./FEATURE_infra.md) — Coturn TURN-сервер для NAT traversal
- [FEATURE_rooms](./FEATURE_rooms.md) — голосовой чат и screen share привязаны к комнате
- [FEATURE_monitoring](./FEATURE_monitoring.md) — Mediasoup SFU порты (40000-40099) и media сервис в docker-compose

## Связанные файлы

- `services/media/server.js` — Mediasoup SFU (Node.js)
- `services/media/Dockerfile`
- `services/media/package.json`
- `frontend/src/hooks/useVoiceChat.js`
- `frontend/src/hooks/useSFUVoice.js` — SFU голос через mediasoup-client
- `frontend/src/pages/Player.jsx` — вкладка Voice
- `config/coturn/turnserver.conf` — TURN сервер
