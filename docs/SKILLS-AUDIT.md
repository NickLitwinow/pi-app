# Аудит скиллов pi и автоподбор под задачу

**Дата:** 2026-07-11 · Дополняет [ROADMAP.md](ROADMAP.md) §5.1 (harness) и [AGENT-ENV.md](AGENT-ENV.md) (аудит окружения).
**Модель:** [Qwable-v2](https://huggingface.co/lordx64/Qwable-v2) — см. §4 про её особенности; AGENTS.md переписан под неё (бэкап `~/.pi/agent/AGENTS.md.bak-20260711`).

## 1. Что было (диагноз «несвязанная каша» подтверждён)

В `settings.json → skills` стояло 5 каталогов, суммарно **18 скиллов**. Механика pi: *описания* всех скиллов попадают в стартовый промпт каждой сессии (~2К токенов на 18 штук), тело SKILL.md подгружается при вызове. Проблема не только в токенах — 35B-модель видит 18 названий и «хочет» их применять (attention pollution), а нужных нет вовсе.

| Каталог | Скиллы | Вердикт |
|---|---|---|
| `devops-skills` (marketplace) | aws-cost-finops, ci-cd, gitops-workflows, iac-terraform, k8s-troubleshooter, monitoring-observability | ❌ **Убрано из глобальных.** В проектах нет k8s/AWS/Terraform/ArgoCD. Тела по 100–350 КБ. Подключать per-project, когда появится такой проект (`<proj>/.pi/settings.json → skills`); для VPS-задач хватает ci-cd + monitoring точечно |
| `plugin-dev/skills` | agent-development, command-development, hook-development, mcp-integration, plugin-settings, plugin-structure, skill-development | ❌ **Убрано.** Это разработка **плагинов Claude Code** — у pi другой extension API; в контексте pi это чистый шум (7 описаний, ~3.5 КБ) |
| `mcp-server-dev/skills` | build-mcp-server, build-mcp-app, build-mcpb | ❌ **Убрано из глобальных.** Ситуативно полезно — подключать per-project при написании MCP-сервера |
| `skill-creator/skills` | skill-creator | ✅ **Оставлено** — нужен для написания/правки собственных скиллов (формат SKILL.md совместим) |
| `frontend-design/skills` | frontend-design | ✅ **Оставлено** — реально полезен в UI-работе над pi-app (4 КБ, короткий) |
| `~/.claude/skills` (не был подключен) | 13 × Google Cloud (bigquery, gke, firebase, cloud-run…) | ❌ **Не подключать** — GCP-стек не используется |

**Ноль скиллов покрывали ежедневный воркфлоу** — ревью, верификацию, отладку, тесты, коммиты. Именно эти «встроенные привычки» дают качество Claude Code, а не k8s-энциклопедии.

## 2. Что стало

`settings.json → skills` (бэкап `settings.json.bak-20260711`):

```json
"skills": [
  "~/GithubControl/pi-app/agent-skills",
  "~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills",
  "~/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/skills"
]
```

Итого **7 скиллов** (~1 КБ описаний в промпте вместо ~7.5 КБ), из них 5 — новые собственные workflow-скиллы в этом репозитории ([agent-skills/](../agent-skills)), версионируются git'ом:

| Скилл | Триггер («Use when…») | Что даёт |
|---|---|---|
| [code-review](../agent-skills/code-review/SKILL.md) | ревью диффа/PR/коммита | High-signal ревью как у кнопки «Review code» в Claude Code: только подтверждённые баги, формат `file:line — дефект — сценарий — фикс`, запрет на стиль/рефакторинг |
| [verify](../agent-skills/verify/SKILL.md) | после любой правки, «работает ли», перед коммитом | Контур верификации: typecheck → тесты → рантайм (в т.ч. dev-сервер из `.claude/launch.json`), честный отчёт реальным выводом, стоп после 2 неудачных фиксов |
| [debug](../agent-skills/debug/SKILL.md) | ошибка/краш/неверный вывод без очевидной причины | Анти-луп отладка: репродукция → ОДНА гипотеза → минимальный пробник → корневая причина → re-verify |
| [testing](../agent-skills/testing/SKILL.md) | написать/дополнить тесты | Конвенции проекта, реальные фикстуры, «тест должен уметь падать», без ослабления ассертов |
| [ship](../agent-skills/ship/SKILL.md) | commit/push/PR/MR | Гигиена: осмотр диффа перед add, ветка от main, conventional commits, verify перед push, gh/glab/web |

Все пять написаны короткими (1.5–2 КБ), императивными, в стилистике Claude Code — для Qwable-v2 это in-distribution формат (§4). Анти-луп правила («2 неудачи → стоп», «одна гипотеза за шаг») продублированы в скиллах намеренно: скилл активен именно в тот момент, когда модель склонна зациклиться.

Возврат старого набора: `cp ~/.pi/agent/settings.json.bak-20260711 ~/.pi/agent/settings.json`.

## 3. Автоподбор скиллов под запрос/задачу («автоподсос»)

Задача: скилл должен включаться сам — от запроса пользователя и текущей задачи сессии, а не «если модель вспомнит». Три уровня, от бесплатного к умному:

**Уровень 0 — сделано сейчас: кураторский набор + триггерные description.**
Штатный механизм pi (описания в системном промпте) и есть авто-выбор — он не работал, потому что 18 описаний были нерелевантным шумом. С 7 скиллами, у каждого из которых description начинается с чёткого «Use when …», модель выбирает надёжно; правило «задача совпала с описанием скилла → прочти SKILL.md и следуй ему» закреплено в AGENTS.md (§Workflow п.5). Это ровно то, как «Claude loads them automatically when relevant» работает в Claude Code.

**Уровень 1 — скилл-роутер в pi-app (итерация R2, дёшево, без LLM).**
В `sendPrompt` перед отправкой приложение матчит текст запроса (+ имя сессии) по описаниям скиллов (`list_skills` в Rust уже есть):
- скоринг: нормализация → пересечение стем/ключевых слов описания и запроса (BM25-lite, словарь триггеров в frontmatter: `keywords:`);
- топ-1..2 с порогом → в prompt добавляется системная подсказка: `[pi-app] Relevant skill: /debug — systematic debugging… Read its SKILL.md first if applicable`;
- в UI над композером — чипы подсвеченных скиллов (клик = вставить `/skill` в текст), как палитра `/`, но проактивная;
- защита: не подсказывать один и тот же скилл дважды подряд, выключатель в настройках.

**Уровень 2 — в расширении `pi-app-harness` (R2, работает и в TUI).**
Тот же матчинг внутри расширения pi (перехват user prompt через extension API) + контекст сессии: тип текущей todo-задачи (bugfix/feature/review/ship) поднимает соответствующий скилл; после `tool_execution_end` c edit/write харнесс напоминает про `verify`. Профили: «фронтенд-задача» → +frontend-design; «пишем MCP» → per-project подключение mcp-server-dev.

**Уровень 3 — семантика (после R2, по необходимости).**
Локальные эмбеддинги описаний (маленькая модель через oMLX или fastembed в Rust) для нечётких запросов; кэш векторов рядом с meta-кэшем. Вводить только если keyword-роутер даёт промахи — «fewest moving parts wins».

## 4. Особенности Qwable-v2, учтённые в AGENTS.md

По [карточке модели](https://huggingface.co/lordx64/Qwable-v2):

| Факт о модели | Адаптация |
|---|---|
| Файнтюн на трейсах сессий Claude Code (реальные имена Read/Edit/Bash, поля file_path/old_string/new_string) | Правило «держать pi-claude-style-tools включённым»; воркфлоу-скиллы и AGENTS.md написаны в стилистике Claude Code — in-distribution формат |
| XML `<tool_use>` надёжен только с явным агентным системным промптом; без него — дрейф в `<tool_code>`/markdown | Жёсткий гард: «никогда не писать tool call как markdown/прозу; распарсилось неудачно → одна повторная попытка → стоп» |
| Узкое распределение: DevOps/data-science нестабильны | Секция «Out of distribution»: меньше шаги, больше чтения, спрашивать раньше (+ мы убрали DevOps-скиллы из глобальных — они провоцировали OOD-действия) |
| Persona drift (называет себя Claude) | Секция Identity: «ты pi coding agent на локальной Qwen-модели, НЕ Claude» |
| Train seq 8192 — длинный контекст хуже заявленного окна | Ужесточена контекст-дисциплина: compact при >60%, чтение диапазонами, ре-якорение после компакции |
| Рекомендованный сэмплинг temp 0.6 / top-p 0.9; max_tokens 2048 в примерах | `models.json`: temperature 0.7→**0.6**, topP 0.95→**0.9** (бэкап `models.json.bak-20260711`); правило «ответ ≤ ~1500 токенов, большие файлы — частями» |
| Text-only | Из `models.json → input` убран `"image"` — UI перестанет предлагать прикреплять картинки этой модели |
| Reasoning унаследован от Opus 4.7 дистилла (не улучшен) | Оставлены sequential-thinking MCP для тяжёлых рассуждений и plan-mode для многофайловых задач |

Примечание: `models.json` по-прежнему описывает id `Qwen3.6-35B-A3B-Claude-4.7-Opus-DWQ4-mtp` — если oMLX теперь отдаёт веса Qwable-v2 под новым именем, поменяйте только `id` (сэмплинг уже выставлен под v2). Лицензия модели AGPL-3.0 — для локального личного использования ограничений нет.

## 5. Открытые хвосты (в ROADMAP)

- **Пакеты (24 шт.)** — вне скоупа этого аудита, но AGENT-ENV.md §2 всё ещё актуален: guardrails дублирует permission-system; team-mode/observability/task-scheduler/loop/supi-cache — кандидаты в per-workspace. С момента того аудита добавились pi-agent-browser-native (нужен превью), pi-ponytail, pi-simplify, pi-goal — стоит замерить стартовый промпт заново (цель ≤15К токенов).
- **15 sub-agent определений** в `~/.pi/agent/agents/` — рекомендация сократить до 3–5 остаётся в силе.
- Скилл-роутер (уровни 1–2) — включён в ROADMAP §5.1 как часть R2.
