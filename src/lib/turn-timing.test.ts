import { describe, expect, it } from "vitest";
import { stripAnsi } from "./markdown";
import {
  formatRunDuration,
  parseTurnTiming,
  splitTrailingTurnTiming,
  timingFromWorkedMeta,
} from "./turn-timing";

const ESC = "\u001b";
const ANSI_TIMING = `${ESC}[38;2;136;136;136m✻ Turn took 49s (Total time 49s · 1 turn)${ESC}[0m`;

describe("stripAnsi", () => {
  it("removes CSI colors including the ESC byte itself", () => {
    expect(stripAnsi(ANSI_TIMING)).toBe("✻ Turn took 49s (Total time 49s · 1 turn)");
  });

  it("removes OSC sequences and orphan ESC/BEL", () => {
    expect(stripAnsi(`${ESC}]133;A\u0007ready${ESC}`)).toBe("ready");
  });
});

describe("parseTurnTiming", () => {
  it("parses the full pi-claude-style line (with ANSI)", () => {
    expect(parseTurnTiming(ANSI_TIMING)).toEqual({ turn: "49s", total: "49s", turns: 1 });
  });

  it("parses a line without the Total-time part", () => {
    expect(parseTurnTiming("✻ Turn took 2m 5s")).toEqual({ turn: "2m 5s", total: null, turns: null });
  });

  it("rejects ordinary text and trailing garbage", () => {
    expect(parseTurnTiming("ordinary assistant text")).toBeNull();
    expect(parseTurnTiming("✻ Turn took 5s (Total time 4s · 2 turns) хвост")).toBeNull();
  });
});

describe("splitTrailingTurnTiming", () => {
  it("splits the timing tail appended to a normal answer", () => {
    const text = `Привет! Чем могу помочь?\n\n${ANSI_TIMING}`;
    const { body, timing } = splitTrailingTurnTiming(text);
    expect(body).toBe("Привет! Чем могу помочь?");
    expect(timing).toEqual({ turn: "49s", total: "49s", turns: 1 });
  });

  it("keeps text without a timing line untouched", () => {
    const { body, timing } = splitTrailingTurnTiming("просто текст\nв две строки");
    expect(body).toBe("просто текст\nв две строки");
    expect(timing).toBeNull();
  });

  it("drops duplicated timing lines, keeping the last parsed one", () => {
    const text = `ответ\n\n✻ Turn took 3s (Total time 3s · 1 turn)\n\n✻ Turn took 8s (Total time 11s · 2 turns)`;
    const { body, timing } = splitTrailingTurnTiming(text);
    expect(body).toBe("ответ");
    expect(timing).toEqual({ turn: "8s", total: "11s", turns: 2 });
  });

  it("does not treat a mid-text mention of Turn took as timing", () => {
    const text = "строка про Turn took внутри предложения\nи ещё текст";
    expect(splitTrailingTurnTiming(text).timing).toBeNull();
  });
});

describe("timingFromWorkedMeta", () => {
  it("builds timing from pi-claude-style message metadata", () => {
    expect(
      timingFromWorkedMeta({
        role: "assistant",
        content: [],
        _piClaudeStyleWorkedDurationMs: 6807,
        _piClaudeStyleWorkedSessionTotalMs: 177_000,
        _piClaudeStyleWorkedTurns: 3,
      }),
    ).toEqual({ turn: "6s", total: "2m 57s", turns: 3 });
  });

  it("returns null without metadata", () => {
    expect(timingFromWorkedMeta({ role: "assistant", content: [] })).toBeNull();
  });
});

describe("formatRunDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatRunDuration(33_000)).toBe("33s");
    expect(formatRunDuration(177_000)).toBe("2m 57s");
  });
});
