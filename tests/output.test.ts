import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { OutputCoalescer } from "../src/output.js";
import { StateStore } from "../src/store.js";
import type { TelegramDelivery, TelegramTextOptions } from "../src/types.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("stream output", () => {
  it("coalesces progress and delivers an immutable final exactly once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-output-")); temporary.push(dir);
    const store = new StateStore(path.join(dir, "state.db"));
    const project = store.upsertProject(dir, "project", "explicit");
    const chat = { id: "chat", projectId: project.id, title: "Title", preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" };
    store.upsertChat(chat); store.startTurn(chat.id, "turn");
    const sent: { text: string; options?: TelegramTextOptions }[] = [];
    const telegram: TelegramDelivery = {
      async sendText(_chatId, text, options) { sent.push({ text, ...(options ? { options } : {}) }); return sent.length; },
      async editText() {}, async sendDocument() { return 1; },
    };
    const output = new OutputCoalescer(store, telegram, pino({ level: "silent" }), () => "[project / Title]");
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "Working" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = { threadId: "chat", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "Done" }] } };
    await output.complete(completed, 1);
    await output.complete(completed, 1);
    expect(sent.filter((entry) => entry.options?.idempotencyKey?.startsWith("final:"))).toHaveLength(1);
    expect(sent.at(-1)?.text).toContain("Done");
    store.close();
  });

  it("does not race multiple sends while the first Telegram request is pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-output-race-")); temporary.push(dir);
    const store = new StateStore(path.join(dir, "state.db"));
    const project = store.upsertProject(dir, "project", "explicit");
    store.upsertChat({ id: "chat", projectId: project.id, title: "Title", preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
    store.startTurn("chat", "turn");
    const progressSends: string[] = [];
    const telegram: TelegramDelivery = {
      async sendText(_chatId, text, options) {
        if (!options?.idempotencyKey) progressSends.push(text);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return progressSends.length + 1;
      },
      async editText() {}, async sendDocument() { return 1; },
    };
    const output = new OutputCoalescer(store, telegram, pino({ level: "silent" }), () => "[project / Title]");
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "Раз" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "беру" }, 1);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: " это" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(progressSends).toHaveLength(1);
    await output.complete({ threadId: "chat", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "agent", phase: "final_answer", text: "Разберу это" }] } }, 1);
    store.close();
  });
});
