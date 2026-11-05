import { describe, expect, it } from "vitest";
import { recordedTurnDiff } from "../src/history-diff.js";

const change = (type: string, diff: string, filename = "/repo/src/app.ts", extra = {}) => ({ path: filename, kind: { type, ...extra }, diff });
const turn = (changes: unknown[], status = "completed") => ({ id: "turn", items: [{ type: "fileChange", status, changes }] });
describe("recorded chat diffs", () => {
  it("keeps update hunks in order with relative filenames", () => {
    const result = recordedTurnDiff(turn([change("update", "@@ -1 +1 @@\n-old\n+middle\n"), change("update", "@@ -1 +1 @@\n-middle\n+new\n")]), "/repo")!;
    expect(result.source).toBe("history");
    expect(result.turnId).toBe("turn");
    expect(result.diff).toContain("diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@");
    expect(result.diff.indexOf("+middle")).toBeLessThan(result.diff.indexOf("+new"));
  });
  it("converts added and deleted full-file contents into unified hunks", () => {
    const result = recordedTurnDiff(turn([change("add", "one\ntwo\n"), change("delete", "old")]), "/repo")!;
    expect(result.diff).toContain("--- /dev/null\n+++ b/src/app.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(result.diff).toContain("--- a/src/app.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n\\ No newline at end of file\n");
  });
  it("does not mistake diff-looking source text in an added file for patch syntax", () => {
    expect(recordedTurnDiff(turn([change("add", "@@ header\n+literal\n")]), "/repo")?.diff).toContain("+@@ header\n++literal\n");
  });
  it("retains renames and quotes unsafe filename characters", () => {
    const result = recordedTurnDiff(turn([change("update", "", "/repo/old name.ts", { move_path: "/repo/new\nname.ts" })]), "/repo")!;
    expect(result.diff).toContain('rename from "old name.ts"\nrename to "new\\nname.ts"\n');
    expect(result.diff).toContain('+++ "b/new\\nname.ts"');
  });
  it.each(["inProgress", "failed", "declined", "unknown"])("does not include %s file changes", (status) => {
    expect(recordedTurnDiff(turn([change("add", "not applied")], status), "/repo")).toBeNull();
  });
  it("includes applied edits even if the overall turn was interrupted", () => {
    expect(recordedTurnDiff({ ...turn([change("add", "done\n")]), status: "interrupted" }, "/repo")?.diff).toContain("+done");
  });
  it("ignores malformed items and preserves empty file creations", () => {
    expect(recordedTurnDiff({ id: "t", items: [null, { type: "agentMessage", text: "changed files" }] }, "/repo")).toBeNull();
    expect(recordedTurnDiff(turn([{ path: 12, diff: "bad" }, change("unknown", "bad")]), "/repo")).toBeNull();
    expect(recordedTurnDiff(turn([change("add", "")]), "/repo")?.diff).toContain("--- /dev/null");
  });
});
