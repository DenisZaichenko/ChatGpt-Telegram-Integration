export type JsonRpcId = number | string;

export interface RpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface Project {
  id: number;
  canonicalPath: string;
  alias: string;
  source: "explicit" | "alias" | "discovered" | "chat";
  enabled: boolean;
  lastUsedAt: number | null;
}

export interface CodexChat {
  id: string;
  projectId: number;
  title: string | null;
  preview: string | null;
  cwd: string;
  sourceKind: string;
  createdAt: number;
  updatedAt: number;
  status: string;
}

export type TurnState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export interface ActiveTurn {
  chatId: string;
  turnId: string;
  state: TurnState;
  startedAt: number;
  lastToolStatus: string | null;
  finalDelivered: boolean;
}

export interface TelegramDelivery {
  sendText(chatId: number, text: string, options?: TelegramTextOptions): Promise<number>;
  editText(chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void>;
  sendDocument(chatId: number, filename: string, body: Buffer, caption: string): Promise<number>;
}

export interface TelegramTextOptions {
  replyMarkup?: unknown;
  parseMode?: "MarkdownV2" | "HTML";
  idempotencyKey?: string;
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  source?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string; activeFlags?: string[] };
}
