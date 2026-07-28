import type { Logger } from "pino";
import { StateStore } from "./store.js";
import { TurnCoordinator } from "./turns.js";
import type { CodexChat } from "./types.js";

export class UnreadNotificationMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: StateStore,
    private readonly turns: TurnCoordinator,
    private readonly notify: (chat: CodexChat, messages: string[]) => Promise<void>,
    private readonly logger: Logger,
    private readonly unreadDelayMs = 10_000,
    private readonly pollIntervalMs = 2_500,
  ) {}

  async start(): Promise<void> {
    for (const chat of this.store.listChats(undefined, 10_000)) {
      if (!this.store.chatWatchState(chat.id)) this.store.setChatScanned(chat.id, chat.updatedAt);
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.turns.refreshChats();
      for (const chat of this.store.listChats(undefined, 10_000)) await this.scanChangedChat(chat);
      await this.deliverDue();
    } catch (error) {
      this.logger.debug({ error }, "Unread notification poll failed");
    } finally {
      this.running = false;
    }
  }

  private async scanChangedChat(chat: CodexChat): Promise<void> {
    const state = this.store.chatWatchState(chat.id);
    if (!state) { this.store.setChatScanned(chat.id, chat.updatedAt); return; }
    if (chat.updatedAt <= state.scannedUpdatedAt) return;
    const messages = await this.turns.assistantMessages(chat.id);
    for (const message of messages) {
      if (message.occurredAt <= state.scannedUpdatedAt) continue;
      this.store.recordAssistantMessage(chat.id, message.messageId, message.turnId, message.occurredAt, this.store.isBotOwnedTurn(chat.id, message.turnId));
    }
    this.store.setChatScanned(chat.id, chat.updatedAt);
  }

  private async deliverDue(): Promise<void> {
    const pending = this.store.pendingAssistantNotifications(Date.now() - this.unreadDelayMs);
    const byChat = new Map<string, typeof pending>();
    for (const item of pending) byChat.set(item.chatId, [...(byChat.get(item.chatId) ?? []), item]);
    for (const [chatId, items] of byChat) {
      const chat = this.store.getChat(chatId);
      if (!chat) continue;
      const snapshots = await this.turns.assistantMessages(chatId);
      const bodies = new Map(snapshots.map((message) => [message.messageId, message.text]));
      const texts = items.map((item) => bodies.get(item.messageId)).filter((text): text is string => !!text);
      if (texts.length) await this.notify(chat, texts.slice(-3));
      this.store.markAssistantNotified(chatId, items.map((item) => item.messageId));
    }
  }
}
