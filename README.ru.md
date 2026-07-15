# Pi — Нативный macOS-клиент для [pi.dev](https://pi.dev)

> **🌐 Language:** [English](README.md) | **Русский**

<div align="center">

[![macOS](https://img.shields.io/badge/macOS-13+-000000?logo=apple)](https://www.apple.com/macos/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-22c55e?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

Лёгкое нативное macOS-приложение для **[pi](https://pi.dev)** — полнофункционального ИИ-ассистента для программирования с потоковыми чатами, управлением сессиями, git-интеграцией, маркетплейсом и настройкой конфигураций.

## ✨ Возможности

- **Потоковые чаты** — потоковая передача токенов в реальном времени с мышлением, вызовами инструментов и рендерингом markdown
- **Управление сессиями** — рабочие пространства, поиск, форк, перемотка, закрепление, архив, сессии по группам
- **Полный git-центр** — стадировка, коммиты, ветки, fetch/pull/push, история коммитов с дифами
- **Code review** — контрольные точки, объединённые дифы, комменты к строкам, откат файлов
- **Живые сессии** — наблюдение за файлами в `~/.pi/agent/sessions`, новые сессии появляются мгновенно
- **Контроль контекстного окна** — кольцо-индикатор, детали токенов/стоимости, переключатель авто-компакции
- **Система разрешений** — нативный UI расширений (выбор/подтверждение/ввод/редактор), неблокирующий
- **Параллельные сессии** — просмотр другой сессии в режиме чтения, пока агент работает в фоне
- **Экономичная память** — история фона выгружается в файлы, вывод инструментов ограничен
- **Создать PR/MR** — GitHub (`gh`), GitLab (`glab`) или через браузер
- **Автообновление** — проверка последней версии на GitHub, сборка из исходников, перезапуск
- **Аналитика** — стоимость за день, статистика по моделям, почасовые графики использования

## 📸 Скриншоты

### Главное окно чата

![Pi Chat](screenshot-home.png)

### Настройки

Настройте редактор, ограничения процессов, idle-kill, тему, масштаб UI, расширения, навыки, MCP-серверы и модели.

### Code Review

Git-ревью с контрольными точками, объединёнными дифами, комментами к строкам и откатом файлов.

### Маркетплейс

Просматривайте и устанавливайте расширения и навыки от сообщества из реестра npm.

## 🚀 Начало работы

### Требования

| Требование | Версия |
| --- | --- |
| macOS | 13+ |
| [pi](https://pi.dev) | ≥ 0.80 (в `$PATH`) |
| [Node.js](https://nodejs.org) | ≥ 20 (для разработки) |
| [Rust](https://rustup.rs) | stable (для сборки) |
| [Git](https://git-scm.com) | ≥ 2.39 |

### Установка одной командой

Клонировать, собрать и положить приложение в `/Applications` за один шаг:

```bash
git clone https://github.com/NickLitwinow/pi-app.git && cd pi-app && npm run bootstrap
```

Приложение не подписано — при первом запуске правый клик по `Pi.app` → **Открыть**.
Установите [pi](https://pi.dev), чтобы работали сессии агента.

### Разработка

```bash
npm ci               # `npm install` перезаписывает затреканный package-lock.json
npm run dev          # только UI, mock-бэкенд, pi не нужен — http://localhost:1420
npm run tauri dev    # полное приложение с hot-reload (требуется установленный pi)
```

### Сборка для распространения

```bash
npm run tauri build  # .app + .dmg в src-tauri/target/release/bundle/
```

### Обновление падает с «local changes would be overwritten»

```
error: Your local changes to the following files would be overwritten by merge:
        package-lock.json
```

Версии по `6a1dae4` включительно выполняли при обновлении `npm install` — он
перезаписывал затреканный `package-lock.json` и оставлял рабочую копию грязной,
поэтому *следующее* обновление обрывалось на `git pull --ff-only`. Новые версии
используют `npm ci` и откатывают артефакты сборки сами, но чтобы до них
добраться, нужен один ручной шаг:

```bash
cd /путь/к/pi-app           # каталог исходников (показан в Центре обновлений)
git checkout -- package-lock.json src-tauri/Cargo.lock
```

После этого запустите обновление снова. Вашу незакоммиченную работу это не
затрагивает: обновление теперь вообще не стартует, если находит её, а вместо
запуска показывает список файлов.

## ⌨️ Горячие клавиши

| Комбинация | Действие |
| --- | --- |
| `⌘B` | Переключить боковую панель |
| `⌘N` | Новая сессия (в текущем проекте) |
| `⌘1` | Открыть вкладку Chat |
| `⌘2` | Открыть вкладку Review |
| `⌘3` | Переключить разделённый экран (чат + превью) |
| `⌘4` | Открыть вкладку Settings |
| `⌘0` | Сбросить масштаб UI |
| `⌘+` / `⌘-` | Увеличить / Уменьшить масштаб UI |
| `⌘,` | Открыть Settings |

## 🏗 Архитектура

Pi — это Tauri 2-приложение с React 19 фронтендом. Rust-бэкенд запускает `pi --mode rpc` (JSONL через stdio) для каждой активной сессии и потоково передаёт события в WebView.

```
┌─────────────────────────────────────────────┐
│  Frontend (React 19 + TypeScript)           │
│  ┌───────────┬───────────┬───────────────┐ │
│  │  Chat     │  Review   │  Settings     │ │
│  │  View     │  View     │  View         │ │
│  └───────────┴───────────┴───────────────┘ │
│  Zustand store  │  Backend abstraction      │
└───────────────┬───────────────────────────┘
                │  invoke / listen
┌───────────────▼───────────────────────────┐
│  Backend (Rust via Tauri)                 │
│  ┌───────────┬───────────┬───────────────┐ │
│  │ supervisor│  jsonl    │  sessions     │ │
│  │ (spawn/  │  (JSONL   │  (scan,       │ │
│  │  kill)   │   RPC)    │   search)     │ │
│  └───────────┴───────────┴───────────────┘ │
│  ┌───────────┬───────────┬───────────────┐ │
│  │  config   │  gitops   │  pi_cli       │ │
│  │ (atomic  │  (check- │  (install,     │ │
│  │  write)   │   points)│   stream)     │ │
│  └───────────┴───────────┴───────────────┘ │
└───────────────┬───────────────────────────┘
                │  JSONL
┌───────────────▼───────────────────────────┐
│  pi (installed agent)                     │
│  --mode rpc → JSONL over stdio            │
└─────────────────────────────────────────────┘
```

## 📁 Структура проекта

```
src-tauri/src/
  supervisor.rs   # spawn/kill pi --mode rpc, события, лимиты, idle-reaper
  jsonl.rs        # строгий LF-только JSONL-фреймер (pi RPC spec)
  sessions.rs     # скан ~/.pi/agent/sessions, метаданные, поиск, аналитика
  config.rs       # settings/models/mcp.json: атомарная запись + бэкап; навыки
  gitops.rs       # контрольные точки, review-diff (+untracked), откат
  pi_cli.rs       # pi install/remove/update с потоковой передачей вывода
  editor.rs       # открытие файлов в внешнем редакторе

src/
  lib/            # абстракция бэкенда (Tauri/mock), RPC reducer, markdown, diff
  state/store.ts  # zustand: рабочие пространства, агенты, RPC-корреляция
  components/     # Chat, History, Review, Analytics, Settings, Extension UI
```

## 🔧 Разработка

### Запуск тестов

```bash
# Фронтенд (Vitest)
npm run test

# Rust-ядро (JSONL, сессии, конфиг, git)
cd src-tauri && cargo test
```

### Без Tauri

Запустить фронтенд в браузере с mock-бэкендом — удобно для разработки только UI:

```bash
npm run dev
```

Mock-бэкенд эмулирует сессии, вызовы инструментов, разрешения и аналитику.

## 📦 Стек технологий

| Слой | Технология |
| --- | --- |
| Фреймворк | [Tauri 2](https://tauri.app) |
| Фронтенд | [React 19](https://react.dev) + [TypeScript 5.8](https://www.typescriptlang.org) |
| Стили | CSS (тёмная/светлая темы, нативный macOS-вид) |
| Состояние | [Zustand 5](https://zustand.pm) |
| Markdown | [shiki 3](https://shiki.style) + [marked 15](https://github.com/markedjs/marked) |
| Иконки | [Lucide React](https://lucide.dev) |
| Безопасность | [DOMPurify 3](https://github.com/cure53/DOMPurify) |

## 🗺 Дорожная карта

Развитие спланировано в **[docs/ROADMAP.md](docs/ROADMAP.md)** — подробный план по итерациям
(харнесс, память/производительность, экосистема, дизайн-система). Открытые пункты —
в [issues](https://github.com/NickLitwinow/pi-app/issues).

## 🤝 Вклад

Вклады приветствуются — см. **[CONTRIBUTING.md](CONTRIBUTING.md)**: настройка окружения, карта
репозитория, как гонять тесты, чеклист PR. Хорошее начало — issues с меткой
[`good first issue`](https://github.com/NickLitwinow/pi-app/labels/good%20first%20issue);
свободные вопросы — в [Discussions](https://github.com/NickLitwinow/pi-app/discussions).

## 🙏 Благодарности

Построено поверх открытого агента [pi](https://pi.dev) и его экосистемы расширений, скиллов и тем.

## 📄 Лицензия

MIT © [NickLitwinow](https://github.com/NickLitwinow)

---

*Сделано с ❤️ [NickLitwinow](https://github.com/NickLitwinow)*
