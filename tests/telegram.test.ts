import { describe, expect, it } from "vitest";
import { isAuthorizedPrivate, parseCommand } from "../src/telegram.js";

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
