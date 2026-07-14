import type { AppConfig, AppThemePalette } from "./types";

export const PI_THEME_TOKENS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
  "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
  "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
] as const;

export function completePiThemeColors(seed: Record<string, string | number> = {}): Record<string, string | number> {
  const accent = String(seed.accent || "#10a37f");
  const defaults: Record<string, string | number> = {
    accent, border: "#3f4a48", borderAccent: accent, borderMuted: "#303936", success: "#22c55e", error: "#ef4444", warning: "#f59e0b",
    muted: "#a1aaa7", dim: "#717a77", text: "#f4f7f6", thinkingText: "#a1aaa7", selectedBg: "#273330", userMessageBg: "#202825",
    userMessageText: "#f4f7f6", customMessageBg: "#171d1b", customMessageText: "#f4f7f6", customMessageLabel: accent,
    toolPendingBg: "#151a19", toolSuccessBg: "#14231b", toolErrorBg: "#281719", toolTitle: accent, toolOutput: "#d8dedc",
    mdHeading: accent, mdLink: accent, mdLinkUrl: "#8f9a96", mdCode: "#72d5b6", mdCodeBlock: "#d8dedc", mdCodeBlockBorder: "#3f4a48",
    mdQuote: "#a1aaa7", mdQuoteBorder: "#3f4a48", mdHr: "#3f4a48", mdListBullet: accent,
    toolDiffAdded: "#22c55e", toolDiffRemoved: "#ef4444", toolDiffContext: "#8f9a96",
    syntaxComment: "#77817d", syntaxKeyword: "#f472b6", syntaxFunction: "#60a5fa", syntaxVariable: "#fbbf24", syntaxString: "#4ade80",
    syntaxNumber: "#c084fc", syntaxType: "#38bdf8", syntaxOperator: accent, syntaxPunctuation: "#a1aaa7",
    thinkingOff: "#717a77", thinkingMinimal: accent, thinkingLow: "#60a5fa", thinkingMedium: "#22d3ee", thinkingHigh: "#c084fc",
    thinkingXhigh: "#fb7185", bashMode: "#fbbf24",
  };
  return Object.fromEntries(PI_THEME_TOKENS.map((token) => [token, seed[token] ?? defaults[token]]));
}

export const APP_THEME_PROPERTIES = [
  "--bg", "--bg-sidebar", "--bg-raised", "--bg-active", "--bg-input",
  "--text", "--text-dim", "--border", "--brand", "--brand-strong",
  "--ok", "--warn", "--danger",
] as const;

export function paletteFromPiColors(name: string, colors: Record<string, string>): AppThemePalette {
  const get = (token: string, fallback: string) => colors[token] || fallback;
  const background = get("toolPendingBg", get("customMessageBg", "#111113"));
  return {
    name,
    background,
    sidebar: get("customMessageBg", background),
    raised: get("userMessageBg", "#202024"),
    active: get("selectedBg", "#303036"),
    text: get("text", "#f4f4f5"),
    muted: get("muted", "#a1a1aa"),
    border: get("borderMuted", get("border", "#3f3f46")),
    accent: get("accent", "#10a37f"),
    success: get("success", "#22c55e"),
    warning: get("warning", "#f59e0b"),
    danger: get("error", "#ef4444"),
  };
}

export function applyAppThemePalette(palette: AppThemePalette | null | undefined): void {
  const root = document.documentElement;
  if (!palette) {
    for (const property of APP_THEME_PROPERTIES) root.style.removeProperty(property);
    return;
  }
  const values: Record<(typeof APP_THEME_PROPERTIES)[number], string> = {
    "--bg": palette.background,
    "--bg-sidebar": palette.sidebar,
    "--bg-raised": palette.raised,
    "--bg-active": palette.active,
    "--bg-input": palette.raised,
    "--text": palette.text,
    "--text-dim": palette.muted,
    "--border": palette.border,
    "--brand": palette.accent,
    "--brand-strong": palette.accent,
    "--ok": palette.success,
    "--warn": palette.warning,
    "--danger": palette.danger,
  };
  for (const [property, value] of Object.entries(values)) root.style.setProperty(property, value);
}

export function applyAppearanceConfig(config: AppConfig): void {
  const root = document.documentElement;
  const preset = config.appearancePreset ?? "chatgpt";
  const accent = preset === "chatgpt" ? "#10a37f" : preset === "claude" ? "#d97757" : preset === "gemini" ? "#6d7cff" : config.accentColor ?? "#8b5cf6";
  if (preset === "custom" && config.customTheme) applyAppThemePalette(config.customTheme);
  else {
    applyAppThemePalette(null);
    root.style.setProperty("--brand", accent);
  }
  const effectiveAccent = preset === "custom" && config.customTheme ? config.customTheme.accent : accent;
  root.style.setProperty("--icon-accent", preset === "custom" ? config.iconColor || effectiveAccent : effectiveAccent);
}
