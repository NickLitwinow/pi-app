import { describe, expect, it } from "vitest";
import { avatarHash, avatarVariant, decodeDataUrlJson, DEFAULT_PRESET, isLottieData } from "./avatar";
import { formatRunDuration, parseTurnTiming } from "../components/MessageView";

describe("avatarHash", () => {
  it("is deterministic and separates workspace paths", () => {
    expect(avatarHash("/workspace/pi-app")).toBe(avatarHash("/workspace/pi-app"));
    expect(avatarHash("/workspace/pi-app")).not.toBe(avatarHash("/workspace/other"));
  });
});

describe("post-run presentation", () => {
  it("parses pi timing notices into structured data", () => {
    expect(parseTurnTiming("✻ Turn took 33s (Total time 2m 57s · 3 turns)")).toEqual({
      turn: "33s",
      total: "2m 57s",
      turns: 3,
    });
    expect(parseTurnTiming("ordinary assistant text")).toBeNull();
  });

  it("formats elapsed time like Codex", () => {
    expect(formatRunDuration(33_000)).toBe("33s");
    expect(formatRunDuration(177_000)).toBe("2m 57s");
  });
});

describe("default avatar", () => {
  it("falls back to the standard Pi icon, not a random identicon", () => {
    expect(DEFAULT_PRESET.id).toBe("pi");
    expect(DEFAULT_PRESET.glyph).toBe("π");
  });
});

describe("animated avatar formats", () => {
  it("routes only Lottie payloads to the player, not raster/SVG", () => {
    expect(isLottieData("data:application/json;base64,e30=")).toBe(true);
    expect(isLottieData("data:application/vnd.dotlottie+json;base64,e30=")).toBe(true);
    // анимированный SVG — обычный <img>, плеер не нужен
    expect(isLottieData("data:image/svg+xml;base64,PHN2Zy8+")).toBe(false);
    expect(isLottieData("data:image/gif;base64,R0lGODlh")).toBe(false);
  });

  it("decodes Lottie animation data from a base64 data URL", () => {
    const json = JSON.stringify({ v: "5.7.4", layers: [] });
    const url = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
    expect(decodeDataUrlJson(url)).toEqual({ v: "5.7.4", layers: [] });
  });

  it("returns null for malformed payloads instead of throwing", () => {
    expect(decodeDataUrlJson("data:application/json;base64,!!!not-base64!!!")).toBeNull();
    expect(decodeDataUrlJson("garbage")).toBeNull();
  });
});

describe("avatarVariant", () => {
  it("uses the working variant only while the LLM streams", () => {
    const config = { kind: "preset" as const, value: "spark", workingKind: "path" as const, workingValue: "/tmp/work.gif" };
    expect(avatarVariant(config, false)).toEqual({ kind: "preset", value: "spark" });
    expect(avatarVariant(config, true)).toEqual({ kind: "path", value: "/tmp/work.gif" });
  });

  it("falls back to idle when no working icon is configured", () => {
    expect(avatarVariant({ kind: "preset", value: "orbit" }, true)).toEqual({ kind: "preset", value: "orbit" });
    expect(avatarVariant(undefined, true)).toBeNull();
  });
});
