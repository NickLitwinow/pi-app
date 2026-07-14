/**
 * i18n-слой (ROADMAP §5.11-7). Плоский словарь ключ → { ru, en }.
 * Язык берётся из appConfig.lang; если не задан — авто по локали ОС.
 * Архитектурно готово к добавлению zh/hi/es/fr/de/pt/ar (после основного).
 *
 * Миграция инкрементальная: строки переносятся в `dict` по мере касания
 * компонентов. `t("literal fallback")` без записи в словаре возвращает сам
 * ключ — незамигрированный текст просто остаётся на языке ключа.
 */
import { useStore } from "../state/store";

export type Lang = "ru" | "en";
export const LANGS: Lang[] = ["ru", "en"];
export const LANG_LABEL: Record<Lang, string> = { ru: "Русский", en: "English" };

/** Локаль ОС → поддерживаемый язык (дефолт ru — исходный язык приложения). */
export function detectLang(): Lang {
  try {
    const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
    if (nav.startsWith("en")) return "en";
  } catch {
    // недоступно — падаем на дефолт
  }
  return "ru";
}

export function currentLang(): Lang {
  const l = useStore.getState().appConfig.lang;
  return l === "en" || l === "ru" ? l : detectLang();
}

type Entry = Record<Lang, string>;

/** Словарь. Ключ = русский исходник (или короткий стабильный id). */
const dict: Record<string, Entry> = {
  // --- App shell / хоткеи / ⌘K ---
  "Горячие клавиши": { ru: "Горячие клавиши", en: "Keyboard shortcuts" },
  "Командная палитра (навигация, проекты)": {
    ru: "Командная палитра (навигация, проекты)",
    en: "Command palette (navigation, projects)",
  },
  "Поиск по сессии": { ru: "Поиск по сессии", en: "Search in session" },
  "Чат / Code Review / Настройки": { ru: "Чат / Code Review / Настройки", en: "Chat / Code Review / Settings" },
  "Live-превью рядом с чатом (сплит)": {
    ru: "Live-превью рядом с чатом (сплит)",
    en: "Live preview beside chat (split)",
  },
  "Свернуть/показать сайдбар": { ru: "Свернуть/показать сайдбар", en: "Toggle sidebar" },
  "Новая сессия в текущем проекте": { ru: "Новая сессия в текущем проекте", en: "New session in current project" },
  "Фокус в поле сообщения": { ru: "Фокус в поле сообщения", en: "Focus the composer" },
  Настройки: { ru: "Настройки", en: "Settings" },
  "Масштаб интерфейса": { ru: "Масштаб интерфейса", en: "UI scale" },
  "Отправить / перенос строки": { ru: "Отправить / перенос строки", en: "Send / newline" },
  "Палитра команд в композере (Esc — закрыть, текст сохранится)": {
    ru: "Палитра команд в композере (Esc — закрыть, текст сохранится)",
    en: "Command palette in composer (Esc closes, text kept)",
  },
  "Эта справка": { ru: "Эта справка", en: "This help" },
  "Esc или клик мимо — закрыть": { ru: "Esc или клик мимо — закрыть", en: "Esc or click outside to close" },
  "Команда или проект…": { ru: "Команда или проект…", en: "Command or project…" },
  "Ничего не найдено": { ru: "Ничего не найдено", en: "Nothing found" },
  "Перейти: Чат": { ru: "Перейти: Чат", en: "Go to: Chat" },
  "Перейти: Code Review": { ru: "Перейти: Code Review", en: "Go to: Code Review" },
  "Перейти: Настройки": { ru: "Перейти: Настройки", en: "Go to: Settings" },
  "Переключить live-превью (сплит)": {
    ru: "Переключить live-превью (сплит)",
    en: "Toggle live preview (split)",
  },
  "Переключить боковую панель": { ru: "Переключить боковую панель", en: "Toggle sidebar" },
  "Новая сессия": { ru: "Новая сессия", en: "New session" },
  текущий: { ru: "текущий", en: "current" },
  Проект: { ru: "Проект", en: "Project" },

  // --- Nav rail ---
  Чат: { ru: "Чат", en: "Chat" },

  // --- Settings: general/language ---
  Общие: { ru: "Общие", en: "General" },
  "Язык интерфейса": { ru: "Язык интерфейса", en: "Interface language" },
  "Авто (по системе)": { ru: "Авто (по системе)", en: "Auto (system)" },
};

/** Русские формы: pluralRu(5, ["файл","файла","файлов"]) → "файлов". */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d === 1) return forms[0];
  if (d >= 2 && d <= 4) return forms[1];
  return forms[2];
}

/** Перевести ключ на текущий язык. Неизвестный ключ → сам ключ (fallback). */
export function t(key: string): string {
  const entry = dict[key];
  if (!entry) return key;
  return entry[currentLang()] ?? key;
}

/** Реактивный хук: перерисовывает компонент при смене языка. */
export function useT(): (key: string) => string {
  const lang = useStore((s) => s.appConfig.lang);
  return (key: string) => {
    const entry = dict[key];
    if (!entry) return key;
    const l = lang === "en" || lang === "ru" ? (lang as Lang) : detectLang();
    return entry[l] ?? key;
  };
}
