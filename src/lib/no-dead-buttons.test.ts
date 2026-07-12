import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Регресс-guard против «мёртвых» интерактивных элементов (ROADMAP §5.11-8):
 * ловит самый частый паттерн — обработчик, который ничего не делает
 * (`onClick={() => {}}`, `onClick={undefined}`, `onClick={noop}`). Кликабельный
 * на вид элемент обязан либо что-то делать, либо быть `disabled`.
 *
 * Статический скан исходников — работает в текущем node-окружении без jsdom/RTL.
 * Полный клик-по-всему аудит (Playwright, свежие запросы на каждый вид) — отдельная
 * задача R6 §5.8; ненадёжную «click-all»-эвристику намеренно не хардкодим.
 */

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const EMPTY_HANDLER =
  /\bon(Click|MouseDown|Change|Submit|KeyDown)=\{\s*(?:\(\s*\)|\([^)]*\))?\s*=>\s*\{\s*\}\s*\}|\bon(Click|MouseDown|Change|Submit)=\{\s*(undefined|noop)\s*\}/g;

describe("no dead buttons", () => {
  it("нет пустых обработчиков событий в компонентах", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(process.cwd(), "src"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(EMPTY_HANDLER)) {
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        offenders.push(`${file.replace(process.cwd() + "/", "")}:${line} — ${m[0].trim()}`);
      }
    }
    expect(offenders, `Пустые обработчики (мёртвые элементы):\n${offenders.join("\n")}`).toEqual([]);
  });
});
