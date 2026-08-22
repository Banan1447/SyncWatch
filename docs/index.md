---
title: SyncWatch — Platform Overview
tags: [index, overview]
---

# SyncWatch Platform

Real-time video synchronization platform with voice chat and multi-source video support.

## Architecture

```
Client (React) → NGINX → Kong API GW → Go Microservices
                               │
                               └── WS Gateway → NATS → Services
```

## Core Platform

- [Auth](./FEATURE_auth.md) — authentication, JWT, user management
- [Rooms](./FEATURE_rooms.md) — room creation and management
- [Sync](./FEATURE_sync.md) — CRDT video synchronization between clients
- [Video Queue](./FEATURE_video_queue.md) — video queue, multi-source player
- [Chat](./FEATURE_chat.md) — real-time chat with history
- [WS Gateway](./FEATURE_ws_gateway.md) — central WebSocket server

## Client Side

- [Frontend](./FEATURE_frontend.md) — React SPA (Player, RoomSelect, Admin, FileManager)
- [Voice/RTC](./FEATURE_voice_rtc.md) — voice chat and screen share (WebRTC + Mediasoup)
- [Admin](./FEATURE_admin.md) — admin panel
- [File Manager](./FEATURE_file_manager.md) — MinIO file manager (/files)
- [Desktop](./FEATURE_desktop.md) — Windows Electron app (90%)

## Infrastructure

- [Infrastructure](./FEATURE_infra.md) — PostgreSQL, Redis, ScyllaDB, MinIO, NATS
- [API Gateway](./FEATURE_api_gateway.md) — Kong + NGINX
- [Monitoring](./FEATURE_monitoring.md) — Prometheus, Grafana, Jaeger, Loki
- [Transcoder](./FEATURE_transcoder.md) — FFmpeg transcoding

## Fully Implemented

- [Proxy Mode](./FEATURE_proxy_mode.md) — server-side video proxying (bypass CORS/Cloudflare)
- [Stream Cacher](./FEATURE_stream_cacher.md) — external stream caching in MinIO
- [Parser Service](./FEATURE_parser_service.md) — anime parser (animego, jut.su, etc.) + FlareSolverr
- [Email Verification](./FEATURE_email_verification.md) — email verification on registration
- [PWA](./FEATURE_pwa.md) — PWA manifest + Service Worker

## Dev Tools

- [MCP](./FEATURE_mcp.md) — MCP servers for Claude Code

## Feature Map

→ [featuremap](./featuremap.md)
