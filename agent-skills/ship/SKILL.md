---
name: ship
description: Commit, branch, push, and open a PR/MR cleanly. Use when the user says commit/push/PR/merge/ship/release. Handles branch naming, commit message style, and provider-specific PR creation (gh/glab/web).
---

# Ship

Only when the user asked to commit/push — never on your own initiative.

## Steps

1. **Inspect first**: `git status` and `git diff` — know exactly what is about to be committed. Never `git add -A` blindly if the tree contains unrelated or generated files; stage the intended paths.
2. **Branch**: if on main/master and the change is non-trivial, create `feat/<slug>` or `fix/<slug>` first. Reuse the repo's existing prefix style (`git branch -a` shows it).
3. **Commit message**: match the repo's history style (`git log --oneline -10`). Default: conventional commits — `type: imperative summary` ≤72 chars, body only when the "why" is not obvious from the diff.
4. **Verify before pushing**: run the project checks (see /verify). Do not push red.
5. **Push**: `git push -u origin <branch>`.
6. **PR/MR**: GitHub → `gh pr create --fill`; GitLab → `glab mr create --fill`; otherwise give the provider's compare URL for the branch. Use the user's existing auth; never hardcode accounts or tokens.
7. Report: branch, commit hash(es), PR link.

## Rules

- Split unrelated changes into separate commits.
- Never amend or force-push published history unless explicitly told.
- Never commit secrets, .env, local configs (check the diff for them — refuse and warn if present).
- Do not merge PRs yourself unless explicitly asked.
