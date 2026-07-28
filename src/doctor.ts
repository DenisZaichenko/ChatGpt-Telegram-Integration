import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { CodexRpcClient } from "./codex-rpc.js";
import { StateStore } from "./store.js";

const execFileAsync = promisify(execFile);

export async function doctor(config: Config, store: StateStore, logger: Logger): Promise<boolean> {
  let healthy = true;
  const check = (name: string, ok: boolean, detail: string) => {
    process.stdout.write(`${ok ? "✓" : "✗"} ${name}: ${detail}\n`);
    if (!ok) healthy = false;
  };
  try {
    const stat = fs.statSync(config.dataDir);
    check("data directory", stat.isDirectory() && (stat.mode & 0o077) === 0, `${config.dataDir} mode ${(stat.mode & 0o777).toString(8)}`);
  } catch (error) { check("data directory", false, errorMessage(error)); }
  try {
    const row = store.db.pragma("integrity_check", { simple: true });
    check("SQLite", row === "ok", String(row));
  } catch (error) { check("SQLite", false, errorMessage(error)); }
  try {
    const { stdout } = await execFileAsync(config.codexBin, ["--version"], { timeout: 10_000 });
    check("Codex executable", true, stdout.trim());
  } catch (error) { check("Codex executable", false, errorMessage(error)); }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`, { signal: AbortSignal.timeout(10_000) });
    check("Telegram", response.ok, response.ok ? "bot token accepted" : `HTTP ${response.status}`);
  } catch (error) { check("Telegram", false, errorMessage(error)); }
  const rpc = new CodexRpcClient(config, logger, "0.1.0-doctor");
  try {
    await rpc.start();
    const account = await rpc.request<Record<string, unknown>>("account/read", { refreshToken: false });
    check("app-server", true, "handshake and thread/list succeeded");
    if (account.account != null) {
      check("Codex authentication", true, "account available (details redacted)");
    } else {
      const env = { ...process.env, ...(config.codexHome ? { CODEX_HOME: config.codexHome } : {}) };
      const { stdout, stderr } = await execFileAsync(config.codexBin, ["login", "status"], { env, timeout: 10_000 });
      const loggedIn = /logged in/i.test(`${stdout}\n${stderr}`);
      check("Codex authentication", loggedIn, loggedIn ? "CLI login available to custom provider" : "no reusable login");
    }
  } catch (error) { check("app-server", false, errorMessage(error)); }
  finally { await rpc.stop(); }
  return healthy;
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
