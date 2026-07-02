import { describe, expect, it } from "vitest";
import { firstChangedLine, parseUnifiedDiff } from "./diff";

const SAMPLE = [
  "diff --git a/src/lib/reducer.ts b/src/lib/reducer.ts",
  "index 111..222 100644",
  "--- a/src/lib/reducer.ts",
  "+++ b/src/lib/reducer.ts",
  "@@ -1,6 +1,8 @@",
  ' import type { ChatState } from "./types";',
  "-function old(): void {}",
  "+function applyEvent(chat: ChatState): void {",
  "+  // new implementation",
  "+}",
  " export {};",
  "diff --git a/src/components/NewFile.tsx b/src/components/NewFile.tsx",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/components/NewFile.tsx",
  "@@ -0,0 +1,3 @@",
  "+export function NewFile() {",
  "+  return null;",
  "+}",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses files, hunks and line numbers", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(3);

    const [mod, added, bin] = files;
    expect(mod.newPath).toBe("src/lib/reducer.ts");
    expect(mod.status).toBe("modified");
    expect(mod.additions).toBe(3);
    expect(mod.deletions).toBe(1);
    expect(mod.hunks).toHaveLength(1);

    const lines = mod.hunks[0].lines;
    expect(lines[0]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
    expect(lines[1]).toMatchObject({ kind: "del", oldNo: 2, newNo: null });
    expect(lines[2]).toMatchObject({ kind: "add", oldNo: null, newNo: 2 });
    expect(lines.at(-1)).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 5 });

    expect(added.status).toBe("added");
    expect(added.newPath).toBe("src/components/NewFile.tsx");
    expect(added.additions).toBe(3);

    expect(bin.status).toBe("binary");
  });

  it("finds the first changed line for editor jumps", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(firstChangedLine(files[0])).toBe(2);
    expect(firstChangedLine(files[1])).toBe(1);
  });

  it("tolerates empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
