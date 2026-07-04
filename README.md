# Pi — Native macOS Client for [pi.dev](https://pi.dev)

> **🌐 Language:** **English** | [Русский](README.ru.md)

<div align="center">

[![macOS](https://img.shields.io/badge/macOS-13+-000000?logo=apple)](https://www.apple.com/macos/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-22c55e?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

Lightweight native macOS app for **[pi](https://pi.dev)** — a full-featured AI coding assistant with streaming chats, session management, git integration, marketplace, and configuration management.

## ✨ Features

- **Streaming chats** — real-time token streaming with thinking, tool calls, and markdown rendering
- **Session management** — workspaces, search, fork, rewind, pin, archive, grouped sessions
- **Full git center** — staging, commits, branches, fetch/pull/push, commit history with diffs
- **Code review** — checkpoints, unified diffs, line comments, file revert
- **Live sessions** — file watcher on `~/.pi/agent/sessions`, new sessions appear instantly
- **Context window control** — ring indicator, tokens/cost details, auto-compaction toggle
- **Permission system** — native extension UI (select/confirm/input/editor), non-blocking
- **Parallel sessions** — read-only view of another session while agent works in background
- **Memory-efficient** — background history offloaded to files, tool outputs bounded
- **Create PR/MR** — GitHub (`gh`), GitLab (`glab`), or browser-based
- **Self-update** — check latest version on GitHub, rebuild from source, relaunch
- **Analytics** — per-day cost, per-model stats, hourly usage charts

## 📸 Screenshots

### Main Chat View

![Pi Chat](screenshot-home.png)

### Settings View

Configure editor, process limits, idle-kill, theme, UI scale, extensions, skills, MCP servers, and models.

### Review View

Git review with checkpoints, unified diffs, line comments, and file revert.

### Marketplace

Browse and install community extensions and skills from the npm registry.

## 🚀 Getting Started

### Requirements

| Requirement | Version |
| --- | --- |
| macOS | 13+ |
| [pi](https://pi.dev) | ≥ 0.80 (in `$PATH`) |
| [Node.js](https://nodejs.org) | ≥ 20 (for development) |
| [Rust](https://rustup.rs) | stable (for building) |
| [Git](https://git-scm.com) | ≥ 2.39 |

### Install from Source

```bash
# Clone the repository
git clone https://github.com/NickLitwinow/pi-app.git
cd pi-app

# Install dependencies
npm install

# Run in development mode (with mock backend for UI testing)
npm run dev
# Opens http://localhost:1420/ in your browser

# Run with Tauri (requires pi installed)
npm run tauri dev
```

### Build for Distribution

```bash
# Build a signed .app and .dmg (requires Developer ID for notarization)
npm run tauri build
```

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘B` | Toggle sidebar |
| `⌘N` | New session (in current project) |
| `⌘1` | Open Chat view |
| `⌘2` | Open Review view |
| `⌘3` | Toggle split-screen (chat + preview) |
| `⌘4` | Open Settings view |
| `⌘0` | Reset UI scale |
| `⌘+` / `⌘-` | Increase / Decrease UI scale |
| `⌘,` | Open Settings |

## 🏗 Architecture

Pi is a Tauri 2 application with a React 19 frontend. The Rust backend runs `pi --mode rpc` (JSONL over stdio) for each active session and streams events to the WebView.

```
┌─────────────────────────────────────────────┐
│  Frontend (React 19 + TypeScript)           │
│  ┌───────────┬───────────┬───────────────┐ │
│  │  Chat     │  Review   │  Settings     │ │
│  │  View     │  View     │  View         │ │
│  └───────────┴───────────┴───────────────┘ │
│  Zustand store  │  Backend abstraction      │
└───────────────┬───────────────────────────┘
                │  invoke / listen
┌───────────────▼───────────────────────────┐
│  Backend (Rust via Tauri)                 │
│  ┌───────────┬───────────┬───────────────┐ │
│  │ supervisor│  jsonl    │  sessions     │ │
│  │ (spawn/  │  (JSONL   │  (scan,       │ │
│  │  kill)   │   RPC)    │   search)     │ │
│  └───────────┴───────────┴───────────────┘ │
│  ┌───────────┬───────────┬───────────────┐ │
│  │  config   │  gitops   │  pi_cli       │ │
│  │ (atomic  │  (check- │  (install,     │ │
│  │  write)   │   points)│   stream)     │ │
│  └───────────┴───────────┴───────────────┘ │
└───────────────┬───────────────────────────┘
                │  JSONL
┌───────────────▼───────────────────────────┐
│  pi (installed agent)                     │
│  --mode rpc → JSONL over stdio            │
└─────────────────────────────────────────────┘
```

## 📁 Project Structure

```
src-tauri/src/
  supervisor.rs   # spawn/kill pi --mode rpc, events, limits, idle-reaper
  jsonl.rs        # strict LF-only JSONL-framer (pi RPC spec)
  sessions.rs     # scan ~/.pi/agent/sessions, metadata, search, analytics
  config.rs       # settings/models/mcp.json: atomic write + backup; skills
  gitops.rs       # checkpoints, review-diff (+untracked), revert
  pi_cli.rs       # pi install/remove/update with output streaming
  editor.rs       # open files in external editor

src/
  lib/            # backend abstraction (Tauri/mock), RPC reducer, markdown, diff
  state/store.ts  # zustand: workspaces, agents, RPC correlation
  components/     # Chat, History, Review, Analytics, Settings, Extension UI
```

## 🔧 Development

### Run Tests

```bash
# Frontend (Vitest)
npm run test

# Rust core (JSONL, sessions, config, git)
cd src-tauri && cargo test
```

### Without Tauri

Run the frontend in a browser with a mock backend — useful for UI-only development:

```bash
npm run dev
```

The mock backend simulates sessions, tool calls, permissions, and analytics.

## 📦 Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | [Tauri 2](https://tauri.app) |
| Frontend | [React 19](https://react.dev) + [TypeScript 5.8](https://www.typescriptlang.org) |
| Styling | CSS (dark/light themes, native macOS look) |
| State | [Zustand 5](https://zustand.pm) |
| Markdown | [shiki 3](https://shiki.style) + [marked 15](https://github.com/markedjs/marked) |
| Icons | [Lucide React](https://lucide.dev) |
| Security | [DOMPurify 3](https://github.com/cure53/DOMPurify) |

## 🤝 Contributing

Contributions are welcome! Please read the [PLAN.md](PLAN.md) for architecture details and requirements.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT © [NickLitwinow](https://github.com/NickLitwinow)

---

*Built with ❤️ by [NickLitwinow](https://github.com/NickLitwinow)*
