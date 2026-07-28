import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { UnreadNotificationMonitor } from "../src/notifications.js";
import { StateStore } from "../src/store.js";
import type { TurnCoordinator } from "../src/turns.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("unread Codex notifications", () => {
  it("notifies for a newly persisted assistant final after the delay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-notifications-")); temporary.push(dir);
    const store = new StateStore(path.join(dir, "state.db"));
    const project = store.upsertProject(dir, "project", "explicit");
    const chat = { id: "chat", projectId: project.id, title: "Chat", preview: null, cwd: dir, sourceKind: "appServer", createdAt: 1, updatedAt: 1_000, status: "idle" };
    store.upsertChat(chat); store.setChatScanned(chat.id, 1_000);
    const fakeTurns = {
      async refreshChats() { store.upsertChat({ ...chat, updatedAt: 20_000 }); return 1; },
      async assistantMessages() { return [{ messageId: "agent-1", turnId: "external-turn", text: "Finished in Codex App", occurredAt: 5_000 }]; },
    } as unknown as TurnCoordinator;
    const delivered: string[][] = [];
    const monitor = new UnreadNotificationMonitor(store, fakeTurns, async (_chat, messages) => { delivered.push(messages); }, pino({ level: "silent" }), 0);
    await monitor.tick();
    expect(delivered).toEqual([["Finished in Codex App"]]);
    await monitor.tick();
    expect(delivered).toHaveLength(1);
    store.close();
  });
});
