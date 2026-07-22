# Аудит покрытия исходного запроса: что ещё не «200%»

Дата первоначальной проверки: 2026-07-19. Финальная актуальная сверка находится в
`docs/HARNESS-FINAL-READINESS-AUDIT-2026-07-20.md`. Это не перечень обещаний, а карта фактически
наблюдаемого поведения: код, session JSONL, RPC-smoke, OS sandbox, UI snapshots,
production build и изолированные прогоны ThinkingCap на `localhost:8003`.

## Краткий вывод

Основной контур уже перестроен: capability intent → persisted DAG → исполнение →
детерминированные gates → независимый evaluator → bounded repair → review.
Background work, transactional worktree merge, same-session rewind, план, задачи,
timeline, context inspector и session branches существуют как реальные механизмы,
а не как текстовые роли в `AGENTS.md`.

До «200%» не дотягивают не базовые панели, а доказательность некоторых решений:
semantic evaluator был укреплён после воспроизводимых false PASS: candidate PASS
обязан пережить второй независимый counterexample-falsifier, а resume принимает
только versioned completed quorum. Первый полный post-fix workflow уже доказал
repair→re-evaluate→falsifier и 9/9 hidden gates; live compaction также прошёл. Затем
advanced rewind выявил новый blind spot: четыре review-слоя приняли payload без
восстановления leaf identity. Контракт и programmatic gate усилены, поэтому полный
fingerprint-run намеренно перезапускается. Все дорогие прогоны собраны в resumable
`bench/verify-final.mjs`, чтобы
выполняться локально без открытого assistant-turn. Browser/UI
auto-verify не является универсальным программным gate; фоновые задачи после
рестарта нельзя продолжить с середины; production sandbox пока полноценно
реализован только для macOS; реальные component-ablation и compaction прогоны должны
быть завершены до окончательного вывода.

## Покрытие исходных требований

| Требование | Состояние | Фактическая реализация | Что не «200%» |
|---|---|---|---|
| Убрать тупые ограничения harness | ✅ для обычной работы | Обычные read/write/shell вызовы не проходят через второй denylist; approval блокирует только реально high-risk/hotfix DAG | Intent всё ещё выводится локальной policy-функцией, а не отдельным semantic router; ложную маршрутизацию измеряет classifier ablation |
| AI workflows и loops | ✅ | Persisted profile DAG, зависимости, acceptance, project verifier manifest, primary+falsifier quorum и максимум 4 repair continuations; stateful flows обязаны доказать identity+payload round trip, invalid handles и отсутствие nested aliasing | Общий evaluator не заменяет task-specific semantic probes; каждый repair повторяет весь clause/corpus audit, потому что один verdict может остановиться на первом blocker |
| Упростить и адаптировать `AGENTS.md` | ✅ | Глобальный файл — менее 450 слов; только работа, безопасность, проверка и контекстная дисциплина | Repo-specific команды должны оставаться в локальном `AGENTS.md`/manifest, иначе глобальный файл снова разрастётся |
| ThinkingCap с окном 262144 | ✅ | `localhost:8003/v1`, vision+reasoning, `contextWindow=262144`, `maxTokens=16384`; production default thinking переведён на `high` | Основной interleaved A/B стартовал на заранее зафиксированном `minimal`, поэтому после него нужен отдельный high-reasoning post-fix прогон |
| Проверить compaction | ✅ механизм и live evidence | Pi compaction: reserve 32768, keep recent 24000; structured checkpoint при 75%; UI показывает usage/checkpoints/compactions; реальная копия сессии 81k tokens была compacted до ~42k без изменения оригинала | После текущего semantic-gate patch полный final script по fingerprint намеренно повторит live-smoke; crash-resumable compaction в середине внешнего процесса остаётся отдельной задачей |
| Background tasks уровня coding apps | ✅ механизм, 🟡 новый final evidence | Queue/run/cancel/steer/transcript/diff/retry/merge; retained task records; isolated worktree; transactional verified merge. `maxConcurrent=2`; advanced grader требует ровно два overlapping background worktree-run и включение обеих веток в HEAD | Строгий сценарий должен пройти в final run; дальнейшие задачи остаются в очереди; после рестарта незавершённая задача становится interrupted; нет managed worktree retention/handoff |
| Skills/extensions/harness/workflows/sandboxes | ✅ | Ponytail, subagents и harness подключены явно; macOS Seatbelt ограничивает записи workspace | Linux/Windows production enforcement ещё не реализован; skill dependency/UI marketplace не заменяют project-owned manifests |
| Планирование с дроблением | ✅ | DAG Plan tab + persisted model `todo` backlog с status/dependencies/owner + approve-plan | Нет внешнего ticket/Kanban/spec-factory connector; это отдельная интеграция, а не недостающий цикл модели |
| Same-session rewind | ✅ механизм, 🟡 усиленный final evidence | Abort текущего хода, остановка active workers, подтверждённое восстановление Git checkpoint выбранного хода, `navigateTree(..., summarize:false)` в том же JSONL, возврат prompt/images, abandoned leaf и Return. При сбое navigation safety checkpoint возвращает файлы. Advanced gate отдельно проверяет session/leaf identity, invalid target и aliasing | Старые сообщения без сохранённого checkpoint явно используют conversation-only fallback; новый advanced fingerprint должен пройти повторно |
| Жёсткая Ponytail-привязка | ✅ в production | Официальное расширение включено, `defaultMode=full`, harness добавляет короткий mandatory fallback | Постоянная инъекция имеет context/latency cost; именно поэтому `no-ponytail` остаётся обязательной ablation-рукой |
| Исторический Fable A/B | ⛔ эксперимент завершён и снят | 5 paired trials дали outcome 1/5 в обеих руках и около +42% mean latency | По решению пользователя Fable удалён из prompt/config/arms/provenance/final verifier; его generic идеи реализуются нативным workflow без внешнего skill |

## Что показали четыре приложенных workflow

1. **Build → lint → format → test → review.** Реализовано как программные
   verifier nodes с возвратом в bounded repair, а не как четыре дорогих LLM-роли.
2. **Несколько planner/build/test/review sandboxes → merge → ship.** Реализованы
   изолированные worktree-задачи и verified merge. На одном model endpoint они
   запускаются параллельно попарно (`maxConcurrent=2`), последующие остаются в очереди.
3. **Support crisis → scout → hotfix → approve → sandboxes.** Реализован hotfix
   profile с containment plan и реальным human approval gate перед mutation.
4. **Ticket/spec factory → feature/bug/chore/hotfix routers.** Реализованы profiles
   и capability routing. Внешний Kanban/ticket ingestion и ad-hoc speculative
   fan-out пока отсутствуют.

## Наблюдаемый semantic gap

В первом paired A/B и baseline, и full получили 7/8. Контракт разрешал port только
как integer или decimal digit string, однако реализация оставила
`const port = Number(value.port)`. Поэтому `true`, `null`, `"1e3"` и другие
запрещённые значения проходили. Независимый evaluator прочитал этот код, но выдал
PASS, ошибочно посчитав `Number.isInteger(Number(value))` достаточной проверкой.

Это важнее ещё одного prompt-ритуала. После фиксированной матрицы реализованы:

- обязательная positive/negative boundary matrix для каждого нормативного clause;
- evaluator, который трассирует фиксированный coercion corpus через конкретное
  выражение, включая отдельный type-strict corpus для discriminator;
- второй изолированный falsifier, который не доверяет candidate PASS и отдельно
  ищет контрпримеры для literal sets, defaults, decimal grammar и discriminators;
- fail-closed parser, принимающий безвредный Markdown вокруг control lines, но
  требующий complete protocol, отсутствие clause FAIL и `BLOCKING: NONE`;
- versioned quorum evidence: старый single PASS и failed/malformed falsifier нельзя
  переиспользовать через same-session retry;
- программный preflight для неавторизованного удаления tracked public files;
- awaited repair lifecycle для fire-and-forget Pi continuation API.

Read-only regression replay на сохранённом дефектном workspace теперь сам нашёл
`Number(value.version)` и выдал `VERDICT: FAIL` за 435.93 s. Остаются нужны:

- project-owned semantic probes в `.pi/verifiers.json` для критичных доменных
  инвариантов;
- отдельный high-reasoning post-fix trial, чтобы доказать устранение, не меняя
  treatment посередине A/B.

Последующий high trial подтвердил реальный lifecycle, но одновременно нашёл ещё две
ошибки самого измерительного контура. Первый evaluator дал malformed false PASS;
второй независимо нашёл version coercion; repair-turn заменил discriminator на
strict equality; третий выдал полный matrix PASS в устойчивом формате
`Verdict: CLAUSE Cx: PASS`. Старый parser отвергал этот формат, хотя простой
`Verdict: PASS` под heading справедливо недостаточен. Parser теперь нормализует только
явную запись с clause id, а malformed positive review не цитируется executor'у.
Кроме того, hidden idempotency grader сравнивал `JSON.stringify` и считал разный
порядок эквивалентных object keys дефектом; он заменён на structural deep equality.
Новый final trial также содержит отдельный wrong-type host-default gate, поэтому эти
исправления не превращают evaluator-format tolerance в ослабление correctness.

Следующий full run подтвердил пользу loop на реальном длинном задании: первый executor
оставил два дефекта миграции, evaluator отклонил build, repair исправил оба, повторный
evaluator и falsifier дали кворум, а внешний grader получил 9/9. Но advanced rewind
затем показал другой класс false PASS. Реализация сохраняла `sessionId`, сообщения и
composer, однако `returnBranch` не восстанавливал старый `leafId` и принимал assistant/
unknown targets; primary evaluator, falsifier и внешний model judge это пропустили.
Теперь для state machine обязательны:

- детерминированный identity+payload round trip, а не только сравнение payload;
- отклонение unknown/wrong-kind handles;
- мутация возвращённых вложенных объектов как probe на alias к исходному state;
- явные те же obligations в primary, repair и falsifier prompts.
- тот же probe объявлен required node в fixture `.pi/verifiers.json`, поэтому failure
  возвращает evidence executor'у внутри DAG, а не остаётся постфактум внешним score;
- внешний grader повторяет probe и проверяет неизменность verifier/SPEC.

Сохранённая ошибочная workspace воспроизводимо падает на новом gate, поэтому прошлые
2/2 не считаются promotion evidence.

## UI и сессии: уже проверено

- Tasks — lifecycle, tokens/duration/branch, прямые controls и merge evidence.
- Plan — intent/risk, acceptance DAG и реальный `todo` backlog.
- Workflow — команды gates, attempts, evidence и timeline.
- Context — live tokens/window, checkpoint threshold, compact threshold и summaries.
- Branches — abandoned rewind leaf и возврат внутри того же session file.
- Rewind preview — сколько user/assistant/tool turns исчезнет, какие tasks будут
  остановлены и какие attachments вернутся.
- 122 frontend/policy unit tests, 23 Playwright scenarios (включая реальный
  click-preview-image-edit-resend rewind и отдельные Plan,
  Tasks и Context snapshots), 61 Rust test + real-agent E2E, production web build и
  Tauri release build прошли. Предыдущий fingerprint: 14/14 quick final stages;
  после identity-roundtrip patch точечные 113 unit tests и production build зелёные,
  полный fingerprint-run должен подтвердить остальные stages заново.

## UX/architecture gaps относительно Codex/Claude-class apps

Следующие пункты полезны, но не должны маскироваться словом «harness»:

1. Для этого проекта Playwright уже объявлен required gate в tracked manifest.
   Универсального агента, который сам запускает произвольный preview, читает DOM/
   console и строит новые screenshot probes для незнакомого UI, пока нет.
2. Managed worktrees требуют retention policy, snapshot-before-cleanup и Handoff;
   текущий transactional merge решает безопасность merge, но не lifecycle среды.
3. Side chat, split view, встроенный terminal/editor и drag-and-drop layout — gaps
   desktop workspace, а не качества agent loop.
4. OS notifications и scheduled routines нужны для фонового UX.
5. Cross-platform sandbox должен иметь Seatbelt/bubblewrap/Windows backends с одним
   policy contract.
6. Human judge нельзя автоматизировать и затем назвать независимым; blind packets
   должны оставаться pending до реального reviewer input.

Финальная проверка этих пунктов запускается одной командой
`npm run verify:harness:final`. Она делает preflight exact model/config/262144,
быстрые TS/Rust/UI/release/sandbox/session gates, отдельный post-fix trial, пять
advanced trials (включая доказуемые parallel worktree records), пять component arms и
live compaction. Каждый дорогой trial — отдельный durable stage; повторный запуск
пропускает уже доказанные стадии и выдаёт единый machine-readable verdict.

## Исторический paired A/B и решение об отказе от Fable

Пять повторов на руку завершены на ThinkingCap. Full строго прочитал staged Fable
ровно один раз в каждом trial; source и staged hashes остались неизменными.

| Метрика | Baseline | Full | Delta full − baseline |
|---|---:|---:|---:|
| deterministic success | 1/5 | 1/5 | 0 |
| mean score | 0.80 | 0.90 | +0.10 |
| mean duration | 793.40 s | 1127.34 s | +333.95 s |
| mean tool calls | 27.0 | 32.6 | +5.6 |
| mean tool errors | 2.6 | 3.6 | +1.0 |
| mean output tokens | 7174.2 | 6521.2 | −653.0 |
| mean diff churn | 191.8 | 91.2 | −100.6 |

Paired outcomes: one win full, one loss full, три tie. Экспериментальный full заметно
уменьшил churn и немного поднял частичный score, но не поднял end-to-end success и
стоил примерно 42% дополнительного времени. 2026-07-19 пользователь принял решение
полностью отказаться от Fable: экспериментальные arms, skill checkout, prompt flag,
provenance pin и final-judge replay удалены. Исторический report сохранён как evidence:
`bench/results/2026-07-18T12-02-54-595Z-thinkingcap-interleaved-ab-recovered.json`.

## Research alignment

Codex рекомендует короткий практичный `AGENTS.md`, явные goal/context/constraints/
done-when, plan mode для сложной работы, project verification, progressive disclosure
skills, OS sandbox и worktrees для фоновых независимых chats. Это совпадает с
реализованным направлением и одновременно подчёркивает оставшиеся gaps: managed
worktree lifecycle, browser verification и cross-platform enforcement.

Anthropic рекомендует начинать с простых composable workflows, использовать
evaluator-optimizer только при измеримом критерии, держать контекст high-signal и
аблировать компоненты long-running harness по одному. Поэтому жёсткий Ponytail нельзя
оценивать по ощущению: итог определят paired outcomes, стоимость,
ошибки, churn и независимая проверка.

Исследование 2026 года дополнительно предлагает отделять durable append-only session,
сменяемый harness и sandbox/tool «hands». Текущие typed session entries и OS sandbox
идут в этом направлении, но crash-resumable stateless harness и credential vault
остаются следующей архитектурной ступенью.

Первичные источники: [Codex best practices](https://learn.chatgpt.com/guides/best-practices.md),
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md),
[Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees.md),
[Codex skills](https://learn.chatgpt.com/docs/build-skills.md),
[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md),
[Codex sandbox](https://learn.chatgpt.com/docs/sandboxing.md),
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps),
[Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents).
