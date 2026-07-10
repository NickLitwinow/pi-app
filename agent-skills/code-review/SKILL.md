---
name: code-review
description: Review a diff or recent changes for real defects. Use when the user asks to review code, check a diff/PR/commit, find bugs in recent changes, or before merging. High-signal only — bugs, logic errors, security, data loss — not style.
---

# Code review

Review the change, not the whole repo. Report only issues you can defend.

## Steps

1. Get the diff: `git diff` (worktree), `git diff --cached` (staged), or `git show <hash>` / `git diff main...HEAD` (branch). If the user pointed at specific files, diff those.
2. For EVERY changed file: read the surrounding code (the whole function/module the change touches), not just the +/- lines. Most false findings come from skipping this step.
3. Hunt in priority order:
   - correctness: wrong logic, inverted conditions, off-by-one, broken error paths, race conditions
   - data loss / destructive ops without guard
   - security: injection, path traversal, secrets in code, unsafe deserialization
   - contract breaks: changed signatures/formats that callers still use (grep for callers!)
   - resource leaks: unclosed handles, listeners, processes, timers
4. For each suspected issue, VERIFY before reporting: re-read the code, trace the failing input. Drop anything you cannot trace to a concrete failure.
5. Report findings ranked by severity, each as: `file:line — one-sentence defect — concrete failure scenario — suggested fix`. If nothing survived verification, say so plainly.

## Rules

- Do NOT flag style, formatting, naming, or anything a linter catches.
- Do NOT propose refactors unless asked.
- Max 10 findings; fewer verified beats many guessed.
- Do not edit files in review mode unless the user asks you to fix the findings.
