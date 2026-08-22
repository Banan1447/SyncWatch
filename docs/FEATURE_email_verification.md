---
title: Email Verification
status: done
progress: 100
last_audited: 2026-08-07
tags: [backend, go, auth, smtp, email, security]
---

# Email Verification

## Описание
Опциональная верификация email при регистрации. Если `SMTP_HOST` задан — пользователь получает письмо с ссылкой. Если не задан — регистрация работает без верификации (backward compatible).

## Реализовано

### Backend (`services/auth/main.go`)
- [x] Новые поля в Config: `SMTPHost`, `SMTPPort`, `SMTPUser`, `SMTPPass`, `SMTPFrom`, `FrontendURL`
- [x] Auto-migration: `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE` в `Initialize()`
- [x] `generateToken()` — 24-байтовый криптографически стойкий hex-токен
- [x] `sendVerificationEmail(userID, username, email)` — хранит токен в Redis (`email_verify:{token}`, TTL 24ч), отправляет письмо через stdlib `net/smtp`; вызывается горутиной (не блокирует регистрацию)
- [x] `GET /api/v1/auth/verify-email?token=...` — проверяет Redis, обновляет `email_verified=true` в БД, удаляет токен, редиректит на `FRONTEND_URL/?email_verified=1`
- [x] `POST /api/v1/auth/resend-verification` (JWT required) — пересылает письмо если не верифицирован; Redis rate limit 3 запроса/час на пользователя (`resend_limit:{userId}`, TTL 1h)
- [x] `handleMe` возвращает `email_verified: bool`
- [x] `UserResponse.EmailVerified` поле

### Database (`init/postgres/01_users.sql`)
- [x] `email_verified BOOLEAN DEFAULT FALSE` — в schema для новых установок

### Kong (`config/kong/kong.yml`)
- [x] `verify-email` добавлен в `auth-public` routes (GET, без JWT)
- [x] `auth-resend-verification` — отдельный маршрут с JWT плагином

### Frontend
- [x] `AuthContext.jsx` — `register(username, password, email?)` передаёт email в API
- [x] `RoomSelect.jsx` — поле email в форме регистрации (необязательное)
- [x] `RoomSelect.jsx` — баннер "⚠ Подтвердите email" + кнопка "Отправить снова" (отображается если `user.email && !user.email_verified`)
- [x] `RoomSelect.jsx` — toast "✓ Email успешно подтверждён!" при `?email_verified=1` в URL

### Config (`docker-compose.yml`, `.env.example`)
- [x] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `FRONTEND_URL` env vars в auth-service
- [x] `.env.example` обновлён с примерами (Gmail, Yandex)

## Не реализовано

- [x] HTML email template — dark-themed (фон #09090f, purple/pink акценты, кнопка подтверждения, fallback-ссылка, MIME `text/html`)
- [x] **Блокировка аккаунта если email не подтверждён через N дней** — реализовано через `EMAIL_VERIFY_TIMEOUT_DAYS` env var (default `0` = выключено). В `handleLogin`: если значение > 0, запрашивается `email`, `email_verified`, `created_at` из БД; если email задан, не верифицирован и прошло ≥ N дней с регистрации — возвращается `403 email_not_verified`. Добавлено в `docker-compose.yml` и `.env.example`. (`services/auth/main.go`)
- [ ] Верификация при смене email (если в будущем добавится смена email) — зависит от отсутствующей фичи смены email

## Связанные файлы

- `services/auth/main.go`
- `init/postgres/01_users.sql`
- `config/kong/kong.yml`
- `docker-compose.yml`
- `frontend/src/contexts/AuthContext.jsx`
- `frontend/src/pages/RoomSelect.jsx`
