import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const schema = z.object({
  telegramBotToken: z.string().min(20),
  allowedUserId: z.coerce.number().int().positive(),
  pairingSecretHash: z.string().min(20),
  codexBin: z.string().min(1).default("codex"),
  codexHome: z.string().min(1).optional(),
  dataDir: z.string().min(1),
  projectRoots: z.array(z.string()).default([]),
  projectParentDirs: z.array(z.string()).default([]),
  projectAliases: z.record(z.string(), z.string()).default({}),
  projectDiscoveryDepth: z.coerce.number().int().min(0).max(4).default(1),
  maxConcurrentTurns: z.coerce.number().int().min(1).max(10).default(3),
  maxQueuedPromptsPerChat: z.coerce.number().int().min(1).max(20).default(5),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  approvalExpiryMs: z.coerce.number().int().min(30_000).max(3_600_000).default(600_000),
  childEnvAllowlist: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof schema>;

function list(value: string | undefined): string[] | undefined {
  return value?.split(",").map((part) => part.trim()).filter(Boolean);
}

function tomlConfig(filename: string | undefined): Record<string, unknown> {
  if (!filename) return {};
  const parsed = parseToml(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
  return {
    allowedUserId: parsed.allowed_user_id,
    codexBin: parsed.codex_bin,
    codexHome: parsed.codex_home,
    dataDir: parsed.data_dir,
    projectRoots: parsed.project_roots,
    projectParentDirs: parsed.project_parent_dirs,
    projectAliases: parsed.project_aliases,
    projectDiscoveryDepth: parsed.project_discovery_depth,
    maxConcurrentTurns: parsed.max_concurrent_turns,
    logLevel: parsed.log_level,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = tomlConfig(env.CONFIG_FILE);
  const result = schema.parse({
    ...file,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    allowedUserId: env.TELEGRAM_ALLOWED_USER_ID ?? file.allowedUserId,
    pairingSecretHash: env.PAIRING_SECRET_HASH,
    codexBin: env.CODEX_BIN ?? file.codexBin,
    codexHome: env.CODEX_HOME ?? file.codexHome,
    dataDir: env.DATA_DIR ?? file.dataDir ?? path.join(process.cwd(), "data"),
    projectRoots: list(env.PROJECT_ROOTS) ?? file.projectRoots,
    projectParentDirs: list(env.PROJECT_PARENT_DIRS) ?? file.projectParentDirs,
    projectDiscoveryDepth: env.PROJECT_DISCOVERY_DEPTH ?? file.projectDiscoveryDepth,
    maxConcurrentTurns: env.MAX_CONCURRENT_TURNS ?? file.maxConcurrentTurns,
    maxQueuedPromptsPerChat: env.MAX_QUEUED_PROMPTS_PER_CHAT,
    logLevel: env.LOG_LEVEL ?? file.logLevel,
    approvalExpiryMs: env.APPROVAL_EXPIRY_MS,
    childEnvAllowlist: list(env.CODEX_CHILD_ENV_ALLOWLIST),
  });

  if (process.getuid?.() === 0) throw new Error("Refusing to run as root");
  return result;
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
