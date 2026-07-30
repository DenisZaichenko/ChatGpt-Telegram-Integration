import { describe, expect, it } from "vitest";
import { isAuthorizedPrivate, pageWindow, parseCommand } from "../src/telegram.js";

describe("Telegram routing boundary", () => {
  it("authorizes only the configured user's matching private chat", () => {
    expect(isAuthorizedPrivate(42, 42, 42, "private")).toBe(true);
    expect(isAuthorizedPrivate(42, 41, 41, "private")).toBe(false);
    expect(isAuthorizedPrivate(42, 42, -100, "supergroup")).toBe(false);
  });

  it("recognizes bot commands so they are not forwarded", () => {
    expect(parseCommand("/steer focus on tests")).toEqual(["steer", "focus on tests"]);
    expect(parseCommand("ordinary prompt")).toBeNull();
  });
});

describe("Button list paging", () => {
  const items = Array.from({ length: 93 }, (_, index) => index);

  it("keeps a page within the inline keyboard budget", () => {
    const { visible, hasPrevious, hasNext } = pageWindow(items, 0, 10);
    expect(visible).toHaveLength(10);
    expect(hasPrevious).toBe(false);
    expect(hasNext).toBe(true);
  });

  it("clamps an out-of-range offset onto the last page", () => {
    const { visible, safeOffset, hasNext } = pageWindow(items, 5_000, 10);
    expect(safeOffset).toBe(90);
    expect(visible).toEqual([90, 91, 92]);
    expect(hasNext).toBe(false);
  });

  it("clamps a negative offset to the first page", () => {
    expect(pageWindow(items, -40, 10).safeOffset).toBe(0);
  });

  it("honours an off-boundary offset without leaving the range", () => {
    const { visible, safeOffset } = pageWindow(items, 47, 10);
    expect(safeOffset).toBe(47);
    expect(visible).toEqual([47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
  });

  it("reports no navigation for an empty list", () => {
    expect(pageWindow([], 0, 10)).toEqual({ visible: [], safeOffset: 0, hasPrevious: false, hasNext: false });
  });
});
