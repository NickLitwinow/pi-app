import type { ModelAvatarConfig } from "./types";

export const AVATAR_PRESETS = [
  { id: "pi", glyph: "π", label: "Pi" },
  { id: "spark", glyph: "✦", label: "Spark" },
  { id: "orbit", glyph: "◈", label: "Orbit" },
  { id: "terminal", glyph: "›_", label: "Terminal" },
  { id: "reasoning", glyph: "Σ", label: "Reasoning" },
] as const;

/** Аватар не настроен → стандартная иконка Pi (не пёстрый identicon). */
export const DEFAULT_PRESET = AVATAR_PRESETS[0];

/** Lottie-данные приходят как data:application/json (или dotlottie) — их рисует плеер. */
export function isLottieData(data: string): boolean {
  return (
    data.startsWith("data:application/json")
    || data.startsWith("data:application/vnd.dotlottie")
  );
}

export function decodeDataUrlJson(data: string): unknown | null {
  const comma = data.indexOf(",");
  if (comma < 0) return null;
  try {
    const raw = data.slice(comma + 1);
    const text = data.slice(0, comma).includes(";base64")
      ? decodeURIComponent(escape(atob(raw)))
      : decodeURIComponent(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function avatarHash(identity: string): number {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function avatarVariant(
  config: ModelAvatarConfig | undefined,
  working: boolean,
): { kind: "preset" | "path"; value: string } | null {
  if (working && config?.workingKind && config.workingValue) {
    return { kind: config.workingKind, value: config.workingValue };
  }
  return config?.kind && config.value
    ? { kind: config.kind, value: config.value }
    : null;
}
