// Unified diff parser for the review UI.

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) {
      if (file.oldPath === "/dev/null") file.status = "added";
      else if (file.newPath === "/dev/null") file.status = "deleted";
      else if (file.oldPath !== file.newPath) file.status = "renamed";
      files.push(file);
    }
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      pushFile();
      hunk = null;
      // "diff --git a/path b/path" — paths may contain spaces; split on " b/"
      const rest = raw.slice("diff --git ".length);
      const idx = rest.lastIndexOf(" b/");
      const a = idx >= 0 ? rest.slice(0, idx) : rest;
      const b = idx >= 0 ? rest.slice(idx + 1) : rest;
      file = {
        oldPath: stripPrefix(a),
        newPath: stripPrefix(b),
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      file.oldPath = stripPrefix(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file.newPath = stripPrefix(p);
      continue;
    }
    if (raw.startsWith("Binary files")) {
      file.status = "binary";
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      file.deletions++;
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
    }
  }
  pushFile();
  return files;
}

/** First changed line number (new side) of a file — for "open in editor at line". */
export function firstChangedLine(file: DiffFile): number {
  for (const h of file.hunks) {
    const add = h.lines.find((l) => l.kind === "add" && l.newNo != null);
    if (add?.newNo != null) return add.newNo;
    // deletion-only hunk: jump to the nearest new-side context line
    if (h.lines.some((l) => l.kind === "del")) {
      const ctx = h.lines.find((x) => x.newNo != null);
      if (ctx?.newNo != null) return ctx.newNo;
    }
  }
  return 1;
}
