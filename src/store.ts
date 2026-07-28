import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActiveTurn, CodexChat, JsonRpcId, Project, TurnState } from "./types.js";
import { shortId } from "./security.js";

interface ProjectRow {
  id: number;
  canonical_path: string;
  alias: string;
  source: Project["source"];
  enabled: number;
  last_used_at: number | null;
}

interface ChatRow {
  id: string;
  project_id: number;
  title: string | null;
  preview: string | null;
  cwd: string;
  source_kind: string;
  created_at: number;
  updated_at: number;
  status: string;
}

interface QueueRow {
  id: number;
  chat_id: string;
  body: string;
  created_at: number;
  retry_count: number;
  position: number;
}

export interface PendingRequest {
  tokenHash: string;
  rpcRequestId: JsonRpcId;
  telegramChatId: number;
  userId: number;
  chatId: string;
  turnId: string;
  kind: string;
  expiresAt: number;
  usedAt: number | null;
  payload: unknown;
}

export interface QueuedPrompt {
  id: number;
  chatId: string;
  body: string;
  createdAt: number;
  retryCount: number;
  position: number;
}

export interface TelegramInputMode {
  userId: number;
  kind: "queue_edit" | "chat_search";
  targetId: string | null;
  expiresAt: number;
  payload: unknown;
}

export interface RecoveryPrompt {
  chatId: string;
  turnId: string;
  body: string;
  createdAt: number;
  offeredAt: number | null;
}

export interface PendingAssistantNotification {
  chatId: string;
  messageId: string;
  turnId: string;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* created after first write on some platforms */ }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    fs.chmodSync(filename, 0o600);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO settings(key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        alias TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        allowed_parent TEXT,
        last_used_at INTEGER,
        last_refreshed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_chat_selections (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        chat_id TEXT,
        selected_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_chats (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT,
        preview TEXT,
        cwd TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_refreshed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS codex_chats_project_updated ON codex_chats(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS turns (
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        bot_owned INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        last_tool_status TEXT,
        progress_message_id INTEGER,
        final_message_id INTEGER,
        final_delivered INTEGER NOT NULL DEFAULT 0,
        terminal_error TEXT,
        PRIMARY KEY(chat_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS prompt_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS prompt_queue_order ON prompt_queue(created_at, id);

      CREATE TABLE IF NOT EXISTS pending_requests (
        token_hash TEXT PRIMARY KEY,
        rpc_request_id TEXT NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        telegram_method TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        telegram_message_id INTEGER,
        delivered_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS request_answers (
        rpc_request_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        PRIMARY KEY(rpc_request_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS diffs (
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        unified_diff TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS chat_watch_state (
        chat_id TEXT PRIMARY KEY,
        scanned_updated_at INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS assistant_message_receipts (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        discovered_at INTEGER NOT NULL,
        read_at INTEGER,
        notified_at INTEGER,
        PRIMARY KEY(chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS assistant_message_unread ON assistant_message_receipts(read_at, notified_at, occurred_at);

      CREATE TABLE IF NOT EXISTS chat_access_settings (
        chat_id TEXT PRIMARY KEY,
        full_access INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_queue_positions (
        prompt_id INTEGER PRIMARY KEY REFERENCES prompt_queue(id) ON DELETE CASCADE,
        position INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_queue_position_order ON prompt_queue_positions(position, prompt_id);

      CREATE TABLE IF NOT EXISTS chat_preferences (
        chat_id TEXT PRIMARY KEY,
        favorite INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_input_modes (
        user_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id TEXT,
        expires_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_recovery (
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        prompt_body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        offered_at INTEGER,
        PRIMARY KEY(chat_id, turn_id)
      );
    `);
    this.db.exec(`INSERT OR IGNORE INTO prompt_queue_positions(prompt_id,position) SELECT id,id FROM prompt_queue;`);
  }

  close(): void { this.db.close(); }

  getSetting(key: string): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  isPaired(): boolean { return this.getSetting("paired") === "1"; }
  markPaired(): void { this.setSetting("paired", "1"); }

  isFullAccess(chatId: string): boolean {
    const row = this.db.prepare("SELECT full_access FROM chat_access_settings WHERE chat_id=?").get(chatId) as { full_access: number } | undefined;
    return !!row?.full_access;
  }

  setFullAccess(chatId: string, enabled: boolean): void {
    this.db.prepare(`INSERT INTO chat_access_settings(chat_id,full_access,updated_at) VALUES (?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET full_access=excluded.full_access,updated_at=excluded.updated_at`).run(chatId, enabled ? 1 : 0, Date.now());
  }

  upsertProject(canonicalPath: string, alias: string, source: Project["source"], allowedParent?: string): Project {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO projects(canonical_path,alias,source,allowed_parent,last_refreshed_at)
      VALUES (@canonicalPath,@alias,@source,@allowedParent,@now)
      ON CONFLICT(canonical_path) DO UPDATE SET source=excluded.source, allowed_parent=excluded.allowed_parent,
        enabled=1, last_refreshed_at=excluded.last_refreshed_at
    `).run({ canonicalPath, alias, source, allowedParent: allowedParent ?? null, now });
    return this.getProjectByPath(canonicalPath)!;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT id,canonical_path,alias,source,enabled,last_used_at FROM projects WHERE enabled=1 ORDER BY COALESCE(last_used_at,0) DESC, alias").all() as ProjectRow[]).map(mapProject);
  }

  getProject(id: number): Project | null {
    const row = this.db.prepare("SELECT id,canonical_path,alias,source,enabled,last_used_at FROM projects WHERE id=? AND enabled=1").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  getProjectByAlias(alias: string): Project | null {
    const row = this.db.prepare("SELECT id,canonical_path,alias,source,enabled,last_used_at FROM projects WHERE alias=? AND enabled=1").get(alias) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  getProjectByPath(canonicalPath: string): Project | null {
    const row = this.db.prepare("SELECT id,canonical_path,alias,source,enabled,last_used_at FROM projects WHERE canonical_path=? AND enabled=1").get(canonicalPath) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  selectProject(projectId: number): void {
    this.db.transaction(() => {
      this.setSetting("selected_project_id", String(projectId));
      this.db.prepare("UPDATE projects SET last_used_at=? WHERE id=?").run(Date.now(), projectId);
      const selection = this.db.prepare("SELECT chat_id FROM project_chat_selections WHERE project_id=?").get(projectId) as { chat_id: string | null } | undefined;
      if (selection?.chat_id && this.getChat(selection.chat_id)) this.setSetting("selected_chat_id", selection.chat_id);
      else this.setSetting("selected_chat_id", "");
    })();
  }

  selectedProject(): Project | null {
    const id = Number(this.getSetting("selected_project_id"));
    return Number.isFinite(id) ? this.getProject(id) : null;
  }

  selectChat(chatId: string): void {
    const chat = this.getChat(chatId);
    if (!chat) throw new Error("Chat is not indexed");
    this.db.transaction(() => {
      this.selectProject(chat.projectId);
      this.setSetting("selected_chat_id", chatId);
      this.db.prepare(`INSERT INTO project_chat_selections(project_id,chat_id,selected_at) VALUES (?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET chat_id=excluded.chat_id,selected_at=excluded.selected_at`).run(chat.projectId, chatId, Date.now());
    })();
  }

  selectedChat(): CodexChat | null {
    const id = this.getSetting("selected_chat_id");
    return id ? this.getChat(id) : null;
  }

  upsertChat(chat: CodexChat): void {
    this.db.prepare(`INSERT INTO codex_chats(id,project_id,title,preview,cwd,source_kind,created_at,updated_at,status,last_refreshed_at)
      VALUES (@id,@projectId,@title,@preview,@cwd,@sourceKind,@createdAt,@updatedAt,@status,@now)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,preview=excluded.preview,
      cwd=excluded.cwd,source_kind=excluded.source_kind,updated_at=excluded.updated_at,status=excluded.status,last_refreshed_at=excluded.last_refreshed_at`)
      .run({ ...chat, now: Date.now() });
  }

  getChat(id: string): CodexChat | null {
    const row = this.db.prepare("SELECT * FROM codex_chats WHERE id=?").get(id) as ChatRow | undefined;
    return row ? mapChat(row) : null;
  }

  listChats(projectId?: number, limit = 10, offset = 0): CodexChat[] {
    const rows = projectId === undefined
      ? this.db.prepare("SELECT c.* FROM codex_chats c LEFT JOIN chat_preferences p ON p.chat_id=c.id ORDER BY COALESCE(p.favorite,0) DESC,c.updated_at DESC LIMIT ? OFFSET ?").all(limit, offset)
      : this.db.prepare("SELECT c.* FROM codex_chats c LEFT JOIN chat_preferences p ON p.chat_id=c.id WHERE c.project_id=? ORDER BY COALESCE(p.favorite,0) DESC,c.updated_at DESC LIMIT ? OFFSET ?").all(projectId, limit, offset);
    return (rows as ChatRow[]).map(mapChat);
  }

  findChats(query: string, limit = 20): CodexChat[] {
    return (this.db.prepare(`SELECT * FROM codex_chats WHERE title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`)
      .all(...Array(3).fill(`%${escapeLike(query)}%`), limit) as ChatRow[]).map(mapChat);
  }

  resolveShortId(short: string): CodexChat[] {
    return this.listChats(undefined, 10_000).filter((chat) => chat.id.startsWith(short) || shortId(chat.id) === short.toLowerCase());
  }

  isFavorite(chatId: string): boolean {
    const row = this.db.prepare("SELECT favorite FROM chat_preferences WHERE chat_id=?").get(chatId) as { favorite: number } | undefined;
    return !!row?.favorite;
  }

  toggleFavorite(chatId: string): boolean {
    const next = !this.isFavorite(chatId);
    this.db.prepare(`INSERT INTO chat_preferences(chat_id,favorite,updated_at) VALUES (?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET favorite=excluded.favorite,updated_at=excluded.updated_at`).run(chatId, next ? 1 : 0, Date.now());
    return next;
  }

  unreadCount(chatId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) count FROM assistant_message_receipts WHERE chat_id=? AND read_at IS NULL").get(chatId) as { count: number };
    return Number(row.count);
  }

  startTurn(chatId: string, turnId: string, state: TurnState = "running"): void {
    this.db.prepare(`INSERT INTO turns(chat_id,turn_id,bot_owned,state,started_at) VALUES (?,?,1,?,?)
      ON CONFLICT(chat_id,turn_id) DO UPDATE SET state=excluded.state`).run(chatId, turnId, state, Date.now());
  }

  updateTurn(chatId: string, turnId: string, state: TurnState, values: { lastToolStatus?: string | null; terminalError?: string | null; completedAt?: number } = {}): void {
    this.db.prepare(`UPDATE turns SET state=@state,last_tool_status=COALESCE(@lastToolStatus,last_tool_status),
      terminal_error=COALESCE(@terminalError,terminal_error),completed_at=COALESCE(@completedAt,completed_at)
      WHERE chat_id=@chatId AND turn_id=@turnId`).run({ chatId, turnId, state, lastToolStatus: values.lastToolStatus ?? null, terminalError: values.terminalError ?? null, completedAt: values.completedAt ?? null });
  }

  setTurnMessage(chatId: string, turnId: string, kind: "progress" | "final", messageId: number): void {
    const column = kind === "progress" ? "progress_message_id" : "final_message_id";
    this.db.prepare(`UPDATE turns SET ${column}=?, final_delivered=CASE WHEN ?='final' THEN 1 ELSE final_delivered END WHERE chat_id=? AND turn_id=?`).run(messageId, kind, chatId, turnId);
  }

  turnFinalDelivered(chatId: string, turnId: string): boolean {
    const row = this.db.prepare("SELECT final_delivered FROM turns WHERE chat_id=? AND turn_id=?").get(chatId, turnId) as { final_delivered: number } | undefined;
    return !!row?.final_delivered;
  }

  activeTurn(chatId: string): ActiveTurn | null {
    const row = this.db.prepare(`SELECT chat_id,turn_id,state,started_at,last_tool_status,final_delivered FROM turns
      WHERE chat_id=? AND bot_owned=1 AND state IN ('starting','running','waiting_approval') ORDER BY started_at DESC LIMIT 1`).get(chatId) as {
        chat_id: string; turn_id: string; state: TurnState; started_at: number; last_tool_status: string | null; final_delivered: number;
      } | undefined;
    return row ? { chatId: row.chat_id, turnId: row.turn_id, state: row.state, startedAt: row.started_at, lastToolStatus: row.last_tool_status, finalDelivered: !!row.final_delivered } : null;
  }

  activeTurns(): ActiveTurn[] {
    return this.listChats(undefined, 10_000).map((chat) => this.activeTurn(chat.id)).filter((turn): turn is ActiveTurn => !!turn);
  }

  markActiveTurnsUnknown(reason: string): void {
    this.db.prepare(`UPDATE turns SET state='unknown',terminal_error=? WHERE bot_owned=1 AND state IN ('starting','running','waiting_approval')`).run(reason);
  }

  isBotOwnedTurn(chatId: string, turnId: string): boolean {
    const row = this.db.prepare("SELECT bot_owned FROM turns WHERE chat_id=? AND turn_id=?").get(chatId, turnId) as { bot_owned: number } | undefined;
    return !!row?.bot_owned;
  }

  chatWatchState(chatId: string): { scannedUpdatedAt: number; lastOpenedAt: number } | null {
    const row = this.db.prepare("SELECT scanned_updated_at,last_opened_at FROM chat_watch_state WHERE chat_id=?").get(chatId) as { scanned_updated_at: number; last_opened_at: number } | undefined;
    return row ? { scannedUpdatedAt: row.scanned_updated_at, lastOpenedAt: row.last_opened_at } : null;
  }

  setChatScanned(chatId: string, updatedAt: number): void {
    this.db.prepare(`INSERT INTO chat_watch_state(chat_id,scanned_updated_at,last_opened_at) VALUES (?,?,0)
      ON CONFLICT(chat_id) DO UPDATE SET scanned_updated_at=excluded.scanned_updated_at`).run(chatId, updatedAt);
  }

  markChatOpened(chatId: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO chat_watch_state(chat_id,scanned_updated_at,last_opened_at) VALUES (?,0,?)
        ON CONFLICT(chat_id) DO UPDATE SET last_opened_at=excluded.last_opened_at`).run(chatId, now);
      this.db.prepare("UPDATE assistant_message_receipts SET read_at=COALESCE(read_at,?) WHERE chat_id=?").run(now, chatId);
    })();
  }

  recordAssistantMessage(chatId: string, messageId: string, turnId: string, occurredAt: number, forceRead = false, now = Date.now()): boolean {
    const openedAt = this.chatWatchState(chatId)?.lastOpenedAt ?? 0;
    const readAt = forceRead || occurredAt <= openedAt ? now : null;
    const result = this.db.prepare(`INSERT OR IGNORE INTO assistant_message_receipts(chat_id,message_id,turn_id,occurred_at,discovered_at,read_at)
      VALUES (?,?,?,?,?,?)`).run(chatId, messageId, turnId, occurredAt, now, readAt);
    return result.changes > 0;
  }

  pendingAssistantNotifications(cutoff: number): PendingAssistantNotification[] {
    return (this.db.prepare(`SELECT chat_id,message_id,turn_id FROM assistant_message_receipts
      WHERE read_at IS NULL AND notified_at IS NULL AND occurred_at<=? ORDER BY occurred_at`).all(cutoff) as { chat_id: string; message_id: string; turn_id: string }[])
      .map((row) => ({ chatId: row.chat_id, messageId: row.message_id, turnId: row.turn_id }));
  }

  markAssistantNotified(chatId: string, messageIds: readonly string[], now = Date.now()): void {
    const statement = this.db.prepare("UPDATE assistant_message_receipts SET notified_at=? WHERE chat_id=? AND message_id=? AND read_at IS NULL");
    this.db.transaction(() => { for (const messageId of messageIds) statement.run(now, chatId, messageId); })();
  }

  enqueuePrompt(chatId: string, body: string): number {
    return this.db.transaction(() => {
      const id = Number(this.db.prepare("INSERT INTO prompt_queue(chat_id,body,created_at) VALUES (?,?,?)").run(chatId, body, Date.now()).lastInsertRowid);
      const row = this.db.prepare("SELECT COALESCE(MAX(position),0)+1 position FROM prompt_queue_positions").get() as { position: number };
      this.db.prepare("INSERT INTO prompt_queue_positions(prompt_id,position) VALUES (?,?)").run(id, row.position);
      return id;
    })();
  }

  queueCount(chatId?: string): number {
    const row = chatId ? this.db.prepare("SELECT COUNT(*) count FROM prompt_queue WHERE chat_id=?").get(chatId) : this.db.prepare("SELECT COUNT(*) count FROM prompt_queue").get();
    return Number((row as { count: number }).count);
  }

  nextQueuedPrompt(onlyIdle = true): QueuedPrompt | null {
    const sql = onlyIdle
      ? `SELECT q.*,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE q.retry_count>=0 AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.chat_id=q.chat_id AND t.state IN ('starting','running','waiting_approval')) ORDER BY o.position,q.id LIMIT 1`
      : "SELECT q.*,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE q.retry_count>=0 ORDER BY o.position,q.id LIMIT 1";
    const row = this.db.prepare(sql).get() as QueueRow | undefined;
    return row ? mapQueuedPrompt(row) : null;
  }

  deleteQueuedPrompt(id: number): void { this.db.prepare("DELETE FROM prompt_queue WHERE id=?").run(id); }
  markQueuedAmbiguous(id: number): void { this.db.prepare("UPDATE prompt_queue SET retry_count=-1 WHERE id=?").run(id); }

  getQueuedPrompt(id: number): QueuedPrompt | null {
    const row = this.db.prepare("SELECT q.*,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE q.id=?").get(id) as QueueRow | undefined;
    return row ? mapQueuedPrompt(row) : null;
  }

  listQueuedPrompts(chatId?: string): QueuedPrompt[] {
    const rows = chatId
      ? this.db.prepare("SELECT q.*,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE q.chat_id=? ORDER BY o.position,q.id").all(chatId)
      : this.db.prepare("SELECT q.*,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id ORDER BY o.position,q.id").all();
    return (rows as QueueRow[]).map(mapQueuedPrompt);
  }

  updateQueuedPrompt(id: number, body: string): boolean {
    return this.db.prepare("UPDATE prompt_queue SET body=? WHERE id=?").run(body, id).changes > 0;
  }

  moveQueuedPrompt(id: number, direction: "up" | "down", withinChat = false): boolean {
    const current = this.getQueuedPrompt(id);
    if (!current) return false;
    const chatFilter = withinChat ? "q.chat_id=? AND " : "";
    const sql = direction === "up"
      ? `SELECT q.id,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE ${chatFilter}o.position<? ORDER BY o.position DESC LIMIT 1`
      : `SELECT q.id,o.position FROM prompt_queue q JOIN prompt_queue_positions o ON o.prompt_id=q.id WHERE ${chatFilter}o.position>? ORDER BY o.position LIMIT 1`;
    const adjacent = this.db.prepare(sql).get(...(withinChat ? [current.chatId, current.position] : [current.position])) as { id: number; position: number } | undefined;
    if (!adjacent) return false;
    this.db.transaction(() => {
      this.db.prepare("UPDATE prompt_queue_positions SET position=? WHERE prompt_id=?").run(adjacent.position, current.id);
      this.db.prepare("UPDATE prompt_queue_positions SET position=? WHERE prompt_id=?").run(current.position, adjacent.id);
    })();
    return true;
  }

  setInputMode(mode: TelegramInputMode): void {
    this.db.prepare(`INSERT INTO telegram_input_modes(user_id,kind,target_id,expires_at,payload) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,target_id=excluded.target_id,expires_at=excluded.expires_at,payload=excluded.payload`)
      .run(mode.userId, mode.kind, mode.targetId, mode.expiresAt, JSON.stringify(mode.payload));
  }

  inputMode(userId: number, now = Date.now()): TelegramInputMode | null {
    const row = this.db.prepare("SELECT * FROM telegram_input_modes WHERE user_id=? AND expires_at>?").get(userId, now) as { user_id: number; kind: TelegramInputMode["kind"]; target_id: string | null; expires_at: number; payload: string } | undefined;
    if (!row) { this.clearInputMode(userId); return null; }
    return { userId: row.user_id, kind: row.kind, targetId: row.target_id, expiresAt: row.expires_at, payload: JSON.parse(row.payload) as unknown };
  }

  clearInputMode(userId: number): void { this.db.prepare("DELETE FROM telegram_input_modes WHERE user_id=?").run(userId); }

  saveRecoveryPrompt(chatId: string, turnId: string, body: string): void {
    this.db.prepare(`INSERT INTO turn_recovery(chat_id,turn_id,prompt_body,created_at) VALUES (?,?,?,?)
      ON CONFLICT(chat_id,turn_id) DO UPDATE SET prompt_body=excluded.prompt_body`).run(chatId, turnId, body, Date.now());
  }

  recoveryPrompt(chatId: string, turnId: string): RecoveryPrompt | null {
    const row = this.db.prepare("SELECT * FROM turn_recovery WHERE chat_id=? AND turn_id=?").get(chatId, turnId) as { chat_id: string; turn_id: string; prompt_body: string; created_at: number; offered_at: number | null } | undefined;
    return row ? { chatId: row.chat_id, turnId: row.turn_id, body: row.prompt_body, createdAt: row.created_at, offeredAt: row.offered_at } : null;
  }

  pendingRecoveryPrompts(): RecoveryPrompt[] {
    const rows = this.db.prepare(`SELECT r.* FROM turn_recovery r JOIN turns t ON t.chat_id=r.chat_id AND t.turn_id=r.turn_id
      WHERE r.offered_at IS NULL AND t.state IN ('failed','interrupted','unknown') ORDER BY r.created_at`).all() as { chat_id: string; turn_id: string; prompt_body: string; created_at: number; offered_at: number | null }[];
    return rows.map((row) => ({ chatId: row.chat_id, turnId: row.turn_id, body: row.prompt_body, createdAt: row.created_at, offeredAt: row.offered_at }));
  }

  markRecoveryOffered(chatId: string, turnId: string): void { this.db.prepare("UPDATE turn_recovery SET offered_at=? WHERE chat_id=? AND turn_id=?").run(Date.now(), chatId, turnId); }
  clearRecoveryPrompt(chatId: string, turnId: string): void { this.db.prepare("DELETE FROM turn_recovery WHERE chat_id=? AND turn_id=?").run(chatId, turnId); }

  addPendingRequest(request: PendingRequest): void {
    this.db.prepare(`INSERT INTO pending_requests(token_hash,rpc_request_id,telegram_chat_id,user_id,chat_id,turn_id,kind,expires_at,used_at,payload)
      VALUES (@tokenHash,@rpcRequestId,@telegramChatId,@userId,@chatId,@turnId,@kind,@expiresAt,@usedAt,@payload)`)
      .run({ ...request, rpcRequestId: JSON.stringify(request.rpcRequestId), payload: JSON.stringify(request.payload) });
  }

  consumePendingRequest(tokenHash: string, userId: number, telegramChatId: number, now = Date.now()): PendingRequest | null {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM pending_requests WHERE token_hash=? AND user_id=? AND telegram_chat_id=? AND used_at IS NULL AND expires_at>?").get(tokenHash, userId, telegramChatId, now) as Record<string, unknown> | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE pending_requests SET used_at=? WHERE token_hash=? AND used_at IS NULL").run(now, tokenHash);
      return mapPending(row);
    });
    return transaction();
  }

  expiredPendingRequests(now = Date.now()): PendingRequest[] {
    return (this.db.prepare("SELECT * FROM pending_requests WHERE used_at IS NULL AND expires_at<=?").all(now) as Record<string, unknown>[]).map(mapPending);
  }

  markPendingUsed(tokenHash: string): void { this.db.prepare("UPDATE pending_requests SET used_at=? WHERE token_hash=? AND used_at IS NULL").run(Date.now(), tokenHash); }

  markRpcRequestUsed(rpcRequestId: JsonRpcId): void {
    const storedId = JSON.stringify(rpcRequestId);
    this.db.prepare("UPDATE pending_requests SET used_at=? WHERE rpc_request_id=? AND used_at IS NULL").run(Date.now(), storedId);
    this.db.prepare("DELETE FROM request_answers WHERE rpc_request_id=?").run(storedId);
  }

  recordRequestAnswer(rpcRequestId: JsonRpcId, questionId: string, answer: string): void {
    const storedId = JSON.stringify(rpcRequestId);
    this.db.prepare(`INSERT INTO request_answers(rpc_request_id,question_id,answer) VALUES (?,?,?)
      ON CONFLICT(rpc_request_id,question_id) DO UPDATE SET answer=excluded.answer`).run(storedId, questionId, answer);
  }

  requestAnswers(rpcRequestId: JsonRpcId): Record<string, { answers: string[] }> {
    const rows = this.db.prepare("SELECT question_id,answer FROM request_answers WHERE rpc_request_id=?").all(JSON.stringify(rpcRequestId)) as { question_id: string; answer: string }[];
    return Object.fromEntries(rows.map((row) => [row.question_id, { answers: [row.answer] }]));
  }

  replaceDiff(chatId: string, turnId: string, diff: string): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO diffs(chat_id,turn_id,unified_diff,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(chat_id,turn_id) DO UPDATE SET unified_diff=excluded.unified_diff,updated_at=excluded.updated_at`).run(chatId, turnId, diff, now, now);
  }

  latestDiff(chatId: string): { turnId: string; diff: string } | null {
    const row = this.db.prepare("SELECT turn_id,unified_diff FROM diffs WHERE chat_id=? ORDER BY updated_at DESC LIMIT 1").get(chatId) as { turn_id: string; unified_diff: string } | undefined;
    return row ? { turnId: row.turn_id, diff: row.unified_diff } : null;
  }

  getDiff(chatId: string, turnId: string): { turnId: string; diff: string } | null {
    const row = this.db.prepare("SELECT turn_id,unified_diff FROM diffs WHERE chat_id=? AND turn_id=?").get(chatId, turnId) as { turn_id: string; unified_diff: string } | undefined;
    return row ? { turnId: row.turn_id, diff: row.unified_diff } : null;
  }

  prune(): void {
    const weekAgo = Date.now() - 7 * 86_400_000;
    this.db.prepare("DELETE FROM diffs WHERE updated_at<?").run(weekAgo);
    this.db.prepare(`DELETE FROM diffs WHERE rowid IN (SELECT rowid FROM diffs ORDER BY updated_at DESC LIMIT -1 OFFSET 10)`).run();
    this.db.prepare("DELETE FROM outbox WHERE delivered_at IS NOT NULL AND delivered_at<?").run(Date.now() - 86_400_000);
    this.db.prepare("DELETE FROM pending_requests WHERE used_at IS NOT NULL AND used_at<?").run(Date.now() - 86_400_000);
  }

  prepareOutbox(idempotencyKey: string, method: string, payload: unknown): { attempts: number; messageId: number | null; delivered: boolean } {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(idempotency_key,telegram_method,payload,state,attempt_count,next_attempt_at) VALUES (?,?,?,'pending',0,?)`)
      .run(idempotencyKey, method, JSON.stringify(payload), Date.now());
    const row = this.db.prepare("SELECT attempt_count,telegram_message_id,state FROM outbox WHERE idempotency_key=?").get(idempotencyKey) as { attempt_count: number; telegram_message_id: number | null; state: string };
    if (row.state !== "delivered") this.db.prepare("UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=? WHERE idempotency_key=?").run(Date.now(), idempotencyKey);
    return { attempts: row.attempt_count, messageId: row.telegram_message_id, delivered: row.state === "delivered" };
  }

  deliverOutbox(idempotencyKey: string, messageId: number): void {
    this.db.prepare("UPDATE outbox SET state='delivered',telegram_message_id=?,delivered_at=?,payload='{}' WHERE idempotency_key=?").run(messageId, Date.now(), idempotencyKey);
  }
}

function mapProject(row: ProjectRow): Project {
  return { id: row.id, canonicalPath: row.canonical_path, alias: row.alias, source: row.source, enabled: !!row.enabled, lastUsedAt: row.last_used_at };
}

function mapChat(row: ChatRow): CodexChat {
  return { id: row.id, projectId: row.project_id, title: row.title, preview: row.preview, cwd: row.cwd, sourceKind: row.source_kind, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status };
}

function mapPending(row: Record<string, unknown>): PendingRequest {
  return { tokenHash: String(row.token_hash), rpcRequestId: JSON.parse(String(row.rpc_request_id)) as JsonRpcId, telegramChatId: Number(row.telegram_chat_id), userId: Number(row.user_id), chatId: String(row.chat_id), turnId: String(row.turn_id), kind: String(row.kind), expiresAt: Number(row.expires_at), usedAt: row.used_at == null ? null : Number(row.used_at), payload: JSON.parse(String(row.payload)) as unknown };
}

function mapQueuedPrompt(row: QueueRow): QueuedPrompt {
  return { id: row.id, chatId: row.chat_id, body: row.body, createdAt: row.created_at, retryCount: row.retry_count, position: row.position };
}

function escapeLike(input: string): string { return input.replace(/[\\%_]/g, "\\$&"); }
