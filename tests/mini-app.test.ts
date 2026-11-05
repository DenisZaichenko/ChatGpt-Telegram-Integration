import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMiniAppData } from "../src/mini-app-auth.js";
import { MiniAppServer } from "../src/mini-app.js";
import { StateStore } from "../src/store.js";
import type { Config } from "../src/config.js";
import { PromptNotSentError, QueueActionError, type TurnCoordinator } from "../src/turns.js";
import type { CodexRpcClient } from "../src/codex-rpc.js";
import type { ChatDiff } from "../src/history-diff.js";

const token = "123456789:test-only-bot-token";
const owner = 42;
function signed(userId = owner, date = Math.floor(Date.now() / 1000)) {
  const entries = { auth_date: String(date), query_id: "test-query", user: JSON.stringify({ id: userId, first_name: "Tester" }) };
  const check = Object.entries(entries).map(([key, value]) => `${key}=${value}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...entries, hash }).toString();
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-app-test-"));
  const store = new StateStore(path.join(dir, "state.db"));
  const project = store.upsertProject(dir, "test", "explicit");
  store.upsertChat({ id: "chat", projectId: project.id, title: "Private chat", preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1, status: "idle" });
  store.markPaired();
  const prompt = vi.fn(async () => "started");
  const turns = { prompt, nativeQueue: vi.fn(async (): Promise<{ id: string; body: string; retryCount: number; native: true }[]> => []), messages: vi.fn(async () => [{ id: "m", role: "assistant", text: "Private reply", status: "completed", turnId: "t" }]), isQueuedStarting: vi.fn(() => false) };
  const diffs = { diff: vi.fn(async (chatId: string, turnId?: string): Promise<ChatDiff | null> => {
    const result = turnId ? store.getDiff(chatId, turnId) : store.latestDiff(chatId);
    return result ? { ...result, source: "live" } : null;
  }) };
  Object.assign(turns, diffs);
  const queueActions = { sendQueuedNow: vi.fn(async () => "steered"), startNativeQueuedNow: vi.fn(async () => "started"), isNativeQueuedStarting: vi.fn(() => false) };
  Object.assign(turns, queueActions);
  const config = { miniAppPort: 8787, miniAppUrl: "https://example.test", telegramBotToken: token, allowedUserId: owner } as Config;
  const rpc = { ready: true, request: vi.fn(async () => ({ deleted: true })) };
  const server = new MiniAppServer(config, store, turns as unknown as TurnCoordinator, rpc as unknown as CodexRpcClient, pino({ level: "silent" }));
  const port = await server.start(0);
  cleanups.push(async () => { await server.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (url: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { Authorization: `tma ${signed()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { request, store, turns, prompt, rpc, queueActions, diffs };
}

describe("Telegram launch authentication", () => {
  it("accepts the signed owner and rejects a different signed user, tampering, expiry and future timestamps", () => {
    expect(() => verifyMiniAppData(signed(), token, owner)).not.toThrow();
    expect(() => verifyMiniAppData(signed(99), token, owner)).toThrow("Access denied");
    expect(() => verifyMiniAppData(signed().replace("Tester", "Hacker"), token, owner)).toThrow("signature");
    const now = Math.floor(Date.now() / 1000);
    expect(() => verifyMiniAppData(signed(owner, now - 3601), token, owner)).toThrow("expired");
    expect(() => verifyMiniAppData(signed(owner, now + 60), token, owner)).toThrow("expired");
    expect(() => verifyMiniAppData(`${signed()}&auth_date=1`, token, owner)).toThrow("launch data");
    expect(() => verifyMiniAppData("", token, owner)).toThrow();
  });
});

describe("Mini App HTTP boundary", () => {
  it("serves and downloads historical changes without relying on the bot cache", async () => {
    const { request, store, diffs } = await fixture();
    const historical: ChatDiff = { turnId: "desktop-turn", diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n", source: "history" };
    diffs.diff.mockResolvedValue(historical);
    expect(store.latestDiff("chat")).toBeNull();
    expect((await (await request("/api/chats/chat")).json()).diff).toEqual(historical);
    const download = await request("/api/chats/chat/diff/desktop-turn");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(historical.diff);
    expect(diffs.diff).toHaveBeenLastCalledWith("chat", "desktop-turn");
    const calls = diffs.diff.mock.calls.length;
    expect((await request("/api/chats/other/diff/desktop-turn")).status).toBe(404);
    expect((await request("/api/chats/chat/diff/desktop-turn", "GET", undefined, { Authorization: "" })).status).toBe(401);
    expect(diffs.diff).toHaveBeenCalledTimes(calls);
    diffs.diff.mockResolvedValue(null);
    expect((await request("/api/chats/chat/diff/missing")).status).toBe(404);
    diffs.diff.mockRejectedValue(new Error("History failed"));
    expect((await request("/api/chats/chat")).status).toBe(503);
  });
  it("versions CSS and JS by content and serves those URLs without caching", async () => {
    const { request } = await fixture();
    const page = await request("/", "GET", undefined, { Authorization: "" });
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    for (const [file, type] of [["app.css", "text/css"], ["app.js", "text/javascript"]]) {
      const content = fs.readFileSync(new URL(`../web/${file}`, import.meta.url));
      const version = createHash("sha256").update(content).digest("hex").slice(0, 16);
      const url = `/${file}?v=${version}`;
      expect(html).toContain(`"${url}"`);
      const asset = await request(url, "GET", undefined, { Authorization: "" });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("no-store");
      expect(asset.headers.get("content-type")).toContain(type);
      expect(await asset.text()).toBe(content.toString("utf8"));
    }
  });

  it("serves only public UI assets anonymously, requires pairing/auth and blocks other origins", async () => {
    const { request, store } = await fixture();
    const asset = await request("/", "GET", undefined, { Authorization: "" });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Codex Remote");
    const denied = await request("/api/state", "GET", undefined, { Authorization: "" });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("Private chat");
    expect((await request("/api/state", "GET", undefined, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await request("/.env")).status).toBe(404);
    expect((await request("/api/state", "GET", undefined, { Origin: "https://example.test" })).status).toBe(200);
    store.setSetting("paired", "0");
    expect((await request("/api/state")).status).toBe(403);
  });

  it("reads messages, marks read only on explicit open, and scopes diff downloads to a turn", async () => {
    const { request, store } = await fixture();
    store.recordAssistantMessage("chat", "unread", "t", Date.now());
    const message = (await (await request("/api/chats/chat")).json()).messages[0];
    expect(message.text).toBe("Private reply");
    expect(message.html).toBe("<p>Private reply</p>\n");
    expect(store.unreadCount("chat")).toBe(1);
    await request("/api/chats/chat/open", "POST", {});
    expect(store.unreadCount("chat")).toBe(0);
    store.replaceDiff("chat", "one", "diff one"); store.replaceDiff("chat", "two", "diff two");
    const diff = await request("/api/chats/chat/diff/one");
    expect(await diff.text()).toBe("diff one");
    expect(diff.headers.get("content-disposition")).toContain(".diff");
    expect((await request("/api/chats/other/diff/one")).status).toBe(404);
  });

  it("submits a prompt once across retries and rejects id reuse with a different prompt", async () => {
    const { request, prompt } = await fixture();
    const headers = { "Idempotency-Key": "unique-request-0001" };
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Hello" }, headers)).status).toBe(200);
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Hello" }, headers)).status).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Different" }, headers)).status).toBe(409);
    expect((await request("/api/chats/chat/prompts", "POST", { text: "" }, headers)).status).toBe(400);
  });

  it("never replays a prompt after uncertain delivery", async () => {
    const { request, prompt } = await fixture();
    prompt.mockRejectedValueOnce(new Error("timeout"));
    const headers = { "Idempotency-Key": "uncertain-request-0001" };
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Work" }, headers)).status).toBe(503);
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Work" }, headers)).status).toBe(409);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("permits retry with the same key only when failure was before turn/start", async () => {
    const { request, prompt } = await fixture();
    prompt.mockRejectedValueOnce(new PromptNotSentError("resume failed"));
    const headers = { "Idempotency-Key": "not-sent-request-0001" };
    const failed = await request("/api/chats/chat/prompts", "POST", { text: "Work" }, headers);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toContain("Сообщение не отправлено");
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Work" }, headers)).status).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("returns a writer conflict on repeated requests instead of claiming unknown delivery", async () => {
    const { request, prompt } = await fixture();
    prompt.mockResolvedValueOnce("external_busy");
    const headers = { "Idempotency-Key": "busy-request-0001" };
    for (let i = 0; i < 2; i++) {
      const reply = await request("/api/chats/chat/prompts", "POST", { text: "Work" }, headers);
      expect(reply.status).toBe(200);
      expect((await reply.json()).disposition).toBe("external_busy");
    }
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await request("/api/chats/chat/prompts", "POST", { text: "Work" }, { "Idempotency-Key": "busy-request-0002" })).status).toBe(200);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("edits, moves and cancels queue entries but refuses changes to a starting prompt", async () => {
    const { request, store, turns } = await fixture();
    const first = store.enqueuePrompt("chat", "first");
    const last = store.enqueuePrompt("chat", "last");
    expect((await request(`/api/queue/${last}`, "PATCH", { body: "edited" })).status).toBe(200);
    await request(`/api/queue/${last}`, "PATCH", { direction: "up" });
    expect(store.listQueuedPrompts("chat").map((item) => item.body)).toEqual(["edited", "first"]);
    turns.isQueuedStarting.mockReturnValueOnce(true);
    expect((await request(`/api/queue/${first}`, "DELETE")).status).toBe(409);
    expect(store.getQueuedPrompt(first)).not.toBeNull();
    await request(`/api/queue/${first}`, "DELETE");
    expect(store.getQueuedPrompt(first)).toBeNull();
  });

  it("includes the native queue and scopes its mutations to the selected chat", async () => {
    const { request, turns, rpc } = await fixture();
    turns.nativeQueue.mockResolvedValue([
      { id: "native-one", body: "First", native: true, retryCount: 0 },
      { id: "native-two", body: "Second", native: true, retryCount: 0 },
    ]);
    expect((await (await request("/api/chats/chat")).json()).queue).toHaveLength(2);
    await request("/api/chats/chat/queue/native-one", "PATCH", { body: "Edited" });
    expect(rpc.request).toHaveBeenLastCalledWith("thread/queue/update", { threadId: "chat", queuedSubmissionId: "native-one", input: [{ type: "text", text: "Edited" }] });
    await request("/api/chats/chat/queue/native-two", "PATCH", { direction: "up" });
    expect(rpc.request).toHaveBeenLastCalledWith("thread/queue/reorder", { threadId: "chat", queuedSubmissionIds: ["native-two", "native-one"] });
    await request("/api/chats/chat/queue/native-one", "DELETE");
    expect(rpc.request).toHaveBeenLastCalledWith("thread/queue/delete", { threadId: "chat", queuedSubmissionId: "native-one" });
    const calls = rpc.request.mock.calls.length;
    expect((await request("/api/chats/chat/queue/missing", "DELETE")).status).toBe(409);
    expect((await request("/api/chats/other/queue/native-one", "DELETE")).status).toBe(404);
    expect(rpc.request).toHaveBeenCalledTimes(calls);
  });

  it("routes send-now for both queue types, requires auth and preserves conflicts", async () => {
    const { request, queueActions } = await fixture();
    const local = await request("/api/queue/12/start", "POST", {});
    expect(await local.json()).toEqual({ disposition: "steered" });
    expect(queueActions.sendQueuedNow).toHaveBeenCalledExactlyOnceWith(12);
    const native = await request("/api/chats/chat/queue/native-one/start", "POST", {});
    expect(await native.json()).toEqual({ disposition: "started" });
    expect(queueActions.startNativeQueuedNow).toHaveBeenCalledExactlyOnceWith("chat", "native-one");
    expect((await request("/api/chats/other/queue/native-one/start", "POST", {})).status).toBe(404);
    expect((await request("/api/queue/12/start", "POST", {}, { Authorization: "" })).status).toBe(401);
    expect(queueActions.sendQueuedNow).toHaveBeenCalledTimes(1);
    queueActions.startNativeQueuedNow.mockRejectedValueOnce(new QueueActionError("Осталось в очереди"));
    const conflict = await request("/api/chats/chat/queue/native-one/start", "POST", {});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "Осталось в очереди" });
  });

  it("refuses editing or removing native entries while send-now is in progress", async () => {
    const { request, queueActions, rpc } = await fixture();
    queueActions.isNativeQueuedStarting.mockReturnValue(true);
    expect((await request("/api/chats/chat/queue/native-one", "DELETE")).status).toBe(409);
    expect((await request("/api/chats/chat/queue/native-one", "PATCH", { body: "edit" })).status).toBe(409);
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it("preserves the client request id when delivering to ChatGPT's queue", async () => {
    const { request, prompt } = await fixture();
    prompt.mockResolvedValueOnce("queued_external");
    const headers = { "Idempotency-Key": "native-request-0001" };
    for (let i = 0; i < 2; i++) {
      const response = await request("/api/chats/chat/prompts", "POST", { text: "Hello app" }, headers);
      expect((await response.json()).disposition).toBe("queued_external");
    }
    expect(prompt).toHaveBeenCalledExactlyOnceWith("chat", "Hello app", headers["Idempotency-Key"]);
  });
});
