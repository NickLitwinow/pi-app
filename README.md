# Pi — нативный macOS-клиент для [pi.dev](https://pi.dev)

Лёгкая замена Claude Desktop поверх вашего установленного агента **pi**: чаты со стримингом,
workspaces, история сессий с поиском, аналитика, встроенный code review с чекпоинтами
и управление конфигурацией pi (extensions/skills/MCP/models) прямо из приложения.

Архитектура и требования — в [PLAN.md](PLAN.md).

## Как это устроено

- **Tauri 2 + React 19.** Rust-ядро запускает `pi --mode rpc` (JSONL по stdio) на каждую
  активную сессию и транслирует события в WebView. Приложение не хранит собственного
  состояния агента: сессии, настройки, auth и расширения — это файлы вашего `~/.pi/agent`.
- **Extension UI мост.** Диалоги расширений pi (`select`/`confirm`/`input`/`editor`),
  уведомления, статус-бар и виджеты рендерятся нативно — permission-prompts, plan-mode,
  todo и т.п. работают без адаптации.
- **Лимит процессов + idle-kill** — дружелюбно к локальным моделям (GPU-арбитр):
  простаивающие pi-процессы останавливаются, сессия прозрачно возобновляется
  через `--session <file>`.
- **Полный git-центр**: staging (stage/unstage/discard пофайлово), commit/amend,
  ветки (переключение/создание/удаление, remote → track), fetch/pull/push с ahead/behind,
  история коммитов с диффами. Плюс review на git-чекпоинтах: перед каждым промптом
  снимается снапшот (`git stash create` + ref в `refs/pi-app/checkpoints/`), дифф против
  HEAD или чекпоинта, комментарии к строкам отправляются агенту, файлы откатываются
  точечно, всё открывается в VS Code/Cursor/Zed/JetBrains на строке.
- **Live-сессии.** Файловый вотчер на `~/.pi/agent/sessions`: новые сессии и сообщения
  (в том числе созданные из pi TUI) появляются в сайдбаре сразу, без перезапуска.
- **Контекстное окно под контролем**: кольцевой индикатор заполнения под инпутом
  (клик — детали: токены/кэш/стоимость, тумблер авто-компакции, ручной compact).
  Авто-компакция — механизм ядра pi, настраивается на вкладке «Общие».
- **Permission-запросы не блокируют чат**: панель над инпутом сворачивается в чип,
  историю можно перечитать и вернуться к ответу.
- **Rewind / Fork как в Claude for Mac**: у сообщений пользователя — «Откатить сюда»
  (pi fork; с установленным pi-rewind возвращаются и файлы) и «Форк отсюда» (новая
  сессия с историей до сообщения); полный форк сессии — из меню в сайдбаре.
- **Организация сессий**: группы/папки внутри проекта, pin/архив; закрепляемые
  сообщения с компактным виджетом в чате; сворачиваемый (⌘B / меню View) и
  растягиваемый сайдбар.

## Требования

- macOS 13+, git ≥ 2.39
- установленный [pi](https://pi.dev) ≥ 0.80 (`pi` в PATH)
- для сборки: Node ≥ 20, Rust (stable)

## Разработка

```bash
npm install
npm run tauri dev      # запуск приложения
npm run test           # vitest (reducer, diff-парсер)
cd src-tauri && cargo test   # Rust-ядро (JSONL, sessions, config, git)
npm run tauri build    # подписанный .app/.dmg (нужен Developer ID для нотаризации)
```

Без Tauri (`npm run dev`) фронтенд поднимается в браузере на mock-бэкенде
с демо-данными — удобно для работы над UI.

## Структура

```
src-tauri/src/
  supervisor.rs   # spawn/kill pi --mode rpc, события, лимиты, idle-reaper
  jsonl.rs        # строгий LF-only JSONL-фреймер (спека pi RPC)
  sessions.rs     # скан ~/.pi/agent/sessions, метаданные, поиск, аналитика
  config.rs       # settings/models/mcp.json: атомарная запись + бэкап; skills
  gitops.rs       # чекпоинты, review-дифф (+untracked), revert
  pi_cli.rs       # pi install/remove/update со стримом вывода
  editor.rs       # открытие файлов в внешнем редакторе
src/
  lib/            # backend-абстракция (Tauri/mock), RPC-редьюсер, markdown, diff
  state/store.ts  # zustand: workspaces, агенты, RPC-корреляция
  components/     # Chat, History, Review, Analytics, Settings, Extension UI
```
