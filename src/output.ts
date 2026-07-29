import type { Logger } from "pino";
import { StateStore } from "./store.js";
import { chunkText, diffStats } from "./text.js";
import type { CodexChat, TelegramDelivery } from "./types.js";

interface BufferState {
  chatId: string;
  turnId: string;
  telegramChatId: number;
  prefix: string;
  parts: Map<string, string>;
  plan: string | null;
  progressMessageId: number | null;
  draftId: number;
  keepAlive: NodeJS.Timeout | null;
  timer: NodeJS.Timeout | null;
  flushPromise: Promise<void> | null;
  dirty: boolean;
  lastEditAt: number;
  finalText: string | null;
}

/** A streamed draft is a 30-second ephemeral preview, so it has to be re-sent while the turn is still producing nothing new. */
const DRAFT_KEEPALIVE_MS = 20_000;

export class OutputCoalescer {
  private readonly buffers = new Map<string, BufferState>();
  private streamDrafts = true;

  constructor(private readonly store: StateStore, private readonly telegram: TelegramDelivery, private readonly logger: Logger, private readonly labelFor: (chat: CodexChat) => string) {}

  agentDelta(params: Record<string, unknown>, telegramChatId: number): void {
    const state = this.state(params, telegramChatId);
    const itemId = String(params.itemId ?? "agent");
    state.parts.set(itemId, (state.parts.get(itemId) ?? "") + String(params.delta ?? ""));
    this.schedule(state);
  }

  itemStarted(params: Record<string, unknown>, telegramChatId: number): void {
    const item = object(params.item);
    const type = String(item.type ?? "");
    const id = String(item.id ?? type);
    const state = this.state(params, telegramChatId);
    if (type === "commandExecution") state.parts.set(id, `⚙️ ${String(item.command ?? "Command")} — running`);
    if (type === "fileChange") state.parts.set(id, `📝 Proposed file changes (${Array.isArray(item.changes) ? item.changes.length : 0} files)`);
    if (type === "mcpToolCall") state.parts.set(id, `🔧 ${String(item.server ?? "tool")}/${String(item.tool ?? "call")} — running`);
    if (["commandExecution", "fileChange", "mcpToolCall"].includes(type)) this.schedule(state);
  }

  itemCompleted(params: Record<string, unknown>, telegramChatId: number): void {
    const item = object(params.item);
    const type = String(item.type ?? "");
    const id = String(item.id ?? type);
    const state = this.state(params, telegramChatId);
    if (type === "agentMessage") {
      const text = String(item.text ?? "");
      state.parts.set(id, text);
      if (item.phase === "final_answer" || item.phase === "finalAnswer") state.finalText = text;
    } else if (type === "commandExecution") {
      const status = String(item.status ?? "completed");
      const exit = item.exitCode == null ? "" : ` (exit ${String(item.exitCode)})`;
      state.parts.set(id, `⚙️ ${String(item.command ?? "Command")} — ${status}${exit}`);
      this.store.updateTurn(state.chatId, state.turnId, "running", { lastToolStatus: `${status}${exit}` });
    } else if (type === "fileChange") {
      state.parts.set(id, `📝 File changes — ${String(item.status ?? "completed")} (${Array.isArray(item.changes) ? item.changes.length : 0} files)`);
    } else if (type === "mcpToolCall") {
      state.parts.set(id, `🔧 ${String(item.server ?? "tool")}/${String(item.tool ?? "call")} — ${String(item.status ?? "completed")}`);
    }
    this.schedule(state);
  }

  planUpdated(params: Record<string, unknown>, telegramChatId: number): void {
    const state = this.state(params, telegramChatId);
    const plan = Array.isArray(params.plan) ? params.plan : [];
    state.plan = plan.map((entry) => {
      const row = object(entry);
      const marker = row.status === "completed" ? "✓" : row.status === "inProgress" ? "→" : "·";
      return `${marker} ${String(row.step ?? "")}`;
    }).join("\n");
    this.schedule(state);
  }

  async complete(params: Record<string, unknown>, telegramChatId: number): Promise<void> {
    const turn = object(params.turn);
    const enriched = { ...params, turnId: turn.id };
    const state = this.state(enriched, telegramChatId);
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.keepAlive) { clearTimeout(state.keepAlive); state.keepAlive = null; }
    if (state.flushPromise) await state.flushPromise;
    state.dirty = false;
    if (this.store.turnFinalDelivered(state.chatId, state.turnId)) { this.discard(state); return; }

    for (const raw of Array.isArray(turn.items) ? turn.items : []) {
      const item = object(raw);
      if (item.type === "agentMessage") {
        state.parts.set(String(item.id ?? "agent"), String(item.text ?? ""));
        if (item.phase === "final_answer" || item.phase === "finalAnswer") state.finalText = String(item.text ?? "");
      }
    }
    await this.flush(state);
    const status = typeof turn.status === "string" ? turn.status : String(object(turn.status).type ?? "completed");
    const error = object(turn.error).message;
    const final = state.finalText ?? [...state.parts.values()].filter((text) => !text.startsWith("⚙️") && !text.startsWith("📝") && !text.startsWith("🔧")).at(-1)
      ?? (status === "failed" ? `Turn failed: ${String(error ?? "unknown error")}` : `Turn ${status}.`);
    const diff = this.store.latestDiff(state.chatId);
    const suffix = diff?.turnId === state.turnId ? (() => { const stats = diffStats(diff.diff); return `\n\nChanged ${stats.files} files (+${stats.added}/-${stats.removed}).`; })() : "";
    const chunks = chunkText(final + suffix);
    let finalMessageId: number | null = null;
    for (const [index, chunk] of chunks.entries()) finalMessageId = await this.telegram.sendText(telegramChatId, `${state.prefix}\n${chunk}`, { idempotencyKey: `final:${state.chatId}:${state.turnId}:${index}` });
    if (finalMessageId !== null) this.store.setTurnMessage(state.chatId, state.turnId, "final", finalMessageId);
    const terminalState = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
    this.store.updateTurn(state.chatId, state.turnId, terminalState, { completedAt: Date.now(), terminalError: error == null ? null : String(error) });
    this.discard(state);
  }

  async warning(chatId: string, turnId: string, telegramChatId: number, message: string): Promise<void> {
    const chat = this.store.getChat(chatId);
    if (chat) await this.telegram.sendText(telegramChatId, `${this.labelFor(chat)}\n⚠️ ${message}`);
    this.logger.warn({ chatId, turnId }, "Codex warning delivered");
  }

  private state(params: Record<string, unknown>, telegramChatId: number): BufferState {
    const chatId = String(params.threadId ?? "");
    const turnId = String(params.turnId ?? object(params.turn).id ?? "");
    if (!chatId || !turnId) throw new Error("Turn event is missing threadId/turnId");
    const id = key(chatId, turnId);
    let state = this.buffers.get(id);
    if (!state) {
      const chat = this.store.getChat(chatId);
      if (!chat) throw new Error("Turn event references an unindexed chat");
      state = { chatId, turnId, telegramChatId, prefix: this.labelFor(chat), parts: new Map(), plan: null, progressMessageId: null, draftId: draftIdFor(turnId), keepAlive: null, timer: null, flushPromise: null, dirty: false, lastEditAt: 0, finalText: null };
      this.buffers.set(id, state);
    }
    return state;
  }

  private schedule(state: BufferState): void {
    state.dirty = true;
    if (state.timer || state.flushPromise) return;
    // Keyed off lastEditAt rather than progressMessageId: when streaming drafts there
    // is never a progress message, so the latter would disable throttling entirely.
    const delay = state.lastEditAt === 0 ? 0 : Math.max(0, 1_500 - (Date.now() - state.lastEditAt));
    state.timer = setTimeout(() => {
      state.timer = null;
      state.dirty = false;
      const operation = this.flush(state);
      state.flushPromise = operation;
      void operation.catch((error: unknown) => this.logger.warn({ error }, "Progress delivery failed")).finally(() => {
        state.flushPromise = null;
        if (state.dirty) this.schedule(state);
      });
    }, delay);
  }

  private async flush(state: BufferState): Promise<void> {
    const body = [state.plan ? `Plan\n${state.plan}` : "", ...state.parts.values()].filter(Boolean).join("\n\n");
    const chunks = chunkText(body);
    if (!chunks.length) return;

    // While the turn runs, stream into a draft: it leaves nothing behind, so the
    // turn produces exactly one persisted message instead of a progress message
    // plus a final one. Only the newest chunk is previewed; complete() still
    // delivers the whole body.
    if (this.streamDrafts && state.progressMessageId === null) {
      const tail = chunks.length > 1 ? `…\n${chunks.at(-1)!}` : chunks[0]!;
      if (await this.telegram.sendDraft(state.telegramChatId, state.draftId, `${state.prefix}\n${tail}`)) {
        state.lastEditAt = Date.now();
        this.armKeepAlive(state);
        return;
      }
      this.streamDrafts = false;
    }

    const text = `${state.prefix}\n${chunks[0]}`;
    if (state.progressMessageId === null) {
      state.progressMessageId = await this.telegram.sendText(state.telegramChatId, text);
      this.store.setTurnMessage(state.chatId, state.turnId, "progress", state.progressMessageId);
    } else await this.telegram.editText(state.telegramChatId, state.progressMessageId, text);
    for (const chunk of chunks.slice(1)) await this.telegram.sendText(state.telegramChatId, `${state.prefix}\n${chunk}`);
    state.lastEditAt = Date.now();
  }

  /** Re-sends the draft before its 30-second preview lapses, so a quiet stretch mid-turn does not blank the stream. */
  private armKeepAlive(state: BufferState): void {
    if (state.keepAlive) clearTimeout(state.keepAlive);
    state.keepAlive = setTimeout(() => {
      state.keepAlive = null;
      if (!this.buffers.has(key(state.chatId, state.turnId))) return;
      this.schedule(state);
    }, DRAFT_KEEPALIVE_MS);
    state.keepAlive.unref?.();
  }

  private discard(state: BufferState): void {
    if (state.keepAlive) { clearTimeout(state.keepAlive); state.keepAlive = null; }
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    this.buffers.delete(key(state.chatId, state.turnId));
  }
}

/** Draft ids must be non-zero, and stable across a turn so Telegram animates updates instead of stacking previews. */
export function draftIdFor(turnId: string): number {
  let hash = 0;
  for (const character of turnId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (hash & 0x7fffffff) || 1;
}

function key(chatId: string, turnId: string): string { return `${chatId}\0${turnId}`; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
