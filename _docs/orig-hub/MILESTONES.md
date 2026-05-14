# orig-hub Milestones & Implementation Plan (v2 — Test-Complete)

## Milestone Overview

| Milestone | Focus | Tasks | Est. Weeks | Gate |
|-----------|-------|-------|-----------|------|
| **M0** | Test Infrastructure + CI/CD | 5 | 1 | 🔄 Must-pass |
| **M1** | Protocol Engine + HTTP Download | 5 | 3-4 | Gate-1 |
| **M2** | Wails Desktop GUI + Browser Extension | 6 | 4-5 | Gate-2 |
| **M3** | BitTorrent + IPFS Protocols | 5 | 3-4 | Gate-3 |
| **M4** | Multi-Node Distributed Download | 6 | 4-5 | Gate-4 |
| **M5** | Video Platform Integration | 5 | 3-4 | Gate-5 |
| **M6** | Polish, Testing & v1.0 Release | 4 | 2-3 | Gate-6 |

**Total Estimated Timeline**: 20-26 weeks

---

## Standardized 6-Stage Test Flow (Per Milestone)

Every milestone MUST pass all 6 stages before proceeding to the next.

```
Stage 1: Compile ──────→ go build / bun build (zero errors, zero warnings)
Stage 2: Unit Test ────→ go test ./... / bun test (coverage > 80%)
Stage 3: API Test ─────→ REST/gRPC endpoint tests (all endpoints return expected)
Stage 4: Frontend Test → Component tests + visual regression (if applicable)
Stage 5: E2E Test ────→ Full flow test (user scenario, Playwright)
Stage 6: Screenshot ──→ Capture UI state for review (if applicable)
```

### Stage Details

| Stage | Tool | Command | Pass Criteria |
|-------|------|---------|---------------|
| 1. Compile | go/bun | `go build ./...` / `bun run build` | Exit 0, no warnings |
| 2. Unit Test | go test / vitest | `go test -race -coverprofile=coverage.out ./...` | Coverage > 80%, no failures |
| 3. API Test | httptest / Postman | `go test -tags=api_test ./...` | All endpoints 200/expected |
| 4. Frontend Test | vitest + testing-library | `bun run test` | All components render correctly |
| 5. E2E Test | Playwright | `playwright test` | All user scenarios pass |
| 6. Screenshot | Playwright | `playwright test --update-snapshots` | Visual review approved |

---

## M0: Test Infrastructure + CI/CD (Week 1)

**Goal**: Establish test infrastructure BEFORE any feature code. This is the foundation that guarantees every subsequent milestone is testable.

### Task Breakdown

#### M0.1: Go Test Infrastructure
- [ ] Create `internal/testutil/` package with shared test helpers
- [ ] Create `internal/testutil/mock_http_server.go` — Configurable HTTP mock server (supports range, content-disposition, slow response, disconnect)
- [ ] Create `internal/testutil/mock_bt_tracker.go` — BitTorrent tracker mock
- [ ] Create `internal/testutil/mock_ipfs_gateway.go` — IPFS gateway mock
- [ ] Create `internal/testutil/fixtures.go` — Test file generators (various sizes, checksums)
- [ ] Create `internal/testutil/assert.go` — Custom assertions for download testing (progress, speed, state)
- [ ] Write tests for all test utilities (meta-testing)

#### M0.2: Frontend Test Infrastructure
- [ ] Set up Vitest + React Testing Library in frontend/
- [ ] Create component test helpers (renderWithProviders, mockWailsBindings)
- [ ] Create mock Wails runtime for testing (EventsEmit, EventsOn, Call bindings)
- [ ] Set up Playwright for E2E testing
- [ ] Create E2E test fixtures (mock download server, test files)
- [ ] Write sample component test + E2E test to validate infrastructure

#### M0.3: CI/CD Pipeline
- [ ] Create `.github/workflows/test.yml` — PR test pipeline (go test + bun test + lint)
- [ ] Create `.github/workflows/build.yml` — Build pipeline (Windows/macOS/Linux)
- [ ] Create `.github/workflows/release.yml` — Release pipeline (tag-triggered)
- [ ] Create `.github/workflows/e2e.yml` — Nightly E2E test pipeline
- [ ] Create `.golangci.yml` — Linter configuration
- [ ] Add test coverage reporting (Codecov or GitHub Actions artifact)
- [ ] Add branch protection rules (require test pass for merge)

#### M0.4: Logging & Error Infrastructure
- [ ] Create `internal/logging/logger.go` — Structured logging (slog based)
- [ ] Create `internal/logging/tracing.go` — OpenTelemetry trace integration
- [ ] Create `internal/errdefs/errors.go` — Typed error definitions per layer
- [ ] Create `internal/errdefs/codes.go` — Error codes (protocol, engine, service, UI)
- [ ] Create `internal/errdefs/wrap.go` — Error wrapping with context
- [ ] Write tests for error types and logging

#### M0.5: Development Environment
- [ ] Create `Makefile` with standard targets (build, test, lint, cover, e2e)
- [ ] Create `CONTRIBUTING.md` with development setup instructions
- [ ] Create `.editorconfig` for consistent formatting
- [ ] Create `Taskfile.yml` as alternative to Makefile
- [ ] Set up pre-commit hooks (lint, test)

### M0 Gate Verification
- [ ] `go build ./...` passes with zero errors
- [ ] `go test ./...` passes with > 80% coverage on testutil package
- [ ] `bun run test` passes in frontend/
- [ ] CI pipeline runs successfully on push
- [ ] Mock HTTP server can simulate range requests, disconnects, slow responses
- [ ] Structured logging outputs JSON format
- [ ] Error types wrap correctly with codes

---

## M1: Protocol Engine + HTTP Download (Week 2-5)

**Goal**: Build the protocol abstraction layer and HTTP download engine with complete test coverage.

### Task Breakdown

#### M1.1: Protocol Interface & Registry
- [ ] Create `internal/protocol/interface.go` — Protocol, Downloader, Uploader interfaces
- [ ] Create `internal/protocol/registry.go` — ProtocolRegistry with scheme-based routing
- [ ] Create `internal/protocol/capabilities.go` — CapabilitySet bitmask system
- [ ] Create `internal/protocol/types.go` — ParsedURL, Metadata, Progress, DownloadState, UploadState, ProtocolError
- [ ] **Test**: Unit tests for all protocol types (ParseURL for http/https/magnet/ipfs/ipns)
- [ ] **Test**: Unit tests for registry (register, get, match, conflict detection, concurrent access)
- [ ] **Test**: Unit tests for CapabilitySet (add, remove, has, combinations)
- [ ] **Test**: Fuzz tests for URL parsing (random strings, malformed URLs)

#### M1.2: HTTP Protocol + Concurrent Engine
- [ ] Create `internal/protocol/http/protocol.go` — HTTPProtocol implementation
- [ ] Create `internal/protocol/http/probe.go` — HEAD request probing
- [ ] Create `internal/engine/concurrent/downloader.go` — Chunk-based parallel downloader
- [ ] Create `internal/engine/concurrent/worker.go` — Worker with HTTP range requests
- [ ] Create `internal/engine/concurrent/task_queue.go` — Work-stealing task queue
- [ ] Create `internal/engine/concurrent/health.go` — Stall detection, health monitoring
- [ ] Create `internal/engine/single/downloader.go` — Sequential fallback
- [ ] Create `internal/engine/types/` — Models, config, progress types
- [ ] **Test**: Unit tests for HTTP probe (mock server: range support, content-disposition, redirect)
- [ ] **Test**: Unit tests for concurrent downloader (mock server: chunk verification, speed)
- [ ] **Test**: Integration test: download 10MB file with 4 connections, verify checksum
- [ ] **Test**: Integration test: pause/resume mid-download, verify state recovery
- [ ] **Test**: Integration test: server disconnect during download, verify retry
- [ ] **Test**: Integration test: mirror failover, verify switch to alternate source
- [ ] **Test**: Benchmark: download speed vs single connection

#### M1.3: Download Manager + State Persistence
- [ ] Create `internal/download/manager.go` — Protocol-aware download manager
- [ ] Create `internal/download/pool.go` — Worker pool with lifecycle management
- [ ] Create `internal/engine/state/db.go` — SQLite persistence with WAL mode
- [ ] Create `internal/core/interface.go` — Protocol-agnostic DownloadService interface
- [ ] Create `internal/core/local_service.go` — Embedded mode service
- [ ] Create `internal/core/remote_service.go` — Daemon mode service
- [ ] Create `internal/processing/manager.go` — Post-processing pipeline
- [ ] Create `internal/processing/events.go` — SSE event broadcasting
- [ ] **Test**: Unit tests for download manager (add/remove/pause/resume lifecycle)
- [ ] **Test**: Unit tests for SQLite state persistence (CRUD, concurrent writes, WAL mode)
- [ ] **Test**: Integration test: full lifecycle (add → download → pause → resume → complete)
- [ ] **Test**: Integration test: app restart recovery (state survives process kill)
- [ ] **Test**: Integration test: SSE events fire correctly on state changes
- [ ] **Test**: Concurrency test: 10 simultaneous downloads, verify no state corruption

#### M1.4: Daemon Mode + Headless CLI
- [ ] Create `cmd/orig-hub/main.go` — Entry point
- [ ] Create HTTP REST API for download management
- [ ] Create SSE event streaming for real-time updates
- [ ] Add token authentication for daemon mode
- [ ] Create minimal CLI: daemon, add, list, status, pause, resume, cancel
- [ ] Create `internal/config/settings.go` — TOML configuration
- [ ] Create `internal/config/paths.go` — Platform-specific paths
- [ ] **Test**: API test: all REST endpoints (POST /downloads, GET /downloads/:id, etc.)
- [ ] **Test**: API test: SSE event stream (subscribe, receive events)
- [ ] **Test**: API test: authentication (valid token, invalid token, no token)
- [ ] **Test**: E2E test: start daemon → add URL → download → verify file
- [ ] **Test**: E2E test: start daemon → add URL → pause → resume → verify
- [ ] **Test**: E2E test: config file auto-migration (missing fields get defaults)

#### M1.5: M1 Integration Verification
- [ ] **Stage 1**: `go build ./...` — zero errors
- [ ] **Stage 2**: `go test -race -coverprofile=coverage.out ./...` — coverage > 80%
- [ ] **Stage 3**: API test all daemon endpoints
- [ ] **Stage 4**: N/A (no frontend yet)
- [ ] **Stage 5**: E2E: full download lifecycle via CLI + daemon
- [ ] **Stage 6**: N/A (no GUI yet)
- [ ] Write M1 completion report to `_docs/orig-hub/reports/M1-SCOPE.md`

### M1 Gate Verification
- [ ] All 6 test stages pass
- [ ] HTTP concurrent download works with pause/resume
- [ ] Daemon mode serves REST API with SSE events
- [ ] State persistence survives app restart
- [ ] Test coverage > 80% for all new code
- [ ] No race conditions detected (`-race` flag)
- [ ] M1-SCOPE.md report written and reviewed

---

## M2: Wails Desktop GUI + Browser Extension (Week 6-10)

**Goal**: Build the primary user interface — FDM-style desktop app with browser integration.

### Task Breakdown

#### M2.1: Wails Project Setup
- [ ] Initialize Wails v2 project with React + TypeScript template
- [ ] Configure Wails bindings for Go services
- [ ] Set up frontend tooling (Vite, ESLint, Prettier, shadcn/ui)
- [ ] Create basic app shell with navigation tabs
- [ ] Set up Zustand for UI state + TanStack Query for server state
- [ ] **Test**: Component test: app shell renders correctly
- [ ] **Test**: Component test: navigation tabs switch views
- [ ] **Test**: Wails binding test: Go service calls work from frontend

#### M2.2: Core UI Components
- [ ] Download list component with real-time progress bars
- [ ] Add URL dialog with protocol auto-detection
- [ ] Speed graph component
- [ ] Protocol indicator badges (HTTP/BT/IPFS/Video)
- [ ] Category tabs (Downloads/Uploads/Active/Completed/Settings)
- [ ] Status bar with global stats
- [ ] Theme engine (light/dark)
- [ ] **Test**: Component test: each component renders with mock data
- [ ] **Test**: Component test: progress bar updates in real-time
- [ ] **Test**: Component test: protocol auto-detection (http/magnet/ipfs URLs)
- [ ] **Test**: Component test: theme switching (light ↔ dark)
- [ ] **Test**: Accessibility test: keyboard navigation, ARIA labels

#### M2.3: Service Integration
- [ ] Bind DownloadService to Wails runtime
- [ ] Implement SSE event bridge for real-time UI updates
- [ ] Add download management (add/pause/resume/cancel/retry)
- [ ] Add drag-and-drop queue reordering
- [ ] Add bandwidth limiter UI
- [ ] Add download scheduler UI
- [ ] Add system tray integration (minimize to tray, notifications)
- [ ] **Test**: Integration test: add download via UI → verify daemon receives request
- [ ] **Test**: Integration test: real-time progress updates appear in UI
- [ ] **Test**: Integration test: pause/resume via UI → verify daemon state changes
- [ ] **Test**: Integration test: system tray minimize/restore
- [ ] **Test**: E2E test: full download flow via GUI (add → download → complete)

#### M2.4: Browser Extension
- [ ] Set up WXT project for cross-browser extension
- [ ] Implement download interception (monitor network requests)
- [ ] Add "Download with orig-hub" context menu
- [ ] Add extension popup for quick URL adding
- [ ] Add notification toast when download starts
- [ ] **Test**: Extension unit test: URL detection logic
- [ ] **Test**: Extension unit test: context menu registration
- [ ] **Test**: Integration test: extension → daemon API → download starts
- [ ] **Test**: Cross-browser test: Chrome, Firefox, Edge

#### M2.5: Cross-Platform Polish
- [ ] Test on Windows, macOS, Linux
- [ ] Add native file dialog integration
- [ ] Add auto-start on boot option
- [ ] Optimize bundle size
- [ ] Add auto-update mechanism
- [ ] **Test**: Platform test: Windows (file dialogs, tray, notifications)
- [ ] **Test**: Platform test: macOS (file dialogs, tray, notifications)
- [ ] **Test**: Platform test: Linux (file dialogs, tray, notifications)
- [ ] **Test**: Performance test: app startup < 3s, memory < 200MB idle

#### M2.6: M2 Integration Verification
- [ ] **Stage 1**: `go build ./...` + `bun run build` — zero errors
- [ ] **Stage 2**: `go test ./...` + `bun run test` — coverage > 80%
- [ ] **Stage 3**: API test all daemon endpoints (unchanged from M1)
- [ ] **Stage 4**: Component tests for all UI components
- [ ] **Stage 5**: E2E: full download flow via GUI (Playwright)
- [ ] **Stage 6**: Screenshot: main window, download progress, settings, tray
- [ ] Write M2 completion report to `_docs/orig-hub/reports/M2-SCOPE.md`

### M2 Gate Verification
- [ ] All 6 test stages pass
- [ ] Desktop app runs on Windows, macOS, Linux
- [ ] All download operations work through GUI
- [ ] Real-time progress updates via SSE/Wails events
- [ ] Browser extension intercepts downloads on Chrome + Firefox
- [ ] System tray works correctly on all platforms
- [ ] App bundle < 30MB
- [ ] M2-SCOPE.md report written and reviewed

---

## M3: BitTorrent + IPFS Protocols (Week 11-14)

**Goal**: Add BitTorrent and IPFS protocol support with complete test coverage.

### Task Breakdown

#### M3.1: BitTorrent Protocol
- [ ] Add `github.com/anacrolix/torrent` dependency
- [ ] Create `internal/protocol/bittorrent/protocol.go` — BitTorrentProtocol
- [ ] Create `internal/protocol/bittorrent/torrent_file.go` — .torrent file parsing
- [ ] Create `internal/protocol/bittorrent/downloader.go` — BT downloader
- [ ] Create `internal/protocol/bittorrent/tracker.go` — Tracker client
- [ ] Implement magnet URL support in registry
- [ ] Add BT-specific UI elements (peers, seeds, leechers)
- [ ] **Test**: Unit test: magnet URL parsing (valid, invalid, missing info_hash)
- [ ] **Test**: Unit test: .torrent file parsing (single file, multi file, private)
- [ ] **Test**: Integration test: download via local test tracker + seeder
- [ ] **Test**: Integration test: pause/resume BT download
- [ ] **Test**: Integration test: magnet link → metadata → download flow
- [ ] **Test**: Benchmark: BT download speed vs HTTP for same content

#### M3.2: IPFS Protocol
- [ ] Add `github.com/ipfs/go-ipfs-api` dependency
- [ ] Create `internal/protocol/ipfs/protocol.go` — IPFSProtocol
- [ ] Create `internal/protocol/ipfs/gateway.go` — Gateway fallback
- [ ] Create `internal/protocol/ipfs/downloader.go` — IPFS downloader
- [ ] Create `internal/protocol/ipfs/pinning.go` — Pin management
- [ ] Implement ipfs:// and ipns:// URL support
- [ ] Add IPFS-specific UI elements (CID, gateway status, pin status)
- [ ] **Test**: Unit test: CID parsing (v0, v1, invalid)
- [ ] **Test**: Unit test: gateway fallback (primary fails → secondary → tertiary)
- [ ] **Test**: Integration test: download via local IPFS node (ipfs-lite)
- [ ] **Test**: Integration test: download via public gateway
- [ ] **Test**: Integration test: pin/unpin content
- [ ] **Test**: Integration test: gateway timeout → fallback verification

#### M3.3: Protocol UI Enhancements
- [ ] Add protocol-specific settings panels
- [ ] Add torrent file picker dialog (.torrent file open)
- [ ] Add IPFS gateway configuration UI
- [ ] Add protocol status indicators in download list
- [ ] **Test**: Component test: BT settings panel renders
- [ ] **Test**: Component test: IPFS gateway config saves correctly
- [ ] **Test**: E2E test: add magnet link via GUI → download completes

#### M3.4: M3 Integration Verification
- [ ] **Stage 1**: `go build ./...` + `bun run build` — zero errors
- [ ] **Stage 2**: `go test ./...` + `bun run test` — coverage > 80%
- [ ] **Stage 3**: API test: add BT/IPFS downloads via REST API
- [ ] **Stage 4**: Component tests for protocol-specific UI
- [ ] **Stage 5**: E2E: HTTP + BT + IPFS downloads in same session
- [ ] **Stage 6**: Screenshot: download list with mixed protocols
- [ ] Write M3 completion report to `_docs/orig-hub/reports/M3-SCOPE.md`

### M3 Gate Verification
- [ ] All 6 test stages pass
- [ ] BitTorrent download works with magnet links and .torrent files
- [ ] IPFS download works with CID URLs
- [ ] Protocol auto-detection works correctly for all schemes
- [ ] UI shows protocol-specific information (peers, CID, gateway)
- [ ] No regression in HTTP download functionality
- [ ] M3-SCOPE.md report written and reviewed

---

## M4: Multi-Node Distributed Download (Week 15-19)

**Goal**: Enable distributed downloads across multiple orig-hub instances.

### Task Breakdown

#### M4.1: Node Protocol
- [ ] Define gRPC service definitions (NodeService, DownloadService, SyncService)
- [ ] Generate Go code from .proto files
- [ ] Implement gRPC server and client
- [ ] Add mutual TLS authentication
- [ ] **Test**: Unit test: gRPC service methods (register, heartbeat, start_download)
- [ ] **Test**: Unit test: mTLS handshake (valid cert, invalid cert, expired cert)
- [ ] **Test**: Integration test: client → server communication

#### M4.2: Node Discovery
- [ ] Implement mDNS-based local discovery
- [ ] Add manual node configuration
- [ ] Build node health monitoring
- [ ] Add node registration and deregistration
- [ ] **Test**: Unit test: mDNS discovery (find node, timeout, multiple nodes)
- [ ] **Test**: Integration test: node joins cluster, appears in coordinator list
- [ ] **Test**: Integration test: node leaves cluster, coordinator detects failure

#### M4.3: Download Coordination
- [ ] Implement task splitter (divide file into chunks)
- [ ] Build chunk distribution logic
- [ ] Add progress aggregation from nodes
- [ ] Implement chunk assembly and verification
- [ ] **Test**: Unit test: task splitter (various file sizes, chunk sizes)
- [ ] **Test**: Integration test: 2 nodes download different chunks, assemble correctly
- [ ] **Test**: Integration test: progress aggregates from both nodes
- [ ] **Test**: Integration test: checksum verification after assembly

#### M4.4: Fault Tolerance
- [ ] Handle node failure gracefully
- [ ] Implement chunk reassignment
- [ ] Add state synchronization on reconnection
- [ ] Build bandwidth management per node
- [ ] **Test**: Integration test: kill node mid-download, verify reassignment
- [ ] **Test**: Integration test: node reconnects, verify state sync
- [ ] **Test**: Integration test: bandwidth limit enforcement per node
- [ ] **Test**: Stress test: 3 nodes, kill 1, verify download completes

#### M4.5: UI Integration
- [ ] Add node status dashboard to Wails UI
- [ ] Add node management page
- [ ] Add multi-node download progress view
- [ ] Add node configuration in settings
- [ ] **Test**: Component test: node dashboard renders with mock data
- [ ] **Test**: E2E test: add node via UI, verify appears in dashboard

#### M4.6: M4 Integration Verification
- [ ] **Stage 1**: `go build ./...` + `bun run build` — zero errors
- [ ] **Stage 2**: `go test ./...` + `bun run test` — coverage > 80%
- [ ] **Stage 3**: API test: node management endpoints
- [ ] **Stage 4**: Component tests for node UI
- [ ] **Stage 5**: E2E: 2-node coordinated download via GUI
- [ ] **Stage 6**: Screenshot: node dashboard, multi-node progress
- [ ] Write M4 completion report to `_docs/orig-hub/reports/M4-SCOPE.md`

### M4 Gate Verification
- [ ] All 6 test stages pass
- [ ] 2+ nodes can coordinate a single download
- [ ] Node failure triggers automatic reassignment
- [ ] Progress aggregates correctly from all nodes
- [ ] gRPC communication is secure (mTLS)
- [ ] No regression in single-node download functionality
- [ ] M4-SCOPE.md report written and reviewed

---

## M5: Video Platform Integration (Week 15-18)

**Goal**: Native video platform download and upload support.

### Task Breakdown

#### M5.1: Platform Interface
- [ ] Define VideoPlatform interface
- [ ] Create platform registry
- [ ] Define video metadata types
- [ ] Create format selection types
- [ ] **Test**: Unit test: VideoPlatform interface compliance
- [ ] **Test**: Unit test: platform registry (register, get, match URL)

#### M5.2: YouTube Support
- [ ] Integrate yt-dlp as backend
- [ ] Implement video info extraction
- [ ] Add format/quality selection
- [ ] Add subtitle download
- [ ] Add playlist support
- [ ] **Test**: Unit test: YouTube URL detection (watch, playlist, short)
- [ ] **Test**: Integration test: extract video info (title, formats, duration)
- [ ] **Test**: Integration test: download video with specific format
- [ ] **Test**: Integration test: download subtitles
- [ ] **Test**: Integration test: download playlist (first 2 videos)

#### M5.3: Bilibili Support
- [ ] Implement Bilibili API client
- [ ] Add cookie-based authentication
- [ ] Add video download with quality selection
- [ ] Add danmaku download
- [ ] Add batch download support
- [ ] **Test**: Unit test: Bilibili URL detection (video, bangumi, space)
- [ ] **Test**: Integration test: extract video info
- [ ] **Test**: Integration test: download video with quality selection
- [ ] **Test**: Integration test: cookie auth flow

#### M5.4: Upload Support + UI
- [ ] Implement upload interface
- [ ] Add YouTube upload (OAuth)
- [ ] Add Bilibili upload
- [ ] Add metadata management (title, description, tags)
- [ ] Add video format selection dialog in UI
- [ ] Add upload queue management in UI
- [ ] **Test**: Component test: video format selection dialog
- [ ] **Test**: Component test: upload queue renders correctly
- [ ] **Test**: E2E test: download YouTube video via GUI

#### M5.5: M5 Integration Verification
- [ ] **Stage 1**: `go build ./...` + `bun run build` — zero errors
- [ ] **Stage 2**: `go test ./...` + `bun run test` — coverage > 80%
- [ ] **Stage 3**: API test: video download/upload endpoints
- [ ] **Stage 4**: Component tests for video UI
- [ ] **Stage 5**: E2E: YouTube download → verify file plays
- [ ] **Stage 6**: Screenshot: video format selection, download progress
- [ ] Write M5 completion report to `_docs/orig-hub/reports/M5-SCOPE.md`

### M5 Gate Verification
- [ ] All 6 test stages pass
- [ ] YouTube download works with format selection
- [ ] Bilibili download works with quality selection
- [ ] Upload works for at least 1 platform
- [ ] Playlist/batch download works
- [ ] No regression in other protocol functionality
- [ ] M5-SCOPE.md report written and reviewed

---

## M6: Polish, Testing & v1.0 Release (Week 20-22)

**Goal**: Comprehensive quality assurance and release preparation.

### Task Breakdown

#### M6.1: Regression Testing
- [ ] Full regression test suite (all protocols, all UI flows)
- [ ] Cross-platform testing (Windows 10/11, macOS 13+, Ubuntu 22.04+)
- [ ] Browser extension testing (Chrome, Firefox, Edge latest + 2 versions back)
- [ ] Multi-node stress test (5 nodes, 20 simultaneous downloads)
- [ ] Performance benchmarks vs M1 (no regression)
- [ ] Memory leak detection (long-running daemon, 24h test)
- [ ] Security scan (go vuln check, dependency audit)

#### M6.2: Documentation
- [ ] User guide (Desktop app)
- [ ] Browser extension guide
- [ ] Developer guide (adding protocols)
- [ ] Configuration reference
- [ ] Architecture decision records
- [ ] API documentation (OpenAPI/Swagger)

#### M6.3: Release Preparation
- [ ] Security audit (code review, dependency audit)
- [ ] Performance optimization (profile, optimize hot paths)
- [ ] CI/CD pipeline for releases (tag-triggered, multi-platform build)
- [ ] Scoop manifest / Homebrew formula / AUR package
- [ ] Docker image for daemon mode
- [ ] GitHub release with binaries for all platforms
- [ ] Auto-update mechanism final testing

#### M6.4: M6 Integration Verification (Final)
- [ ] **Stage 1**: `go build ./...` + `bun run build` — zero errors on all platforms
- [ ] **Stage 2**: `go test -race ./...` + `bun run test` — coverage > 80%, no races
- [ ] **Stage 3**: API test all endpoints (all protocols)
- [ ] **Stage 4**: Component tests for all UI components
- [ ] **Stage 5**: E2E: full user journey (install → add download → manage → settings)
- [ ] **Stage 6**: Screenshot: all pages, all states
- [ ] Write M6 completion report to `_docs/orig-hub/reports/M6-SCOPE.md`

### M6 Gate Verification (Release Gate)
- [ ] All 6 test stages pass on Windows, macOS, Linux
- [ ] Zero critical or high-severity bugs
- [ ] Documentation is complete and accurate
- [ ] Security audit has no critical findings
- [ ] Performance is comparable to or better than FDM/Surge
- [ ] Release binaries available for all platforms
- [ ] Auto-update works correctly
- [ ] M6-SCOPE.md report written and approved

---

## Test Infrastructure Summary

### Mock Servers Required

| Mock Server | Purpose | Protocols |
|-------------|---------|-----------|
| `mock_http_server` | HTTP range, content-disposition, redirect, slow, disconnect | HTTP |
| `mock_bt_tracker` | BitTorrent tracker announce, scrape | BitTorrent |
| `mock_ipfs_gateway` | IPFS CID resolution, pin, timeout | IPFS |
| `mock_video_api` | Video info extraction, format list | YouTube/Bilibili |
| `mock_grpc_node` | gRPC node communication | Multi-Node |

### Test Categories Per Milestone

| Category | Tool | Frequency | Gate |
|----------|------|-----------|------|
| Unit Tests | go test / vitest | Every commit | Must pass |
| Integration Tests | go test -tags=integration | Every PR | Must pass |
| API Tests | httptest / Postman | Every PR | Must pass |
| Component Tests | React Testing Library | Every PR | Must pass |
| E2E Tests | Playwright | Nightly + pre-merge | Must pass |
| Visual Regression | Playwright screenshots | Pre-merge | Review required |
| Performance Benchmarks | go test -bench | Weekly | No regression |
| Security Scan | go vuln check | Weekly | No critical |
| Stress Tests | Custom harness | Pre-release | Must pass |

### Coverage Requirements

| Layer | Minimum Coverage | Target |
|-------|-----------------|--------|
| Protocol Interface | 90% | 95% |
| HTTP Protocol | 85% | 90% |
| BitTorrent Protocol | 80% | 85% |
| IPFS Protocol | 80% | 85% |
| Video Platform | 75% | 85% |
| Download Manager | 85% | 90% |
| State Persistence | 90% | 95% |
| REST API | 85% | 90% |
| gRPC Services | 80% | 85% |
| Frontend Components | 75% | 85% |

---

## Dependency Graph (Updated)

```
M0 (Test Infra + CI) ──→ M1 (Protocol + HTTP)
                              │
                              ├──→ M2 (Wails GUI + Extension)
                              │         │
                              │         ├──→ M4 (Multi-Node)
                              │         └──→ M5 (Video Platform)
                              │
                              └──→ M3 (BT + IPFS)
                                        │
                                        ▼
                                  M6 (Release)
```

**Critical Path**: M0 → M1 → M2 → M4/M5 → M6

---

## Risk Register (Updated)

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Test infrastructure too complex | Medium | Medium | Start minimal, iterate |
| anacrolix/torrent API instability | High | Medium | Pin version, wrap behind adapter |
| Wails v2 platform issues | Medium | Low | Test early on all platforms |
| gRPC complexity | Medium | Medium | Start with WebSocket fallback |
| yt-dlp dependency | Medium | High | Consider Go-native extraction |
| SQLite concurrency limits | Low | Low | WAL mode + connection pooling |
| Scope creep | High | High | Strict milestone gates |
| Browser extension review process | Low | Medium | Follow store guidelines |
| Test flakiness in E2E | Medium | High | Retry logic, deterministic fixtures |
| Mock server maintenance | Medium | Medium | Keep mocks simple, test the mocks |

---

## Quick Reference

```bash
# Build
make build

# Test (all stages)
make test              # Stage 2: Unit tests
make test-integration  # Stage 3: API tests
make test-frontend     # Stage 4: Component tests
make test-e2e          # Stage 5: E2E tests
make test-screenshots  # Stage 6: Visual regression

# Coverage
make coverage          # Generate coverage report

# Lint
make lint              # Run golangci-lint + eslint

# Run daemon
./bin/orig-hub daemon --port 8080

# Run desktop GUI
./bin/orig-hub gui
```
