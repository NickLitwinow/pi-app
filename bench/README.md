# bench — агентный бенчмарк (ROADMAP §5.11-1, H3)

Headless-прогоны изолированного `pi --no-approve --thinking <lvl> -p` на фиксированных задачах с детерминированной
проверкой результата. По этому бенчмарку судятся: сетка гиперпараметров модели
(temperature/topP/penalty в `~/.pi/agent/models.json`), каждое новое правило
harness-расширения и изменения набора инструментов — а не «на глаз».

## Финальная проверка одной командой

Полная high-reasoning матрица возобновляема и рассчитана на локальный запуск без
открытого assistant-turn:

```bash
npm run verify:harness:final
```

Точечный прогон не запускает остальные стадии и сохраняет результаты в тот же
resumable state. Например, после уже закрытых quick/advanced проверок:

```bash
npm run verify:harness:final -- --only-stages ablation-no-repair-loop,ablation-no-semantic-gates,ablation-no-ponytail --continue-on-failure
```

Каждый быстрый gate, advanced-task и ablation-arm получает отдельный checkpoint в
`bench/results/final-verification-state.json`. Повторный запуск пропускает готовые
этапы. По умолчанию pipeline fail-fast останавливается и не сжигает следующие GPU
часы, если outcome/workflow/treatment/model-judge текущего обязательного trial не
принят (`--continue-on-failure` собирает все failures). План без выполнения:
`node bench/verify-final.mjs --list`; только preflight:
`node bench/verify-final.mjs --preflight-only`; только быстрые проверки:
`node bench/verify-final.mjs --quick-only`; повтор выбранных этапов:
`node bench/verify-final.mjs --reset postfix-config-migration,advanced-security-path-command`.

Если executor уже дал корректный deterministic outcome, но процесс оборвался во
время evaluator, повторный запуск восстанавливает **тот же workspace и тот же Pi
session JSONL** через `bench/resume-workflow.mjs`. Сохранённый evaluator evidence
повторно используется только если это `protocolVersion=2`, task завершён успешно и
записан completed primary+falsifier quorum; legacy single PASS и failed quorum не
восстанавливают workflow. Новый model turn нужен только когда пригодного evidence в
сессии нет. Для новых long/advanced trials внешний лимит равен 90 минутам, каждая
evaluator/falsifier/judge фаза ограничена собственным 30-минутным budget, а nested
repair-turn — 30 минутами. Не запущенные после fail-fast этапы показываются как
`pending`, а не как ложные blocking failures.

Принятый expensive artifact не пересчитывается после изменений только в UI,
документации или final-verifier: перед reuse повторно проверяются outcome/treatment,
точные task/arm, hashes harness и task suite, model/settings, версия Pi и закреплённый
HEAD Ponytail. Изменение любого execution input инвалидирует artifact.
Sandbox-пути канонизируются до `/private/var/...`, включая ещё не созданные lock-файлы;
это исключает macOS alias-ошибку `/var` → `/private/var` в compaction и judge replay.

Сводный verdict записывается в `bench/results/final-verification-report.json`.
Blind human-review packets намеренно остаются pending, пока их не заполнит реальный
reviewer. На macOS pipeline автоматически держит систему бодрствующей через
`caffeinate`; `--allow-sleep` отключает это поведение.

Skill arms считаются treatment-success только если staged skill прочитан ровно один
раз, его source/target hashes не изменились и required workflow завершён. Outcome
score хранится отдельно, поэтому случайно удачный patch без соблюдения treatment не
становится доказательством метода.

## Запуск

```bash
node bench/run.mjs                        # все задачи, thinking=minimal, таймаут 240с
node bench/run.mjs --only bugfix-off-by-one,refactor-rename
node bench/run.mjs --thinking high --label thinking-high
node bench/run.mjs --timeout 300 --label temp-0.6
node bench/run.mjs --suite long --model ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision --timeout 1200 --label long-baseline
node bench/run.mjs --suite long --only ledger-spec-twins --skill /path/to/skill --label with-skill
node bench/run.mjs --suite long --only config-migration --arms baseline,full --repeats 5 --timeout 1200 --judge all --judge-timeout 600 --label interleaved-ab
node bench/run.mjs --suite advanced --arms full,no-classifier,no-repair-loop,no-semantic-gates,no-ponytail --repeats 5 --timeout 1200 --label ablations
```

Проверка rewind без вызова модели (работает на копии указанной session JSONL):

```bash
node bench/rewind-smoke.mjs /path/to/session.jsonl
node bench/runtime-command-smoke.mjs
node bench/task-controls-smoke.mjs
node bench/macos-sandbox-smoke.mjs
node bench/skill-resource-smoke.mjs
node bench/schedule-smoke.mjs
node bench/analyze.mjs bench/results/<report>.json
node bench/blind-review.mjs bench/results/<legacy-report>.json
node bench/model-judge-replay.mjs bench/results/<report>.json --thinking high --timeout 1800
node bench/import-human-review.mjs bench/results/<report>.json bench/results/<scored-blind>.json
node bench/recover.mjs --suite long --only config-migration --workspace baseline:1:/absolute/workspace
npx vite-node bench/evaluator-replay.ts --workspace /absolute/workspace --thinking high --timeout 1800
```

Тест требует загруженный `pi-app-harness`, выполняет `/pi-rewind` через RPC и
проверяет, что активная ветка перемещена внутри того же файла без второй сессии.

Отчёт: `bench/results/<ts>-<label>.json` (в git не коммитится) + таблица в stdout.
При `--judge human|all` рядом создаётся отдельный перемешанный
`<ts>-<label>-human-review-blind.json`: в нём нет arm, trial, workspace или порядка
запуска, зато есть objective, deterministic evidence, diff и пустые поля вердикта.
Ревьюер открывает только blind-файл; соответствие `reviewId → arm` остаётся в основном
отчёте до окончания оценки.
`model-judge-replay.mjs` возобновляет только потерянные model verdicts, после каждого
workspace атомарно обновляет report и судит blind-копию без `.pi`, staged skill и arm
в пути. `import-human-review.mjs` принимает только полностью заполненные независимым
человеком packets: PASS/FAIL и четыре score 0..5; pending-поля импортировать нельзя.
`analyze.mjs` добавляет median/stddev/range, Wilson 95% interval для pass rate и
paired deltas относительно первого arm. При пяти повторах это всё ещё small-sample
evidence, а не заявление о статистической значимости.
Каждая fixture сначала коммитится как чистый baseline, поэтому агент видит
содержательный `git diff`, а не пустой diff поверх набора untracked-файлов.
Перед сеткой гиперпараметров меняйте `models.json`, ставьте `--label` с описанием точки.

## Метрики

- **success** — детерминированный outcome/static/security результат;
- **treatmentSuccess** — outcome успешен и обязательный workflow полностью принят;
  lucky patch с rejected evaluator остаётся виден в score, но не считается успехом treatment;
- **arms / trialOrder** — чередуемый порядок arms (не блоками), минимум 5–10 trials на arm;
- **provenance** — model config/settings/harness hashes, версии extensions/Pi, server model catalog и системная нагрузка до/после trial;
- **graders** — раздельные outcome/static/security проверки, опциональный independent model judge и blind human-review rubric;
- **score / maxScore** — несколько независимых outcome-проверок для длинных задач;
- **turns / toolCalls** — assistant-сообщения и tool-вызовы из jsonl сессии;
- **loopScore** — идентичные tool+args подряд (болезнь локальных 35B);
- **harness** — события pi-app-harness из `.pi/harness.log`: objectives,
  primary evaluator/falsifier starts, bounded verify loops, strategy notes и context checkpoints; legacy-счётчики
  nudges/loops/blocks сохранены только для сравнения старых отчётов;
- **finalCtx / outTokens** — контекст последнего ответа и суммарный output;
- **diff** — changed files, insertions, deletions и общий churn относительно
  закоммиченного fixture baseline (важно для Ponytail/YAGNI arm);
- suite `advanced` покрывает UI/rewind, vision, background/worktree/merge,
  compaction continuity и security/path/command-injection. Background-сценарий
  требует ровно два overlapping background Agent-run с worktree/base-SHA records и
  проверяет, что обе branch являются ancestors итогового HEAD;
- `node bench/compaction-smoke.mjs` копирует длинную пользовательскую сессию в
  изолированный fixture, вызывает настоящий RPC `compact` на ThinkingCap и проверяет
  structured summary, `CompactionEntry` и harness record, не меняя оригинальный JSONL;
- arms `no-classifier`, `no-repair-loop`, `no-semantic-gates` и `no-ponytail`
  дают по-компонентные ablations;
- **✅⏱** — задача решена, но pi не завершил ран сам (луп после решения — тоже дефект).

## Гигиена

- Каждая задача — в свежем tmp-каталоге со своим `git init`; промпт начинается с
  «работай СТРОГО в текущем каталоге» (инцидент §5.9-5: hermes-memory уводила агента
  в чужой репозиторий).
- Таймаут убивает всю process group pi (`detached` + `kill(-pid)`).
- Каждый trial получает отдельные `PI_CODING_AGENT_DIR`, sessions и TMP внутри
  fixture. Глобальные skills отключены; extension paths и tested skill заданы явно.
  На macOS process tree может писать только внутрь fixture, а staged skill имеет
  отдельный deny rule и проверяется по SHA-256 после запуска.
- Задача `websearch-version` — baseline-детектор отсутствия web-инструментов (H4):
  падает, пока web-access не возвращён в набор.

## Известные результаты

| Дата | Label | Итог | Заметки |
|---|---|---|---|
| 2026-07-11 | baseline-b1 | 2/3 (coding) | bugfix 37с/5 туров, slugify 45с; refactor — таймаут 150с без лупа. До abort-предохранителя bugfix зависал в BLOCK todo ×20 до таймаута |
| 2026-07-11 | baseline-b2 | 1/3 | refactor ✅⏱ 240с (решил, потом залип — «луп после решения»); multi-file — 60×write с ПУСТЫМИ arguments (формат-дрейф, невидим для tool_call-гардов → добавлен malformed-детектор на message_end); websearch ❌ ожидаемо + подтверждён ABORT after 8 blocked calls (ран прерван сам, 193с) |
| 2026-07-11 | malformed-guard | 1/1 | multi-file ✅ 57с/8 туров/0 лупов (в формат-дыру не попал; гард дежурит) |
| 2026-07-18 | thinkingcap-interleaved-ab-recovered | baseline 1/5, experimental full 1/5 | Исторический Fable-containing experiment: mean score 0.90 против 0.80, но +333.95s; success-rate lift не доказан. Эксперимент снят с production и final verifier 2026-07-19 |
| 2026-07-18 | evaluator-strict-discriminator-v4 | expected FAIL | Read-only high-reasoning evaluator самостоятельно нашёл `Number(version)` coercion defect за 435.93s; protocol accepted=false |

| 2026-07-11 | thinking-high | 1/3 | **thinking=high вредит агентике Qwable-v2**: slugify — 41 тур/40 повторов/таймаут (на minimal — 45с чисто); multi-file — быстро, но не доведено. bugfix ок (29с) |

**Текущий счёт кодинг-задач: 4/4 решаются** (37–57с при thinking=minimal); открытые дефекты поведения: «луп после решения» (pi не завершает ран), формат-дрейф args (ловится новым гардом), websearch до H4.

| 2026-07-11 | thinking-medium | 2/3 | bugfix 29с ✅, multi-file 44с ✅; slugify ❌ — 10 повторов/8 блоков, abort-предохранитель оборвал луп на 75с (гард работает) |

**Вывод по thinking (сетка 2026-07-11): minimal 4/4 → medium 2/3 → high 1/3** — агентная надёжность Qwable-v2 монотонно падает с ростом thinking. Рекомендуемый дефолт для агентных задач: **minimal** (low не тестирован); medium/high — точечно на архитектурные вопросы без инструментов.
