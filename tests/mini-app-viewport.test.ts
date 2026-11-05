import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function fixture(telegramHeight?: number) {
  const hostEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, () => void>();
  const visualEvents = new Map<string, () => void>();
  const setProperty = vi.fn();
  const visualViewport = { height: 844, scale: 1, addEventListener: (name: string, fn: () => void) => visualEvents.set(name, fn) };
  const host = { viewportHeight: telegramHeight, ready() {}, expand() {}, onEvent: (name: string, fn: () => void) => hostEvents.set(name, fn) };
  const window = {
    innerHeight: 844, visualViewport,
    ...(telegramHeight === undefined ? {} : { Telegram: { WebApp: host } }),
    addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn),
  };
  // No initData: exercise the real startup and viewport listeners without API calls.
  const element = { addEventListener() {}, setAttribute() {} };
  const document = {
    documentElement: { style: { setProperty } },
    getElementById: () => element, querySelectorAll: () => [], addEventListener() {},
  };
  vm.runInNewContext(source, { window, document });
  const height = () => setProperty.mock.lastCall;
  return { host, window, visualViewport, hostEvents, windowEvents, visualEvents, height };
}

describe("Mini App viewport", () => {
  it("uses the entire Telegram content height without subtracting its header", () => {
    const app = fixture(744);
    expect(app.height()).toEqual(["--app-viewport-height", "744px"]);
    app.host.viewportHeight = 810;
    app.hostEvents.get("viewportChanged")!();
    expect(app.height()).toEqual(["--app-viewport-height", "810px"]);
  });

  it("fits the keyboard while the host update is pending, and restores after dismissal", () => {
    const app = fixture(744);
    app.visualViewport.height = 430;
    app.visualEvents.get("resize")!();
    expect(app.height()).toEqual(["--app-viewport-height", "430px"]);
    app.visualViewport.height = 844;
    app.visualEvents.get("resize")!();
    expect(app.height()).toEqual(["--app-viewport-height", "744px"]);
  });

  it("follows browser resizing without Telegram, but does not relayout during pinch zoom", () => {
    const app = fixture();
    expect(app.height()).toEqual(["--app-viewport-height", "844px"]);
    app.visualViewport.height = 600;
    app.window.innerHeight = 600;
    app.windowEvents.get("resize")!();
    expect(app.height()).toEqual(["--app-viewport-height", "600px"]);
    app.visualViewport.scale = 2;
    app.visualViewport.height = 300;
    app.visualEvents.get("resize")!();
    expect(app.height()).toEqual(["--app-viewport-height", "600px"]);
  });
});
