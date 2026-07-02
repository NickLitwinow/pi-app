import { marked } from "marked";
import DOMPurify from "dompurify";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string): string {
  const clean = stripAnsi(src ?? "");
  const html = marked.parse(clean, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_ATTR: ["data-lang"],
  });
}

// ---------- lazy shiki highlighting ----------

type Highlighter = {
  codeToHtml(code: string, opts: { lang: string; theme: string }): string;
};

let highlighterPromise: Promise<Highlighter | null> | null = null;

// Fine-grained shiki core: only these grammars end up in the bundle.
const LANGS = [
  "typescript", "javascript", "tsx", "jsx", "json", "rust", "python", "bash",
  "shellscript", "html", "css", "markdown", "diff", "go", "yaml", "toml", "sql",
  "swift", "c", "cpp", "java",
];

async function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
          import("shiki/core"),
          import("shiki/engine/oniguruma"),
        ]);
        const hl = await createHighlighterCore({
          themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")],
          langs: [
            import("@shikijs/langs/typescript"),
            import("@shikijs/langs/javascript"),
            import("@shikijs/langs/tsx"),
            import("@shikijs/langs/jsx"),
            import("@shikijs/langs/json"),
            import("@shikijs/langs/rust"),
            import("@shikijs/langs/python"),
            import("@shikijs/langs/bash"),
            import("@shikijs/langs/shellscript"),
            import("@shikijs/langs/html"),
            import("@shikijs/langs/css"),
            import("@shikijs/langs/markdown"),
            import("@shikijs/langs/diff"),
            import("@shikijs/langs/go"),
            import("@shikijs/langs/yaml"),
            import("@shikijs/langs/toml"),
            import("@shikijs/langs/sql"),
            import("@shikijs/langs/swift"),
            import("@shikijs/langs/c"),
            import("@shikijs/langs/cpp"),
            import("@shikijs/langs/java"),
          ],
          engine: createOnigurumaEngine(import("shiki/wasm")),
        });
        return hl as unknown as Highlighter;
      } catch {
        return null;
      }
    })();
  }
  return highlighterPromise;
}

const hlCache = new Map<string, string>();

export async function highlightCode(code: string, lang: string, dark: boolean): Promise<string | null> {
  const hl = await getHighlighter();
  if (!hl) return null;
  const theme = dark ? "github-dark" : "github-light";
  const key = `${theme}:${lang}:${code.length}:${code.slice(0, 80)}`;
  const cached = hlCache.get(key);
  if (cached) return cached;
  const aliases: Record<string, string> = {
    shell: "shellscript", sh: "shellscript", zsh: "shellscript",
    js: "javascript", ts: "typescript", py: "python", yml: "yaml", "c++": "cpp",
  };
  const effLang = LANGS.includes(lang) ? lang : (aliases[lang] ?? "text");
  try {
    const html = hl.codeToHtml(code, { lang: effLang, theme });
    // жёсткий кап кэша подсветки: highlight-HTML в разы больше исходника
    if (hlCache.size > 150) hlCache.clear();
    hlCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

/** Post-process rendered markdown: replace <pre><code class="language-x"> with shiki output. */
export async function enhanceCodeBlocks(root: HTMLElement, dark: boolean): Promise<void> {
  const blocks = root.querySelectorAll("pre > code");
  for (const code of Array.from(blocks)) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.hl === "1") continue;
    const langMatch = /language-(\w+)/.exec(code.className);
    const lang = langMatch ? langMatch[1] : "text";
    const text = code.textContent ?? "";
    if (text.length > 20000) continue;
    const html = await highlightCode(text, lang, dark);
    if (html && pre.isConnected) {
      const wrap = document.createElement("div");
      wrap.innerHTML = DOMPurify.sanitize(html);
      const newPre = wrap.querySelector("pre");
      if (newPre) {
        newPre.dataset.hl = "1";
        pre.replaceWith(newPre);
      }
    } else {
      pre.dataset.hl = "1";
    }
  }
}
