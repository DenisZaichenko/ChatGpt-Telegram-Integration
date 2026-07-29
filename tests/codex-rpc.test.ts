import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRpcClient } from "../src/codex-rpc.js";
import type { Config } from "../src/config.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(): { config: Config; transcript: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-rpc-")); temporary.push(dir);
  const executable = path.join(dir, "fake-codex");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.145.0\\n"); process.exit(0); }
const readline = require("node:readline");
let initialized = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(transcript)}, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "initialized") { initialized = true; return; }
  if (!initialized) return send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
  if (message.method === "thread/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "crash") return setTimeout(() => process.exit(9), 5);
  send({ id: message.id, result: {} });
});
`);
  fs.chmodSync(executable, 0o700);
  const config = {
    telegramBotToken: "1234567890:abcdefghijklmnopqrstuvwxyzABCDE",
    allowedUserId: 1,
    pairingSecretHash: "$argon2id$v=19$m=19456,t=2,p=1$abcdefghijklmnop$abcdefghijklmnopqrstuv",
    codexBin: executable,
    dataDir: dir,
    projectRoots: [], projectParentDirs: [], projectAliases: {}, projectDiscoveryDepth: 1,
    maxConcurrentTurns: 3, maxQueuedPromptsPerChat: 5, logLevel: "silent", approvalExpiryMs: 600_000, childEnvAllowlist: [],
  } satisfies Config;
  return { config, transcript };
}

describe("Codex JSONL transport", () => {
  it("initializes in order and rejects pending calls on child crash", async () => {
    const { config, transcript } = fixture();
    const rpc = new CodexRpcClient(config, pino({ level: "silent" }), "test");
    await rpc.start();
    const methods = fs.readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "thread/list"]);
    await expect(rpc.request("crash", {}, 2_000)).rejects.toThrow("exited");
    await rpc.stop();
  });
});
