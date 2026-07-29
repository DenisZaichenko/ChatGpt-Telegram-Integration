import { Bot, GrammyError, HttpError, InputFile, Keyboard } from "grammy";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { ApprovalCoordinator } from "./approvals.js";
import { ProjectRegistry } from "./projects.js";
import { callbackToken, hashToken, redact, shortId, SlidingWindowRateLimiter, verifyPairingSecret } from "./security.js";
import { StateStore } from "./store.js";
import { chunkText, diffStats, label } from "./text.js";
import { TurnCoordinator, type TurnLifecycleEvent } from "./turns.js";
import type { CodexChat, Project, TelegramDelivery, TelegramTextOptions } from "./types.js";
import { CodexRpcClient } from "./codex-rpc.js";
import { telegramHtml } from "./telegram-format.js";

export class GrammyGateway implements TelegramDelivery {
  private draftsSupported = true;

  constructor(readonly bot: Bot, private readonly logger: Logger, private readonly store: StateStore) {}

  async sendDraft(chatId: number, draftId: number, text: string): Promise<boolean> {
    if (!this.draftsSupported) return false;
    try {
      await this.bot.api.sendMessageDraft(chatId, draftId, telegramHtml(text), { parse_mode: "HTML" });
      return true;
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes("parse entities")) {
        await this.bot.api.sendMessageDraft(chatId, draftId, text);
        return true;
      }
      if (error instanceof GrammyError && (error.error_code === 404 || /method not found|unknown method/i.test(error.description))) {
        this.draftsSupported = false;
        this.logger.warn({ description: error.description }, "Bot API rejected message drafts; falling back to edited progress messages");
        return false;
      }
      throw error;
    }
  }

  async sendText(chatId: number, text: string, options: TelegramTextOptions = {}): Promise<number> {
    const outbox = options.idempotencyKey ? this.store.prepareOutbox(options.idempotencyKey, "sendMessage", { chatId, text }) : null;
    if (outbox?.delivered && outbox.messageId !== null) return outbox.messageId;
    const body = outbox && outbox.attempts > 0 ? `${text.split("\n")[0]}\n[recovered]\n${text.split("\n").slice(1).join("\n")}` : text;
    const parseMode = options.parseMode ?? "HTML";
    const rendered = parseMode === "HTML" ? telegramHtml(body) : body;
    const message = await this.bot.api.sendMessage(chatId, rendered, {
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup as never } : {}),
      parse_mode: parseMode,
    }).catch(async (error: unknown) => {
      if (error instanceof GrammyError && error.description.includes("parse entities")) return this.bot.api.sendMessage(chatId, body, { link_preview_options: { is_disabled: true }, ...(options.replyMarkup ? { reply_markup: options.replyMarkup as never } : {}) });
      if (options.idempotencyKey && error instanceof HttpError && outbox?.attempts === 0) return { message_id: await this.sendText(chatId, text, options) } as never;
      throw error;
    });
    if (options.idempotencyKey) this.store.deliverOutbox(options.idempotencyKey, message.message_id);
    return message.message_id;
  }

  async editText(chatId: number, messageId: number, text: string, options: TelegramTextOptions = {}): Promise<void> {
    const parseMode = options.parseMode ?? "HTML";
    const rendered = parseMode === "HTML" ? telegramHtml(text) : text;
    try {
      await this.bot.api.editMessageText(chatId, messageId, rendered, { parse_mode: parseMode, link_preview_options: { is_disabled: true }, ...(options.replyMarkup ? { reply_markup: options.replyMarkup as never } : {}) });
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
      if (error instanceof GrammyError && error.description.includes("parse entities")) {
        await this.bot.api.editMessageText(chatId, messageId, text, { link_preview_options: { is_disabled: true }, ...(options.replyMarkup ? { reply_markup: options.replyMarkup as never } : {}) });
        return;
      }
      throw error;
    }
  }

  async sendDocument(chatId: number, filename: string, body: Buffer, caption: string): Promise<number> {
    const message = await this.bot.api.sendDocument(chatId, new InputFile(body, filename), { caption: telegramHtml(caption), parse_mode: "HTML" });
    return message.message_id;
  }
}

export class TelegramController {
  private readonly limiter = new SlidingWindowRateLimiter(10, 60_000);
  private accepting = true;

  constructor(
    private readonly config: Config,
    private readonly gateway: GrammyGateway,
    private readonly store: StateStore,
    private readonly registry: ProjectRegistry,
    private readonly rpc: CodexRpcClient,
    private readonly turns: TurnCoordinator,
    private readonly approvals: ApprovalCoordinator,
    private readonly logger: Logger,
  ) {
    this.installHandlers();
    this.turns.setLifecycleHandler((event) => this.onTurnLifecycle(event));
  }

  async start(): Promise<void> {
    await this.gateway.bot.api.deleteWebhook({ drop_pending_updates: false });
    await this.gateway.bot.api.setMyCommands([
      { command: "projects", description: "Choose a project" }, { command: "chats", description: "Choose a Codex chat" },
      { command: "new", description: "Create a chat" }, { command: "where", description: "Show current routing" },
      { command: "status", description: "Show turn status" }, { command: "stop", description: "Stop the current turn" },
      { command: "queue", description: "Manage queued prompts" },
      { command: "fullaccess", description: "Manage full access for this chat" },
      { command: "help", description: "Show commands" },
    ]);
    return this.gateway.bot.start({ allowed_updates: ["message", "callback_query"] });
  }

  stop(): void { this.accepting = false; this.gateway.bot.stop(); }

  private installHandlers(): void {
    const bot = this.gateway.bot;
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      const chat = ctx.chat;
      if (!from || !chat || !isAuthorizedPrivate(this.config.allowedUserId, from.id, chat.id, chat.type)) return;
      await next();
    });

    bot.on("message:text", async (ctx) => {
      try {
        const text = ctx.message.text.trim();
        if (text.startsWith("/pair")) { await this.pair(ctx.chat.id, ctx.message.message_id, text); return; }
        if (!this.store.isPaired()) { await ctx.reply("Pairing is required. Send /pair <one-time-code> in this private chat."); return; }
        if (!this.accepting) { await ctx.reply("The service is shutting down and is not accepting prompts."); return; }
        await this.routeMessage(ctx.chat.id, text);
      } catch (error) {
        await this.gateway.sendText(ctx.chat.id, `Error: ${redact(errorMessage(error))}`);
      }
    });

    bot.on("callback_query:data", async (ctx) => {
      if (!this.store.isPaired()) { await ctx.answerCallbackQuery({ text: "Pairing required" }); return; }
      const data = ctx.callbackQuery.data;
      try {
        if (data.startsWith("req:")) {
          const answer = await this.approvals.handleCallback(data, ctx.from.id, ctx.chat!.id);
          await ctx.answerCallbackQuery({ text: answer, show_alert: answer.includes("expired") });
          return;
        }
        await this.routeCallback(ctx.chat!.id, ctx.from.id, data);
        await ctx.answerCallbackQuery();
      } catch (error) {
        await ctx.answerCallbackQuery({ text: redact(errorMessage(error)).slice(0, 180), show_alert: true });
      }
    });

    bot.catch((error) => {
      const cause = error.error;
      if (cause instanceof GrammyError) this.logger.error({ code: cause.error_code, description: cause.description }, "Telegram API error");
      else if (cause instanceof HttpError) this.logger.error({ message: cause.message }, "Telegram transport error");
      else this.logger.error({ error: cause }, "Telegram update failed");
    });
  }

  private async pair(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.store.isPaired()) { await this.gateway.sendText(chatId, "Pairing is already complete."); return; }
    const secret = text.replace(/^\/pair(?:@\w+)?\s*/, "");
    if (!secret || !(await verifyPairingSecret(this.config.pairingSecretHash, secret))) {
      await this.gateway.sendText(chatId, "Invalid pairing code.");
      return;
    }
    this.store.markPaired();
    this.store.setSetting("telegram_chat_id", String(chatId));
    await this.gateway.bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
    await this.gateway.sendText(chatId, "Paired. Telegram bot chats are not end-to-end encrypted; repository-derived text sent here is visible to Telegram. Confirm your company policy permits this transfer.", { replyMarkup: mainKeyboard() });
  }

  private async routeMessage(chatId: number, text: string): Promise<void> {
    const parsed = parseCommand(text);
    if (!parsed) {
      if (await this.consumeInputMode(chatId, text)) return;
      await this.sendPrompt(chatId, text);
      return;
    }
    const [command, args] = parsed;
    switch (command) {
      case "start": await this.showStart(chatId); break;
      case "projects": await this.showProjects(chatId); break;
      case "project": await this.selectProjectAlias(chatId, args); break;
      case "chats": await this.showChats(chatId, args === "all", 0); break;
      case "find": await this.find(chatId, args); break;
      case "use": await this.useShortId(chatId, args); break;
      case "new": await this.newChat(chatId, args); break;
      case "where": await this.where(chatId); break;
      case "history": await this.history(chatId, args); break;
      case "status": await this.status(chatId); break;
      case "stop": await this.confirmStop(chatId); break;
      case "steer": await this.steer(chatId, args); break;
      case "diff": await this.diff(chatId); break;
      case "queue": await this.showQueue(chatId, args === "all", 0); break;
      case "fullaccess": await this.fullAccess(chatId, args); break;
      case "help": await this.help(chatId); break;
      default: await this.gateway.sendText(chatId, "Unknown bot command. Use /help. Bot commands are never forwarded to Codex.");
    }
  }

  private async routeCallback(chatId: number, userId: number, data: string): Promise<void> {
    const match = /^ui:([A-Za-z0-9_-]+)$/.exec(data);
    if (!match) throw new Error("Invalid or unsigned callback");
    const pending = this.store.consumePendingRequest(hashToken(match[1]!), userId, chatId);
    if (!pending || pending.kind !== "ui") throw new Error("This button expired, was already used, or belongs to another chat");
    const payload = pending.payload as { action?: unknown; value?: unknown; extra?: unknown; expectedTurnId?: unknown };
    const action = String(payload.action ?? "");
    const value = payload.value == null ? undefined : String(payload.value);
    const extra = payload.extra == null ? undefined : String(payload.extra);
    if (action === "project") {
      const project = this.store.getProject(Number(value));
      if (!project) throw new Error("Project is no longer available");
      this.store.selectProject(project.id);
      await this.showChats(chatId, false, 0);
    } else if (action === "chat" || action === "open") {
      const chat = this.store.getChat(value!);
      if (!chat) throw new Error("Chat is no longer available");
      await this.openChat(chatId, chat);
    } else if (action === "new") await this.createForProject(chatId, Number(value));
    else if (action === "chats") await this.showChats(chatId, value === "all", Number(extra ?? 0));
    else if (action === "search") {
      this.store.setInputMode({ userId, kind: "chat_search", targetId: null, expiresAt: Date.now() + 30 * 60_000, payload: {} });
      await this.gateway.sendText(chatId, "Send the text to search for. Your next non-command message will be used as the search query.");
    } else if (action === "favorite") {
      const chat = this.store.getChat(value!);
      if (!chat) throw new Error("Chat is no longer available");
      this.store.toggleFavorite(chat.id);
      const [scope, rawOffset] = (extra ?? "project:0").split(":");
      await this.showChats(chatId, scope === "all", Number(rawOffset ?? 0));
    } else if (action === "queueUp" || action === "queueDown") {
      const context = queueContext(extra);
      if (!this.store.moveQueuedPrompt(Number(value), action === "queueUp" ? "up" : "down", !context.all)) throw new Error("The prompt cannot move farther in that direction");
      await this.showQueue(chatId, context.all, context.offset);
    } else if (action === "queueEdit") {
      const queued = this.store.getQueuedPrompt(Number(value));
      if (!queued) throw new Error("Queued prompt is no longer available");
      this.store.setInputMode({ userId, kind: "queue_edit", targetId: String(queued.id), expiresAt: Date.now() + 30 * 60_000, payload: queueContext(extra) });
      await this.gateway.sendText(chatId, `Send the replacement text for queued prompt #${queued.id}. Your next non-command message will replace it.`);
    } else if (action === "queueCancel") {
      const queued = this.store.getQueuedPrompt(Number(value));
      if (!queued) throw new Error("Queued prompt is no longer available");
      this.store.deleteQueuedPrompt(queued.id);
      await this.gateway.sendText(chatId, `Cancelled queued prompt #${queued.id}.`);
      const context = queueContext(extra);
      await this.showQueue(chatId, context.all, context.offset);
    } else if (action === "queuePage") {
      await this.showQueue(chatId, value === "all", Number(extra ?? 0));
    } else if (action === "diffView" || action === "diffDownload") {
      const diff = this.store.getDiff(value!, extra!);
      const chat = this.store.getChat(value!);
      if (!diff?.diff || !chat) throw new Error("That diff is no longer available");
      if (action === "diffView") await this.sendDiffInline(chatId, chat, diff.turnId, diff.diff);
      else await this.sendDiffDocument(chatId, chat, diff.turnId, diff.diff);
    } else if (action === "recoveryRetry") {
      const chat = this.store.getChat(value!);
      if (!chat) throw new Error("Chat is no longer available");
      const result = await this.turns.retryRecovery(chat.id, extra!);
      const message = result === "started" ? "Retry started." : result === "queued" ? "Retry queued." : "The chat is active outside this bot; retry was not started.";
      await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\n${message}`);
    } else if (action === "recoveryDismiss") {
      this.store.clearRecoveryPrompt(value!, extra!);
      await this.gateway.sendText(chatId, "Recovery prompt dismissed.");
    } else if (action === "stop") {
      const chat = this.store.getChat(value!);
      if (!chat) throw new Error("Chat is no longer available");
      const active = this.store.activeTurn(chat.id);
      if (!active || active.turnId !== String(payload.expectedTurnId)) throw new Error("That turn is no longer active");
      await this.turns.stop(chat.id);
      await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nInterrupt requested.`);
    } else if (action === "enableFullAccessChat") {
      const chat = this.store.getChat(value!);
      if (!chat) throw new Error("Chat is no longer available");
      this.store.setFullAccess(chat.id, true);
      await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\n⚠️ Full access enabled. Future turns run without sandboxing or approval prompts.`);
    }
  }

  private async showStart(chatId: number): Promise<void> {
    const project = this.store.selectedProject();
    const chat = this.store.selectedChat();
    if (chat && project) await this.openChat(chatId, chat, "Codex Telegram Remote is ready.");
    else await this.gateway.sendText(chatId, "[no project / no chat]\nCodex Telegram Remote is ready.", { replyMarkup: mainKeyboard() });
  }

  private async showProjects(chatId: number): Promise<void> {
    const selected = this.store.selectedProject();
    const projects = this.store.listProjects();
    const buttons = projects.map((project) => [this.uiButton(chatId, `${project.id === selected?.id ? "✓ " : ""}${project.alias} · ${abbreviate(project.canonicalPath)} · ${this.store.listChats(project.id, 10_000).length} chats`, "project", project.id)]);
    await this.gateway.sendText(chatId, "Projects", { replyMarkup: { inline_keyboard: buttons } });
  }

  private async selectProjectAlias(chatId: number, alias: string): Promise<void> {
    const project = this.store.getProjectByAlias(alias);
    if (!project) throw new Error("Unknown project alias. Use /projects.");
    this.store.selectProject(project.id);
    await this.showChats(chatId, false, 0);
  }

  private async showChats(chatId: number, all: boolean, offset: number): Promise<void> {
    await this.turns.refreshChats();
    const project = this.store.selectedProject();
    if (!all && !project) { await this.showProjects(chatId); return; }
    const chats = this.store.listChats(all ? undefined : project!.id, 10, Math.max(0, offset));
    const lines = chats.map((chat, index) => `${index + 1}. ${chatIndicators(chat, this.store)}${chat.title || truncate(chat.preview || "Untitled", 55)} · ${shortId(chat.id)} · ${this.store.getProject(chat.projectId)?.alias ?? "?"} · ${displayStatus(chat, this.store)}`);
    const buttons: { text: string; callback_data: string }[][] = [[this.uiButton(chatId, "🔎 Search chats", "search")]];
    for (const [index, chat] of chats.entries()) buttons.push([
      this.uiButton(chatId, `${chatIndicators(chat, this.store)}${index + 1}. ${truncate(chat.title || chat.preview || shortId(chat.id), 40)}`, "chat", chat.id),
      this.uiButton(chatId, this.store.isFavorite(chat.id) ? "★" : "☆", "favorite", chat.id, `${all ? "all" : "project"}:${offset}`),
    ]);
    if (!all && project) buttons.push([this.uiButton(chatId, "＋ New chat", "new", project.id)]);
    const nav: { text: string; callback_data: string }[] = [];
    if (offset > 0) nav.push(this.uiButton(chatId, "Previous", "chats", all ? "all" : "project", Math.max(0, offset - 10)));
    if (chats.length === 10) nav.push(this.uiButton(chatId, "Next", "chats", all ? "all" : "project", offset + 10));
    if (nav.length) buttons.push(nav);
    await this.gateway.sendText(chatId, `${project ? `[${project.alias}] ` : ""}Chats\n${lines.join("\n") || "No chats yet."}`, { replyMarkup: { inline_keyboard: buttons } });
  }

  private async find(chatId: number, query: string): Promise<void> {
    if (!query) throw new Error("Usage: /find <text>");
    const q = query.toLowerCase();
    const projects = this.store.listProjects().filter((project) => project.alias.includes(q) || project.canonicalPath.toLowerCase().includes(q));
    const chats = this.store.findChats(query);
    const buttons = [
      [this.uiButton(chatId, "🔎 Search again", "search")],
      ...projects.map((project) => [this.uiButton(chatId, `Project: ${project.alias}`, "project", project.id)]),
      ...chats.map((chat) => [
        this.uiButton(chatId, `${chatIndicators(chat, this.store)}Chat: ${truncate(chat.title || chat.preview || shortId(chat.id), 37)}`, "chat", chat.id),
        this.uiButton(chatId, this.store.isFavorite(chat.id) ? "★" : "☆", "favorite", chat.id, "all:0"),
      ]),
    ];
    await this.gateway.sendText(chatId, `Search results: ${projects.length + chats.length}`, { replyMarkup: { inline_keyboard: buttons } });
  }

  private async useShortId(chatId: number, id: string): Promise<void> {
    const matches = this.store.resolveShortId(id);
    if (matches.length !== 1) {
      const buttons = matches.map((chat) => [this.uiButton(chatId, `${this.store.getProject(chat.projectId)?.alias}: ${truncate(chat.title || chat.preview || chat.id, 40)}`, "chat", chat.id)]);
      await this.gateway.sendText(chatId, matches.length ? "That id is ambiguous. Select a chat:" : "No matching chat.", { replyMarkup: { inline_keyboard: buttons } });
      return;
    }
    await this.openChat(chatId, matches[0]!);
  }

  private async newChat(chatId: number, alias: string): Promise<void> {
    const project = alias ? this.store.getProjectByAlias(alias) : this.store.selectedProject();
    if (!project) { await this.showProjects(chatId); return; }
    await this.createForProject(chatId, project.id);
  }

  private async createForProject(chatId: number, projectId: number): Promise<void> {
    const chat = await this.turns.createChat(projectId);
    this.store.markChatOpened(chat.id);
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nNew chat created and selected.`);
  }

  private async where(chatId: number): Promise<void> {
    const project = this.store.selectedProject();
    const chat = this.store.selectedChat();
    if (!project || !chat) { await this.gateway.sendText(chatId, "No project/chat selected. Use /projects and /chats."); return; }
    const active = this.store.activeTurn(chat.id);
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nProject: ${project.canonicalPath}\nChat id: ${chat.id}\nWorking directory: ${chat.cwd}\nTurn: ${active?.state ?? "idle"}`);
  }

  private async history(chatId: number, raw: string): Promise<void> {
    const chat = this.requireSelectedChat();
    this.store.markChatOpened(chat.id);
    const pairs = raw ? Number(raw) : 3;
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error("History count must be 1–10");
    const history = await this.turns.history(chat.id, pairs);
    for (const chunk of chunkText(history || "No history.")) await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\n${chunk}`);
  }

  private async status(chatId: number): Promise<void> {
    const chat = this.store.selectedChat();
    const active = chat ? this.store.activeTurn(chat.id) : null;
    const elapsed = active ? `${Math.floor((Date.now() - active.startedAt) / 1000)}s` : "—";
    await this.gateway.sendText(chatId, `${chat ? this.chatLabel(chat) : "[no project / no chat]"}\nCodex: ${this.rpc.ready ? "ready" : "degraded"}\nTurn: ${active?.state ?? "idle"}\nAccess: ${chat && this.store.isFullAccess(chat.id) ? "FULL (unsandboxed)" : "workspace-write"}\nElapsed: ${elapsed}\nQueued: ${chat ? this.store.queueCount(chat.id) : this.store.queueCount()}\nLast tool: ${active?.lastToolStatus ?? "—"}`);
  }

  private async confirmStop(chatId: number): Promise<void> {
    const chat = this.requireSelectedChat();
    const active = this.store.activeTurn(chat.id);
    if (!active) throw new Error("No bot-owned turn is active");
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nStop the active turn?`, { replyMarkup: { inline_keyboard: [[this.uiButton(chatId, "Stop turn", "stop", chat.id, undefined, active.turnId)]] } });
  }

  private async steer(chatId: number, text: string): Promise<void> {
    if (!text) throw new Error("Usage: /steer <text>");
    const chat = this.requireSelectedChat();
    await this.turns.steer(chat.id, text);
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nSteering sent.`);
  }

  private async diff(chatId: number): Promise<void> {
    const chat = this.requireSelectedChat();
    const latest = this.store.latestDiff(chat.id);
    if (!latest?.diff) throw new Error("No captured diff for this chat");
    await this.sendDiffActions(chatId, chat, latest.turnId, latest.diff);
  }

  private async showQueue(chatId: number, all: boolean, offset: number): Promise<void> {
    const selected = this.store.selectedChat();
    if (!all && !selected) throw new Error("No chat selected. Use /queue all or select a chat.");
    const queued = this.store.listQueuedPrompts(all ? undefined : selected!.id);
    const pageSize = 10;
    const safeOffset = Math.max(0, Math.min(offset, Math.floor(Math.max(queued.length - 1, 0) / pageSize) * pageSize));
    const visible = queued.slice(safeOffset, safeOffset + pageSize);
    const lines = visible.map((item, index) => {
      const chat = this.store.getChat(item.chatId);
      return `${safeOffset + index + 1}. #${item.id} ${chat ? this.chatLabel(chat) : `[${shortId(item.chatId)}]`}\n${truncate(item.body.replace(/\s+/g, " "), 140)}`;
    });
    const context = `${all ? "all" : "chat"}:${safeOffset}`;
    const buttons = visible.map((item) => [
      this.uiButton(chatId, "↑", "queueUp", item.id, context),
      this.uiButton(chatId, "↓", "queueDown", item.id, context),
      this.uiButton(chatId, "Edit", "queueEdit", item.id, context),
      this.uiButton(chatId, "Cancel", "queueCancel", item.id, context),
    ]);
    const nav: { text: string; callback_data: string }[] = [];
    if (safeOffset > 0) nav.push(this.uiButton(chatId, "Previous", "queuePage", all ? "all" : "chat", safeOffset - pageSize));
    if (safeOffset + pageSize < queued.length) nav.push(this.uiButton(chatId, "Next", "queuePage", all ? "all" : "chat", safeOffset + pageSize));
    if (nav.length) buttons.push(nav);
    const suffix = queued.length > pageSize ? `\nShowing ${safeOffset + 1}–${safeOffset + visible.length} of ${queued.length}.` : "";
    await this.gateway.sendText(chatId, `${all ? "All queued prompts" : `${this.chatLabel(selected!)} queued prompts`}\n${lines.join("\n\n") || "Queue is empty."}${suffix}`, { replyMarkup: { inline_keyboard: buttons } });
  }

  private async fullAccess(chatId: number, raw: string): Promise<void> {
    const chat = this.requireSelectedChat();
    const action = raw.trim().toLowerCase();
    if (action === "off") {
      this.store.setFullAccess(chat.id, false);
      await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nFull access disabled. Future turns use workspace-write with approvals.`);
      return;
    }
    if (action === "on") {
      await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\n⚠️ Full access removes filesystem and network sandboxing and disables approval prompts for future turns in this chat. Codex will run with your macOS user permissions.`, {
        replyMarkup: { inline_keyboard: [[this.uiButton(chatId, "Confirm full access", "enableFullAccessChat", chat.id)]] },
      });
      return;
    }
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nFull access is ${this.store.isFullAccess(chat.id) ? "ENABLED" : "disabled"}.\nUse /fullaccess on or /fullaccess off.`);
  }

  private async help(chatId: number): Promise<void> {
    const chat = this.store.selectedChat();
    await this.gateway.sendText(chatId, `${chat ? this.chatLabel(chat) : "[no project / no chat]"}\n/projects · /chats [all] · /find <text> · /use <id> · /new [project]\n/where · /history [1-10] · /status · /queue [all] · /stop · /steer <text> · /diff · /fullaccess on|off\nPlain text starts a turn, or queues the next turn when busy.`);
  }

  private async consumeInputMode(chatId: number, text: string): Promise<boolean> {
    const mode = this.store.inputMode(this.config.allowedUserId);
    if (!mode) return false;
    this.store.clearInputMode(this.config.allowedUserId);
    if (mode.kind === "chat_search") {
      await this.find(chatId, text);
      return true;
    }
    const id = Number(mode.targetId);
    if (!Number.isInteger(id) || !this.store.getQueuedPrompt(id)) throw new Error("Queued prompt is no longer available");
    if (Buffer.byteLength(text, "utf8") > 12_000) throw new Error("Prompt exceeds the 12,000-byte limit");
    if (!this.store.updateQueuedPrompt(id, text)) throw new Error("Queued prompt is no longer available");
    await this.gateway.sendText(chatId, `Updated queued prompt #${id}.`);
    const context = object(mode.payload);
    await this.showQueue(chatId, context.all === true, Number(context.offset ?? 0));
    return true;
  }

  private async sendPrompt(chatId: number, text: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > 12_000) throw new Error("Prompt exceeds the 12,000-byte limit");
    if (!this.limiter.take(chatId)) throw new Error("Prompt rate limit exceeded; wait a minute.");
    const chat = this.requireSelectedChat();
    this.store.markChatOpened(chat.id);
    const result = await this.turns.prompt(chat.id, text);
    const message = result === "started" ? "Working…" : result === "queued" ? "Queued as the next turn." : "This chat appears active in Codex App. Wait for it to finish and refresh /chats; simultaneous control is unsupported.";
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\n${message}`);
  }

  private requireSelectedChat(): CodexChat {
    const chat = this.store.selectedChat();
    if (!chat) throw new Error("No chat selected. Use /chats or New chat.");
    return chat;
  }

  private chatLabel(chat: CodexChat): string {
    return label(this.store.getProject(chat.projectId)?.alias ?? "unknown", chat.title || truncate(chat.preview || shortId(chat.id), 28));
  }

  async sendUnreadNotification(chat: CodexChat, messages: string[]): Promise<void> {
    const preview = messages.map((message) => truncate(message, 1_000)).join("\n\n—\n\n");
    await this.gateway.sendText(this.config.allowedUserId, `${this.chatLabel(chat)}\nNew unread Codex message${messages.length > 1 ? "s" : ""}:\n\n${preview}`, {
      replyMarkup: { inline_keyboard: [[this.uiButton(this.config.allowedUserId, "Open chat", "open", chat.id)]] },
    });
  }

  private async onTurnLifecycle(event: TurnLifecycleEvent): Promise<void> {
    const chat = this.store.getChat(event.chatId);
    if (!chat) return;
    const diff = this.store.getDiff(event.chatId, event.turnId);
    if (diff?.diff) await this.sendDiffActions(this.config.allowedUserId, chat, event.turnId, diff.diff);
    if (event.status === "completed") return;
    const recovery = this.store.recoveryPrompt(event.chatId, event.turnId);
    if (!recovery) return;
    const state = event.status === "unknown" ? "Turn state is unknown after reconnecting." : event.status === "interrupted" ? "Turn was interrupted." : "Turn failed.";
    await this.gateway.sendText(this.config.allowedUserId, `${this.chatLabel(chat)}\n⚠️ ${state} You can retry the original prompt or dismiss it.`, {
      replyMarkup: { inline_keyboard: [[
        this.uiButton(this.config.allowedUserId, "Retry prompt", "recoveryRetry", event.chatId, event.turnId),
        this.uiButton(this.config.allowedUserId, "Dismiss", "recoveryDismiss", event.chatId, event.turnId),
      ]] },
    });
    this.store.markRecoveryOffered(event.chatId, event.turnId);
  }

  private async sendDiffActions(chatId: number, chat: CodexChat, turnId: string, diff: string): Promise<void> {
    const stats = diffStats(diff);
    await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nDiff: ${stats.files} files (+${stats.added}/-${stats.removed})`, {
      replyMarkup: { inline_keyboard: [[
        this.uiButton(chatId, "View diff", "diffView", chat.id, turnId),
        this.uiButton(chatId, "Download .diff", "diffDownload", chat.id, turnId),
      ]] },
    });
  }

  private async sendDiffInline(chatId: number, chat: CodexChat, turnId: string, diff: string): Promise<void> {
    const stats = diffStats(diff);
    for (const chunk of chunkText(diff)) await this.gateway.sendText(chatId, `${this.chatLabel(chat)}\nDiff ${shortId(turnId)} · ${stats.files} files (+${stats.added}/-${stats.removed})\n\n${chunk}`);
  }

  private async sendDiffDocument(chatId: number, chat: CodexChat, turnId: string, diff: string): Promise<void> {
    const stats = diffStats(diff);
    await this.gateway.sendDocument(chatId, `${shortId(chat.id)}-${shortId(turnId)}.diff`, Buffer.from(diff), `${this.chatLabel(chat)} ${stats.files} files (+${stats.added}/-${stats.removed})`);
  }

  private async openChat(telegramChatId: number, chat: CodexChat, heading = "Selected."): Promise<void> {
    this.store.selectChat(chat.id);
    this.store.markChatOpened(chat.id);
    await this.gateway.sendText(telegramChatId, `${this.chatLabel(chat)}\n${heading}`, { replyMarkup: mainKeyboard() });
    const history = await this.turns.history(chat.id, 3);
    for (const chunk of chunkText(history || "No messages yet.")) await this.gateway.sendText(telegramChatId, `${this.chatLabel(chat)}\nRecent messages\n\n${chunk}`);
  }

  private uiButton(chatId: number, text: string, action: string, value?: string | number, extra?: string | number, expectedTurnId?: string): { text: string; callback_data: string } {
    const token = callbackToken();
    this.store.addPendingRequest({
      tokenHash: token.hash, rpcRequestId: `ui:${token.hash}`, telegramChatId: chatId, userId: this.config.allowedUserId,
      chatId: this.store.selectedChat()?.id ?? "", turnId: expectedTurnId ?? "", kind: "ui",
      expiresAt: Date.now() + 60 * 60_000, usedAt: null, payload: { action, value, extra, expectedTurnId },
    });
    return { text, callback_data: `ui:${token.raw}` };
  }
}

function mainKeyboard(): Keyboard {
  return new Keyboard().text("/projects").text("/chats").row().text("/queue").text("/status").row().text("/stop").resized().persistent();
}

export function parseCommand(text: string): [string, string] | null {
  const match = /^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  return match ? [match[1]!.toLowerCase(), (match[2] ?? "").trim()] : null;
}

export function isAuthorizedPrivate(allowedUserId: number, fromId: number, chatId: number, chatType: string): boolean {
  return fromId === allowedUserId && chatType === "private" && chatId === fromId;
}

function abbreviate(value: string): string { const parts = value.split("/").filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value; }
function truncate(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function displayStatus(chat: CodexChat, store: StateStore): string { const turn = store.activeTurn(chat.id); return turn ? `${turn.state}${store.queueCount(chat.id) ? ` +${store.queueCount(chat.id)} queued` : ""}` : chat.status === "active" ? "unknown/external" : "idle"; }
function chatIndicators(chat: CodexChat, store: StateStore): string {
  const favorite = store.isFavorite(chat.id) ? "★ " : "";
  const running = store.activeTurn(chat.id) || chat.status === "active" ? "▶ " : "";
  const unread = store.unreadCount(chat.id);
  const waiting = store.queueCount(chat.id);
  return `${favorite}${running}${unread ? `●${unread} ` : ""}${waiting ? `⏳${waiting} ` : ""}`;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function queueContext(value: string | undefined): { all: boolean; offset: number } {
  const [scope, rawOffset] = (value ?? "chat:0").split(":");
  const offset = Number(rawOffset ?? 0);
  return { all: scope === "all", offset: Number.isFinite(offset) ? Math.max(0, offset) : 0 };
}
