import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { ApprovalCoordinator } from "./approvals.js";
import { CodexRpcClient, CodexRpcError } from "./codex-rpc.js";
import { OutputCoalescer } from "./output.js";
import { ProjectRegistry } from "./projects.js";
import { canonicalDirectory, isInside, redact, shortId } from "./security.js";
import { StateStore } from "./store.js";
import type { CodexChat, CodexThreadSummary, RpcRequest } from "./types.js";

const SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];

export type PromptDisposition = "started" | "queued" | "queued_external" | "external_busy";

/** The failure happened before turn/start; retrying cannot duplicate a prompt. */
export class PromptNotSentError extends Error {}

export class QueueActionError extends Error {}

export interface AssistantMessageSnapshot {
  messageId: string;
  turnId: string;
  text: string;
  occurredAt: number;
}

export interface TurnLifecycleEvent {
  chatId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted" | "unknown";
}

export class TurnCoordinator {
  private readonly owned = new Set<string>();
  private readonly startingChats = new Set<string>();
  private readonly startingQueued = new Set<number>();
  private readonly startingNative = new Set<string>();
  private readonly retrying = new Set<string>();
  private draining = false;
  private lifecycleHandler: ((event: TurnLifecycleEvent) => Promise<void>) | null = null;

  constructor(
    private readonly rpc: CodexRpcClient,
    private readonly store: StateStore,
    private readonly projects: ProjectRegistry,
    private readonly output: OutputCoalescer,
    private readonly approvals: ApprovalCoordinator,
    private readonly telegramChatId: number,
    private readonly maxConcurrent: number,
    private readonly maxQueuedPerChat: number,
    private readonly logger: Logger,
  ) {
    rpc.on("notification", (method: string, params: unknown) => void this.onNotification(method, object(params)).catch((error: unknown) => logger.warn({ error, method }, "Codex notification handling failed")));
    rpc.on("request", (request: RpcRequest) => void approvals.handleRequest(request).catch((error: unknown) => {
      logger.error({ error, method: request.method }, "Codex request handling failed");
      rpc.respondError(request.id, -32603, "Telegram request handling failed");
    }));
    rpc.on("ready", () => void this.recover().catch((error: unknown) => logger.error({ error }, "Codex recovery failed")));
  }

  setLifecycleHandler(handler: (event: TurnLifecycleEvent) => Promise<void>): void {
    this.lifecycleHandler = handler;
  }

  async recover(): Promise<void> {
    const interrupted = this.store.activeTurns();
    for (const turn of interrupted) this.store.updateTurn(turn.chatId, turn.turnId, "unknown", { terminalError: "App-server connection restarted" });
    this.owned.clear();
    await this.refreshChats();
    const pending = new Map(this.store.pendingRecoveryPrompts().map((recovery) => [turnKey(recovery.chatId, recovery.turnId), recovery]));
    for (const turn of interrupted) pending.set(turnKey(turn.chatId, turn.turnId), { chatId: turn.chatId, turnId: turn.turnId, body: "", createdAt: 0, offeredAt: null });
    for (const recovery of pending.values()) await this.emitLifecycle({ chatId: recovery.chatId, turnId: recovery.turnId, status: "unknown" });
  }

  async refreshChats(): Promise<number> {
    let cursor: string | null = null;
    let count = 0;
    do {
      const response = object(await this.rpc.request("thread/list", { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds: SOURCE_KINDS }));
      for (const raw of Array.isArray(response.data) ? response.data : []) {
        const thread = raw as CodexThreadSummary;
        let canonicalCwd: string | null = null;
        try { canonicalCwd = thread.cwd ? canonicalDirectory(thread.cwd) : null; } catch { /* stale or inaccessible cwd */ }
        const project = canonicalCwd ? this.projects.resolveProjectForCwd(canonicalCwd) : null;
        if (!project) continue;
        this.store.upsertChat({
          id: thread.id,
          projectId: project.id,
          title: thread.name ?? null,
          preview: thread.preview ?? null,
          cwd: canonicalCwd!,
          sourceKind: sourceName(thread.source),
          createdAt: epochMs(thread.createdAt),
          updatedAt: epochMs(thread.updatedAt),
          status: thread.status?.type ?? "unknown",
        });
        count += 1;
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor);
    return count;
  }

  async createChat(projectId: number): Promise<CodexChat> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Project is not available");
    const cwd = this.projects.recanonicalize(project);
    const response = object(await this.rpc.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "codex_telegram_remote",
      threadSource: "codex_telegram_remote",
    }));
    const thread = object(response.thread);
    const chat: CodexChat = {
      id: String(thread.id), projectId: project.id, title: null, preview: "New chat", cwd,
      sourceKind: "appServer", createdAt: epochMs(number(thread.createdAt)), updatedAt: epochMs(number(thread.updatedAt)), status: "idle",
    };
    this.store.upsertChat(chat);
    this.store.selectChat(chat.id);
    return chat;
  }

  async prompt(chatId: string, text: string, requestId: string = randomUUID()): Promise<PromptDisposition> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new PromptNotSentError("Select an indexed chat first");
    if (this.store.activeTurn(chatId) || this.startingChats.has(chatId)) return this.enqueue(chatId, text);
    if (chat.status === "active") return this.enqueueExternal(chatId, text, requestId);
    if (this.store.activeTurns().length + this.startingChats.size >= this.maxConcurrent) return this.enqueue(chatId, text);
    const result = await this.startTurn(chat, text);
    return result === "external_busy" ? this.enqueueExternal(chatId, text, requestId) : result;
  }

  async nativeQueue(chatId: string): Promise<{ id: string; body: string; retryCount: number; native: true }[]> {
    if (!this.rpc.supportsPaginatedHistory) return [];
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const items: { id: string; body: string; retryCount: number; native: true }[] = [];
    let cursor: string | null = null;
    do {
      const response = object(await this.rpc.request("thread/queue/list", { threadId: chatId, cursor, limit: 100 }));
      for (const raw of Array.isArray(response.data) ? response.data : []) {
        const item = object(raw);
        items.push({ id: String(item.id), body: userText({ content: item.input }), retryCount: 0, native: true });
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor);
    return items;
  }

  private async enqueueExternal(chatId: string, text: string, requestId: string): Promise<PromptDisposition> {
    if (!this.rpc.supportsPaginatedHistory) return "external_busy";
    try {
      if ((await this.nativeQueue(chatId)).length >= this.maxQueuedPerChat) throw new Error("The ChatGPT queue is full");
    } catch (error) { throw new PromptNotSentError(errorMessage(error), { cause: error }); }
    // The desktop owner watches this shared queue. Never steal its writer lock or
    // apply this service's permissions to a turn executed by the desktop app.
    await this.rpc.request("thread/queue/add", { threadId: chatId, input: [{ type: "text", text }], clientUserMessageId: requestId });
    return "queued_external";
  }

  async steer(chatId: string, text: string): Promise<void> {
    const active = this.store.activeTurn(chatId);
    if (!active || !this.owned.has(turnKey(chatId, active.turnId))) throw new Error("No bot-owned turn is active in this chat");
    await this.rpc.request("turn/steer", { threadId: chatId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: active.turnId });
  }

  async stop(chatId: string): Promise<void> {
    const active = this.store.activeTurn(chatId);
    if (!active || !this.owned.has(turnKey(chatId, active.turnId))) throw new Error("No bot-owned turn is active in this chat");
    await this.rpc.request("turn/interrupt", { threadId: chatId, turnId: active.turnId });
  }

  async retryRecovery(chatId: string, turnId: string): Promise<PromptDisposition> {
    const key = turnKey(chatId, turnId);
    if (this.retrying.has(key)) throw new Error("Retry is already being submitted");
    const recovery = this.store.recoveryPrompt(chatId, turnId);
    if (!recovery) throw new Error("That recovery prompt is no longer available");
    this.retrying.add(key);
    try {
      const disposition = await this.prompt(chatId, recovery.body);
      if (disposition !== "external_busy") this.store.clearRecoveryPrompt(chatId, turnId);
      return disposition;
    } finally { this.retrying.delete(key); }
  }

  isQueuedStarting(id: number): boolean { return this.startingQueued.has(id); }

  async sendQueuedNow(id: number): Promise<"started" | "steered"> {
    const queued = this.store.getQueuedPrompt(id);
    if (!queued) throw new QueueActionError("Сообщение уже отправлено или удалено из очереди.");
    if (queued.retryCount < 0) throw new QueueActionError("Доставка этого сообщения не подтверждена. Сначала проверьте переписку — повтор может создать дубль.");
    if (this.startingQueued.has(id) || this.startingChats.has(queued.chatId)) throw new QueueActionError("Сообщение уже отправляется. Обновите очередь.");
    const chat = this.store.getChat(queued.chatId);
    if (!chat) throw new QueueActionError("Чат больше недоступен.");
    this.validateChat(chat);
    const active = this.store.activeTurn(chat.id);
    if (active && !this.owned.has(turnKey(chat.id, active.turnId))) throw new QueueActionError("Текущая работа управляется другим процессом Codex.");
    if (!active && this.store.activeTurns().length + this.startingChats.size >= this.maxConcurrent) throw new QueueActionError("Все слоты выполнения заняты. Сообщение осталось в очереди.");
    this.startingQueued.add(id);
    try {
      if (active) {
        // Persist uncertainty before sending, so a crash cannot replay this entry.
        this.store.markQueuedAmbiguous(id);
        try { await this.steer(chat.id, queued.body); }
        catch (error) {
          if (error instanceof CodexRpcError && error.code === -32600) this.store.restoreQueuedRetryCount(id, queued.retryCount);
          throw error;
        }
        this.store.deleteQueuedPrompt(id);
        return "steered";
      }
      if (await this.startTurn(chat, queued.body, id) === "external_busy") throw new QueueActionError("Чатом управляет ChatGPT на Mac. Немедленная отправка доступна в приложении; сообщение осталось в очереди.");
      return "started";
    } finally { this.startingQueued.delete(id); }
  }

  isNativeQueuedStarting(chatId: string, id: string): boolean { return this.startingNative.has(turnKey(chatId, id)); }

  async startNativeQueuedNow(chatId: string, id: string): Promise<"started"> {
    const key = turnKey(chatId, id);
    if (this.startingNative.has(key) || this.startingChats.has(chatId)) throw new QueueActionError("Сообщение уже отправляется. Обновите очередь.");
    if (this.store.activeTurn(chatId)) throw new QueueActionError("В чате уже выполняется задание. Сообщение осталось в очереди ChatGPT.");
    if (this.store.activeTurns().length + this.startingChats.size >= this.maxConcurrent) throw new QueueActionError("Все слоты выполнения заняты. Сообщение осталось в очереди.");
    this.startingNative.add(key);
    this.startingChats.add(chatId);
    try {
      const queued = (await this.nativeQueue(chatId)).find((item) => item.id === id);
      if (!queued) throw new QueueActionError("Сообщение уже отправлено или удалено из очереди ChatGPT.");
      const chat = this.store.getChat(chatId)!;
      const cwd = this.validateChat(chat);
      const fullAccess = this.store.isFullAccess(chatId);
      try {
        await this.rpc.request("thread/resume", { threadId: chatId, excludeTurns: true, cwd,
          approvalPolicy: fullAccess ? "never" : "on-request", sandbox: fullAccess ? "danger-full-access" : "workspace-write" });
      } catch (error) {
        if (error instanceof CodexRpcError && error.code === -32600 && /already has an active writer\b/.test(error.message)) {
          throw new QueueActionError("Очередью управляет ChatGPT на Mac. «Отправить сейчас» нужно нажать в приложении; сообщение осталось в очереди.");
        }
        throw error;
      }
      // Start by queue ID: the server atomically consumes it. Never copy its text
      // to turn/start, which could race the desktop consumer and duplicate it.
      const response = object(await this.rpc.request("thread/queue/start", { threadId: chatId, queuedSubmissionId: id }));
      const turnId = String(object(response.turn).id);
      this.store.startTurn(chatId, turnId, "running");
      this.store.saveRecoveryPrompt(chatId, turnId, queued.body);
      this.owned.add(turnKey(chatId, turnId));
      return "started";
    } finally { this.startingNative.delete(key); this.startingChats.delete(chatId); }
  }

  async history(chatId: string, pairs: number): Promise<string> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const turns = await this.readTurns(chatId, pairs);
    const rendered: string[] = [];
    for (const rawTurn of turns.slice(-pairs)) {
      const items = Array.isArray(object(rawTurn).items) ? object(rawTurn).items as unknown[] : [];
      const user = items.map(object).find((item) => item.type === "userMessage");
      const agent = items.map(object).filter((item) => item.type === "agentMessage").at(-1);
      rendered.push(`You: ${userText(user)}\nCodex: ${String(agent?.text ?? "(no final response)")}`);
    }
    return rendered.join("\n\n");
  }

  async messages(chatId: string): Promise<{ id: string; turnId: string; role: "user" | "assistant"; text: string; status: string }[]> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const rawTurns = await this.readTurns(chatId, 50);
    const messages: { id: string; turnId: string; role: "user" | "assistant"; text: string; status: string }[] = [];
    for (const rawTurn of (Array.isArray(rawTurns) ? rawTurns : []).slice(-50)) {
      const turn = object(rawTurn);
      for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
        const item = object(rawItem);
        if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
        messages.push({ id: String(item.id ?? messages.length), turnId: String(turn.id), role: item.type === "userMessage" ? "user" : "assistant",
          text: item.type === "userMessage" ? userText(item) : String(item.text ?? ""), status: String(turn.status ?? "unknown") });
      }
    }
    return messages;
  }

  async assistantMessages(chatId: string): Promise<AssistantMessageSnapshot[]> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const turns = await this.readTurns(chatId, 100);
    const messages: AssistantMessageSnapshot[] = [];
    for (const rawTurn of turns) {
      const turn = object(rawTurn);
      const turnId = String(turn.id ?? "");
      const occurredAt = epochMs(number(turn.completedAt) ?? number(turn.startedAt)) || chat.updatedAt;
      for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
        const item = object(rawItem);
        if (item.type !== "agentMessage") continue;
        const phase = item.phase;
        if (phase != null && phase !== "final_answer" && phase !== "finalAnswer") continue;
        const text = String(item.text ?? "").trim();
        if (!text) continue;
        messages.push({ messageId: String(item.id ?? shortId(`${turnId}:${text}`)), turnId, text, occurredAt });
      }
    }
    return messages;
  }

  private async readTurns(chatId: string, limit: number): Promise<unknown[]> {
    if (this.rpc.supportsPaginatedHistory) {
      const response = object(await this.rpc.request("thread/turns/list", { threadId: chatId, limit, sortDirection: "desc", itemsView: "full" }));
      return Array.isArray(response.data) ? response.data.reverse() : [];
    }
    const response = object(await this.rpc.request("thread/read", { threadId: chatId, includeTurns: true }));
    return Array.isArray(object(response.thread).turns) ? object(response.thread).turns as unknown[] : [];
  }

  private enqueue(chatId: string, text: string): "queued" {
    if (this.store.queueCount(chatId) >= this.maxQueuedPerChat) throw new PromptNotSentError(`This chat already has ${this.maxQueuedPerChat} queued prompts`);
    this.store.enqueuePrompt(chatId, text);
    return "queued";
  }

  private async startTurn(chat: CodexChat, text: string, queuedId?: number): Promise<"started" | "external_busy"> {
    let startRequested = false;
    this.startingChats.add(chat.id);
    if (queuedId !== undefined) this.startingQueued.add(queuedId);
    try {
      const cwd = this.validateChat(chat);
      const fullAccess = this.store.isFullAccess(chat.id);
      await this.rpc.request("thread/resume", { threadId: chat.id, ...(this.rpc.supportsPaginatedHistory ? { excludeTurns: true } : {}) });
      if (queuedId !== undefined) this.store.markQueuedAmbiguous(queuedId);
      startRequested = true;
      const response = object(await this.rpc.request("turn/start", {
        threadId: chat.id,
        input: [{ type: "text", text, text_elements: [] }],
        cwd,
        approvalPolicy: fullAccess ? "never" : "on-request",
        sandboxPolicy: fullAccess
          ? { type: "dangerFullAccess" }
          : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      }));
      const turn = object(response.turn);
      const turnId = String(turn.id);
      this.store.startTurn(chat.id, turnId, "running");
      this.store.saveRecoveryPrompt(chat.id, turnId, text);
      this.owned.add(turnKey(chat.id, turnId));
      if (queuedId !== undefined) this.store.deleteQueuedPrompt(queuedId);
      return "started";
    } catch (error) {
      if (!startRequested) {
        if (error instanceof CodexRpcError && error.code === -32600 && /already has an active writer\b/.test(error.message)) return "external_busy";
        throw new PromptNotSentError(errorMessage(error), { cause: error });
      }
      if (queuedId !== undefined) this.store.markQueuedAmbiguous(queuedId);
      throw error;
    } finally {
      this.startingChats.delete(chat.id);
      if (queuedId !== undefined) this.startingQueued.delete(queuedId);
    }
  }

  private validateChat(chat: CodexChat): string {
    const project = this.store.getProject(chat.projectId);
    if (!project) throw new Error("The chat's project is no longer allowed");
    const projectPath = this.projects.recanonicalize(project);
    const cwd = canonicalDirectory(chat.cwd);
    if (!this.projects.isAllowed(cwd) || !isInside(cwd, projectPath)) throw new Error("The chat working directory is outside its allowed canonical project");
    return cwd;
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
    while (this.store.activeTurns().length + this.startingChats.size < this.maxConcurrent) {
      const queued = this.store.listQueuedPrompts().find((item) => item.retryCount >= 0 && !this.startingQueued.has(item.id) && !this.startingChats.has(item.chatId) && !this.store.activeTurn(item.chatId) && this.store.getChat(item.chatId)?.status !== "active");
      if (!queued) break;
      const chat = this.store.getChat(queued.chatId);
      if (!chat) { this.store.deleteQueuedPrompt(queued.id); continue; }
      try {
        if (await this.startTurn(chat, queued.body, queued.id) === "external_busy") {
          if (await this.enqueueExternal(chat.id, queued.body, `telegram-queue-${queued.id}`) === "external_busy") break;
          this.store.deleteQueuedPrompt(queued.id);
        }
      }
      catch (error) {
        if (!(error instanceof PromptNotSentError)) this.store.markQueuedAmbiguous(queued.id);
        const explanation = error instanceof PromptNotSentError
          ? "A queued prompt could not be sent; it remains in the queue"
          : "A queued prompt has ambiguous delivery after a Codex error and was not replayed automatically";
        await this.output.warning(chat.id, "queued", this.telegramChatId, `${explanation}: ${redact(errorMessage(error))}`);
        break;
      }
    }
    } finally { this.draining = false; }
  }

  private async onNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const chatId = String(params.threadId ?? "");
    const turn = object(params.turn);
    const turnId = String(params.turnId ?? turn.id ?? "");

    if (method === "thread/status/changed") {
      const chat = this.store.getChat(chatId);
      if (chat) this.store.upsertChat({ ...chat, status: String(object(params.status).type ?? "unknown") });
      return;
    }
    if (method === "serverRequest/resolved") { this.approvals.resolved(params); return; }
    if (method === "turn/started" && this.startingChats.has(chatId)) {
      this.store.startTurn(chatId, turnId, "running");
      this.owned.add(turnKey(chatId, turnId));
    }
    if (!chatId || !turnId || !this.owned.has(turnKey(chatId, turnId))) return;

    if (method === "item/agentMessage/delta") this.output.agentDelta(params, this.telegramChatId);
    else if (method === "item/started") this.output.itemStarted(params, this.telegramChatId);
    else if (method === "item/completed") this.output.itemCompleted(params, this.telegramChatId);
    else if (method === "turn/plan/updated") this.output.planUpdated(params, this.telegramChatId);
    else if (method === "turn/diff/updated") this.store.replaceDiff(chatId, turnId, String(params.diff ?? ""));
    else if (method === "warning") await this.output.warning(chatId, turnId, this.telegramChatId, redact(String(params.message ?? "Codex warning")));
    else if (method === "error") await this.output.warning(chatId, turnId, this.telegramChatId, redact(String(object(params.error).message ?? "Turn error")));
    else if (method === "turn/completed") {
      await this.output.complete(params, this.telegramChatId);
      this.owned.delete(turnKey(chatId, turnId));
      const status = terminalStatus(turn.status);
      if (status === "completed") this.store.clearRecoveryPrompt(chatId, turnId);
      await this.emitLifecycle({ chatId, turnId, status });
      await this.drainQueue();
    }
  }

  private async emitLifecycle(event: TurnLifecycleEvent): Promise<void> {
    if (!this.lifecycleHandler) return;
    await this.lifecycleHandler(event).catch((error: unknown) => this.logger.warn({ error, event }, "Turn lifecycle delivery failed"));
  }
}

function turnKey(chatId: string, turnId: string): string { return `${chatId}\0${turnId}`; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function number(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function epochMs(value: number | undefined): number { return value ? (value < 10_000_000_000 ? value * 1_000 : value) : Date.now(); }
function sourceName(value: unknown): string { return typeof value === "string" ? value : value && typeof value === "object" ? Object.keys(value)[0] ?? "unknown" : "unknown"; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }

function terminalStatus(value: unknown): TurnLifecycleEvent["status"] {
  const status = typeof value === "string" ? value : String(object(value).type ?? "completed");
  return status === "failed" ? "failed" : status === "interrupted" || status === "cancelled" ? "interrupted" : "completed";
}

function userText(item: Record<string, unknown> | undefined): string {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content.map(object).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join(" ") || "(no text)";
}
