import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDirectory, isAllowedCanonicalPath, isInside, redact, shortId, SlidingWindowRateLimiter } from "../src/security.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("security boundaries", () => {
  it("redacts common secrets without changing ordinary text", () => {
    expect(redact("token=supersecretvalue and sk-abcdefghijklmnop")).toBe("token=[REDACTED] and [REDACTED]");
    expect(redact("normal response")).toBe("normal response");
  });

  it("checks canonical containment without prefix confusion", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "remote-security-")); temporary.push(base);
    const allowed = path.join(base, "project");
    const sibling = path.join(base, "project-evil");
    fs.mkdirSync(allowed); fs.mkdirSync(sibling);
    expect(isInside(canonicalDirectory(allowed), canonicalDirectory(allowed))).toBe(true);
    expect(isInside(canonicalDirectory(sibling), canonicalDirectory(allowed))).toBe(false);
    expect(isAllowedCanonicalPath(canonicalDirectory(sibling), [canonicalDirectory(allowed)], [])).toBe(false);
  });

  it("creates stable eight-character display ids", () => {
    expect(shortId("thread-1")).toMatch(/^[a-f0-9]{8}$/);
    expect(shortId("thread-1")).toBe(shortId("thread-1"));
  });

  it("limits a sliding window", () => {
    const limiter = new SlidingWindowRateLimiter(2, 1000);
    expect(limiter.take(1, 0)).toBe(true);
    expect(limiter.take(1, 1)).toBe(true);
    expect(limiter.take(1, 2)).toBe(false);
    expect(limiter.take(1, 1001)).toBe(true);
  });
});
