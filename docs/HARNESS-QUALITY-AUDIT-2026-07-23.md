# Harness quality audit — 2026-07-23

## Scope

The pass covered the native Tauri backend, React UI, the installed Pi package set, standalone skills, themes, provider/MCP/settings editors, session and group CRUD, Code Review, workflow/background controls, preview/process management, and the trust boundary for data emitted by arbitrary extensions.

Installed package specs exercised in the UI and metadata backend included npm, scoped npm, pinned npm, Git and local paths. The local test configuration contained 12 packages, including `pi-mcp-adapter`, web access, todos, permission system, retry/statusline, Plannotator, subagents, Ponytail and the local Harness extension. Two direct `SKILL.md` paths and the installed Pi theme were also exercised.

## Closed findings

- Package management now preserves the exact installed source for update/remove and correctly parses scoped, pinned, Git and local specs. Offline registry failures no longer hide installed packages. Local Harness is identified as a client dependency. Mutations are serialized and disabled while another package action is active.
- An installed Pi package is no longer labelled “theme only” merely because it is viewed on the Themes tab. Installed packages are treated as potentially executable because one package may combine extensions, skills, themes and prompts.
- Extension-controlled dialog, status, widget, queue, workflow, task and checkpoint payloads are type-checked, size/count bounded and stripped of unsafe object keys before they reach React state. Malformed reserved Harness JSON now fails closed.
- Theme input is bounded and rejects path traversal and active CSS values (`url`, `var`, `expression`, declarations). Theme deletion is limited to direct JSON children of the canonical theme roots. Apply/save rolls back if app-config persistence fails.
- Standalone skills are discovered from direct files, directories and packages in global and project scope. Frontmatter parsing reads a bounded prefix and caps user-controlled fields.
- Provider CRUD validates names, URL schemes/credentials, model IDs/counts and context limits. Provider/model changes are reconciled atomically; an active provider cannot be deleted. Settings, models and MCP raw editors accept object roots only and preserve concurrent external edits.
- App configuration, session flags and settings writes are serialized and rollback on failure. Native app config clamps enums, scale, process limits, sidebar width, timeouts and colors. Session metadata now has deduplication and limits for groups, paths and pinned messages.
- Native JSON writes use unique temporary names under concurrent writes and remove failed temporaries. Network probe input is bounded, rejects credentials/whitespace/non-HTTP schemes and is separated from curl options with `--`.
- Sidebar project/session/group rows and Code Review branch/file/history/checkpoint rows are keyboard accessible. Resize has separator semantics and keyboard control. Rename, pin, archive, group, fork, delete, search and reveal failures are surfaced instead of silently ignored.
- Code Review resets cross-workspace selections and exposes branch/status/diff/history/checkpoint/editor failures. Process stop, Library config, theme and provider errors are also visible.
- Obsolete duplicate Extensions/Skills/Prompts settings surfaces were removed; Library is now the single package-management surface.
- `dompurify` was updated to 3.4.12, removing the npm advisory.
- The readiness verifier now creates its results directory on a fresh checkout.

## Verification evidence

- Frontend unit suite: 14 files, 145 tests (final expected count after the added package-risk test).
- Rust: 77 unit tests plus the real Pi agent roundtrip integration test; `cargo fmt --check` and Clippy with warnings denied.
- Visual/browser regression: 24 Playwright scenarios, including settings presets, Library, themes, Code Review, compact 150% layout, profiles, workflow controls, rewind, model selection/avatar, virtual scrolling and hotkeys.
- Extension runtime smoke: 37 registered commands and 18 required tools, including MCP, permissions, todo/question, Plannotator, web access, subagents and Ponytail.
- Additional passing smokes: direct task merge controls, macOS shared-repository sandbox, skill-resource sandbox, empty Git fixture, schedule rotation, workflow resume and same-session rewind.
- Dependency audit: `npm audit` reports 0 vulnerabilities.
- Production build and full Tauri release bundle succeeded, producing `Pi.app` and `Pi_0.1.0_aarch64.dmg`.
- Manual browser traversal covered Chat, Settings sections, Library categories and installed-only view, direct skills, themes, profiles, Code Review tabs, session/project menus, keyboard navigation and Harness workflow/task controls.

## Remaining measured risks

- The aspirational `perf:smoke` RSS budget remains red on the current macOS/WebKit runtime: approximately 282–292 MB total RSS versus the existing 180 MB target. Warm startup passed at about 0.52–0.62 s; cold runs were about 1.04–1.16 s around the 1.0 s target. This is already tracked in `docs/ROADMAP.md` G5 and was not hidden by raising the budget.
- The evidence-only readiness run passed current production configuration and live-model checks, but cannot validate seven historical long-run artifacts because `bench/results` artifacts are intentionally absent from this checkout. Deterministic current-code gates were run independently in this audit.
- Vite still reports the third-party `lottie-web` `eval` warning and three chunks above 500 kB. Lottie and Shiki language resources are lazy-loaded, so these are build/optimization warnings rather than a failed correctness gate.
- `cargo-audit` is not installed in this environment; Rust dependencies were compiled, tested and linted, but were not checked against the RustSec database in this pass.
