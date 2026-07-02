import { memo, useEffect, useMemo, useRef } from "react";
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

  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});
