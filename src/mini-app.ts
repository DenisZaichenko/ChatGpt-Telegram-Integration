import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { StateStore } from "./store.js";
import { PromptNotSentError, QueueActionError, type TurnCoordinator } from "./turns.js";
import type { CodexRpcClient } from "./codex-rpc.js";
import type { CodexChat } from "./types.js";
import { hashToken, SlidingWindowRateLimiter } from "./security.js";
import { verifyMiniAppData } from "./mini-app-auth.js";
import { messageHtml } from "./message-format.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class MiniAppServer {
  private readonly server: http.Server;
  private readonly writes = new SlidingWindowRateLimiter(40, 60_000);

  constructor(private readonly config: Config, private readonly store: StateStore, private readonly turns: TurnCoordinator,
    private readonly rpc: CodexRpcClient, private readonly logger: Logger) {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof HttpError) this.json(res, { error: error.message }, error.status);
      else if (error instanceof QueueActionError) this.json(res, { error: error.message }, 409);
      else {
        this.logger.warn({ message: error instanceof Error ? error.message : "Unknown error" }, "Mini App request failed");
        this.json(res, { error: "Operation could not be completed. Refresh the chat status before retrying." }, 503);
      }
    }));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
  }

  async start(port = this.config.miniAppPort): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org");
    const url = new URL(req.url ?? "/", "http://localhost");
    const asset = assets.get(url.pathname);
    if (asset && req.method === "GET") {
      res.setHeader("Content-Type", asset[1]!);
      const readAsset = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)));
      let content = readAsset(asset[0]!);
      if (url.pathname === "/") {
        // WebViews can retain assets across launches. A changed file must get a new URL.
        const html = content.toString("utf8").replace(/\/(app\.(?:css|js))(?=")/g, (_, name: string) => {
          const version = createHash("sha256").update(readAsset(name)).digest("hex").slice(0, 16);
          return `/${name}?v=${version}`;
        });
        content = Buffer.from(html);
      }
      res.end(content);
      return;
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    if (!this.store.isPaired()) throw new HttpError(403, "Pair this bot in Telegram first");
    const origin = req.headers.origin;
    if (origin && (!this.config.miniAppUrl || origin !== new URL(this.config.miniAppUrl).origin)) throw new HttpError(403, "Invalid origin");
    const authorization = req.headers.authorization ?? "";
    try { verifyMiniAppData(authorization.startsWith("tma ") ? authorization.slice(4) : "", this.config.telegramBotToken, this.config.allowedUserId); }
    catch (error) { throw new HttpError(401, error instanceof Error ? error.message : "Access denied"); }
    const method = req.method ?? "";
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new HttpError(405, "Method not allowed");
    if (method !== "GET" && !this.writes.take(this.config.allowedUserId)) throw new HttpError(429, "Too many actions. Wait a minute.");
    const body = method === "POST" || method === "PATCH" ? await readJson(req) : {};
    if (url.pathname === "/api/state" && method === "GET") {
      this.json(res, { ready: this.rpc.ready, projects: this.store.listProjects().map(({ id, alias }) => ({ id, alias })),
        chats: this.store.listChats(undefined, 10_000).map((chat) => this.chatView(chat)), selectedChatId: this.store.selectedChat()?.id ?? null });
      return;
    }
    if (url.pathname === "/api/chats" && method === "POST") {
      if (!Number.isSafeInteger(body.projectId) || !this.store.getProject(Number(body.projectId))) throw new HttpError(400, "Select an available project");
      this.json(res, { chat: this.chatView(await this.turns.createChat(Number(body.projectId))) });
      return;
    }
    const queueStartMatch = /^\/api\/queue\/(\d+)\/start$/.exec(url.pathname);
    if (queueStartMatch && method === "POST") {
      this.json(res, { disposition: await this.turns.sendQueuedNow(Number(queueStartMatch[1])) });
      return;
    }
    const queueMatch = /^\/api\/queue\/(\d+)$/.exec(url.pathname);
    if (queueMatch && ["PATCH", "DELETE"].includes(method)) {
      const id = Number(queueMatch[1]);
      if (!this.store.getQueuedPrompt(id) || this.turns.isQueuedStarting(id)) throw new HttpError(409, "Prompt has already started or was removed");
      if (method === "DELETE") this.store.deleteQueuedPrompt(id);
      else if (body.direction === "up" || body.direction === "down") this.store.moveQueuedPrompt(id, body.direction, true);
      else this.store.updateQueuedPrompt(id, promptText(body.body));
      this.json(res, { ok: true });
      return;
    }
    const match = /^\/api\/chats\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "Not found");
    let chatId: string;
    try { chatId = decodeURIComponent(match[1]!); } catch { throw new HttpError(400, "Invalid chat id"); }
    const chat = this.store.getChat(chatId);
    if (!chat || !this.store.getProject(chat.projectId)) throw new HttpError(404, "Chat is no longer available");
    const action = match[2] ?? "";
    if (!action && method === "GET") {
      const [history, diff] = await Promise.all([this.turns.messages(chatId), this.turns.diff(chatId)]);
      const messages = history.map((message) => ({ ...message, html: messageHtml(message.text) }));
      this.json(res, { chat: this.chatView(chat), messages, queue: [...this.store.listQueuedPrompts(chatId), ...await this.turns.nativeQueue(chatId)],
        recoveries: this.store.recoveryPromptsForChat(chatId), diff });
    } else if (action === "open" && method === "POST") {
      this.store.selectChat(chatId);
      this.store.markChatOpened(chatId);
      this.json(res, { ok: true });
    } else if (action === "read" && method === "POST") {
      this.store.markChatOpened(chatId);
      this.json(res, { ok: true });
    } else if (action === "favorite" && method === "POST") {
      this.json(res, { favorite: this.store.toggleFavorite(chatId) });
    } else if (action === "stop" && method === "POST") {
      await this.turns.stop(chatId);
      this.json(res, { ok: true });
    } else if (action === "prompts" && method === "POST") {
      const text = promptText(body.text);
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(key)) throw new HttpError(400, "Missing prompt request id");
      const fingerprint = hashToken(JSON.stringify([chatId, text]));
      const claim = this.store.claimMiniAppSubmission(key, fingerprint);
      if (claim.fingerprint !== fingerprint) throw new HttpError(409, "This request id was used for another prompt");
      if (!claim.fresh) {
        if (!claim.disposition) throw new HttpError(409, "Доставка ещё не подтверждена. Проверьте переписку перед повторной отправкой.");
        this.json(res, { disposition: claim.disposition });
        return;
      }
      let disposition;
      try { disposition = await this.turns.prompt(chatId, text, key); }
      catch (error) {
        if (error instanceof PromptNotSentError) {
          this.store.releaseMiniAppSubmission(key);
          this.logger.warn({ message: error.message }, "Mini App prompt rejected before submission");
          throw new HttpError(503, "Сообщение не отправлено: не удалось открыть чат в Codex. Текст сохранён, можно повторить попытку.");
        }
        throw error;
      }
      this.store.finishMiniAppSubmission(key, disposition);
      this.store.markChatOpened(chatId);
      this.json(res, { disposition });
    } else if (/^queue\/[^/]+\/start$/.test(action) && method === "POST") {
      const id = decodeURIComponent(action.slice(6, -6));
      this.json(res, { disposition: await this.turns.startNativeQueuedNow(chatId, id) });
    } else if (action.startsWith("queue/") && ["PATCH", "DELETE"].includes(method)) {
      const id = decodeURIComponent(action.slice(6));
      if (this.turns.isNativeQueuedStarting(chatId, id)) throw new HttpError(409, "Сообщение уже отправляется. Обновите очередь.");
      const queue = await this.turns.nativeQueue(chatId);
      if (this.turns.isNativeQueuedStarting(chatId, id)) throw new HttpError(409, "Сообщение уже отправляется. Обновите очередь.");
      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) throw new HttpError(409, "Сообщение уже запущено или удалено из очереди ChatGPT");
      if (method === "DELETE") {
        const result = await this.rpc.request<{ deleted: boolean }>("thread/queue/delete", { threadId: chatId, queuedSubmissionId: id });
        if (!result.deleted) throw new HttpError(409, "Сообщение уже запущено или удалено");
      } else if (body.direction === "up" || body.direction === "down") {
        const target = index + (body.direction === "up" ? -1 : 1);
        if (target >= 0 && target < queue.length) {
          [queue[index], queue[target]] = [queue[target]!, queue[index]!];
          await this.rpc.request("thread/queue/reorder", { threadId: chatId, queuedSubmissionIds: queue.map((item) => item.id) });
        }
      } else {
        await this.rpc.request("thread/queue/update", { threadId: chatId, queuedSubmissionId: id, input: [{ type: "text", text: promptText(body.body) }] });
      }
      this.json(res, { ok: true });
    } else if (action.startsWith("diff/") && method === "GET") {
      const diff = await this.turns.diff(chatId, decodeURIComponent(action.slice(5)));
      if (!diff) throw new HttpError(404, "Diff is no longer available");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="changes.diff"');
      res.end(diff.diff);
    } else {
      const recovery = /^recoveries\/([^/]+)\/(retry|dismiss)$/.exec(action);
      if (!recovery || method !== "POST") throw new HttpError(404, "Not found");
      const turnId = decodeURIComponent(recovery[1]!);
      if (!this.store.recoveryPrompt(chatId, turnId)) throw new HttpError(409, "Recovery is no longer available");
      if (recovery[2] === "retry") this.json(res, { disposition: await this.turns.retryRecovery(chatId, turnId) });
      else { this.store.clearRecoveryPrompt(chatId, turnId); this.json(res, { ok: true }); }
    }
  }

  private chatView(chat: CodexChat) {
    return { ...chat, favorite: this.store.isFavorite(chat.id), unread: this.store.unreadCount(chat.id), queued: this.store.queueCount(chat.id), activeTurn: this.store.activeTurn(chat.id) };
  }

  private json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
}

function promptText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 12_000) throw new HttpError(400, "Prompt must contain 1–12,000 bytes of text");
  return value.trim();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "JSON required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 32_768) throw new HttpError(413, "Request too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "Invalid JSON"); }
}
