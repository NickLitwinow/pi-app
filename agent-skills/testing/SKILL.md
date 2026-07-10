---
name: testing
description: Write or extend tests for new/changed behavior. Use when the user asks for tests, when finishing a feature/fix that lacks coverage, or when refactoring risky code. Follows the project's existing test conventions.
---

# Testing

Tests document behavior. Write few, focused, honest ones.

## Steps

1. **Find the conventions.** Locate existing tests (`*_test.rs`, `*.test.ts`, `tests/`, `__tests__/`) and the runner (package.json scripts, Cargo). Copy their structure, naming, and helpers — do not invent a new style.
2. **Pick targets.** Test the behavior that just changed: the happy path, the edge that motivated the change, and the failure path. Skip trivia (getters, framework glue).
3. **Write the test to fail first** mentally: it must be able to catch the bug it guards against. A test that passes with the fix reverted is worthless — when practical, check by reverting.
4. **Use real shapes.** Feed realistic inputs (real RPC events, real diffs, real file contents) rather than minimal synthetic stubs; fixtures from actual data catch format drift.
5. **Run them** (narrow first, then the suite) and paste the real result. Fix failures you introduced; do not weaken assertions to make them pass.

## Rules

- No mocking what you can use for real (tempdirs, real git repos in tmp — this project already does both).
- One behavior per test; name it after the behavior, not the function.
- Deterministic: no sleeps for timing, no network, no reliance on machine state.
- If the project has zero test infrastructure, propose the smallest setup and ask before adding a framework.
