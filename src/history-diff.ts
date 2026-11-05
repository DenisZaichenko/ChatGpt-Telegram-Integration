import path from "node:path";

export interface ChatDiff {
  turnId: string;
  diff: string;
  source: "history" | "live";
}

/** Recorded fileChange patches are sequential edits, not a working-tree diff. */
export function recordedTurnDiff(rawTurn: unknown, cwd: string): ChatDiff | null {
  const turn = object(rawTurn);
  if (typeof turn.id !== "string") return null;
  const patches: string[] = [];
  for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
    const item = object(rawItem);
    // A proposed, failed or declined patch must never look like an applied edit.
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const rawChange of Array.isArray(item.changes) ? item.changes : []) {
      const change = object(rawChange);
      const kind = object(change.kind);
      if (typeof change.path !== "string" || typeof change.diff !== "string") continue;
      if (!["add", "delete", "update"].includes(String(kind.type))) continue;
      const from = displayPath(change.path, cwd);
      const to = typeof kind.move_path === "string" ? displayPath(kind.move_path, cwd) : from;
      const a = quotePath(`a/${from}`);
      const b = quotePath(`b/${to}`);
      let patch = `diff --git ${a} ${b}\n`;
      if (from !== to) patch += `rename from ${quotePath(from)}\nrename to ${quotePath(to)}\n`;
      patch += `--- ${kind.type === "add" ? "/dev/null" : a}\n+++ ${kind.type === "delete" ? "/dev/null" : b}\n`;
      // Add/delete store the complete file text; update stores unified hunks.
      if (kind.type === "add" || kind.type === "delete") patch += wholeFileHunk(change.diff, kind.type);
      else if (change.diff) patch += change.diff + (change.diff.endsWith("\n") ? "" : "\n");
      else if (from === to) continue;
      patches.push(patch);
    }
  }
  return patches.length ? { turnId: turn.id, diff: patches.join(""), source: "history" } : null;
}

function wholeFileHunk(text: string, kind: "add" | "delete"): string {
  if (!text) return "";
  const lines = text.split("\n");
  const hasFinalNewline = text.endsWith("\n");
  if (hasFinalNewline) lines.pop();
  const range = `1,${lines.length}`;
  const header = kind === "add" ? `@@ -0,0 +${range} @@\n` : `@@ -${range} +0,0 @@\n`;
  return header + lines.map((line) => `${kind === "add" ? "+" : "-"}${line}\n`).join("")
    + (hasFinalNewline ? "" : "\\ No newline at end of file\n");
}

function displayPath(filename: string, cwd: string): string {
  if (!path.isAbsolute(filename)) return filename;
  const relative = path.relative(cwd, filename);
  // Keep outside-workspace paths recognizable; never read the file from disk.
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? relative : filename;
}
function quotePath(filename: string): string { return /[\s"\\]/.test(filename) ? JSON.stringify(filename) : filename; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
