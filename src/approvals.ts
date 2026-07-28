import type { Logger } from "pino";
import { CodexRpcClient } from "./codex-rpc.js";
import { callbackToken, hashToken, redact } from "./security.js";
import { StateStore, type PendingRequest } from "./store.js";
import type { RpcRequest, TelegramDelivery } from "./types.js";

interface Button { text: string; callback_data: string }
export const SESSION_APPROVAL_LABEL = "Allow for session";

export class ApprovalCoordinator {
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rpc: CodexRpcClient,
    private readonly store: StateStore,
    private readonly telegram: TelegramDelivery,
    private readonly telegramChatId: number,
    private readonly allowedUserId: number,
    private readonly expiryMs: number,
    private readonly labelForChat: (chatId: string) => string,
    private readonly logger: Logger,
  ) {}

  start(): void { this.expiryTimer = setInterval(() => void this.expire(), 10_000); }
  stop(): void { if (this.expiryTimer) clearInterval(this.expiryTimer); }

  async handleRequest(request: RpcRequest): Promise<void> {
    const params = object(request.params);
    const chatId = String(params.threadId ?? "");
    const turnId = String(params.turnId ?? "");
    const active = this.store.activeTurn(chatId);
    if (!active || active.turnId !== turnId) {
      this.rpc.respondError(request.id, -32000, "The Telegram client does not own this turn");
      return;
    }
    this.store.updateTurn(chatId, turnId, "waiting_approval");
    if (request.method === "item/tool/requestUserInput") await this.renderQuestions(request, params);
    else await this.renderApproval(request, params);
  }

  async handleCallback(data: string, userId: number, telegramChatId: number): Promise<string> {
    const match = /^req:([A-Za-z0-9_-]+)$/.exec(data);
    if (!match) return "Invalid action";
    const pending = this.store.consumePendingRequest(hashToken(match[1]!), userId, telegramChatId);
    if (!pending) return "This action expired, was already used, or belongs to another chat.";
    const payload = object(pending.payload);
    const action = String(payload.action ?? "decline");

    if (pending.kind === "userInput") {
      this.store.recordRequestAnswer(pending.rpcRequestId, String(payload.questionId), String(payload.answer));
      const answers = this.store.requestAnswers(pending.rpcRequestId);
      const expected = Array.isArray(payload.expectedQuestionIds) ? payload.expectedQuestionIds.map(String) : [];
      if (!expected.every((id) => id in answers)) return "Answer recorded. Choose the remaining answer(s).";
      this.rpc.respond(pending.rpcRequestId, { answers });
      this.store.markRpcRequestUsed(pending.rpcRequestId);
      this.store.updateTurn(pending.chatId, pending.turnId, "running");
      return "Answers sent.";
    }

    if (action === "requestFullAccess") {
      const token = callbackToken();
      this.store.addPendingRequest({
        tokenHash: token.hash,
        rpcRequestId: pending.rpcRequestId,
        telegramChatId: pending.telegramChatId,
        userId: pending.userId,
        chatId: pending.chatId,
        turnId: pending.turnId,
        kind: pending.kind,
        expiresAt: pending.expiresAt,
        usedAt: null,
        payload: { action: "enableFullAccess", permissions: payload.permissions },
      });
      await this.telegram.sendText(telegramChatId, `${this.labelForChat(pending.chatId)}\n⚠️ Full access removes filesystem and network sandboxing for future turns in this chat and disables approval prompts. Codex will run with your macOS user permissions.`, {
        replyMarkup: { inline_keyboard: [[
          { text: "Confirm full access", callback_data: `req:${token.raw}` },
          this.pendingButton("Cancel", pending, { action: "decline", permissions: payload.permissions }),
        ]] },
      });
      return "Confirmation required.";
    }

    if (action === "cancel") {
      this.rpc.respond(pending.rpcRequestId, approvalDecision(pending.kind, "cancel", payload));
      this.store.markRpcRequestUsed(pending.rpcRequestId);
      await this.interrupt(pending);
      return "Turn cancelled.";
    }
    const decision = action === "enableFullAccess" ? "acceptForSession" : action;
    this.rpc.respond(pending.rpcRequestId, approvalDecision(pending.kind, decision, payload));
    if (action === "enableFullAccess") this.store.setFullAccess(pending.chatId, true);
    this.store.markRpcRequestUsed(pending.rpcRequestId);
    this.store.updateTurn(pending.chatId, pending.turnId, "running");
    return action === "accept" ? "Allowed once."
      : action === "acceptForSession" ? "Allowed for this Codex session."
      : action === "enableFullAccess" ? "Full access enabled for future turns in this chat."
      : "Declined.";
  }

  resolved(params: Record<string, unknown>): void {
    if (typeof params.requestId === "string" || typeof params.requestId === "number") this.store.markRpcRequestUsed(params.requestId);
  }

  private async renderApproval(request: RpcRequest, params: Record<string, unknown>): Promise<void> {
    const chatId = String(params.threadId);
    const turnId = String(params.turnId);
    const kind = kindForMethod(request.method);
    const description = describeRequest(request.method, params);
    const canElevate = ["command", "file", "permissions"].includes(kind);
    const buttons: Button[][] = [[this.createButton("Allow once", request, kind, chatId, turnId, "accept", params)]];
    if (canElevate) buttons.push([
      this.createButton(SESSION_APPROVAL_LABEL, request, kind, chatId, turnId, "acceptForSession", params),
      this.createButton("Enable full access…", request, kind, chatId, turnId, "requestFullAccess", params),
    ]);
    buttons.push([
      this.createButton("Decline", request, kind, chatId, turnId, "decline", params),
      this.createButton("Cancel turn", request, kind, chatId, turnId, "cancel", params),
    ]);
    await this.telegram.sendText(this.telegramChatId, `${this.labelForChat(chatId)}\nApproval required: ${description}\nExpires in ${Math.round(this.expiryMs / 60_000)} minutes.`, { replyMarkup: { inline_keyboard: buttons } });
  }

  private async renderQuestions(request: RpcRequest, params: Record<string, unknown>): Promise<void> {
    const chatId = String(params.threadId);
    const turnId = String(params.turnId);
    const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
    if (!questions.length || questions.some((question) => !Array.isArray(question.options) || question.isSecret === true)) {
      this.rpc.respond(request.id, { answers: {} });
      this.store.updateTurn(chatId, turnId, "running");
      await this.telegram.sendText(this.telegramChatId, `${this.labelForChat(chatId)}\nA Codex question could not be represented safely on Telegram and was left unanswered.`);
      return;
    }
    const expectedQuestionIds = questions.map((question) => String(question.id));
    for (const question of questions) {
      const buttons = (question.options as unknown[]).map((option) => {
        const row = object(option);
        const token = this.makePending(request, "userInput", chatId, turnId, { action: "answer", questionId: String(question.id), answer: String(row.label), expectedQuestionIds });
        return [{ text: String(row.label).slice(0, 50), callback_data: `req:${token}` }];
      });
      await this.telegram.sendText(this.telegramChatId, `${this.labelForChat(chatId)}\n${String(question.header ?? "Question")}: ${redact(String(question.question ?? ""))}`, { replyMarkup: { inline_keyboard: buttons } });
    }
  }

  private createButton(text: string, request: RpcRequest, kind: string, chatId: string, turnId: string, action: string, params: Record<string, unknown>): Button {
    const raw = this.makePending(request, kind, chatId, turnId, { action, permissions: params.permissions });
    return { text, callback_data: `req:${raw}` };
  }

  private makePending(request: RpcRequest, kind: string, chatId: string, turnId: string, payload: unknown): string {
    const token = callbackToken();
    this.store.addPendingRequest({ tokenHash: token.hash, rpcRequestId: request.id, telegramChatId: this.telegramChatId, userId: this.allowedUserId, chatId, turnId, kind, expiresAt: Date.now() + this.expiryMs, usedAt: null, payload });
    return token.raw;
  }

  private pendingButton(text: string, pending: PendingRequest, payload: unknown): Button {
    const token = callbackToken();
    this.store.addPendingRequest({ ...pending, tokenHash: token.hash, usedAt: null, payload });
    return { text, callback_data: `req:${token.raw}` };
  }

  private async expire(): Promise<void> {
    const resolved = new Set<string>();
    for (const pending of this.store.expiredPendingRequests()) {
      if (pending.kind === "ui") { this.store.markPendingUsed(pending.tokenHash); continue; }
      const requestKey = JSON.stringify(pending.rpcRequestId);
      if (resolved.has(requestKey)) continue;
      resolved.add(requestKey);
      try {
        if (pending.kind === "userInput") await this.interrupt(pending);
        else this.rpc.respond(pending.rpcRequestId, approvalDecision(pending.kind, "decline", {}));
      } catch (error) { this.logger.warn({ error, kind: pending.kind }, "Failed to resolve expired request"); }
      this.store.markRpcRequestUsed(pending.rpcRequestId);
      await this.telegram.sendText(this.telegramChatId, `${this.labelForChat(pending.chatId)}\nApproval or question expired; the request was declined.`).catch(() => undefined);
    }
  }

  private async interrupt(pending: PendingRequest): Promise<void> {
    await this.rpc.request("turn/interrupt", { threadId: pending.chatId, turnId: pending.turnId }).catch(() => undefined);
  }
}

export function approvalDecision(kind: string, action: string, payload: Record<string, unknown>): unknown {
  if (kind === "permissions") return action === "accept" || action === "acceptForSession"
    ? { permissions: object(payload.permissions), scope: action === "acceptForSession" ? "session" : "turn" }
    : { permissions: {}, scope: "turn" };
  if (kind === "elicitation") return { action: action === "accept" ? "accept" : action === "cancel" ? "cancel" : "decline", content: null };
  return { decision: action };
}

function kindForMethod(method: string): string {
  if (method.includes("commandExecution")) return "command";
  if (method.includes("fileChange")) return "file";
  if (method.includes("permissions")) return "permissions";
  if (method.includes("elicitation")) return "elicitation";
  return "unknown";
}

function describeRequest(method: string, params: Record<string, unknown>): string {
  const reason = params.reason ? `\nreason: ${redact(String(params.reason))}` : "";
  if (method.includes("commandExecution")) return `run command\ncwd: ${redact(String(params.cwd ?? ""))}\ncommand: ${redact(String(params.command ?? "(see Codex item)"))}${reason}`;
  if (method.includes("fileChange")) return `apply file changes${reason}`;
  if (method.includes("permissions")) return `grant temporary permissions\ncwd: ${redact(String(params.cwd ?? ""))}${reason}`;
  if (method.includes("elicitation")) return `MCP confirmation\n${redact(String(params.message ?? ""))}`;
  return `Codex action${reason}`;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
