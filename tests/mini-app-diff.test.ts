import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const element = { addEventListener() {}, setAttribute() {} };
const context = vm.createContext({ window: { innerHeight: 844, addEventListener() {} }, document: {
  documentElement: { style: { setProperty() {} } }, getElementById: () => element, querySelectorAll: () => [], addEventListener() {},
} });
vm.runInContext(source, context);
const parse = (text: string) => JSON.parse(JSON.stringify(context.parseDiff(text)));

describe("diff viewer parsing", () => {
  it("groups repeated file edits, preserving their steps and total counts", () => {
    const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+middle\ndiff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+created\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -4 +4 @@\n-middle\n+new\n";
    const files = parse(text);
    expect(files.map((file: { name: string }) => file.name)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]).toMatchObject({ added: 2, removed: 2 });
    expect(files[0].parts).toHaveLength(2);
    expect(files[0].parts[0].rows.slice(1)).toEqual([
      { kind: "context", old: 3, next: 3, text: "keep" },
      { kind: "removed", old: 4, next: "", text: "old" },
      { kind: "added", old: "", next: 4, text: "middle" },
    ]);
    expect(files[1].kind).toBe("added");
  });

  it("does not misread source lines beginning with +++ or --- as filenames", () => {
    const [file] = parse("--- a/file\n+++ b/file\n@@ -1 +1 @@\n---old\n+++new\n");
    expect(file).toMatchObject({ name: "file", added: 1, removed: 1 });
    expect(file.parts[0].rows[1].text).toBe("--old");
    expect(file.parts[0].rows[2].text).toBe("++new");
  });

  it("resets line numbers at each hunk and handles zero-length ranges", () => {
    const [file] = parse("--- /dev/null\n+++ b/file\n@@ -0,0 +1,2 @@\n+one\n+two\n@@ -8,0 +9 @@\n+three\n");
    expect(file.parts[0].rows.filter((row: { kind: string }) => row.kind === "added").map((row: { next: number }) => row.next)).toEqual([1, 2, 9]);
    expect(file.added).toBe(3);
  });

  it("decodes quoted paths and retains rename/delete metadata", () => {
    const files = parse('diff --git "a/old name" "b/new name"\nrename from "old name"\nrename to "new name"\n--- "a/old name"\n+++ "b/new name"\ndiff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
    expect(files[0]).toMatchObject({ name: "new name", before: "old name", kind: "renamed" });
    expect(files[1]).toMatchObject({ name: "gone", kind: "deleted", removed: 1 });
  });

  it("preserves binary/unknown text and no-final-newline markers", () => {
    expect(parse("Binary files differ")[0].parts[0].rows[0].text).toBe("Binary files differ");
    const [file] = parse("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
    expect(file).toMatchObject({ added: 1, removed: 1 });
    expect(file.parts[0].rows.filter((row: { kind: string }) => row.kind === "meta")).toHaveLength(2);
  });
});
