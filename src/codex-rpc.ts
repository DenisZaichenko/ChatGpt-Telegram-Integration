import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { JsonRpcId, RpcRequest, RpcResponse } from "./types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

const BACKOFF_SECONDS = [1, 2, 5, 10, 30];
const execFileAsync = promisify(execFile);
export const TESTED_CODEX_VERSION = { major: 0, minor: 145, minimumPatch: 0 } as const;
const TESTED_CODEX_RANGE = `>=${TESTED_CODEX_VERSION.major}.${TESTED_CODEX_VERSION.minor}.${TESTED_CODEX_VERSION.minimumPatch} <${TESTED_CODEX_VERSION.major}.${TESTED_CODEX_VERSION.minor + 1}.0`;

export class CodexRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  private stopping = false;
  private initialized = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config, private readonly logger: Logger, private readonly version: string) { super(); }

  async start(): Promise<void> {
    this.stopping = false;
    await this.checkVersion();
    await this.spawnAndInitialize();
  }

  get ready(): boolean { return this.initialized && !!this.child; }

  async request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.child || !this.initialized) throw new Error("Codex app-server is unavailable");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.child) throw new Error("Codex app-server is unavailable");
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (!this.child) throw new Error("Codex app-server is unavailable");
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (!this.child) return;
    this.write({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.rejectPending(new Error("Codex app-server stopped"));
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private async spawnAndInitialize(): Promise<void> {
    const child = spawn(this.config.codexBin, ["app-server", "--listen", "stdio://"], {
      env: childEnvironment(this.config),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.initialized = false;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => appendRotatingLog(path.join(this.config.dataDir, "app-server.stderr.log"), chunk));
    child.once("error", (error) => this.onChildFailure(error));
    child.once("exit", (code, signal) => this.onChildFailure(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`)));

    try {
      const initialize = this.requestBeforeInitialized("initialize", {
        clientInfo: { name: "codex_telegram_remote", title: "Codex Telegram Remote", version: this.version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      await initialize;
      this.write({ method: "initialized", params: {} });
      this.initialized = true;
      await this.request("thread/list", { limit: 1, sourceKinds: ["cli", "vscode", "appServer", "unknown"] });
      this.failures = 0;
      this.emit("ready");
      this.logger.info("Codex app-server ready");
    } catch (error) {
      if (this.child === child) child.kill("SIGTERM");
      throw error;
    }
  }

  private async checkVersion(): Promise<void> {
    const { stdout } = await execFileAsync(this.config.codexBin, ["--version"], { env: childEnvironment(this.config), timeout: 10_000 });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!match) throw new Error("Unable to parse Codex CLI version");
    const [, major, minor, patch] = match.map(Number);
    if (major !== TESTED_CODEX_VERSION.major || minor !== TESTED_CODEX_VERSION.minor || patch! < TESTED_CODEX_VERSION.minimumPatch) {
      throw new Error(`Unsupported Codex CLI ${major}.${minor}.${patch}; tested range is ${TESTED_CODEX_RANGE}`);
    }
  }

  private requestBeforeInitialized(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("Codex app-server did not start"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex initialization timed out")); }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("Codex app-server stdin is unavailable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch {
      this.logger.warn({ bytes: Buffer.byteLength(line) }, "Malformed app-server protocol line ignored");
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const response = message as unknown as RpcResponse;
      const call = this.pending.get(response.id);
      if (!call) return;
      this.pending.delete(response.id);
      clearTimeout(call.timeout);
      if (response.error) call.reject(new Error(`Codex ${response.error.code}: ${response.error.message}`));
      else call.resolve(response.result);
      return;
    }

    if (typeof message.method === "string" && "id" in message) {
      this.emit("request", message as unknown as RpcRequest);
    } else if (typeof message.method === "string") {
      this.emit("notification", message.method, message.params);
    }
  }

  private onChildFailure(error: Error): void {
    if (!this.child && this.stopping) return;
    this.child = null;
    this.initialized = false;
    this.rejectPending(error);
    if (this.stopping || this.restartTimer) return;
    this.failures += 1;
    this.logger.error({ error: error.message, failures: this.failures }, "Codex app-server unavailable");
    this.emit("unavailable", error);
    if (this.failures >= 10) { this.emit("circuitOpen", error); return; }
    const base = BACKOFF_SECONDS[Math.min(this.failures - 1, BACKOFF_SECONDS.length - 1)]! * 1_000;
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnAndInitialize().catch((reason: unknown) => this.onChildFailure(reason instanceof Error ? reason : new Error(String(reason))));
    }, wait);
  }

  private rejectPending(error: Error): void {
    for (const call of this.pending.values()) { clearTimeout(call.timeout); call.reject(error); }
    this.pending.clear();
  }
}

function childEnvironment(config: Config): NodeJS.ProcessEnv {
  const standard = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  const allowed = new Set([...standard, ...config.childEnvAllowlist]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (config.codexHome) env.CODEX_HOME = config.codexHome;
  return env;
}

function appendRotatingLog(filename: string, chunk: Buffer): void {
  try {
    if (fs.existsSync(filename) && fs.statSync(filename).size > 1_000_000) fs.renameSync(filename, `${filename}.1`);
    fs.appendFileSync(filename, chunk, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
  } catch { /* stderr capture must not crash the service */ }
}
