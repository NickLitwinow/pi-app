# bench — агентный бенчмарк (ROADMAP §5.11-1, H3)

Headless-прогоны `pi -a --thinking <lvl> -p` на фиксированных задачах с детерминированной
проверкой результата. По этому бенчмарку судятся: сетка гиперпараметров модели
(temperature/topP/penalty в `~/.pi/agent/models.json`), каждое новое правило
harness-расширения и изменения набора инструментов — а не «на глаз».

## Запуск

```bash
node bench/run.mjs                        # все задачи, thinking=minimal, таймаут 240с
node bench/run.mjs --only bugfix-off-by-one,refactor-rename
node bench/run.mjs --thinking high --label thinking-high
node bench/run.mjs --timeout 300 --label temp-0.6
```

Отчёт: `bench/results/<ts>-<label>.json` (в git не коммитится) + таблица в stdout.
Перед сеткой гиперпараметров меняйте `models.json`, ставьте `--label` с описанием точки.

## Метрики

- **success** — детерминированный `check` задачи (exit 0);
- **turns / toolCalls** — assistant-сообщения и tool-вызовы из jsonl сессии;
- **loopScore** — идентичные tool+args подряд (болезнь локальных 35B);
- **harness** — события pi-app-harness из `.pi/harness.log` (nudges / loops / blocks);
- **finalCtx / outTokens** — контекст последнего ответа и суммарный output;
- **✅⏱** — задача решена, но pi не завершил ран сам (луп после решения — тоже дефект).

## Гигиена

- Каждая задача — в свежем tmp-каталоге со своим `git init`; промпт начинается с
  «работай СТРОГО в текущем каталоге» (инцидент §5.9-5: hermes-memory уводила агента
  в чужой репозиторий).
- Таймаут убивает всю process group pi (`detached` + `kill(-pid)`).
- Задача `websearch-version` — baseline-детектор отсутствия web-инструментов (H4):
  падает, пока web-access не возвращён в набор.

## Известные результаты

| Дата | Label | Итог | Заметки |
|---|---|---|---|
| 2026-07-11 | baseline-b1 | 2/3 (coding) | bugfix 37с/5 туров, slugify 45с; refactor — таймаут 150с без лупа. До abort-предохранителя bugfix зависал в BLOCK todo ×20 до таймаута |
| 2026-07-11 | baseline-b2 | 1/3 | refactor ✅⏱ 240с (решил, потом залип — «луп после решения»); multi-file — 60×write с ПУСТЫМИ arguments (формат-дрейф, невидим для tool_call-гардов → добавлен malformed-детектор на message_end); websearch ❌ ожидаемо + подтверждён ABORT after 8 blocked calls (ран прерван сам, 193с) |
| 2026-07-11 | malformed-guard | 1/1 | multi-file ✅ 57с/8 туров/0 лупов (в формат-дыру не попал; гард дежурит) |

**Текущий счёт кодинг-задач: 4/4 решаются** (37–57с при thinking=minimal); открытые дефекты поведения: «луп после решения» (pi не завершает ран), формат-дрейф args (ловится новым гардом), websearch до H4.
