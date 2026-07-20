# Аудит harness, community extensions, skills и AGENTS.md

> Исторический срез до redesign. Текущая реализация, модель, набор пакетов и
> решение по официальному Ponytail описаны в
> [HARNESS-REDESIGN-2026-07-18.md](HARNESS-REDESIGN-2026-07-18.md); рекомендации
> ниже про `pi-ponytail` 0.1.2 и strict harness больше не являются текущими.

**Дата:** 2026-07-13  
**Скоуп:** фактически активный `~/.pi/agent/settings.json`, локально установленные npm-пакеты, их `pi`-манифесты и lifecycle/tool hooks, активные `SKILL.md`, глобальный `~/.pi/agent/AGENTS.md`, `pi-app-harness`. Секреты и содержимое model endpoint не читались; модель и сервер не запускались и не изменялись.

Это конфигурационный и статический аудит, а не полный supply-chain/security review исходников всех зависимостей. Pi прямо предупреждает, что extensions исполняются с полным доступом к системе, поэтому перед новыми установками всё равно нужен отдельный source review. Официальная механика позволяет фильтровать ресурсы пакета и отключать отдельные extensions/skills через `pi config`: [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md), [extensions API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

## Короткий вердикт

Проблема «harness ограничивает работу» подтверждена. Ограничения складываются не из одного harness, а из четырёх одновременно активных слоёв:

1. `AGENTS.md` требует todo до первого действия, Plan Mode для multi-file задач, обязательную остановку после двух похожих неудач и активное использование subagents.
2. `pi-app-harness` до этого аудита блокировал 4-й одинаковый вызов, 5-е последовательное чтение файла, 6-й todo и abort-ил ход после серии блокировок/сломанного tool-call.
3. `pi-lens` по умолчанию включает собственный read-guard и реально возвращает `{ block: true }` для edit/write, если считает прочитанный диапазон недостаточным или устаревшим.
4. `pi-permission-system` добавляет ещё один gate. В локальном логе есть серии confirm-запросов даже на `read`, `grep`, `todo`, `web_search` и `lens_diagnostics`; это согласуется с правилом `external_directory: ask` при неверно определённом рабочем корне.

Дополнительно `pi-ponytail` не является пассивным набором skills: extension стартует в режиме `full` по умолчанию и добавляет в **каждый** system prompt императивы YAGNI/minimalism. Это напрямую может урезать запрошенный объём фич, даже когда пользователь явно просит полную реализацию.

## Что исправлено в репозитории

`pi-app-harness` теперь по умолчанию работает как advisory layer:

- loop/todo/reread детекторы продолжают собирать сигналы и давать одноразовые подсказки;
- валидные tool calls не блокируются, ход не abort-ится;
- формулировки todo/context/summary/skill reminders больше не требуют немедленно остановиться или обязательно создать план;
- прежнее поведение доступно только при явном `PI_APP_HARNESS_STRICT=1`;
- `PI_APP_HARNESS=0` по-прежнему полностью выключает extension.

Permission-system остаётся единственным слоем, которому разрешено применять hard deny/ask в обычном режиме. Это сохраняет безопасность, но убирает скрытую конкуренцию политик.

## Фактическая конфигурация

В `settings.json` активны 18 npm-пакетов и локальный `pi-app-harness`. В npm-каталоге физически лежат 32 top-level пакета: 13 больше не активны и являются только остатками старых установок. Это не раздувает prompt само по себе, но усложняет диагностику — `npm ls` нельзя считать списком реально загружаемых extensions.

Текущий default model id в конфиге имеет длинное имя `Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-oQ4e-mtp`. Фактический runtime/model server не зондировался; исторические документы, называющие его `Qwable-v2`, нельзя считать доказательством текущей модели.

### Активные пакеты и доступные обновления

| Пакет | Установлен | npm latest на 2026-07-13 | Вердикт |
|---|---:|---:|---|
| `@gotgenes/pi-permission-system` | 18.1.1 | 20.4.2 | обновить после backup конфигов; единственный hard gate |
| `@juicesharp/rpiv-ask-user-question` | 1.20.0 | 1.20.0 | оставить |
| `@juicesharp/rpiv-todo` | 1.20.0 | 1.20.0 | оставить, но AGENTS не должен форсировать todo всегда |
| `@narumitw/pi-goal` | 0.11.0 | 0.14.1 | обновить; включать только для явных `/goal` задач |
| `@narumitw/pi-retry` | 0.10.0 | 0.14.1 | обновить; stall timeout 0 для локальной reasoning-модели оставить |
| `@narumitw/pi-statusline` | 0.10.0 | 0.14.1 | обновить; полезен главным образом в TUI |
| `@plannotator/pi-extension` | 0.21.4 | 0.23.1 | обновить; не добавлять второй plan-mode |
| `@sting8k/pi-vcc` | 0.3.18 | 0.4.0 | обновить; `overrideDefaultCompaction=false`, конфликта с core нет |
| `@tintinweb/pi-subagents` | 0.13.0 | 0.14.0 | не наращивать глобально; см. миграцию ниже |
| `pi-claude-code-tui` | 0.1.5 | 0.1.5 | TUI-only, ценности для pi-app RPC почти нет |
| `pi-claude-style-tools` | 1.0.64 | 1.0.64 | оставить для TUI parity |
| `pi-hermes-memory` | 0.7.23 | 0.8.0 | обновлять только после проверки cross-project isolation |
| `pi-lens` | 3.8.69 | 3.8.69 | сильный, но тяжёлый; read-guard — отдельная hard policy |
| `pi-mcp-adapter` | 2.11.0 | 2.11.0 | оставить; lazy MCP экономит prompt/context |
| `pi-ponytail` | 0.1.2 | 0.1.2 | **выключить default mode или вынести per-workspace** |
| `pi-rewind` | 0.5.0 | 0.5.0 | оставить только если нужны per-tool snapshots вне функций pi-app |
| `pi-simplify` | 0.2.2 | 0.2.2 | запускать по команде; не превращать в обязательный post-edit gate |
| `pi-web-access` | 0.13.0 | 0.13.0 | оставить для свежих фактов; инструменты должны быть lazy/on-demand |

Обновления доступны у 8 активных пакетов. Они намеренно не установлены в ходе аудита: обновление extensions меняет исполняемый код и требует отдельного окна без занятого benchmark-сервера.

### Дубли и конкурирующие обязанности

| Область | Сейчас | Решение |
|---|---|---|
| Hard permissions | permission-system + pi-lens read-guard + прежний strict harness | hard deny/ask оставляет permission-system; harness уже advisory; read-guard сделать явным профилем, а не скрытым default |
| Workflow pressure | AGENTS todo/plan + harness todo + rpiv-todo + plannotator + goal | todo — инструмент, не обязательный ритуал; plan только когда нужен; goal только по явному запуску |
| «Делать меньше» | Ponytail `full` в каждом prompt + `pi-simplify` + AGENTS minimal diffs | Ponytail default `off`; включать `/ponytail` на задачах, где это попросили |
| Rewind | core tree navigation + app fork/rewind + `pi-rewind` snapshots + harness `/pi-rewind` bridge | сохранить app/core rewind как основной; snapshots оставить опциональными |
| TUI presentation | statusline + claude-code-tui + claude-style-tools | в RPC app большая часть UI не видна; перевести TUI-only packages в профиль «Terminal» |
| Code intelligence | pi-lens (LSP/AST/linters/read-guard) | не ставить параллельно pi-shazam/pi-readseek; сначала настроить lens |
| Web | pi-web-access + возможные web MCP через adapter | оставить один основной search/fetch path; MCP — для специализированных источников |
| Subagents | старый scoped package + 15 agent descriptions + AGENTS «используй всегда» | per-workspace, 3–5 агентов, только явно разделимые задачи; одна локальная GPU выполняет их последовательно |

## Skills

Предыдущий документ утверждал, что активно 7 skills. Это устарело: пакеты автоматически добавляют свои skills. Фактически обнаружено **17**:

- 5 репозиторных workflow skills: `code-review`, `debug`, `testing`, `verify`, `ship`;
- 2 официальных: `frontend-design`, `skill-creator`;
- 4 от pi-lens;
- 5 от Ponytail;
- 1 `librarian` от pi-web-access.

Самые заметные пересечения: `code-review` ↔ `ponytail-review`, `verify/testing` ↔ pi-lens diagnostics, общий `debug` ↔ lens LSP, `librarian` ↔ generic web search. Это допустимо, пока descriptions узкие. Пять Ponytail skills плюс всегда активный Ponytail system prompt — основной источник attention/policy pollution.

Рекомендуемый глобальный набор: 5 репозиторных skills + `frontend-design` + `skill-creator` + `librarian` + 2 прикладных pi-lens (`ast-grep`, `lsp-navigation`). Authoring-skills pi-lens и Ponytail skills лучше отключить через `pi config` и включать в профиль/проект по необходимости. Цель — примерно 10 узких skills, не сотни и не несколько конкурирующих workflow-паков.

## AGENTS.md

Текущий файл требует отдельной правки, но в этом проходе не изменён, чтобы не менять активный model prompt во время benchmark.

Подтверждённые дефекты:

- identity жёстко объявляет локальный distilled Qwen «Claude Opus 4.7» и содержит недоказанные утверждения о линейке Anthropic;
- XML-структура сломана: `<additional_behavior>` и `<claude_coding>` открыты повторно вместо закрывающих тегов;
- `Claude is now being connected...` после закрытия корневого тега — лишний prompt injection-like хвост;
- одновременно требуют «не делать preamble» и обязательный todo/Plan Mode до действий;
- «две похожие неудачи → STOP and ask» слишком жёстко для автономной диагностики;
- subagents предписаны почти всегда, хотя локальная модель делит одну GPU;
- ограничения дублируются в AGENTS, skills и harness.

Целевая версия AGENTS должна быть model-neutral и примерно в 3–4 раза короче: пользовательский scope и факты выше workflow; plan/todo/subagents «когда помогают»; hard safety только для destructive/external side effects; verify пропорционально риску; никаких выдуманных identity/version claims.

## Permission-system и pi-lens

Найдены два permission-конфига:

- глобальный `~/.pi/agent/extensions/pi-permission-system/config.json`: `yoloMode=true`;
- app-owned `~/.pi/extensions/pi-permission-system/config.json`: режим allow-by-default, но `external_directory=ask`, опасные bash-команды ask/deny; marker `.pi-app-mode=auto`.

Исторический permission log показывает confirm на обычные операции в другом репозитории. Вероятная причина — cwd/root normalization классифицирует файлы текущего проекта как external. Это inference, не доказанный runtime-repro в этом проходе. Следующая проверка: показать в UI resolved permission root и источник победившего правила для каждого prompt; добавить тест «файл внутри cwd никогда не external».

Pi-lens read-guard включён по умолчанию и имеет собственный флаг `--no-read-guard`; context injection отключается отдельно (`PI_LENS_NO_CONTEXT_INJECTION=1` или `/lens-context-toggle`) и **не** выключает read-guard. UI должен показывать эти два состояния раздельно.

## Community landscape на 2026-07-13

Registry уже содержит много новых harness-паков, но текущая установка скорее переоснащена, чем недооснащена. По актуальному npm search и репозиториям:

- `pi-subagents` 0.34.0 — более новый unscoped пакет с async/chains/artifacts; рассматривать как **замену**, не дополнение к `@tintinweb/pi-subagents`;
- `pi-shazam` / `pi-readseek` — альтернативы pi-lens, ставить максимум одну после сравнительного benchmark;
- `@hypabolic/pi-hypa`, `pi-lean-ctx`, `pi-rtk-optimizer` — оптимизаторы context/tool output; не наслаивать на vcc и lens без измерения;
- `pi-btw` / `@juicesharp/rpiv-btw` — полезный кандидат для Codex-like side question, не загрязняющего основной контекст;
- `pi-interactive-shell` — кандидат для наблюдаемого интерактивного terminal workflow;
- `@narumitw/pi-plan-mode`, `pi-codex-goal`, `pi-ask-user`, `pi-landstrip`, `pi-sandbox` — уже покрыты plannotator/goal/ask-user/permission-system, установка создаст дубли;
- dynamic-workflows/pi-crew/large methodology packs — не глобально для одной локальной GPU и 35B-модели.

Npm search по `pi-package` содержит 1000+ результатов и не является знаком качества. Критерий допуска: один новый пакет за раз, source review, cold-start/context замер, одна и та же benchmark-задача, затем решение оставить/убрать. Официальные packages имеют полный системный доступ, поэтому «популярный» не равно «безопасный».

## Приоритетный следующий проход

1. После завершения benchmark сделать backup и обновить 8 отставших активных packages по одному.
2. Первым отключить Ponytail default `full`; сравнить полноту выполнения одинаковой задачи до/после.
3. Переписать AGENTS.md в model-neutral advisory-вариант после явного разрешения менять prompt конфигурацию.
4. Добавить в Settings экран «Policy stack»: permission mode, harness advisory/strict/off, lens read-guard, Ponytail mode, победившие config paths.
5. Исправить permission root diagnostics и покрыть cwd/external тестами.
6. Сократить активные skills с 17 примерно до 10 через resource filtering.
7. Только затем оценить side-chat (`pi-btw`) и modern `pi-subagents`; не ставить новые all-in-one harness packs.
# Historical audit note

Этот снимок отражает состояние на 2026-07-13. Текущая реализация и принятые решения описаны в [HARNESS-REDESIGN-2026-07-18.md](./HARNESS-REDESIGN-2026-07-18.md); в частности, отдельный strict-режим harness удалён.
