---
title: File Manager
status: done
progress: 100
last_audited: 2026-08-07
tags: [frontend, react, backend, go, minio, files]
---

# File Manager

## Описание
Полнофункциональный файловый менеджер для управления загруженными видео и медиафайлами, хранящимися в MinIO. Доступен по маршруту `/files` (отдельная страница), открывается из плеера с контекстом комнаты и из Admin панели. Синхронизирован между всеми открытыми вкладками через polling каждые 5 секунд.

## TODO

- [x] **Проблема с передачей локальных файлов — улучшена диагностика** — nginx `client_max_body_size 100G` (не режет). Kong `write_timeout: 300s` достаточно для большинства файлов. Исправлено: (a) `handleFMUpload` теперь передаёт реальный текст ошибки MinIO в `writeError` вместо generic "Failed to upload file"; (b) `objectSize = -1` если `header.Size == 0` — MinIO streaming upload вместо отказа; (c) Frontend `xhr.onload` с non-2xx парсит JSON тело ответа и показывает `body.message/error`; добавлен `xhr.ontimeout` handler с human-readable сообщением; весь `console.error` для debugging. (`services/video/main.go`, `frontend/src/pages/FileManager.jsx`)

### Best practices из легаси (`<legacy-project-path>`)

- [x] **Поле `isSupported` в ответе `GET /api/v1/files`** — добавлено в `FileEntry` структуру в `handleListFiles`. Whitelist: `mp4/webm/ogg/m3u8`. Frontend показывает `⚠ Транскод` badge рядом с именем неподдерживаемого файла. (`services/video/main.go`, `frontend/src/pages/FileManager.jsx`)
- [x] **ffprobe-метаданные (resolution, bitrate) on-demand** — `GET /api/v1/files/info?key=...` запускает ffprobe и возвращает `{resolution, bitrate, duration, video_codec, audio_codec, size}`. Fail-soft: при ошибке возвращает N/A. Кнопка ℹ в строке видео-файла открывает floating panel с метаданными. (`services/video/main.go`, `frontend/src/pages/FileManager.jsx`)
- [x] **Расширенный `mediaExtensions` map** — 30+ форматов (mp4/webm/ogg/avi/mov/wmv/flv/mkv/mpg/mpeg/3gp/ts/mts/m2ts/vob/f4v/rm/rmvb + аудио). Добавлен в `services/video/main.go` как `mediaExtensions` map рядом с `browserSupportedExts`
- [x] **Path traversal hardening** — добавлен `isValidMinIOKey()` helper (отклоняет ключи с `..` и абсолютные пути). Применяется в `handleListFiles`, `handleDeleteFile`, `handleMoveFile`, `handleFMUpload`. (`services/video/main.go`)
- [x] **Self-move guard** — `isSelfMove(src, dst)` проверяет что destination не начинается с `source + "/"`. Применяется в `handleMoveFile`. (`services/video/main.go`)
- [x] **`x-folder-path` header в fm-upload** — `handleFMUpload` теперь принимает `x-folder-path` header как альтернативу `?prefix=` query param (header имеет приоритет). (`services/video/main.go`)
- [x] **Buffer-progress индикатор воспроизведения** — добавлен под hover-превью видео: 3px полоска с `onProgress` обработчиком, который обновляет ширину через `bufferBarRef` (императивный DOM update без ре-рендеров). Показывает процент забуференного: `buffered.end(last) / duration * 100%`. Фиолетовый цвет `rgba(124,111,247,0.7)`, плавный transition 0.3s. (`frontend/src/pages/FileManager.jsx`)
- [x] **`isLocalhostOnly` для destructive операций** — принято решение: не реализовывать. Текущей RBAC через JWT + `subscription_tier=admin` достаточно; дополнительная localhost-проверка сломала бы удалённый доступ к admin-панели.

## Реализовано

### Бэкенд (Video Service — новые эндпоинты)
- [x] `GET /api/v1/files?prefix=videos/` — листинг содержимого папки (не рекурсивный, возвращает файлы и виртуальные папки через MinIO prefix API)
- [x] `DELETE /api/v1/files?key=videos/file.mp4` — удаление файла
- [x] `POST /api/v1/files/folder` — создание виртуальной папки (zero-byte маркер-объект в MinIO, `application/x-directory`)
- [x] `DELETE /api/v1/files/folder?prefix=videos/folder/` — рекурсивное удаление папки со всем содержимым
- [x] `POST /api/v1/files/move` — перемещение/переименование (MinIO CopyObject + RemoveObject)
- [x] `POST /api/v1/files/fm-upload?prefix=videos/folder/` — загрузка файла в указанную папку (до 500MB, multipart/form-data)
- [x] Все эндпоинты защищены JWT через Kong

### Фронтенд (`frontend/src/pages/FileManager.jsx`)
- [x] Хлебные крошки (breadcrumb) для навигации по вложенным папкам
- [x] Таблица файлов с иконками по типу (📁 папка, 🎬 видео, 🖼 изображение, 📄 прочее)
- [x] Столбцы: имя, размер (авто-формат Б/КБ/МБ/ГБ), дата изменения, действия
- [x] Сортировка: папки первыми, далее по имени (ru locale)
- [x] Мультиселект через чекбоксы (выбрать все, снять выделение)
- [x] Удаление нескольких объектов сразу (с подтверждением)
- [x] Загрузка файлов с прогресс-баром (XHR, очередь нескольких файлов)
- [x] Drag-and-drop файлов на страницу
- [x] Создание папки (модальное окно)
- [x] Инлайн-переименование (клик ✏ → редактирование прямо в строке таблицы)
- [x] Перемещение через модал (редактирование полного пути объекта)
- [x] Скачать файл (прямая ссылка на MinIO URL)
- [x] Добавить видео в очередь комнаты (кнопка ▶, только при наличии `?room=<roomId>` в URL)
- [x] Добавить выбранные файлы в очередь комнаты
- [x] Поиск/фильтр по имени файла (client-side)
- [x] Автополинг каждые 5 секунд — real-time синхронизация между вкладками
- [x] Строка статуса: количество объектов, выбрано, итоговый размер файлов
- [x] Toast-уведомления об успехе/ошибке
- [x] Пустая папка: placeholder с подсказкой drag-and-drop
- [x] Копирование файла без удаления источника — `POST /api/v1/files/copy`, кнопка ⧉ в строке
- [x] DnD перемещение файлов на папку-цель (подсветка папки + drop → move)
- [x] Thumbnail preview при наведении на имя файла — изображения через `<img>`, видео через `<video preload="metadata">`

### Интеграция
- [x] Кнопка `📁 Файловый менеджер` в тулбаре вкладки **Очередь** в Player.jsx — всегда видна, открывает `/files?room=<roomId>` в новой вкладке/окне
- [x] Ссылка `📁 Файловый менеджер ↗` в Admin.jsx (справа в табах, открывает в новой вкладке)
- [x] URL загруженных файлов: `/api/v1/videos/stream/{key}` вместо внутреннего MinIO URL — доступен из любого браузера через nginx
- [x] Kong маршрут `video-stream-route` для `~/api/v1/videos/stream/.+`
- [x] Маршрут `/files` в `frontend/src/App.jsx`
- [x] Kong маршруты для всех новых эндпоинтов в `config/kong/kong.yml`
- [x] Десктоп (Electron): `window.open('/files?room=...')` открывается в новом Electron-окне с нативным тайтлбаром (через `setWindowOpenHandler` + `did-create-window`)

## Не реализовано

> ⚠️ Устарело — Multi-bucket support остаётся как возможное будущее расширение, но не входит в текущий scope платформы. Текущий `videos` bucket покрывает все use cases.
- [ ] Поддержка нескольких bucket'ов (сейчас только `videos`) — будущее расширение

## Связанные фичи

- [FEATURE_infra](./FEATURE_infra.md) — MinIO bucket `videos` как хранилище
- [FEATURE_video_queue](./FEATURE_video_queue.md) — кнопка "В очередь" добавляет файл в очередь комнаты
- [FEATURE_api_gateway](./FEATURE_api_gateway.md) — Kong routing всех `/api/v1/files/*` эндпоинтов
- [FEATURE_frontend](./FEATURE_frontend.md) — FileManager.jsx как страница SPA, маршрут `/files`
- [FEATURE_admin](./FEATURE_admin.md) — ссылка на файловый менеджер из Admin панели

## Связанные файлы

- `frontend/src/pages/FileManager.jsx` — страница файлового менеджера
- `frontend/src/App.jsx` — маршрут `/files`
- `services/video/main.go` — обработчики `handleListFiles`, `handleDeleteFile`, `handleCreateFolder`, `handleDeleteFolder`, `handleMoveFile`, `handleFMUpload`
- `config/kong/kong.yml` — маршруты `file-manager-*`
- `desktop/src/main.js` — `setWindowOpenHandler` для открытия внутренних URL в Electron-окне
