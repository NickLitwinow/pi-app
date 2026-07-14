# Contributing

Thanks for your interest in improving this project — a native macOS client for
[pi](https://pi.dev). This guide gets you from clone to a green PR.

## Dev setup

```bash
git clone https://github.com/NickLitwinow/pi-app.git
cd pi-app
npm ci
npm run tauri dev      # launches the app with hot-reload
```

Requirements: **Node 20+**, **Rust stable** (via [rustup](https://rustup.rs)), Xcode
command-line tools. The app drives the `pi` binary — install it from [pi.dev](https://pi.dev)
so agent sessions work (the app finds it on your login-shell `PATH`).

Run the UI without Tauri (mock backend, no `pi` needed) for pure frontend work:

```bash
npm run dev            # http://localhost:1420, all backend calls mocked
```

## Repository map

| Path | What it is |
|---|---|
| `src/` | React 19 + Vite frontend (TypeScript, zustand store) |
| `src/state/store.ts` | Central store + all RPC plumbing to the agent |
| `src/lib/backend.ts` | Backend abstraction — real Tauri calls **and** the browser mock |
| `src/components/` | Views: Chat, Review (git), Settings, Preview, Marketplace |
| `src-tauri/src/` | Rust backend — process supervisor, git, sessions, config, preview |
| `harness-extension/` | Our own pi extension: todo-first, verify, skill routing, anti-loop |
| `agent-skills/` | Workflow skills (code-review, verify, debug, testing, ship) |
| `bench/` | Headless agent benchmark (task suite + metrics) |
| `docs/ROADMAP.md` | Full development roadmap — start here to find work |

## Tests & checks

Run before every PR (this is also what CI runs):

```bash
npx tsc --noEmit                                   # type-check
npm test                                           # vitest (reducer, diff parser)
cargo test --manifest-path src-tauri/Cargo.toml    # Rust unit + e2e
npx tauri build --bundles app                      # release .app for perf smoke
npm run perf:smoke                                 # macOS cold-start + full WebKit RSS budgets
```

The Rust `agent_e2e` test spawns a real `pi` process; it skips gracefully when
`pi` or the local model server is unavailable.

## Making a change

1. Branch from `main`: `git checkout -b feat/<slug>` or `fix/<slug>`.
2. Match the surrounding code — naming, idioms, comment density. Keep diffs focused.
3. **Verify it actually works**, not just that it compiles: drive the affected flow
   (the mock preview covers most UI; use a real `pi` session for agent behavior).
4. Conventional commit messages: `type: imperative summary` (`feat:`, `fix:`, `docs:`,
   `refactor:`, `test:`). See `git log` for the house style.
5. Any UI change: attach a screenshot or short clip to the PR.

## PR checklist

- [ ] `tsc`, `npm test`, and `cargo test` pass locally
- [ ] Change is verified end-to-end (not only compiled)
- [ ] No secrets, `.env`, or personal config in the diff
- [ ] UI changes include a screenshot/clip
- [ ] Roadmap item (if any) ticked in `docs/ROADMAP.md`

## Good first issues

Browse [issues labeled `good first issue`](https://github.com/NickLitwinow/pi-app/labels/good%20first%20issue).
Questions? Open a [Discussion](https://github.com/NickLitwinow/pi-app/discussions).
