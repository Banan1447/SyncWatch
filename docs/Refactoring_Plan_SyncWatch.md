---
name: Refactoring_Plan_SyncWatch
description: Full project refactoring plan using TDD and Serena workflow.
---
# Refactoring Plan: SyncWatch Platform

## 1. Goal & Scope
- **Goal**: Remove unimplemented functions, optimize core services, and ensure production readiness.
- **Methodology**: TDD (Red-Green-Refactor) + Serena Workflow (Plan, Execute, Verify, Reflect).
- **Target**: Clean up `services/` and `frontend/` based on `featuremap.md`.

## 2. Feature Status (from featuremap.md)
### To be Removed/De-prioritized (Planned/Incomplete)
- [FEATURE_desktop](./FEATURE_desktop.md) (90% - needs verification)
- [FEATURE_transcoder](./FEATURE_transcoder.md) (99% - verify if needed for MVP)
- [FEATURE_pwa](./FEATURE_pwa.md) (Planned)
- [FEATURE_email_verification](./FEATURE_email_verification.md) (100% but check if used)

### To be Optimized (Done/In Progress)
- [FEATURE_proxy_mode](./FEATURE_proxy_mode.md) (100% - optimize FlareSolverr routing)
- [FEATURE_ws_gateway](./FEATURE_ws_gateway.md) (100% - optimize Go concurrency)
- [FEATURE_sync](./FEATURE_sync.md) (100% - CRDT optimization)
- [FEATURE_chat](./FEATURE_chat.md) (100% - ScyllaDB query optimization)

## 3. Refactoring Status

### Completed Phases (see [Refactoring_Log.md](../Refactoring_Log.md) for details)

| Phase | Description | Date |
|-------|-------------|------|
| **A: Compose** | Removed `version:` from docker-compose, added LM_STUDIO vars, restored test-work | 2026-08-07 |
| **B: Cleanup** | Deleted .verb.md, docs/pathExists.md, services/video;C, *.exe files, empty examples/ | 2026-08-07 |
| **C: Ignore** | .gitignore: added *.exe, __pycache__, .obsidian/. .dockerignore: removed obsolete entries | 2026-08-07 |
| **D: Env** | .env.example: added LM_STUDIO vars, updated ports, removed unused TURN_SECRET | 2026-08-07 |
| **E: Docs** | CLAUDE.md rewrite, documentation.md/featuremap.md/index.md Obsidian-link cleanup, README.md created, FEATURE_infra.md fixed | 2026-08-07 |
| **F: CI** | .github/workflows/go-services.yml: CI for 8 Go services | 2026-08-07 |
| **G: Startup** | start.bat + start.sh: health checks for ports 8088, 8089 | 2026-08-07 |
| **H: Code** | services/user/Dockerfile aligned. Moved archive/test-work → services/test-work | 2026-08-07 |
| **I: Verify** | docker compose config (main + ha) OK. health_check.py: 8/8 OK. test-work Docker build OK | 2026-08-07 |

### Remaining Work (Original Phases)

#### Phase 3: Service Optimizations
- [ ] **Sync Service**: Optimize CRDT merge logic for high-frequency updates.
- [ ] **WS Gateway**: Implement worker pools for message broadcasting.
- [ ] **Proxy Mode**: Optimize chunked transfer encoding in `services/video`.

#### Phase 4: Frontend Cleanup
- [ ] Remove `frontend/` components related to removed features.
- [ ] Optimize React state management for `video_action` events.

## 4. Verification & Reflection
- [ ] Run full test suite after every major change.
- [ ] Update [featuremap.md](featuremap.md) and [Refactoring_Log.md](../Refactoring_Log.md) after every phase.
