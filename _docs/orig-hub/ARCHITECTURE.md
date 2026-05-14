# orig-hub Architecture Design Document

## 1. Project Overview

**orig-hub** is a multi-protocol, multi-platform, multi-node **desktop download manager** built by the origadmin team. It is designed as a Free Download Manager alternative — a native windowed application with browser integration, not a CLI/TUI tool.

### Core Principles
- **Desktop-First**: Wails desktop GUI is the primary interface, like Free Download Manager
- **Protocol-First**: All download/upload logic flows through a unified protocol interface
- **Browser Integration**: Intercept browser downloads via native extension
- **Clean Architecture**: Strict layer separation with dependency inversion
- **Extensible**: New protocols can be added as plugins without modifying core logic
- **Distributed**: Multi-node coordination for high-throughput downloads

### Product Positioning

| Product | Type | Comparison |
|---------|------|-----------|
| Free Download Manager | Desktop GUI download manager | ✅ Our target model |
| Internet Download Manager (IDM) | Desktop GUI download manager | ✅ Reference for UX |
| Surge (reference) | TUI download manager | ❌ Not our model |
| Motrix | Electron download manager | ⚠️ Similar but Electron-based |

---

## 2. System Architecture

<div class="arch-wrapper">
<div class="arch-sidebar">
<div class="arch-sidebar-panel">
<div class="arch-sidebar-title">Cross-Cutting</div>
<div class="arch-sidebar-item">Logging & Tracing</div>
<div class="arch-sidebar-item">Metrics & Monitoring</div>
<div class="arch-sidebar-item">Error Handling</div>
<div class="arch-sidebar-item">Config Management</div>
<div class="arch-sidebar-item">Security & Auth</div>
</div>
</div>
<div class="arch-main">
<div class="arch-layer user">
<div class="arch-layer-title">Presentation Layer</div>
<div class="arch-grid arch-grid-3">
<div class="arch-box highlight">Wails Desktop App<br><small>React + TypeScript (PRIMARY)</small></div>
<div class="arch-box highlight">Browser Extension<br><small>Chrome/Firefox/Edge (KEY)</small></div>
<div class="arch-box">CLI (headless mode)<br><small>Automation only</small></div>
</div>
</div>
<div class="arch-layer application">
<div class="arch-layer-title">Service Layer</div>
<div class="arch-grid arch-grid-3">
<div class="arch-box highlight">DownloadService<br><small>Protocol-agnostic CRUD</small></div>
<div class="arch-box">HTTP/gRPC API<br><small>REST + SSE + gRPC</small></div>
<div class="arch-box highlight">Node Coordinator<br><small>Multi-node sync</small></div>
</div>
</div>
<div class="arch-layer ai">
<div class="arch-layer-title">Protocol Engine</div>
<div class="arch-grid arch-grid-4">
<div class="arch-box highlight">HTTP<br><small>Concurrent/Single</small></div>
<div class="arch-box highlight">BitTorrent<br><small>anacrolix/torrent</small></div>
<div class="arch-box highlight">IPFS<br><small>go-ipfs-api</small></div>
<div class="arch-box highlight">Video Platform<br><small>YouTube/Bilibili</small></div>
</div>
</div>
<div class="arch-layer data">
<div class="arch-layer-title">Data & Infrastructure</div>
<div class="arch-grid arch-grid-4">
<div class="arch-box">State DB<br><small>SQLite WAL</small></div>
<div class="arch-box">Protocol Registry<br><small>Plugin system</small></div>
<div class="arch-box">Network Pool<br><small>Connection reuse</small></div>
<div class="arch-box">Node Discovery<br><small>mDNS / Manual</small></div>
</div>
</div>
</div>
</div>

---

## 3. Layer Architecture (Hexagonal/Ports & Adapters)

```
┌───────────────────────────────────────────────────────────┐
│                    Presentation Layer                      │
│  Wails Desktop (React) │ Browser Extension │ CLI (headless)│
├───────────────────────────────────────────────────────────┤
│                     Service Layer                         │
│  DownloadService │ UploadService │ NodeCoordinator        │
├───────────────────────────────────────────────────────────┤
│                   Protocol Engine                         │
│  Protocol Interface │ Registry │ CapabilitySet            │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────┐                │
│  │ HTTP │ │  BT  │ │ IPFS │ │  Video   │                │
│  └──────┘ └──────┘ └──────┘ └──────────┘                │
├───────────────────────────────────────────────────────────┤
│                  Infrastructure Layer                     │
│  SQLite │ Network Pool │ Config │ mDNS │ gRPC            │
└───────────────────────────────────────────────────────────┘
```

### Dependency Rule
Dependencies point **inward only**: Presentation → Service → Protocol → Infrastructure.

---

## 4. Wails Desktop App Architecture

### 4.1 Why Wails (Not Electron/Tauri)

| Factor | Wails | Electron | Tauri |
|--------|-------|----------|-------|
| Backend | Go (native) | Node.js | Rust |
| Binary size | ~10-20MB | ~100MB+ | ~5-10MB |
| Memory usage | Low | High | Low |
| Go ecosystem | ✅ Direct | ❌ Bridge needed | ❌ Bridge needed |
| Native feel | Good | Web-like | Best |
| Maturity | v2 stable | Very mature | Growing |

**Wails chosen because**: Go backend integrates directly with our protocol engine, no FFI bridge needed.

### 4.2 Desktop UI Layout (FDM-style)

```
┌─────────────────────────────────────────────────────────────┐
│  orig-hub                                    ─ □ ✕         │
├─────────────────────────────────────────────────────────────┤
│  📥 Downloads  │ 📤 Uploads  │ ⚡ Active  │ ⚙ Settings    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🔍 Add URL...                          ▼ Protocol  │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │                                                     │   │
│  │  📄 ubuntu-24.04-desktop.iso                       │   │
│  │  ████████████████████░░░░░  78%  12.5MB/s  ETA 2m  │   │
│  │  HTTP │ 4.7GB / 6.0GB │ 8 connections              │   │
│  │                                                     │   │
│  │  🎬 tutorial-video.mp4                              │   │
│  │  ██████████████████████████  100%  ✅ Complete      │   │
│  │  YouTube │ 1080p │ 1.2GB                           │   │
│  │                                                     │   │
│  │  🧲 debian-12.torrent                              │   │
│  │  ████████░░░░░░░░░░░░░░░░  35%  5.2MB/s  ETA 8m   │   │
│  │  BitTorrent │ 3.5GB / 10GB │ 24 peers              │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  ⬇ 3 downloading  │  ⬆ 1 uploading  │  ✅ 12 completed   │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 Key UI Features (FDM-inspired)

1. **Download List**: Real-time progress bars, speed, ETA, protocol indicator
2. **Add URL Dialog**: Auto-detect protocol, show available formats (video)
3. **Category Tabs**: Downloads, Uploads, Active, Completed, Settings
4. **System Tray**: Minimize to tray, download notifications
5. **Browser Integration**: Intercept downloads from browser extension
6. **Speed Limiter**: Global and per-download bandwidth control
7. **Scheduler**: Schedule downloads for off-peak hours
8. **Queue Management**: Priority queue with drag-and-drop reordering

### 4.4 Browser Extension Integration

```
Browser (Chrome/Firefox/Edge)
    │
    ▼  User clicks download link
Extension intercepts ──→ Sends URL to orig-hub daemon
    │                       │
    │                       ▼
    │                  ProtocolRegistry.MatchURL()
    │                       │
    │                       ▼
    │                  Add to download queue
    │                       │
    ▼                       ▼
Show notification    Desktop app updates in real-time
```

The browser extension communicates with the orig-hub daemon via HTTP REST API (same as Surge's extension pattern). The daemon runs as a background service managed by the Wails app.

---

## 5. Protocol Interface Design

### 5.1 Core Interfaces

```go
type Protocol interface {
    Name() string
    Schemes() []string
    ParseURL(raw string) (*ParsedURL, error)
    Probe(ctx context.Context, url *ParsedURL) (*Metadata, error)
    Capabilities() CapabilitySet
    CreateDownloader(cfg *DownloadConfig) (Downloader, error)
    CreateUploader(cfg *UploadConfig) (Uploader, error)
}

type Downloader interface {
    Download(ctx context.Context) error
    Pause() error
    Resume() error
    Progress() (*Progress, error)
    State() (*DownloadState, error)
}

type Uploader interface {
    Upload(ctx context.Context) error
    Progress() (*Progress, error)
    Cancel() error
    State() (*UploadState, error)
}
```

### 5.2 Capability System

```go
type Capability uint64
const (
    CapPauseResume   Capability = 1 << iota
    CapMirrors
    CapStreaming
    CapUpload
    CapMetadataProbe
    CapChunkBased
    CapAuthSupport
    CapMultiNode
    CapDHT
    CapPinning
)
```

### 5.3 Protocol Capability Matrix

| Capability | HTTP | BitTorrent | IPFS | Video Platform |
|-----------|------|------------|------|----------------|
| Pause/Resume | ✅ | ✅ | ✅ | Partial |
| Mirrors/Sources | ✅ | Peers | Gateways | CDN |
| Streaming | ✅ | ✅ | ✅ | ✅ |
| Upload | ❌ | ✅ | ✅ | ✅ |
| Metadata Probe | HEAD | Torrent info | CID stat | Video info |
| Chunk-based | ✅ | ✅ | ✅ | ❌ |
| Auth Support | Headers | Private keys | Pin tokens | OAuth |

---

## 6. Project Structure

```
orig-hub/
├── cmd/
│   └── orig-hub/              # Wails app entry point
│       └── main.go
├── internal/
│   ├── protocol/              # Protocol abstraction layer
│   │   ├── interface.go
│   │   ├── registry.go
│   │   ├── capabilities.go
│   │   ├── types.go
│   │   ├── http/
│   │   ├── bittorrent/
│   │   ├── ipfs/
│   │   └── videoplatform/
│   ├── download/              # Download manager & worker pool
│   ├── engine/                # Download engines
│   │   ├── concurrent/
│   │   ├── single/
│   │   ├── state/
│   │   └── types/
│   ├── core/                  # Service layer
│   ├── node/                  # Multi-node coordination
│   ├── processing/            # Post-processing pipeline
│   └── config/                # Configuration system
├── frontend/                  # Wails frontend (React + TypeScript)
│   ├── wails.json
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── components/    # UI components
│   │   │   │   ├── DownloadList.tsx
│   │   │   │   ├── ProgressBar.tsx
│   │   │   │   ├── AddUrlDialog.tsx
│   │   │   │   ├── SpeedGraph.tsx
│   │   │   │   ├── ProtocolSelector.tsx
│   │   │   │   ├── CategoryTabs.tsx
│   │   │   │   └── SettingsPanel.tsx
│   │   │   ├── pages/
│   │   │   │   ├── Downloads.tsx
│   │   │   │   ├── Uploads.tsx
│   │   │   │   ├── Active.tsx
│   │   │   │   └── Settings.tsx
│   │   │   ├── stores/        # Zustand state
│   │   │   ├── services/      # Wails bindings
│   │   │   └── App.tsx
│   │   └── package.json
│   └── app.go                 # Wails Go bindings
├── extension/                 # Browser extension
│   ├── chrome/
│   ├── firefox/
│   └── shared/
├── go.mod
├── .team/
└── _docs/
```

---

## 7. Key Design Decisions

### 7.1 Desktop-First, Not TUI

| Decision | Rationale |
|----------|-----------|
| Wails is the primary UI | Target users expect a desktop window app like FDM/IDM |
| No Bubble Tea TUI | Not needed for desktop download manager |
| CLI is headless mode only | For automation/scripting, not interactive use |
| Browser extension is key | FDM/IDM's killer feature is browser integration |
| System tray support | Desktop app should minimize to tray |

### 7.2 Why New Project Instead of Forking Surge

| Factor | Fork Surge | New Project (orig-hub) |
|--------|-----------|----------------------|
| Protocol coupling | HTTP tightly coupled (8/10) | Protocol-first from day 1 |
| UI model | TUI-first, GUI as add-on | Desktop GUI from day 1 |
| Architecture flexibility | Must refactor existing code | Clean architecture from start |
| Code ownership | Third-party MIT code | 100% own code |

### 7.3 What We Learn from Surge

| Surge Feature | orig-hub Adaptation |
|--------------|-------------------|
| Concurrent chunk-based download | Reimplement with protocol abstraction |
| Work-stealing task queue | Adopt pattern, make protocol-agnostic |
| Daemon mode + SSE | Adopt for browser extension communication |
| SQLite WAL persistence | Adopt same approach |
| Mirror distribution | Extend to multi-source (mirrors + peers + gateways) |
| Browser extension pattern | Adopt and enhance for FDM-style integration |

### 7.4 Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | Go 1.24+ | Performance, concurrency, single binary |
| Desktop UI | Wails v2 | Go backend + React frontend, native feel |
| Frontend | React + TypeScript | Industry standard, rich ecosystem |
| UI Components | shadcn/ui | Consistent, accessible, customizable |
| Browser Extension | WXT (Web Extension Tools) | Cross-browser, React-based |
| Database | SQLite (modernc.org/sqlite) | Pure Go, no CGO, WAL mode |
| gRPC | grpc-go | Multi-node communication |
| BitTorrent | anacrolix/torrent | Mature Go BT library |
| IPFS | go-ipfs-api | Official IPFS Go client |
| State Management | TanStack Query + Zustand | Server state + UI state separation |

---

## 8. Data Flow

### 8.1 Download Flow (Any Protocol)

```
User Input (URL from GUI / Extension / CLI)
    │
    ▼
ProtocolRegistry.MatchURL() ──→ Detects scheme ──→ Routes to Protocol
    │
    ▼
Protocol.ParseURL() ──→ Validates URL, extracts metadata
    │
    ▼
Protocol.Probe() ──→ Checks accessibility, gets file info
    │
    ▼
Show Add Download Dialog (format/quality/path selection)
    │
    ▼
Protocol.CreateDownloader() ──→ Creates protocol-specific Downloader
    │
    ▼
Downloader.Download() ──→ Executes download
    │
    ├── Progress events ──→ Wails Events ──→ React UI updates
    ├── State snapshots ──→ SQLite ──→ Resume support
    └── Completion ──→ System notification + UI update
```

### 8.2 Browser Extension Flow

```
Browser detects download URL
    │
    ▼
Extension sends POST /api/downloads to local daemon
    │
    ▼
Daemon creates download via DownloadService
    │
    ▼
Wails app receives SSE event ──→ Updates React UI
    │
    ▼
Extension shows notification toast
```

### 8.3 Multi-Node Download Flow

```
Coordinator receives download request
    │
    ▼
Analyze: file size, available nodes, bandwidth
    │
    ▼
Split file into chunks, assign to nodes
    │
    ├── Node A: chunks 1-N (gRPC StartDownload)
    ├── Node B: chunks N+1-M (gRPC StartDownload)
    └── Node C: chunks M+1-end (gRPC StartDownload)
    │
    ▼
Real-time progress sync via gRPC streaming
    │
    ▼
Coordinator assembles chunks + verifies checksum
```

---

## 9. Security Model

1. **Daemon Auth**: Bearer token for HTTP API access (browser extension)
2. **Node Auth**: Mutual TLS or pre-shared keys for gRPC
3. **Credential Storage**: Encrypted at rest, OS keychain integration
4. **URL Validation**: Strict parsing to prevent SSRF
5. **Download Verification**: Checksum validation (MD5, SHA256)
6. **Rate Limiting**: Per-protocol and per-node bandwidth limits
