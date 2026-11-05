import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "pino";

/** A quick tunnel is temporary; announce its new URL after every restart. */
export class MiniAppTunnel {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  constructor(private readonly bin: string, private readonly port: number, private readonly onUrl: (url: string) => Promise<void>, private readonly logger: Logger) {}

  start(): void {
    this.stopping = false;
    const child = spawn(this.bin, ["tunnel", "--url", `http://127.0.0.1:${this.port}`, "--no-autoupdate", "--protocol", "http2"], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let announced = false;
    const lines = readline.createInterface({ input: child.stderr! });
    lines.on("line", (line) => {
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.exec(line)?.[0];
      if (!url || announced) return;
      announced = true;
      void this.onUrl(url).catch(() => this.logger.warn("Could not register Mini App menu; retry /app after the tunnel reconnects"));
    });
    const restart = () => {
      if (this.child === child) this.child = null;
      if (this.stopping || this.timer) return;
      this.logger.warn("Mini App tunnel disconnected; restarting in 10 seconds");
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, 10_000);
    };
    child.once("error", restart);
    child.once("exit", restart);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
