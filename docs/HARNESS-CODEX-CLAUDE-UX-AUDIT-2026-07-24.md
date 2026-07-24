# Harness ↔ Codex app ↔ Claude Desktop: UX/data audit

Дата среза: **2026-07-24**. Цель аудита — не копирование внешнего вида
конкурентов, а проверка сквозных пользовательских сценариев: видимый контрол
считается реализованным только тогда, когда за ним есть сохраняемые данные,
исполняемое действие, обработка ошибок и тест.

## 1. Методика и границы

Проверены:

- официально задокументированные возможности Codex app и Claude Desktop;
- экраны Harness: Chat, Code Review, Library, Settings, Preview, sidebar,
  task/workflow/context/branch dock;
- поток данных от UI до Pi RPC и обратно в JSONL-сессию;
- mock backend, Tauri-команды и extension lifecycle;
- переключения экранов, проекты/сессии, rewind/fork/return, streaming,
  steer/follow-up, permissions, themes, skills, MCP и process controls;
- desktop/browser ввод: picker, Finder drop, paste и исторические image-блоки.

Не считаем паритетом статичный макет, если Harness не умеет получить или
изменить соответствующие данные. Не считаем отсутствием функции другое,
но эквивалентное и проверяемое взаимодействие.

## 2. Эталонные сценарии по официальным источникам

### Codex app

Codex позиционируется как command center для параллельных задач с отдельными
threads/worktrees, встроенным diff review, skills, automations и управляемыми
правилами/permissions:

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex for almost everything](https://openai.com/index/codex-for-almost-everything/)
- [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- [Codex for every role and workflow](https://openai.com/index/codex-for-every-role-tool-workflow/)

Desktop-справка дополнительно подтверждает:

- прикрепление, paste и drag нескольких PNG/JPEG-изображений:
  [Image inputs](https://learn.chatgpt.com/docs/image-inputs);
- снимок переднего окна как локальное вложение с сопровождающим текстом:
  [App shots](https://learn.chatgpt.com/docs/appshots);
- side-by-side viewer документов, таблиц, презентаций и PDF с аннотациями:
  [Artifacts viewer](https://learn.chatgpt.com/docs/artifacts-viewer);
- общий с агентом браузер, управление страницей, screenshots и feedback на
  локальном UI: [Browser](https://learn.chatgpt.com/docs/browser);
- настройки поведения follow-up, analytics, shortcuts, notifications,
  appearance, browser/computer permissions, personality, memory, archive и
  always-on-top: [Settings](https://learn.chatgpt.com/docs/reference/settings);
- voice и computer use:
  [Voice](https://learn.chatgpt.com/docs/features/voice),
  [Computer use](https://learn.chatgpt.com/docs/computer-use).

### Claude Desktop

Официальная документация Claude подтверждает:

- click/drag/paste PNG/JPEG/GIF/WebP в чат и постоянные project files:
  [Uploading files to Claude](https://support.claude.com/en/articles/8241126-upload-files-to-claude);
- выделенную artifact-панель, версии, inline edit, экспорт и несколько
  артефактов: [What are artifacts?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them);
- генерацию и редактирование xlsx/pptx/docx/pdf:
  [Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude);
- project workspace с чатами, knowledge, instructions, RAG и sharing:
  [What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects);
- единый каталог skills/connectors/plugins и повторное включение установленных
  интеграций:
  [Browse skills, connectors, and plugins](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory);
- account/project instructions, skills и styles:
  [Personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features).

## 3. Что уже находится на уровне данных Harness

| Область | Реальные данные/действие Harness | Состояние |
|---|---|---|
| Проекты и чаты | Pi JSONL sessions, sidebar CRUD, search, archive/close, fork, same-session rewind/return | Сильная база |
| Агент и модели | Pi RPC, provider/model picker, aliases, thinking level, streaming, usage/cost/context | Сильная база |
| Параллельная работа | Отдельный agent process на workspace, background tasks, worktrees, task lifecycle | Есть |
| Harness workflow | Persisted typed DAG, acceptance, gates, attempts, evaluator quorum, repair loop | Дифференциатор |
| Code Review | Git status/diff, staging, commit, inline comments, checkpoint Review/Undo | Есть |
| Permissions | Режимы Pi + project override известных сторонних gates + UI request flow | Есть |
| Library | Реальный install/update/remove packages; filters global/project; skills, themes, prompts, profiles | Есть |
| Темы | 51 Pi token, live edit, duplicate/save, global/project, export package | Есть |
| MCP | CRUD конфигурации и профили, runtime tool flow через Pi | Есть, без remote OAuth directory |
| Preview | Dev-server lifecycle, URL probe, iframe, devices, logs, process stop | Частично browser parity |
| Extension UI | Dialog/forms/notifications/custom entries и reconciliation extension messages | Есть |
| Context/control plane | Tasks, Plan, Workflow, Context, Branches, compaction/checkpoints | Есть |
| Изображения в чате | Pi image blocks, square preview, history, lightbox, rewind, prompt/steer/follow-up | Закрыто этим проходом |

Главные отличия Harness, которые не надо потерять при выравнивании UX:
локальный контроль моделей и MCP, детерминированные verification gates,
транзакционный extension lifecycle, same-session rewind с Git checkpoints,
явная безопасность worktree merge и инспектор persisted workflow.

## 4. Найденные разрывы и приоритеты

### P0 — целостность текущих функций

| Разрыв до прохода | Риск | Исправление 2026-07-24 | Проверка |
|---|---|---|---|
| Image block уходил в RPC, но исчезал из transcript | Пользователь не видит собственный контекст, rewind выглядит сломанным | MessageView читает persisted image blocks | Unit + visual + manual |
| Composer показывал текстовый chip, а не preview | Нельзя проверить выбранное изображение | Квадратное превью с remove, filename и состоянием загрузки | Visual + manual real file |
| Нельзя отправить image-only message | Несовпадение с привычным chat flow | Отправка разрешена при `text || images` | Visual |
| `steer`/`follow_up` теряли изображения | Модель получает другой контекст, чем показывает UI | Images передаются во всех трёх Pi RPC командах | Unit/source audit |
| Rewind восстанавливал без исходного имени/размера | Потеря идентичности вложения | Метаданные сохраняются в image block и нормализуются для старых сессий | Unit + visual |
| MIME определялся по расширению | Renamed/SVG payload мог пройти как raster | Magic-byte sniffing в browser и Tauri; только PNG/JPEG/GIF/WebP | TS + Rust tests |
| Нет ограничений/дедупликации | До 200+ МБ base64 в памяти/RPC | 10 МБ на файл, 20 файлов, 40 МБ суммарно, exact-content dedupe | Unit |
| `images.blockImages` не применялся | Нарушение явной политики пользователя | Global/project Pi setting блокирует image blocks; файл остаётся path context | Visual |
| Неизвестная capability модели считалась vision | Пиксели могли уйти произвольной/custom text-only модели | Image blocks разрешены только при явном `input: ["image"]`; иначе используется path context | Visual/source audit |
| Lightbox был mouse-only | Недоступность и ловушка фокуса | Dialog, Escape, ArrowLeft/Right, focus return, body scroll lock | Visual + manual |
| Черновик Composer жил в экземпляре компонента | Текст/вложения могли перейти в другой чат или пропасть при async store update | Черновики изолированы по session key; несохранённый чат имеет стабильный scope; переход Chat ↔ Settings не теряет ввод | Visual |
| Скрытая virtualized row имела высоту 0 | Console error каждые 10 секунд | Минимальная измеряемая высота для hidden transcript rows | Manual log soak |

### P1 — следующий полезный слой

| Область | Эталон | Harness сейчас | Недостающий data contract | Критерий готовности |
|---|---|---|---|---|
| Artifacts/files | Codex viewer; Claude artifacts + versions/export | Code diff и iframe preview, но нет типизированного viewer | `ArtifactRecord {id, kind, path, version, sourceTurn, renderState}` + annotations | PDF/docx/xlsx/pptx открываются side-by-side, имеют error/empty/loading, версию и экспорт |
| Shared browser | Codex управляет общей вкладкой и принимает feedback | Dev URL iframe + logs, агент не владеет browser session | `BrowserSession`, navigation/actions, evidence screenshots, page comments, allow/block policy | Агент и пользователь видят одну страницу; каждый action/evidence сохраняется |
| Project knowledge | Claude Projects: files/knowledge/instructions/RAG | Workspace cwd, AGENTS.md и @paths без manifest/index | `ProjectKnowledgeManifest`, scope, source hash, indexing status, instructions | Добавление/удаление/переиндексация видимы; retrieval provenance показывается |
| Connections | Единый catalog с re-enable и auth state | NPM Library + MCP CRUD; нет remote auth/account health | `ConnectionRecord {provider, authState, scopes, enabled, lastCheck}` | Install/connect/disable/reconnect/remove имеют подтверждённый lifecycle |
| Settings IA | Codex taxonomy, search, rebindable shortcuts, permissions | General/Interface/Providers/Themes/MCP/Processes; shortcuts — справка | Typed settings registry + search keywords + shortcut conflict model | Поиск ведёт к контролу; shortcut меняется, конфликт валидируется и сохраняется |
| Terminal/environments | Codex terminal tabs, SSH/environments/actions | Process stats и tool cards | `TerminalSession`/`EnvironmentTarget`, lifecycle и redaction | Открыть/закрыть/reconnect, несколько tabs, явный target и exit state |
| Automations/remote | Codex scheduled/background/mobile continuity | Background tasks только в живом desktop agent | Persisted schedule/run/approval/notification destination | Расписание переживает restart; run history и missed/failed states видимы |

### P2 — расширение продукта, не маскировать под готовность

| Возможность | Статус Harness | Решение |
|---|---|---|
| App shot / выбор окна | Нет | После Attachment contract: отдельный источник с window metadata и privacy confirmation |
| Voice input | Нет | Не добавлять кнопку без audio capture/transcription/error contract |
| Computer use | Нет | Только после permission policy, observable actions и emergency stop |
| Image generation | Нет | Интеграция как typed artifact, не как неразличимый base64 message |
| Memory/suggestions | Частично через extensions, нет единого UI/data model | Сначала provenance, scope, delete/export и isolation между workspaces |
| Sharing/org distribution | Нет | Нужны roles, ownership, audit trail и secret handling |
| Pop-out/always-on-top | Нет | Небольшая desktop-фича после P1 settings registry |
| Appearance extras/profile analytics | Частично | Низкий приоритет относительно viewer/browser/knowledge |

## 5. Настройки: целевая информационная архитектура

Приложенный референс Codex использует короткую вертикальную taxonomy. Для
Harness разумна следующая структура без потери существующей глубины:

1. **Personal** — General, Appearance, Notifications, Shortcuts.
2. **Integrations** — Providers, Models, Connections, MCP.
3. **Coding** — Agent/permissions, Projects/knowledge, Git/worktrees,
   Browser/preview, Terminal/environments.
4. **Extensions** — переход в Library, installed health, update policy,
   trust/context budget.
5. **Advanced** — Processes, diagnostics, import/export, experimental.
6. **Archived** — sessions/projects с restore/delete contract.

Это изменение нельзя делать только перестановкой JSX. Сначала нужен единый
settings registry, чтобы search, defaults, project override, import/export и
валидация использовали одну схему.

## 6. План реализации

### Итерация A — attachment integrity (выполнена)

- общий attachment normalizer/validator;
- одинаковый preview в composer и transcript;
- image-only, paste, drop, picker, remove, keyboard lightbox;
- prompt/steer/follow-up/rewind/history;
- byte sniffing, per-file/count/aggregate limits, dedupe;
- Pi image policy settings и mock/native parity;
- unit, Rust, visual и ручной real-file smoke.

### Итерация B — artifact and browser workspace

1. Ввести `ArtifactRecord` и renderer registry.
2. Добавить preview для code/image/PDF; затем office formats.
3. Хранить render errors/version/source turn, а не только URL.
4. Ввести `BrowserSession` + evidence/comment records.
5. Расширить Preview из iframe в agent-shared controlled session.

### Итерация C — project knowledge and integrations

1. Manifest project files/instructions и indexing lifecycle.
2. Retrieval provenance в Context dock.
3. Унифицированный connection record для MCP/remote connectors.
4. Health/reconnect/remove tests, secret redaction и workspace isolation.

### Итерация D — settings and automation

1. Typed registry и новая taxonomy.
2. Settings search, shortcut rebinding/conflicts, notification routing.
3. Persisted automation schedule + run history.
4. Терминальные tabs/environments только после lifecycle contract.

## 7. Definition of Done для новых UX-поверхностей

Любой новый контрол/экран обязан иметь:

1. источник истины и описанный scope: session/project/global;
2. loading, empty, success, failure и offline/restart state;
3. create/read/update/delete либо честно ограниченный action contract;
4. rollback/retry там, где действие изменяет файлы или конфигурацию;
5. keyboard/focus/reduced-motion и narrow viewport;
6. mock parity без фиктивного «успеха»;
7. unit test data contract, integration test действия и visual regression;
8. проверку с неизвестным extension/skill/theme: UI не ломается от новых
   custom entries, длинных имён, незнакомых полей или произвольных цветов.

## 8. Итог

Harness уже сильнее обычного chat shell в управляемости локального агента,
verification workflow и extension lifecycle. Главный дефицит относительно
Codex/Claude находится не в цветах и радиусах, а в трёх data-backed
пространствах: **artifact viewer, shared browser, project knowledge**. Их стоит
строить раньше voice/computer-use и декоративных настроек. Attachment integrity
была единственным P0-разрывом в базовом chat loop и закрыта в этом проходе.
