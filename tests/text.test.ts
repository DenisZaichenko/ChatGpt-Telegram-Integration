import { describe, expect, it } from "vitest";
import { chunkText, diffStats } from "../src/text.js";

describe("Telegram text handling", () => {
  it("chunks conservatively without loss", () => {
    const source = Array.from({ length: 200 }, (_, index) => `paragraph ${index} ${"x".repeat(30)}`).join("\n\n");
    const chunks = chunkText(source, 400);
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(source.replace(/\s+/g, " "));
  });

  it("counts an aggregated unified diff", () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n+line";
    expect(diffStats(diff)).toEqual({ files: 2, added: 2, removed: 1 });
  });
});
