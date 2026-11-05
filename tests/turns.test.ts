import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { PromptNotSentError, QueueActionError, TurnCoordinator } from "../src/turns.js";
import { StateStore } from "../src/store.js";
import { CodexRpcError, type CodexRpcClient } from "../src/codex-rpc.js";
import type { ProjectRegistry } from "../src/projects.js";
import type { OutputCoalescer } from "../src/output.js";
import type { ApprovalCoordinator } from "../src/approvals.js";

const cleanups: (() => void)[] = [];
function editedTurn(id: string) {
  return { id, status: "completed", items: [{ type: "fileChange", status: "completed", changes: [{ path: "test.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }] }] };
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "turn-concurrency-")));
  const store = new StateStore(path.join(dir, "state.db"));
  const project = store.upsertProject(dir, "test", "explicit");
  for (const id of ["a", "b"]) store.upsertChat({ id, projectId: project.id, title: id, preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
  const rpc = Object.assign(new EventEmitter(), { request: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ turn: { id: "turn" } })) });
  const registry = { recanonicalize: () => dir, isAllowed: () => true };
  const turns = new TurnCoordinator(rpc as unknown as CodexRpcClient, store, registry as unknown as ProjectRegistry, {} as OutputCoalescer, {} as ApprovalCoordinator, 42, 1, 5, pino({ level: "silent" }));
  cleanups.push(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, turns, rpc };
}

it("loads the latest desktop-owned changes from history with an empty bot cache", async () => {
  const { turns, rpc, store } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockResolvedValue({ data: [{ id: "latest-no-edits", items: [] }, editedTurn("edited")], nextCursor: null });
  const diff = await turns.diff("a");
  expect(diff).toMatchObject({ turnId: "edited", source: "history" });
  expect(diff?.diff).toContain("+new");
  expect(store.latestDiff("a")).toBeNull();
  expect(rpc.request).toHaveBeenCalledExactlyOnceWith("thread/turns/list", { threadId: "a", limit: 20, sortDirection: "desc", itemsView: "full" });
});

it("pages older history and downloads the requested turn instead of the latest", async () => {
  const { turns, rpc } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockImplementation(async (_method, params) => (params as { cursor?: string }).cursor
    ? { data: [editedTurn("older")], nextCursor: null }
    : { data: [editedTurn("newer")], nextCursor: "older-page" });
  expect((await turns.diff("a", "older"))?.turnId).toBe("older");
  expect(rpc.request).toHaveBeenLastCalledWith("thread/turns/list", expect.objectContaining({ threadId: "a", cursor: "older-page" }));
  expect(await turns.diff("a", "foreign-turn")).toBeNull();
  await expect(turns.diff("unknown-chat")).rejects.toThrow("not indexed");
});

it("finds older edits when recent pages only contain conversation", async () => {
  const { turns, rpc } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockResolvedValueOnce({ data: [{ id: "discussion", items: [] }], nextCursor: "next" })
    .mockResolvedValueOnce({ data: [editedTurn("older")], nextCursor: null });
  expect((await turns.diff("a"))?.turnId).toBe("older");
});

it("supports legacy history and prefers a matching live diff without reviving removed turns", async () => {
  const { turns, rpc, store } = fixture();
  store.replaceDiff("a", "removed", "stale");
  rpc.request.mockResolvedValue({ thread: { turns: [editedTurn("old"), editedTurn("new")] } });
  expect((await turns.diff("a"))?.turnId).toBe("new");
  expect(await turns.diff("a", "removed")).toBeNull();
  store.replaceDiff("a", "new", "aggregated live diff");
  expect(await turns.diff("a")).toEqual({ turnId: "new", diff: "aggregated live diff", source: "live" });
  expect(rpc.request).toHaveBeenLastCalledWith("thread/read", { threadId: "a", includeTurns: true });
});

it("does not misreport a history error as an empty diff or loop on a bad cursor", async () => {
  const { turns, rpc } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockRejectedValueOnce(new Error("unavailable"));
  await expect(turns.diff("a")).rejects.toThrow("unavailable");
  rpc.request.mockResolvedValue({ data: [], nextCursor: "repeated" });
  await expect(turns.diff("a")).rejects.toThrow("repeated history cursor");
});

it("reserves capacity while turn/start is awaiting acknowledgement", async () => {
  const { turns, rpc, store } = fixture();
  let release!: () => void;
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  rpc.request.mockImplementation(async (method) => { if (method === "thread/resume") await resumed; return { turn: { id: "turn" } }; });
  const first = turns.prompt("a", "first");
  expect(await turns.prompt("a", "same chat")).toBe("queued");
  expect(await turns.prompt("b", "other chat")).toBe("queued");
  release();
  expect(await first).toBe("started");
  expect(rpc.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  expect(store.queueCount()).toBe(2);
});

it("treats a writer lock during resume as a definite refusal, allowing a later retry", async () => {
  const { turns, rpc, store } = fixture();
  rpc.request.mockRejectedValueOnce(new CodexRpcError(-32600, "thread a already has an active writer"));
  expect(await turns.prompt("a", "hello")).toBe("external_busy");
  expect(rpc.request).toHaveBeenCalledTimes(1);
  expect(store.activeTurns()).toHaveLength(0);
  expect(store.queueCount()).toBe(0);
  expect(await turns.prompt("a", "hello")).toBe("started");
});

it("routes a desktop-owned chat to the native queue without starting a second writer", async () => {
  const { turns, rpc, store } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockImplementation(async (method) => {
    if (method === "thread/resume") throw new CodexRpcError(-32600, "thread a already has an active writer");
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    return { queuedSubmission: { id: "native" } };
  });
  expect(await turns.prompt("a", "hello", "client-request-1234")).toBe("queued_external");
  expect(rpc.request).toHaveBeenLastCalledWith("thread/queue/add", { threadId: "a", input: [{ type: "text", text: "hello" }], clientUserMessageId: "client-request-1234" });
  expect(rpc.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  expect(store.activeTurns()).toHaveLength(0);
  expect(store.queueCount()).toBe(0);
});

it("keeps native queue timeouts ambiguous and rejects a full queue before submitting", async () => {
  const { turns, rpc, store } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  store.upsertChat({ ...store.getChat("a")!, status: "active" });
  rpc.request.mockImplementation(async (method) => {
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    throw new Error("queue add timeout");
  });
  await expect(turns.prompt("a", "hello")).rejects.not.toBeInstanceOf(PromptNotSentError);
  rpc.request.mockClear();
  rpc.request.mockResolvedValue({ data: Array.from({ length: 5 }, (_, i) => ({ id: String(i), input: [] })) });
  await expect(turns.prompt("a", "hello")).rejects.toBeInstanceOf(PromptNotSentError);
  expect(rpc.request.mock.calls.some(([method]) => method === "thread/queue/add")).toBe(false);
});

it("distinguishes a failed resume from uncertain turn/start delivery", async () => {
  const { turns, rpc } = fixture();
  rpc.request.mockRejectedValueOnce(new Error("resume timed out"));
  await expect(turns.prompt("a", "hello")).rejects.toBeInstanceOf(PromptNotSentError);
  rpc.request.mockImplementation(async (method) => {
    if (method === "turn/start") throw new Error("start timed out");
    return {};
  });
  await expect(turns.prompt("a", "hello")).rejects.not.toBeInstanceOf(PromptNotSentError);
  // Even the same error text after turn/start must stay ambiguous.
  rpc.request.mockImplementation(async (method) => {
    if (method === "turn/start") throw new CodexRpcError(-32600, "already has an active writer");
    return {};
  });
  await expect(turns.prompt("a", "hello")).rejects.toBeInstanceOf(CodexRpcError);
});

it("keeps recovery available when an external active turn prevents retry", async () => {
  const { turns, store } = fixture();
  store.upsertChat({ ...store.getChat("a")!, status: "active" });
  store.saveRecoveryPrompt("a", "old", "retry this");
  expect(await turns.retryRecovery("a", "old")).toBe("external_busy");
  expect(store.recoveryPrompt("a", "old")?.body).toBe("retry this");
});

it("does not submit the same recovery twice concurrently", async () => {
  const { turns, rpc, store } = fixture();
  let release!: () => void;
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  rpc.request.mockImplementation(async () => { await resumed; return { turn: { id: "turn" } }; });
  store.saveRecoveryPrompt("a", "old", "retry this");
  const first = turns.retryRecovery("a", "old");
  await expect(turns.retryRecovery("a", "old")).rejects.toThrow("already being submitted");
  release();
  expect(await first).toBe("started");
  expect(store.recoveryPrompt("a", "old")).toBeNull();
});

it("reads full paginated turns in chronological order and resumes without loading history", async () => {
  const { turns, rpc } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockImplementation(async (method) => method === "thread/turns/list" ? { data: [
    { id: "new", status: "completed", items: [{ id: "a2", type: "agentMessage", text: "New answer" }] },
    { id: "old", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "Question" }] }, { id: "a1", type: "agentMessage", text: "Old answer" }] },
  ] } : { turn: { id: "turn" } });
  expect((await turns.messages("a")).map((item) => item.text)).toEqual(["Question", "Old answer", "New answer"]);
  expect(rpc.request).toHaveBeenCalledWith("thread/turns/list", { threadId: "a", limit: 50, sortDirection: "desc", itemsView: "full" });
  await turns.prompt("a", "Continue");
  expect(rpc.request).toHaveBeenCalledWith("thread/resume", { threadId: "a", excludeTurns: true });
});

it("sends the selected queued entry now, leaving other entries unchanged", async () => {
  const { turns, rpc, store } = fixture();
  const first = store.enqueuePrompt("a", "first");
  const selected = store.enqueuePrompt("a", "selected");
  expect(await turns.sendQueuedNow(selected)).toBe("started");
  expect(rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [{ type: "text", text: "selected", text_elements: [] }] }));
  expect(store.getQueuedPrompt(selected)).toBeNull();
  expect(store.getQueuedPrompt(first)?.body).toBe("first");
  await expect(turns.sendQueuedNow(selected)).rejects.toBeInstanceOf(QueueActionError);
});

it("steers an owned active turn and deletes the queued entry only after acknowledgement", async () => {
  const { turns, rpc, store } = fixture();
  await turns.prompt("a", "original");
  const id = store.enqueuePrompt("a", "steer this");
  let release!: () => void;
  rpc.request.mockImplementation(async (method) => {
    if (method === "turn/steer") await new Promise<void>((resolve) => { release = resolve; });
    return {};
  });
  const sending = turns.sendQueuedNow(id);
  expect(store.getQueuedPrompt(id)?.retryCount).toBe(-1);
  expect(turns.isQueuedStarting(id)).toBe(true);
  await expect(turns.sendQueuedNow(id)).rejects.toBeInstanceOf(QueueActionError);
  release();
  expect(await sending).toBe("steered");
  expect(rpc.request).toHaveBeenCalledWith("turn/steer", { threadId: "a", expectedTurnId: "turn", input: [{ type: "text", text: "steer this", text_elements: [] }] });
  expect(store.getQueuedPrompt(id)).toBeNull();
  expect(turns.isQueuedStarting(id)).toBe(false);
});

it("keeps uncertain steering in the queue without permitting an accidental replay", async () => {
  const { turns, rpc, store } = fixture();
  await turns.prompt("a", "original");
  const id = store.enqueuePrompt("a", "steer");
  rpc.request.mockRejectedValueOnce(new Error("timeout"));
  await expect(turns.sendQueuedNow(id)).rejects.toThrow("timeout");
  expect(store.getQueuedPrompt(id)?.retryCount).toBe(-1);
  await expect(turns.sendQueuedNow(id)).rejects.toBeInstanceOf(QueueActionError);
});

it("preserves a safely rejected steer and a writer-locked queued start", async () => {
  const { turns, rpc, store } = fixture();
  await turns.prompt("a", "original");
  const id = store.enqueuePrompt("a", "steer");
  rpc.request.mockRejectedValueOnce(new CodexRpcError(-32600, "expectedTurnId mismatch"));
  await expect(turns.sendQueuedNow(id)).rejects.toBeInstanceOf(CodexRpcError);
  expect(store.getQueuedPrompt(id)?.retryCount).toBe(0);
  store.updateTurn("a", "turn", "completed");
  rpc.request.mockRejectedValueOnce(new CodexRpcError(-32600, "thread a already has an active writer"));
  await expect(turns.sendQueuedNow(id)).rejects.toBeInstanceOf(QueueActionError);
  expect(store.getQueuedPrompt(id)?.retryCount).toBe(0);
});

it("does not exceed capacity or send a queue entry twice while resume is pending", async () => {
  const { turns, rpc, store } = fixture();
  const id = store.enqueuePrompt("a", "selected");
  let release!: () => void;
  rpc.request.mockImplementation(async (method) => {
    if (method === "thread/resume") await new Promise<void>((resolve) => { release = resolve; });
    return { turn: { id: "started" } };
  });
  const sending = turns.sendQueuedNow(id);
  await expect(turns.sendQueuedNow(id)).rejects.toBeInstanceOf(QueueActionError);
  const other = store.enqueuePrompt("b", "other");
  await expect(turns.sendQueuedNow(other)).rejects.toBeInstanceOf(QueueActionError);
  expect(store.getQueuedPrompt(other)?.body).toBe("other");
  release();await sending;
  expect(rpc.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
});

it("starts native queue entries by ID without copying or deleting their text", async () => {
  const { turns, rpc, store } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockImplementation(async (method) => method === "thread/queue/list"
    ? { data: [{ id: "native", input: [{ type: "text", text: "selected" }] }] }
    : { turn: { id: "native-turn" } });
  expect(await turns.startNativeQueuedNow("a", "native")).toBe("started");
  expect(rpc.request).toHaveBeenCalledWith("thread/queue/start", { threadId: "a", queuedSubmissionId: "native" });
  expect(rpc.request.mock.calls.some(([method]) => ["thread/queue/delete", "thread/queue/add", "turn/start"].includes(method))).toBe(false);
  expect(store.activeTurn("a")?.turnId).toBe("native-turn");
  expect(store.recoveryPrompt("a", "native-turn")?.body).toBe("selected");
});

it("preserves desktop-owned native entries when immediate start is unavailable", async () => {
  const { turns, rpc, store } = fixture();
  Object.assign(rpc, { supportsPaginatedHistory: true });
  rpc.request.mockImplementation(async (method) => {
    if (method === "thread/queue/list") return { data: [{ id: "native", input: [] }] };
    throw new CodexRpcError(-32600, "thread a already has an active writer");
  });
  await expect(turns.startNativeQueuedNow("a", "native")).rejects.toThrow("сообщение осталось в очереди");
  expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list", "thread/resume"]);
  expect(store.activeTurn("a")).toBeNull();
  expect(turns.isNativeQueuedStarting("a", "native")).toBe(false);
  await expect(turns.startNativeQueuedNow("a", "missing")).rejects.toThrow("уже отправлено или удалено");
});
