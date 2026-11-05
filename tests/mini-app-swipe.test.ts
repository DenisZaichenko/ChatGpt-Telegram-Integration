import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
class Element {
  constructor(readonly excluded = false) {}
  closest() { return this.excluded ? this : null; }
}
function fixture() {
  const elements = new Map<string, any>();
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, { listeners: new Map(), addEventListener(name: string, fn: unknown, options: unknown) { this.listeners.set(name, { fn, options }); }, setAttribute() {}, blur: vi.fn(), classList: { contains: () => true, remove: vi.fn() } });
    return elements.get(id);
  };
  const window = { innerWidth: 390, innerHeight: 844, addEventListener() {}, getSelection: () => ({ toString: () => "" }) };
  vm.runInNewContext(source, { Element, window, document: { activeElement: getElementById("prompt"), documentElement: { style: { setProperty() {} } }, getElementById, querySelectorAll: () => [], addEventListener() {} } });
  const emit = (name: string, x: number, y: number, target = new Element(), timeStamp = 100) => {
    const touch = { identifier: 1, clientX: x, clientY: y };
    getElementById("conversation").listeners.get(name).fn({ target, timeStamp, touches: name === "touchend" ? [] : [touch], changedTouches: [touch] });
  };
  return { emit, window, elements, closed: getElementById("workspace").classList.remove };
}
describe("chat swipe navigation", () => {
  it("closes on a deliberate right swipe, preserving the prompt", () => {
    const app = fixture();
    app.emit("touchstart", 20, 200); app.emit("touchmove", 130, 205); app.emit("touchend", 130, 205);
    expect(app.closed).toHaveBeenCalledExactlyOnceWith("show-detail");
    expect(app.elements.get("prompt").blur).toHaveBeenCalledOnce();
  });
  it.each([[60, 200], [-100, 200], [130, 280]])("ignores short, left or vertical gestures (%s, %s)", (x, y) => {
    const app = fixture();
    app.emit("touchstart", 20, 200); app.emit("touchmove", x, y); app.emit("touchend", x, y);
    expect(app.closed).not.toHaveBeenCalled();
  });
  it("leaves editors, links and horizontally scrollable code/tables alone", () => {
    const app = fixture();
    app.emit("touchstart", 20, 200, new Element(true)); app.emit("touchend", 130, 200);
    expect(app.closed).not.toHaveBeenCalled();
  });
  it("ignores cancelled, long or desktop gestures", () => {
    const app = fixture();
    app.emit("touchstart", 20, 200); app.emit("touchcancel", 20, 200); app.emit("touchend", 130, 200);
    app.emit("touchstart", 20, 200); app.emit("touchend", 130, 200, new Element(), 1000);
    app.window.innerWidth = 1000;
    app.emit("touchstart", 20, 200); app.emit("touchend", 130, 200);
    expect(app.closed).not.toHaveBeenCalled();
  });
});
