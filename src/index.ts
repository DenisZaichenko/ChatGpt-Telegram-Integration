#!/usr/bin/env node
import path from "node:path";
import pino from "pino";
import { Bot } from "grammy";
import { ApprovalCoordinator } from "./approvals.js";
import { CodexRpcClient } from "./codex-rpc.js";
import { ensurePrivateDirectory, loadConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { OutputCoalescer } from "./output.js";
import { UnreadNotificationMonitor } from "./notifications.js";
import { ProjectRegistry } from "./projects.js";
import { StateStore } from "./store.js";
import { GrammyGateway, TelegramController } from "./telegram.js";
import { label } from "./text.js";
import { TurnCoordinator } from "./turns.js";

const VERSION = "0.1.0";
const config = loadConfig();
ensurePrivateDirectory(config.dataDir);
const logger = pino({
  level: config.logLevel,
  redact: { paths: ["telegramBotToken", "token", "secret", "password", "apiKey", "*.token", "*.secret", "*.password", "*.apiKey"], censor: "[REDACTED]" },
});
const store = new StateStore(path.join(config.dataDir, "state.db"));

if (process.argv[2] === "doctor") {
  const healthy = await doctor(config, store, logger);
  store.close();
  process.exitCode = healthy ? 0 : 1;
} else {
  const registry = new ProjectRegistry(config, store);
  registry.refresh();
  store.prune();
  const rpc = new CodexRpcClient(config, logger, VERSION);
  const bot = new Bot(config.telegramBotToken);
  const gateway = new GrammyGateway(bot, logger, store);
  const chatLabel = (chatId: string) => {
    const chat = store.getChat(chatId);
    if (!chat) return "[unknown / unknown]";
    const project = store.getProject(chat.projectId);
    return label(project?.alias ?? "unknown", chat.title || (chat.preview ?? chat.id).slice(0, 28));
  };
  const output = new OutputCoalescer(store, gateway, logger, (chat) => chatLabel(chat.id));
  const approvals = new ApprovalCoordinator(rpc, store, gateway, config.allowedUserId, config.allowedUserId, config.approvalExpiryMs, chatLabel, logger);
  const turns = new TurnCoordinator(rpc, store, registry, output, approvals, config.allowedUserId, config.maxConcurrentTurns, config.maxQueuedPromptsPerChat, logger);
  const controller = new TelegramController(config, gateway, store, registry, rpc, turns, approvals, logger);
  const notifications = new UnreadNotificationMonitor(store, turns, (chat, messages) => controller.sendUnreadNotification(chat, messages), logger);
  approvals.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    controller.stop();
    notifications.stop();
    approvals.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));
    store.markActiveTurnsUnknown("Service stopped while turn was active");
    await rpc.stop();
    store.close();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await rpc.start();
    await rpc.request("account/read", { refreshToken: false });
    await turns.refreshChats();
    await notifications.start();
    logger.info({ version: VERSION, projects: store.listProjects().length }, "Service started");
    await controller.start();
  } catch (error) {
    logger.fatal({ error }, "Service failed");
    await shutdown("startup-error");
    process.exitCode = 1;
  }
}
