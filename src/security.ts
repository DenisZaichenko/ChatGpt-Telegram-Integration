import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verify } from "@node-rs/argon2";

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
];

export function redact(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((value, pattern) =>
    value.replace(pattern, (_match, prefix: string | undefined) => `${prefix && /[:=\s]$/.test(prefix) ? prefix : ""}[REDACTED]`), text);
}

export function shortId(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
}

export function callbackToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(18).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function verifyPairingSecret(verifier: string, candidate: string): Promise<boolean> {
  try {
    return await verify(verifier, candidate);
  } catch {
    return false;
  }
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function canonicalDirectory(candidate: string): string {
  const resolved = fs.realpathSync.native(candidate);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${candidate}`);
  return resolved;
}

export function isAllowedCanonicalPath(candidate: string, roots: readonly string[], parents: readonly string[]): boolean {
  return roots.some((root) => candidate === root) || parents.some((parent) => isInside(candidate, parent));
}

export class SlidingWindowRateLimiter {
  readonly #entries = new Map<number, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(key: number, now = Date.now()): boolean {
    const recent = (this.#entries.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.#entries.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#entries.set(key, recent);
    return true;
  }
}
