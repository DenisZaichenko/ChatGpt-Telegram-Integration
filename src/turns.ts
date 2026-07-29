import type { Logger } from "pino";
import { ApprovalCoordinator } from "./approvals.js";
import { CodexRpcClient } from "./codex-rpc.js";
import { OutputCoalescer } from "./output.js";
import { ProjectRegistry } from "./projects.js";
import { canonicalDirectory, isInside, redact, shortId } from "./security.js";
import { StateStore } from "./store.js";
import type { CodexChat, CodexThreadSummary, RpcRequest } from "./types.js";

const SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];

export type PromptDisposition = "started" | "queued" | "external_busy";

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

  async prompt(chatId: string, text: string): Promise<PromptDisposition> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Select an indexed chat first");
    if (this.store.activeTurn(chatId)) return this.enqueue(chatId, text);
    if (chat.status === "active") return "external_busy";
    if (this.store.activeTurns().length >= this.maxConcurrent) return this.enqueue(chatId, text);
    await this.startTurn(chat, text);
    return "started";
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
    const recovery = this.store.recoveryPrompt(chatId, turnId);
    if (!recovery) throw new Error("That recovery prompt is no longer available");
    this.store.clearRecoveryPrompt(chatId, turnId);
    return this.prompt(chatId, recovery.body);
  }

  async history(chatId: string, pairs: number): Promise<string> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const response = object(await this.rpc.request("thread/read", { threadId: chatId, includeTurns: true }));
    const turns = Array.isArray(object(response.thread).turns) ? object(response.thread).turns as unknown[] : [];
    const rendered: string[] = [];
    for (const rawTurn of turns.slice(-pairs)) {
      const items = Array.isArray(object(rawTurn).items) ? object(rawTurn).items as unknown[] : [];
      const user = items.map(object).find((item) => item.type === "userMessage");
      const agent = items.map(object).filter((item) => item.type === "agentMessage").at(-1);
      rendered.push(`You: ${userText(user)}\nCodex: ${String(agent?.text ?? "(no final response)")}`);
    }
    return rendered.join("\n\n");
  }

  async assistantMessages(chatId: string): Promise<AssistantMessageSnapshot[]> {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.validateChat(chat);
    const response = object(await this.rpc.request("thread/read", { threadId: chatId, includeTurns: true }));
    const turns = Array.isArray(object(response.thread).turns) ? object(response.thread).turns as unknown[] : [];
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

  private enqueue(chatId: string, text: string): "queued" {
    if (this.store.queueCount(chatId) >= this.maxQueuedPerChat) throw new Error(`This chat already has ${this.maxQueuedPerChat} queued prompts`);
    this.store.enqueuePrompt(chatId, text);
    return "queued";
  }

  private async startTurn(chat: CodexChat, text: string, queuedId?: number): Promise<void> {
    const cwd = this.validateChat(chat);
    const fullAccess = this.store.isFullAccess(chat.id);
    this.startingChats.add(chat.id);
    try {
      await this.rpc.request("thread/resume", { threadId: chat.id });
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
    } catch (error) {
      if (queuedId !== undefined) this.store.markQueuedAmbiguous(queuedId);
      throw error;
    } finally {
      this.startingChats.delete(chat.id);
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
    while (this.store.activeTurns().length < this.maxConcurrent) {
      const queued = this.store.nextQueuedPrompt();
      if (!queued) break;
      const chat = this.store.getChat(queued.chatId);
      if (!chat) { this.store.deleteQueuedPrompt(queued.id); continue; }
      try { await this.startTurn(chat, queued.body, queued.id); }
      catch (error) {
        await this.output.warning(chat.id, "queued", this.telegramChatId, `A queued prompt has ambiguous delivery after a Codex error and was not replayed automatically: ${redact(errorMessage(error))}`);
        break;
      }
    }
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
