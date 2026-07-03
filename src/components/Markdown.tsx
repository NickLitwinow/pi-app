import { memo, useEffect, useMemo, useRef } from "react";
import { getBackend } from "../lib/backend";
import { enhanceCodeBlocks, renderMarkdown } from "../lib/markdown";

function isDark(): boolean {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const Markdown = memo(function Markdown({ source, final }: { source: string; final?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => {
    // highlight only finalized messages: streaming re-renders would thrash shiki
    if (final && ref.current) void enhanceCodeBlocks(ref.current, isDark());
  }, [html, final]);

  const handleClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    void getBackend().then((b) => b.invoke("open_external", { url: href }).catch(() => {}));
  };

  return <div ref={ref} className="md" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
