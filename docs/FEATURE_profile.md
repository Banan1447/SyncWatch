---
title: User Profile (Personal Cabinet)
status: in_progress
progress: 75
last_audited: 2026-08-07
tags: [frontend, backend, go, redis, user, profile, watchtime]
---

# User Profile (Personal Cabinet)

## Описание
Личный кабинет пользователя: страница `/profile` с аватаром, именем, email, тарифом, датой регистрации и счётчиком часов просмотра. Watch time накапливается автоматически в Redis при каждом выходе из комнаты.

## Реализовано

- [x] **Страница `/profile`** — `frontend/src/pages/Profile.jsx`. Карточка с аватаром (клик → загрузить фото), именем (inline-редактирование ✎), email с индикатором подтверждения, тариф, дата регистрации, блок watch time. Кнопка «Выйти».
- [x] **Кнопка «👤 Профиль»** — добавлена в хедер RoomSelect для авторизованных пользователей (не гостей).
- [x] **Watch time трекинг** — ws-gateway при `join_room` устанавливает `watch:session:{userID}` в Redis (TTL 25ч). При `leave_room` и disconnect: `GETDEL` сессию → `INCRBY watch:total:{userID}` на elapsed секунды. Санити-проверка: ≤ 86400 сек за сессию.
- [x] **`GET /api/v1/users/me/stats`** — новый endpoint в user-service. Читает `watch:total:{userID}` из Redis DB 1. Возвращает `{watch_seconds, watch_hours, watch_minutes}`.
- [x] **Изменение имени** — `PATCH /api/v1/users/me {username}`, inline edit с Enter/Escape/✓/✕.
- [x] **Загрузка аватара** — `POST /api/v1/users/me/avatar`, отображается в карточке.
- [x] **Изменение пароля** — `POST /api/v1/auth/change-password {current_password, new_password}`. Форма в Profile.jsx с полями текущего/нового/подтверждения пароля. Сбрасывает refresh-токены после смены. (`services/auth/main.go`, `frontend/src/pages/Profile.jsx`)
- [x] **История просмотра** — `GET /api/v1/users/me/history`. ws-gateway при `flushWatchTime()` пушит запись в `watch:history:{userID}` (Redis list, TTL 90 дней, top 20). Запись содержит `{room_id, title, timestamp, seconds}`. Отображается в Profile.jsx. (`services/ws-gateway/main.go`, `services/user/main.go`)
- [x] **Флаш watch time в PostgreSQL** — фоновая горутина в user-service (`startWatchTimeFlushLoop`, каждый час), сканирует `watch:total:*` в Redis, флашит в `users.preferences->{watch_seconds}` JSONB. (`services/user/main.go`)

## TODO

- [x] **Темы оформления** — 3 темы: Тёмная / Светлая / AMOLED. Выбор в Profile.jsx (3 кнопки). localStorage как мгновенный источник истины + фоновый PATCH `/api/v1/users/me {theme}` в PostgreSQL `preferences.theme`. ThemeContext поддерживает `setTheme(t)`. Кнопка в RoomSelect/Player циклически переключает dark→light→amoled.

### ⏱ Watch time — полный подсчёт всех типов видео

Сейчас watch time считается только по сессии в комнате (join → leave), без привязки к тому, воспроизводится ли видео реально. Нужно считать реальное время воспроизведения.

- [ ] **Трекинг на фронтенде** — в `VideoPlayer.jsx`: при `onTimeUpdate` если `isPlaying && !syncBlocked` → каждые 30 сек отправлять WS-событие `{ type: 'watch_tick', payload: { seconds: 30, video_type: srcType, room_id } }`. Работает для всех типов: YouTube (`isYT`), HLS, direct MP4, embed. Счётчик сбрасывается при паузе или смене видео. (`frontend/src/components/VideoPlayer.jsx`)
- [ ] **WS Gateway обработка `watch_tick`** — принимает событие, добавляет `seconds` к `watch:total:{userID}` в Redis. Валидация: `seconds ≤ 60`, `user_id` из токена (не из payload). (`services/ws-gateway/main.go`)
- [ ] **Статистика по типам** — хранить отдельные счётчики: `watch:type:{userID}:youtube`, `watch:type:{userID}:local`, `watch:type:{userID}:hls`, `watch:type:{userID}:embed`. `GET /api/v1/users/me/stats` возвращает breakdown по типам. (`services/user/main.go`)
- [ ] **Убрать дублирование** — старый механизм (сессия join→leave) оставить как fallback для случая когда фронт не отправляет watch_tick (старые клиенты). Но если за сессию пришло хотя бы 1 watch_tick — не засчитывать session time.
- [ ] **Отображение в Profile.jsx** — прогресс-бар или breakdown: `YouTube: 12h | Локальные файлы: 8h | HLS: 3h`. Общий счётчик крупно.

### 🏆 Профиль пользователя — новые фичи

#### Достижения (Achievements)
- [ ] **Таблица `user_achievements`** в PostgreSQL: `(user_id, achievement_id, unlocked_at)`. Список достижений: `first_watch` (первый просмотр), `centurion` (100 часов), `night_owl` (просмотр после 00:00), `binge` (6+ часов подряд), `social` (10 разных комнат), `host` (создал 5 комнат). (`init/postgres/09_achievements.sql`)
- [ ] **Achievement engine** в user-service — фоновая проверка при flush watch time: если условие достижения выполнено и ещё не выдано → INSERT + WS-уведомление `{ type: 'achievement_unlocked', payload: { id, name, icon } }`.
- [ ] **Отображение в Profile.jsx** — сетка иконок достижений, полученные — яркие, заблокированные — серые с замком. Тултип с описанием.
- [ ] **WS уведомление** — при разблокировке показывать тост-уведомление в Player.jsx (если пользователь в комнате): всплывающая карточка с иконкой достижения, исчезает через 5с.

#### Избранные комнаты
- [ ] **`POST /api/v1/users/me/favorites/{roomId}`**, `DELETE` и `GET /api/v1/users/me/favorites` — хранить в `user_favorites` таблице или `preferences.favorites` JSONB. (`services/user/main.go`)
- [ ] **UI в Profile.jsx** — список избранных комнат с кнопкой перехода. Кнопка ⭐ в Player.jsx header для добавления текущей комнаты.

#### Расширенная история
- [ ] **История по неделям** — в `GET /api/v1/users/me/history` добавить группировку по дням недели (график активности как на GitHub contribution graph). Отображать в Profile.jsx как sparkline или heatmap.
- [ ] **Продолжить просмотр** — при `leave_room` сохранять `{ room_id, video_url, title, current_time, timestamp }` в `watch:continue:{userID}` (Redis list, top 5). `GET /api/v1/users/me/continue` → список. В Profile.jsx: секция «Продолжить просмотр» с карточками.

#### Настройки приватности
- [ ] **`preferences.privacy`** JSONB: `{ show_watch_time: bool, show_history: bool, show_achievements: bool }`. `PATCH /api/v1/users/me { privacy: {...} }`. В Profile.jsx: тоггл «Показывать мою активность другим участникам комнаты».
- [ ] **Public profile** — `GET /api/v1/users/:id/public` возвращает только публичные данные (username, avatar, achievements если `show_achievements=true`). Используется при наведении на участника в комнате (тултип с мини-профилем).

#### Кастомизация
- [ ] **Username badge** — в Profile.jsx поле `display_badge` (до 20 символов, цвет фона). Показывается рядом с именем в комнате. Хранится в `preferences.badge`.
- [ ] **Статус** — короткий текст `preferences.status` (до 50 символов), отображается в мини-профиле и в списке участников при наведении.

## Связанные фичи

- [FEATURE_auth](./FEATURE_auth.md) — JWT, user model, `GET /auth/me`
- [FEATURE_frontend](./FEATURE_frontend.md) — AuthContext, RoomSelect header
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) — join_room / leave_room события + Redis watch session
- [FEATURE_infra](./FEATURE_infra.md) — Redis DB 1 (watch:session, watch:total), PostgreSQL users table

## Связанные файлы

- `frontend/src/pages/Profile.jsx` — страница личного кабинета
- `frontend/src/App.jsx` — маршрут `/profile`
- `frontend/src/pages/RoomSelect.jsx` — кнопка «Профиль» в хедере
- `services/auth/main.go` — `POST /api/v1/auth/change-password`
- `services/user/main.go` — `GET /api/v1/users/me/stats`, `GET /api/v1/users/me/history`, `startWatchTimeFlushLoop()`
- `services/ws-gateway/main.go` — `flushWatchTime()`: watch:session/total/history в Redis
