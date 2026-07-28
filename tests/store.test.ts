import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/security.js";
import { StateStore } from "../src/store.js";

const stores: StateStore[] = [];
const temporary: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function makeStore(): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-store-")); temporary.push(dir);
  const store = new StateStore(path.join(dir, "state.db")); stores.push(store); return store;
}

describe("durable state", () => {
  it("remembers one chat independently per project", () => {
    const store = makeStore();
    const a = store.upsertProject("/a", "a", "explicit");
    const b = store.upsertProject("/b", "b", "explicit");
    store.upsertChat({ id: "a-chat", projectId: a.id, title: null, preview: "A", cwd: "/a", sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
    store.upsertChat({ id: "b-chat", projectId: b.id, title: null, preview: "B", cwd: "/b", sourceKind: "unknown", createdAt: 1, updatedAt: 1, status: "idle" });
    store.selectChat("a-chat"); store.selectChat("b-chat"); store.selectProject(a.id);
    expect(store.selectedChat()?.id).toBe("a-chat");
  });

  it("replaces aggregated diffs instead of concatenating", () => {
    const store = makeStore();
    store.replaceDiff("chat", "turn", "first");
    store.replaceDiff("chat", "turn", "complete snapshot");
    expect(store.latestDiff("chat")?.diff).toBe("complete snapshot");
  });

  it("binds callback tokens to user/chat/expiry and consumes once", () => {
    const store = makeStore();
    store.addPendingRequest({ tokenHash: hashToken("token"), rpcRequestId: 7, telegramChatId: 10, userId: 10, chatId: "chat", turnId: "turn", kind: "command", expiresAt: 200, usedAt: null, payload: {} });
    expect(store.consumePendingRequest(hashToken("token"), 11, 10, 100)).toBeNull();
    expect(store.consumePendingRequest(hashToken("token"), 10, 10, 100)?.rpcRequestId).toBe(7);
    expect(store.consumePendingRequest(hashToken("token"), 10, 10, 100)).toBeNull();
  });

  it("queues prompts per chat in arrival order", () => {
    const store = makeStore();
    store.enqueuePrompt("a", "first"); store.enqueuePrompt("b", "second");
    expect(store.nextQueuedPrompt(false)?.body).toBe("first");
  });

  it("views, edits, reorders, and cancels queued prompts", () => {
    const store = makeStore();
    const first = store.enqueuePrompt("a", "first");
    store.enqueuePrompt("b", "other chat");
    const last = store.enqueuePrompt("a", "last");
    expect(store.updateQueuedPrompt(last, "edited")).toBe(true);
    expect(store.moveQueuedPrompt(last, "up", true)).toBe(true);
    expect(store.listQueuedPrompts("a").map((prompt) => prompt.body)).toEqual(["edited", "first"]);
    expect(store.moveQueuedPrompt(first, "up")).toBe(true);
    expect(store.listQueuedPrompts().map((prompt) => prompt.id)).toEqual([last, first, first + 1]);
    store.deleteQueuedPrompt(first);
    expect(store.getQueuedPrompt(first)).toBeNull();
    expect((store.db.prepare("SELECT COUNT(*) count FROM prompt_queue_positions WHERE prompt_id=?").get(first) as { count: number }).count).toBe(0);
  });

  it("sorts favorite chats first and tracks unread counts", () => {
    const store = makeStore();
    const project = store.upsertProject("/a", "a", "explicit");
    store.upsertChat({ id: "new", projectId: project.id, title: "New", preview: null, cwd: "/a", sourceKind: "appServer", createdAt: 2, updatedAt: 2, status: "idle" });
    store.upsertChat({ id: "favorite", projectId: project.id, title: "Favorite", preview: null, cwd: "/a", sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
    expect(store.toggleFavorite("favorite")).toBe(true);
    store.recordAssistantMessage("favorite", "m1", "t1", 1, false, 2);
    expect(store.listChats(project.id).map((chat) => chat.id)).toEqual(["favorite", "new"]);
    expect(store.unreadCount("favorite")).toBe(1);
    store.markChatOpened("favorite", 3);
    expect(store.unreadCount("favorite")).toBe(0);
  });

  it("persists expiring next-message input modes", () => {
    const store = makeStore();
    store.setInputMode({ userId: 7, kind: "queue_edit", targetId: "12", expiresAt: 100, payload: { all: true } });
    expect(store.inputMode(7, 99)).toMatchObject({ kind: "queue_edit", targetId: "12", payload: { all: true } });
    expect(store.inputMode(7, 101)).toBeNull();
  });

  it("keeps failed prompt recovery until retry or dismissal", () => {
    const store = makeStore();
    store.startTurn("chat", "turn");
    store.saveRecoveryPrompt("chat", "turn", "original prompt");
    store.updateTurn("chat", "turn", "interrupted", { completedAt: 2 });
    expect(store.pendingRecoveryPrompts()).toHaveLength(1);
    store.markRecoveryOffered("chat", "turn");
    expect(store.pendingRecoveryPrompts()).toHaveLength(0);
    expect(store.recoveryPrompt("chat", "turn")?.body).toBe("original prompt");
    store.clearRecoveryPrompt("chat", "turn");
    expect(store.recoveryPrompt("chat", "turn")).toBeNull();
  });

  it("retrieves the exact turn diff", () => {
    const store = makeStore();
    store.replaceDiff("chat", "turn-1", "one");
    store.replaceDiff("chat", "turn-2", "two");
    expect(store.getDiff("chat", "turn-1")?.diff).toBe("one");
    expect(store.getDiff("chat", "missing")).toBeNull();
  });

  it("does not redeliver an acknowledged outbox item", () => {
    const store = makeStore();
    expect(store.prepareOutbox("final:1", "sendMessage", { text: "answer" })).toMatchObject({ delivered: false, attempts: 0 });
    store.deliverOutbox("final:1", 99);
    expect(store.prepareOutbox("final:1", "sendMessage", { text: "answer" })).toEqual({ delivered: true, attempts: 1, messageId: 99 });
  });

  it("tracks assistant-only unread messages and marks them read when opened", () => {
    const store = makeStore();
    store.recordAssistantMessage("chat", "message-1", "turn-1", 1_000, false, 2_000);
    expect(store.pendingAssistantNotifications(1_000)).toHaveLength(1);
    store.markChatOpened("chat", 3_000);
    expect(store.pendingAssistantNotifications(10_000)).toHaveLength(0);
    store.recordAssistantMessage("chat", "message-2", "turn-2", 2_500, false, 4_000);
    expect(store.pendingAssistantNotifications(10_000)).toHaveLength(0);
  });

  it("persists per-chat full-access mode", () => {
    const store = makeStore();
    expect(store.isFullAccess("chat")).toBe(false);
    store.setFullAccess("chat", true);
    expect(store.isFullAccess("chat")).toBe(true);
    store.setFullAccess("chat", false);
    expect(store.isFullAccess("chat")).toBe(false);
  });
});
