# Итоговая сверка harness с исходными требованиями

Дата: 2026-07-20. Платформа проверки: macOS, локальная модель
`ollama/ThinkingCap-Qwen3.6-27B-oQ4e-DWQ-MTP-Vision` на `127.0.0.1:8003`.

## Вердикт

Harness готов к эксплуатации на текущем Mac как stateful coding workflow:
capability routing → persisted plan DAG → исполнение/фоновые worktree →
детерминированные gates → независимый evaluator + falsifier → bounded repair →
human gate для high-risk → verified merge/handoff. Rewind работает внутри того же
session JSONL и не создаёт дублирующую сессию.

Это не утверждение о статистическом превосходстве каждого компонента. Repair loop и
semantic gates дали сильный causal signal в ablation. Отдельный вклад Ponytail и
classifier по имеющимся одиночным component trials не установлен; production-policy
не зависит от такого утверждения.

## Поэлементная сверка

| Требование | Состояние | Авторитетное доказательство |
|---|---|---|
| Убрать keyword-router и лишние запреты | Выполнено | `TaskIntent` содержит независимые axes: primary/profile/risk/research/mutation/deletion/plan/sandbox/evaluator/approval; complex-prompt regression покрыт unit tests |
| Workflow loops вместо ролевого текста | Выполнено | Persisted DAG с dependencies, acceptance, owner, attempts/maxAttempts, failure reason и run-state `active/needs-human/blocked/completed`; bounded repair до 4 повторов |
| Реальные lint/typecheck/test/build gates | Выполнено | `.pi/verifiers.json` либо conventional package scripts разворачиваются в отдельные gate nodes и запускаются harness самостоятельно |
| Semantic gates и независимая проверка | Выполнено | Read-only primary evaluator + отдельный counterexample falsifier; fail-closed protocol и quorum v2 |
| Планирование и profiles | Выполнено | Declarative feature/bug/chore/hotfix/research/assessment DAG; Plan UI показывает dependencies, acceptance, owner/status и approval |
| Background tasks уровня coding apps | Выполнено | Queue/run/cancel/steer/transcript/diff/retry/verified merge, retained history, priority, queue position, evidence-based ETA и wait reason; `maxConcurrent=2` |
| Worktree и sandbox | Выполнено для текущей платформы | Isolated Git worktrees + transactional integration merge; macOS Seatbelt workspace-write smoke запрещает записи за boundary |
| UI/UX workflow | Выполнено | Tasks, Plan, Workflow, Context, Branches; live transcript, timeline, compaction/checkpoint inspector и task controls |
| Same-session rewind | Выполнено | Stop foreground/background work → preview → `navigateTree(..., summarize:false)` → restore text/images → edit/resend; abandoned leaf и Return остаются в том же JSONL |
| Rewind не создаёт новую сессию | Доказано | CLI smoke: `sameFile=true`, `noDuplicate=true`, mid-session duplicate prompt, persisted record и branch round-trip; Playwright проверяет click→preview→image restore→edit→resend и неизменное число sessions |
| Compaction для окна 262144 | Доказано | Live run: 81,489 → 41,921 tokens, original hash unchanged, structured checkpoint present, required sections complete |
| ThinkingCap/vision/262144 | Доказано | Pi config и живой `/v1/models`: reasoning+image, `contextWindow/max_model_len=262144`, high thinking, max output 16384 |
| Короткий AGENTS.md | Выполнено | Глобальный `AGENTS.md`: 390 слов, model/window/verification/context discipline без разросшейся identity |
| Ponytail production binding | Выполнено технически | Package enabled, `defaultMode=full`, mandatory harness fallback; runtime smoke видит extension commands и skill aliases |
| Отказ от Fable | Выполнено | Fable отсутствует в production config, harness, package scripts и final verifier; исторические reports сохранены только как экспериментальные данные |
| Самостоятельный research | Выполнено | Архитектура и аудит сопоставлены с composable workflows, evaluator-optimizer, context engineering, worktrees/sandbox и long-running harness patterns |

## Текущая проверочная база

- 122/122 frontend/policy/reducer unit tests.
- 23/23 Playwright UI scenarios, включая настоящий same-session rewind UX.
- Production TypeScript/Vite build.
- Runtime command smoke: 35 команд, включая harness и Ponytail aliases.
- Workflow resume smoke: legacy v3 state обновлён, quorum replay завершает тот же
  session со статусом `completed`.
- Rewind smoke: mid-session, одинаковые prompts, same file, no duplicate, persisted
  abandoned leaf, return round-trip.
- Ранее пройденные неизменённые Rust/release/sandbox/task-control gates не
  перезапускались по прямому указанию пользователя.

Long/advanced evidence:

| Сценарий | Итоговый artefact | Результат |
|---|---|---|
| Config migration full workflow | `bench/results/2026-07-19T16-41-15-213Z-final-postfix-config-migration.json` | 9/9, workflow complete, model judge pass |
| UI/session rewind | `bench/results/2026-07-19T13-58-20-319Z-final-advanced-ui-session-rewind.json` | 4/4, workflow complete, judge pass |
| Vision workflow extraction | `bench/results/2026-07-19T14-23-40-272Z-final-advanced-vision-workflow-extraction.json` | 2/2, workflow complete, judge pass |
| Background worktree merge | `bench/results/2026-07-19T04-48-37-681Z-final-advanced-background-worktree-merge.json` | 2/2, workflow complete, judge pass |
| Compaction continuity | `bench/results/2026-07-19T04-59-18-976Z-final-advanced-compaction-continuity.json` | 2/2, workflow complete, judge pass |
| Security path/command | `bench/results/2026-07-19T19-55-13-517Z-final-untested-security-path-command-path-boundaries-v2.json` | 4/4, workflow complete, judge pass |

Component evidence:

- `no-repair-loop`: 7/9 and failed judge — repair materially necessary on this task.
- `no-semantic-gates`: 7/9 and failed judge — deterministic/semantic review materially necessary.
- `no-ponytail`: 9/9, same as the strongest full run — no causal quality lift from
  Ponytail is established; it remains a production discipline preference, not a
  benchmark-proven claim.
- classifier comparison is inconclusive because compared trials ended 8/9 on both
  sides; classifier correctness is instead covered by direct complex-prompt tests.

## Осознанные границы, не скрытые под словом «готово»

1. Rewind меняет conversation branch, но намеренно не откатывает workspace files.
   Это безопаснее неявного destructive rollback и соответствует выбранному UX.
2. macOS sandbox доказан; Linux bubblewrap и Windows backend не реализованы. Это не
   блокирует эксплуатацию на текущем Mac.
3. Network/process isolation не абсолютна: network нужен research tools, а process
   execution является основной функцией coding agent. Записи ограничивает Seatbelt.
4. Незавершённый worker после полного рестарта помечается interrupted; его можно
   retry, но продолжение с точного model-token state не обещается.
5. Blind human-review packets остаются pending, пока их не оценит независимый человек.
   Model judge не переименовывается в human judge.
6. После последних additive lifecycle/queue/E2E исправлений общий source fingerprint
   изменился. По указанию пользователя дорогие уже пройденные model stages не
   повторялись; текущие изменения проверены unit/build/UI/runtime/resume/rewind
   suites, а long evidence используется как исторически совместимое, не как exact-hash
   повторный прогон.

## Команды повторной проверки

Быстрая проверка текущего кода:

```sh
npm test
npm run build
npm run test:visual
node bench/runtime-command-smoke.mjs
node bench/workflow-resume-smoke.mjs
```

Единый readiness-прогон без новых LLM inference:

```sh
npm run verify:harness:readiness
```

Только повторная валидация конфигурации и уже полученных JSON evidence:

```sh
npm run verify:harness:readiness -- --evidence-only
```

Полный exact-fingerprint прогон, если позднее понадобится переаттестация всех дорогих
model stages:

```sh
npm run verify:harness:final
```
