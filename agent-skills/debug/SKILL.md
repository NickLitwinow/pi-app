---
name: debug
description: Systematic debugging of errors, crashes, wrong output, or flaky behavior. Use when something fails and the cause is not obvious from the message — reproduce, form ONE hypothesis, probe it minimally, fix, verify. Prevents guess-loops.
---

# Debug

Discipline over intuition: one hypothesis, one probe, one conclusion per step.

## Steps

1. **Reproduce first.** Find the exact command/action that shows the failure and run it. If you cannot reproduce, gather the real evidence (logs, stack trace) before touching code.
2. **Read the error for real.** Stack traces name the file and line — open them. Read the failing function fully.
3. **One hypothesis.** State it in one sentence ("X is null because Y runs before Z"). If you have several, rank them and take the top one only.
4. **Smallest probe.** Design the cheapest check that can falsify the hypothesis: a targeted `rg`, reading one function, a one-line log print, running one test. Do NOT shotgun-edit multiple files "to see what helps".
5. **Conclude.** Probe confirmed → fix the root cause (not the symptom). Refuted → cross it off, next hypothesis. NEVER re-run the same probe expecting a different result.
6. **Verify the fix** by re-running the reproduction from step 1 (see /verify). Remove temporary debug prints.

## Rules

- After 2 refuted hypotheses or 2 failed fixes: STOP, write up what is known/ruled out, ask the user.
- Fix root causes; if you must ship a workaround, label it as such and say why.
- Suspect the most recent change first (`git diff`, `git log -3`) before suspecting the framework.
- Don't "fix" unrelated code you noticed along the way — note it and move on.
