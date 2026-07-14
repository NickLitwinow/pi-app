import { describe, expect, it } from "vitest";
import { isStrictHarness, isVerifyCommand, needsSequentialThinking } from "../../harness-extension/policy";

describe("harness verification policy", () => {
  it.each([
    "npm test",
    "pnpm run typecheck",
    "cd src-tauri && cargo test",
    "npm run lint && npm run build",
    "pytest tests/unit",
    "./gradlew test",
  ])("accepts a real verifier: %s", (command) => {
    expect(isVerifyCommand(command)).toBe(true);
  });

  it.each([
    "echo npm test",
    "printf 'cargo test'",
    "npm test || true",
    "cargo test || :",
    "npm run build; exit 0",
    "echo done",
    "cat package.json",
  ])("rejects a fake or masked verifier: %s", (command) => {
    expect(isVerifyCommand(command)).toBe(false);
  });
});

describe("harness enforcement mode", () => {
  it("is advisory by default", () => {
    expect(isStrictHarness(undefined)).toBe(false);
    expect(isStrictHarness("0")).toBe(false);
    expect(isStrictHarness("false")).toBe(false);
  });

  it("requires explicit strict opt-in", () => {
    expect(isStrictHarness("1")).toBe(true);
    expect(isStrictHarness("TRUE")).toBe(true);
  });
});

describe("sequential-thinking routing", () => {
  it.each([
    "Спроектируй архитектуру очереди фоновых задач",
    "Plan a complex refactor of the session supervisor",
    "Нужен системный дизайн синхронизации между четырьмя сервисами",
  ])("suggests structured reasoning for: %s", (prompt) => {
    expect(needsSequentialThinking(prompt)).toBe(true);
  });

  it.each([
    "Исправь отступ у кнопки",
    "Составь короткий план на сегодня",
    "Переименуй переменную",
  ])("does not add reasoning overhead for: %s", (prompt) => {
    expect(needsSequentialThinking(prompt)).toBe(false);
  });
});
