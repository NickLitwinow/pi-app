# Pi extensions and harness audit — 2026-07-23

This audit supersedes the version table in
`HARNESS-EXTENSIONS-AUDIT-2026-07-13.md`. The runtime source of truth is
`~/.pi/agent/settings.json` plus `pi list`; packages that only remain as direct
dependencies in Pi's private npm root are cache residue and are not loaded.

## Runtime baseline

- Pi `0.81.1`, equal to the current npm release during the audit.
- Local model `ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision` points
  to `http://127.0.0.1:8003/v1` with a `262144` token context window.
- All ten enabled npm extensions are at the current registry version.
- Ponytail is `4.8.4` at
  `16f29800fd2681bdf24f3eb4ccffe38be3baec6b`, exactly equal to
  `origin/main` during the audit.

## Enabled extensions

| Extension | Installed/current | Harness contract checked |
|---|---:|---|
| `pi-mcp-adapter` | `2.11.0` | `/mcp`, `/mcp-auth`; lazy MCP, output guard and atomic cache writes remain sandbox-compatible |
| `@juicesharp/rpiv-todo` | `2.0.0` | `/todos`; `todo` details retain the full task snapshot and `rpiv-todos` widgets survive replay/compaction |
| `@juicesharp/rpiv-ask-user-question` | `2.0.0` | Its new RPC fallback uses `select`/`input`; both dialog primitives and cancellation are implemented by the desktop UI |
| `@gotgenes/pi-permission-system` | `20.10.0` | `/permission-system`; RPC permission prompts use native `select`/`input`; default-on review logging can write only to its dedicated logs directory |
| `pi-claude-style-tools` | `1.0.68` | `/cc-tools`, `/cc-theme`, `/cc-spinner`; persisted turn-duration metadata is consumed by the chat timeline |
| `@narumitw/pi-retry` | `0.22.0` | Retry lifecycle/status events are rendered; the local reasoning model keeps the stall watchdog at `0`, while provider-error classification remains active |
| `@narumitw/pi-statusline` | `0.25.0` | `/statusline`; TUI footer ownership does not conflict with the RPC client and extension status events are accepted |
| `@plannotator/pi-extension` | `0.24.2` | All four current commands load; status, progress widgets, notifications and plan-mode toggle are supported |
| local `harness-extension` | workspace | `/pi-rewind`, `/pi-branch-return`, `/pi-workflow`, `/pi-task`; source identity is checked at runtime |
| `pi-web-access` | `0.13.0` | `/websearch`, `/curator`, `/google-account`, `/search`; remains the single general web path |
| `@tintinweb/pi-subagents` | `0.14.2` | `/agents`; Pi 0.81 model-runtime compatibility, lifecycle RPC and the narrow worktree-cwd patch are checked |
| `DietrichGebert/ponytail` | `4.8.4` git | All six current commands and six skills load from the official git package |

The runtime smoke now validates 33 extension/harness commands and skills, ten
model-facing tools, their owning package, absence of permission-log write
warnings, and an actual append to the permission review log. This catches a
package that still loads but has renamed, shadowed or lost its public surface.

## Installed in the private npm root but disabled

These 22 packages are not present in `settings.json`, are absent from `pi list`,
and therefore add no prompt, event handler, tool or sandbox authority to normal
sessions. Keeping them disabled is intentional: most duplicate an enabled
harness capability. Versions are shown only to prevent this cache from being
mistaken for the live environment.

| Package | Cached | Current | Decision |
|---|---:|---:|---|
| `@aliou/pi-guardrails` | `0.15.0` | `0.15.0` | disabled; duplicates permission-system |
| `@amaster.ai/pi-task-scheduler` | `0.1.4` | `0.1.6` | disabled; background scheduling is already owned by subagents/harness |
| `@juicesharp/rpiv-advisor` | `1.20.0` | `2.0.0` | disabled; independent evaluation is harness-owned |
| `@juicesharp/rpiv-args` | `1.20.0` | `2.0.0` | disabled; no current runtime dependency |
| `@juicesharp/rpiv-i18n` | `1.20.0` | `2.0.0` | disabled as a top-level extension; enabled rpiv packages use it as an optional library |
| `@juicesharp/rpiv-pi` | `1.20.0` | `2.0.0` | disabled; all-in-one workflow duplicates the harness |
| `@juicesharp/rpiv-web-tools` | `1.20.0` | `2.0.0` | disabled; `pi-web-access` is the single web path |
| `@juicesharp/rpiv-workflow` | `1.20.0` | `2.0.0` | disabled; persisted workflow state and gates are harness-owned |
| `@mrclrchtr/supi-cache` | `2.0.5` | `2.5.0` | disabled; diagnostic-only overlap |
| `@narumitw/pi-goal` | `0.18.0` | `0.24.0` | disabled; autonomous loop is harness-owned |
| `@narumitw/pi-plan-mode` | `0.9.2` | `0.24.0` | disabled; Plannotator owns plan mode |
| `@spences10/pi-observability` | `0.0.14` | `0.0.22` | disabled; desktop UI already consumes the RPC event stream |
| `@spences10/pi-team-mode` | `0.0.40` | `0.0.53` | disabled; duplicates subagents |
| `@sting8k/pi-vcc` | `0.4.0` | `0.4.0` | disabled; Pi compaction plus structured checkpointing is authoritative |
| `@trevonistrevon/pi-loop` | `0.6.0` | `0.6.4` | disabled; duplicates background lifecycle/repair loops |
| `pi-agent-browser-native` | `0.2.64` | `0.2.71` | disabled; not required by the current web workflow |
| `pi-claude-code-tui` | `0.1.10` | `0.1.10` | disabled; desktop UI owns chrome |
| `pi-hermes-memory` | `0.8.1` | `0.8.2` | disabled; avoids a second persistence/compaction policy |
| `pi-lens` | `3.8.70` | `3.8.71` | disabled; project gates remain deterministic and repository-owned |
| `pi-ponytail` | `0.1.2` | `0.1.2` | disabled; obsolete alternative to the official git package |
| `pi-rewind` | `0.5.0` | `0.5.0` | disabled; desktop rewind has stricter session/file transaction semantics |
| `pi-simplify` | `0.2.3` | `0.2.3` | disabled; overlaps Ponytail review |

The cache can be pruned later, but updating or deleting it is deliberately not
part of runtime correctness: another ad-hoc `pi -e npm:<package>` experiment
may still reuse it. Any package promoted back into `settings.json` must first be
updated and added to the runtime command/tool contract.

## Changes made from audit evidence

1. Added the exact
   `~/.pi/agent/extensions/pi-permission-system/logs` directory to the macOS
   sandbox write allowlist. `20.10.0` made its review stream default-on; the
   former profile caused the visible `EPERM` notification.
2. Expanded the runtime smoke from ten harness/Ponytail names to the complete
   current public command/skill surface and verified package provenance.
3. Added a real permission review-log append probe, not merely a profile string
   assertion.
4. Updated browser-preview marketplace fixtures that still advertised
   impossible/stale extension versions.

## Verification evidence

```text
pi --version                                      0.81.1
npm outdated --json                              no enabled package outdated
git rev-list HEAD...origin/main (Ponytail)        0 0
npm run check:pi-subagents                       passed, patch present
node bench/runtime-command-smoke.mjs              passed, 37 commands and 18 tools loaded
permission review log append                      passed, non-empty append observed
cargo test workspace_sandbox_allows...            passed
```

The remaining npm-root cache drift is non-runtime residue, not an unresolved
harness error. The production extension set is current and its observable RPC,
UI and sandbox boundaries are covered.
