import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { PromptNotSentError, TurnCoordinator } from "../src/turns.js";
import { StateStore } from "../src/store.js";
import { CodexRpcError, type CodexRpcClient } from "../src/codex-rpc.js";
import type { ProjectRegistry } from "../src/projects.js";
import type { OutputCoalescer } from "../src/output.js";
import type { ApprovalCoordinator } from "../src/approvals.js";

const cleanups: (() => void)[] = [];
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
