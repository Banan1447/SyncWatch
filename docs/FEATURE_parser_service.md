---
title: Parser Service (Anime)
status: done
progress: 100
last_audited: 2026-08-07
tags: [parser, anime, animego, kodik, aniboom, python, bookmarklet]
---

# Parser Service (Anime)

## Описание

Python-микросервис для парсинга аниме-сайтов. Извлекает сезоны, эпизоды, озвучки и HLS-потоки через цепочку: animego.me → Kodik/Aniboom → CDN m3u8. Запросы маршрутизируются через Kong.

**Путь:** `services/parser/`  
**Стек:** Python 3.12, FastAPI, httpx, lxml, BeautifulSoup4  
**Порт:** 8089 (внешний), 8080 (внутренний)

## Архитектура

```
animego.me (SSR HTML)
  → GET /player?episode=N (X-Requested-With: XMLHttpRequest)
  → iframe kodik.info или aniboom.net
    → Kodik: POST /ftor с d_sign/ref_sign → base64(reversed) → CDN .m3u8
    → Aniboom: GET embed → uuid + Bearer → POST /api/video → HLS URL
```

## API Endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/v1/anime/search?q=...` | Поиск аниме по названию |
| POST | `/api/v1/anime/parse` | Парсинг страницы аниме → сезоны/эпизоды/плееры |
| POST | `/api/v1/anime/players` | Получить список плееров (iframe) для эпизода |
| POST | `/api/v1/anime/extract` | Извлечь HLS-поток из iframe плеера |
| POST | `/api/v1/anime/inject` | Принять данные от букмарклета (эпизоды из браузера пользователя) |
| GET | `/api/v1/anime/inject/{key}` | Получить ранее инжектированные данные по ключу |
| GET | `/health` | Healthcheck |

## Реализовано

### Backend
- [x] FastAPI приложение с CORS middleware
- [x] `GET /api/v1/anime/search` — поиск на animego.me (AJAX + HTML fallback)
- [x] `POST /api/v1/anime/parse` — парсинг страницы: сезоны, эпизоды, плееры из data-атрибутов
- [x] `POST /api/v1/anime/players` — AJAX `/player?episode=N` → список iframe
- [x] `POST /api/v1/anime/extract` — роутинг на Kodik / Aniboom / auto
- [x] Kodik extractor: GET iframe → извлечь d/d_sign/ref/ref_sign → POST /ftor → decode `base64(reversed)` → HLS URL с `Referer: kodik.info`
- [x] Aniboom extractor: GET embed → uuid + Bearer token → POST /api/video → HLS URL
- [x] Единый shared `httpx.AsyncClient` с bot-friendly User-Agent
- [x] Обработка ошибок: HTTP 502 при upstream, 422 при пустом результате

### Инфраструктура
- [x] `Dockerfile` (python:3.12-slim, non-root user)
- [x] `requirements.txt` (fastapi, uvicorn, httpx, lxml, beautifulsoup4)
- [x] Docker Compose: `parser-service`, порт 8089, зависит от flaresolverr
- [x] Kong: маршрут `/api/v1/anime` с JWT-плагином

### Bookmarklet (DDoS-Guard bypass)
- [x] `POST /api/v1/anime/inject` — принимает JSON {url, title, episodes[]} от букмарклета
- [x] `GET /api/v1/anime/inject/{key}` — отдаёт ранее инжектированные данные
- [x] `parse_anime` проверяет inject cache ПЕРВЫМ — если данные есть, не обращается к animego.me
- [x] Inject cache с TTL 24 часа, автоматическая очистка устаревших записей
- [x] Kong CORS: добавлен `X-Anime-Cookies` в allowed headers

### Frontend (Player.jsx)
- [x] Кнопка "🎌 Поиск аниме" во вкладке Видео
- [x] Модальное окно: поисковая строка → список результатов → выбор тайтла
- [x] **Блок букмарклета** — drag-and-drop ссылка с токеном, инструкция в 4 шага
- [x] Выбор сезона (кнопки-фильтры)
- [x] Выбор эпизода (скроллируемая сетка)
- [x] Выбор плеера/озвучки (после выбора эпизода — автозапрос плееров)
- [x] Список качеств → кнопка "+ В очередь"
- [x] Сброс состояния при смене эпизода/плеера
- [x] Fallback-блок "эпизоды не найдены" с повторной инструкцией + кнопкой букмарклета

## Не реализовано

- [x] FlareSolverr fallback в extractors (если animego.me заблокирован Cloudflare)
- [x] Кеш результатов парсинга (Redis TTL ~10 мин, чтобы не нагружать animego.me)
- [x] Sibnet extractor — `extractors/sibnet.py`: GET embed/video page → regex-парсинг `player.src=[{file,label}]` / `<source>` / redirect fallback. Маршрутизация: `ptype=="sibnet"` или `"sibnet" in iframe_url`. Fallback в auto-mode после kodik/aniboom. (`services/parser/extractors/sibnet.py`, `services/parser/main.py`)
- [x] Поддержка anilibria.tv — `extractors/anilibria.py`: поиск через публичный API `api.anilibria.tv/v3`, эпизоды, HLS-потоки (fhd/hd/sd). Новые эндпоинты: `GET /api/v1/anime/anilibria/episodes?id=...`. Поиск поддерживает `?source=anilibria`. Фронт: переключатель источника в модале (AnimеGO / AniLibria), прямое извлечение потоков без шага «players». (`services/parser/extractors/anilibria.py`, `services/parser/main.py`, `frontend/src/pages/Player.jsx`)
- [x] Поддержка jut.su — `extractors/jutsu.py`: GET страницы эпизода → regex-парсинг quality JSON / `file:` / `<source>` / `data-file`. `GET /api/v1/anime/jutsu/episodes?url=...` возвращает список эпизодов. Маршрутизация: `ptype=="jutsu"` или `"jut.su" in iframe_url`. (`services/parser/extractors/jutsu.py`, `services/parser/main.py`)
- [x] Передача `stream_headers` в queue API и проксирование в video-service (нужно для Kodik CDN Referer)

## TODO

- [x] **`stream_headers` в queue API** — реализовано. `AddToQueueRequest.StreamHeaders map[string]string` сохраняется в `video_metadata.stream_headers`. `handleProxyConfig` принимает `stream_headers` и добавляет их как `&headers=` query param в proxy URL. `handleProxyURL` читает `headers` JSON-param и форвардит заголовки к upstream (Referer, Authorization и т.д.). Frontend `animeAddToQueue` передаёт `stream_headers` из `stream.headers` и `video_source:'hls'`. (`services/video/main.go`, `frontend/src/pages/Player.jsx`)
- [x] **FlareSolverr fallback** — реализован `make_fetch_with_cf_fallback(cookie_str)`: пробует direct Chrome-TLS fetch (curl_cffi), при 403/429 автоматически ретраит через `_fetch_via_flaresolverr()` → POST `{FLARESOLVERR_URL}/v1` с `cmd:"request.get"`. Env `FLARESOLVERR_URL` (default: `http://flaresolverr:8191`). Применён в search, parse, players endpoints. (`services/parser/main.py`)

## Связанные файлы

- `services/parser/main.py` — FastAPI приложение, все endpoints
- `services/parser/extractors/animego.py` — поиск и парсинг страниц animego.me
- `services/parser/extractors/kodik.py` — Kodik iframe extractor
- `services/parser/extractors/aniboom.py` — Aniboom iframe extractor
- `services/parser/extractors/sibnet.py` — Sibnet video extractor
- `services/parser/extractors/anilibria.py` — AniLibria.TV extractor (публичный API v3)
- `services/parser/extractors/jutsu.py` — jut.su extractor (HTML-парсинг эпизода)
- `services/parser/Dockerfile`
- `services/parser/requirements.txt`
- `frontend/src/pages/Player.jsx` — UI модалка (animeOpen state + JSX)
- `config/kong/kong.yml` — маршрут parser-service
- `docker-compose.yml` — сервис parser-service

## Связанные фичи

- [FEATURE_stream_cacher](./FEATURE_stream_cacher.md) — кеширование HLS-потоков (можно совместить: кнопка "Закешировать" в модалке)
- [FEATURE_infra](./FEATURE_infra.md) — FlareSolverr (flaresolverr:8191)
- [FEATURE_frontend](./FEATURE_frontend.md) — Player.jsx, VideoPlayer
