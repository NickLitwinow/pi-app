---
name: verify
description: Prove that a change actually works before calling it done. Use after implementing or fixing anything, when the user asks "does it work", or before committing. Runs the real checks — build, tests, app — and reports real output.
---

# Verify

Never declare a task complete on the strength of "the code looks right". Prove it.

## Steps

1. Pick the strongest available proof, in order:
   - project checks: typecheck/lint/build (`npm run build`, `cargo check`, `tsc --noEmit`, …) — read package.json / Makefile / Cargo.toml to find them
   - tests: run the narrowest suite covering the change first, then the full suite if it's fast
   - runtime: actually exercise the changed path — run the CLI command, hit the endpoint (`curl`), start the dev server (see `.claude/launch.json`) and check the affected page/log output
2. Run the check. Read the FULL output, not just the exit code.
3. If it fails: fix, re-run. After 2 failed fix attempts on the same error, STOP — summarize the error and what you tried, and ask.
4. Report honestly: what you ran, what it printed (key lines), pass/fail. If a proof was impossible (no tests, can't run), say exactly what remains unverified.

## Rules

- One verification target at a time; don't fire a battery of commands speculatively.
- Never fabricate or paraphrase command output — quote the real lines.
- A green typecheck is NOT proof of behavior; prefer runtime evidence for behavior changes.
- New behavior deserves a test if the project has a test setup; add a focused one.
