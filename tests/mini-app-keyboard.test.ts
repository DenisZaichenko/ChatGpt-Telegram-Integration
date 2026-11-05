import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
class Element {
  blur = vi.fn();
  constructor(readonly editable = false, readonly inputLabel = false) {}
  matches() { return this.editable; }
  closest() { return this.editable || this.inputLabel ? this : null; }
}
function fixture() {
  const listeners = new Map<string, { handler: (event: { target: unknown }) => void; capture?: boolean }>();
  const element = { addEventListener() {}, setAttribute() {} };
  const document = {
    activeElement: new Element(true), documentElement: { style: { setProperty() {} } },
    getElementById: () => element, querySelectorAll: () => [],
    addEventListener: (name: string, handler: (event: { target: unknown }) => void, capture?: boolean) => listeners.set(name, { handler, capture }),
  };
  vm.runInNewContext(source, { Element, document, window: { innerHeight: 844, addEventListener() {} } });
  return { document, listeners, click: (target: unknown) => listeners.get("click")!.handler({ target }) };
}
describe("Mini App keyboard dismissal", () => {
  it("blurs the focused editor on an outside click without cancelling the click", () => {
    const app = fixture();
    app.click(new Element());
    expect(app.document.activeElement.blur).toHaveBeenCalledOnce();
  });
  it("keeps focus when tapping an editor, its content or its label", () => {
    const app = fixture();
    app.click(new Element(true));
    app.click(new Element(false, true));
    expect(app.document.activeElement.blur).not.toHaveBeenCalled();
  });
  it("runs only after the click target is fixed and before buttons can focus a new editor", () => {
    const app = fixture();
    expect(app.listeners.has("pointerdown")).toBe(false);
    expect(app.listeners.has("touchstart")).toBe(false);
    expect(app.listeners.get("click")?.capture).toBe(true);
    const newEditor = new Element(true);
    app.click(new Element());
    app.document.activeElement = newEditor; // Search/edit button handler runs next.
    expect(newEditor.blur).not.toHaveBeenCalled();
  });
  it("does not disturb non-editor focus", () => {
    const app = fixture();
    app.document.activeElement = new Element();
    app.click(new Element());
    expect(app.document.activeElement.blur).not.toHaveBeenCalled();
  });
});
