---
title: MCP Servers (Developer Tools)
status: done
progress: 100
last_audited: 2026-08-07
tags: [tooling, mcp, obsidian, claude, developer-tools]
---

# MCP Servers

## Описание
Два MCP-сервера для интеграции с Claude Code: `obsidian-mcp` (взаимодействие с Obsidian vault через Local REST API) и `project-mcp` (файловые инструменты проекта + Docker через HTTP/SSE).

## Реализовано

### obsidian-mcp (stdio, npx)
- [x] Пакет: `mcp-obsidian` (запускается через `npx -y mcp-obsidian`)
- [x] Transport: stdio
- [x] Требует плагин **Local REST API** в Obsidian (порт 27124 HTTPS)
- [x] Зарегистрирован в `.claude/settings.json` (`command: npx`, `args: ["-y", "mcp-obsidian"]`)
- [x] Env: `OBSIDIAN_API_KEY`, `OBSIDIAN_HOST: 127.0.0.1`, `OBSIDIAN_PORT: 27124`
- [x] YAML-конфиг: `mcp-servers/Obsidian/new-mcp-server.yaml`

### project-mcp (HTTP StreamableHTTP + SSE)
- [x] Transport: Streamable HTTP (MCP SDK 1.29.0) + SSE fallback
- [x] OAuth 2.0 (auto-approve, для совместимости с Claude Code)
- [x] `read_file(path)` — чтение файла проекта
- [x] `write_file(path, content)` — запись файла
- [x] `list_directory(path)` — список содержимого директории
- [x] `search_files(pattern, dir?, extension?)` — regex поиск
- [x] `get_project_context()` — чтение CLAUDE.md
- [x] `docker_containers()` — список Docker контейнеров
- [x] Агентский loop удалён (lm_agent, run_lm_agent убраны)
- [x] Запускается через docker-compose как `mcp-server` (порт 3333)

## Не реализовано

- [x] project-mcp зарегистрирован в `.claude/settings.json` (type: http, url: http://localhost:3333/mcp)
- [x] obsidian-mcp: `note_patch` — частичное обновление (frontmatter key-value + замена именованной секции по заголовку)

## Связанные фичи

- [FEATURE_infra](./FEATURE_infra.md) — project-mcp использует Docker API через Auth Service
- [index](./index.md) — центральный хаб документации, описывает всю платформу
- [FEATURE_admin](./FEATURE_admin.md) — project-mcp: docker_containers() читает тот же Docker API что Admin панель
- [FEATURE_auth](./FEATURE_auth.md) — obsidian-mcp хранит и читает документацию по Auth Service
- [FEATURE_monitoring](./FEATURE_monitoring.md) — obsidian-mcp позволяет читать/обновлять заметки о мониторинге

## Связанные файлы

- `mcp-servers/obsidian-mcp/index.js` (~225 строк)
- `mcp-servers/obsidian-mcp/package.json`
- `mcp-servers/project-mcp/index.js` (~200 строк после чистки)
- `mcp-servers/project-mcp/package.json`
- `.claude/settings.json` — регистрация obsidian-mcp
- `.mcp.json` — пустой (очищен)
