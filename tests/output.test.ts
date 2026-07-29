import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { draftIdFor, OutputCoalescer } from "../src/output.js";
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
      async editText() {}, async sendDocument() { return 1; }, async sendDraft() { return false; },
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
      async editText() {}, async sendDocument() { return 1; }, async sendDraft() { return false; },
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

describe("draft streaming", () => {
  function harness(draftResult: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-draft-")); temporary.push(dir);
    const store = new StateStore(path.join(dir, "state.db"));
    const project = store.upsertProject(dir, "project", "explicit");
    store.upsertChat({ id: "chat", projectId: project.id, title: "Title", preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
    store.startTurn("chat", "turn");
    const drafts: { draftId: number; text: string }[] = [];
    const sent: { text: string; options?: TelegramTextOptions }[] = [];
    const edits: string[] = [];
    const telegram: TelegramDelivery = {
      async sendText(_chatId, text, options) { sent.push({ text, ...(options ? { options } : {}) }); return sent.length; },
      async editText(_chatId, _messageId, text) { edits.push(text); },
      async sendDocument() { return 1; },
      async sendDraft(_chatId, draftId, text) { drafts.push({ draftId, text }); return draftResult; },
    };
    const output = new OutputCoalescer(store, telegram, pino({ level: "silent" }), () => "[project / Title]");
    return { store, output, drafts, sent, edits };
  }

  const finish = { threadId: "chat", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "agent", phase: "final_answer", text: "Done" }] } };

  it("streams progress into a draft and persists exactly one message per turn", async () => {
    const { store, output, drafts, sent, edits } = harness(true);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "Working" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toContain("Working");
    expect(drafts[0]?.draftId).toBe(draftIdFor("turn"));
    // No progress message and no edits: the draft leaves nothing behind.
    expect(sent).toHaveLength(0);
    expect(edits).toHaveLength(0);
    await output.complete(finish, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Done");
    store.close();
  });

  it("falls back to an edited progress message when the Bot API rejects drafts", async () => {
    const { store, output, drafts, sent } = harness(false);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "Working" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drafts).toHaveLength(1);
    expect(sent.map((entry) => entry.text)).toEqual([expect.stringContaining("Working")]);
    await output.complete(finish, 1);
    expect(sent).toHaveLength(2);
    store.close();
  });

  it("stops attempting drafts after the first rejection", async () => {
    const { store, output, drafts } = harness(false);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "one" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: " two" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(drafts).toHaveLength(1);
    await output.complete(finish, 1);
    store.close();
  });

  it("throttles draft updates instead of sending one per delta", async () => {
    const { store, output, drafts } = harness(true);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "a" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "b" }, 1);
    output.agentDelta({ threadId: "chat", turnId: "turn", itemId: "agent", delta: "c" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drafts).toHaveLength(1);
    await output.complete(finish, 1);
    store.close();
  });

  it("derives a stable non-zero draft id per turn", () => {
    expect(draftIdFor("turn")).toBe(draftIdFor("turn"));
    expect(draftIdFor("turn")).not.toBe(draftIdFor("other-turn"));
    expect(draftIdFor("")).toBe(1);
    for (const id of ["turn", "0198f2c1-1111-7000-8000-aaaaaaaaaaaa", "x".repeat(200)]) {
      expect(draftIdFor(id)).toBeGreaterThan(0);
      expect(draftIdFor(id)).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});
