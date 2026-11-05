import { createHmac, timingSafeEqual } from "node:crypto";

/** Validate Telegram's signed launch data, never the client's initDataUnsafe. */
export function verifyMiniAppData(raw: string, token: string, allowedUserId: number, now = Date.now()): void {
  if (!raw || raw.length > 16_384) throw new Error("Open the app from Telegram");
  const data = new URLSearchParams(raw);
  const keys = [...data.keys()];
  if (new Set(keys).size !== keys.length) throw new Error("Invalid Telegram launch data");
  const hash = data.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid Telegram signature");
  data.delete("hash");
  const check = [...data.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw new Error("Invalid Telegram signature");
  const timestamp = Number(data.get("auth_date"));
  const age = Math.floor(now / 1_000) - timestamp;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || age < -30 || age > 3600) throw new Error("Session expired. Reopen the app in Telegram");
  let user: unknown;
  try { user = JSON.parse(data.get("user") ?? "null"); } catch { throw new Error("Invalid Telegram user"); }
  if (!user || typeof user !== "object" || !("id" in user) || user.id !== allowedUserId) throw new Error("Access denied");
}
