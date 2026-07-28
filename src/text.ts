import { redact } from "./security.js";

export const TELEGRAM_TEXT_LIMIT = 3_800;

export function label(project: string, chat: string): string {
  return `[${project} / ${chat}]`;
}

export function chunkText(input: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const text = redact(input).trim();
  if (!text) return [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let split = bestSplit(remaining, limit);
    if (split <= 0) split = limit;
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function bestSplit(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const codeFence = window.lastIndexOf("\n```");
  const paragraph = window.lastIndexOf("\n\n");
  const newline = window.lastIndexOf("\n");
  const space = window.lastIndexOf(" ");
  const candidates = [codeFence >= limit * 0.5 ? codeFence + 4 : -1, paragraph, newline, space];
  return candidates.find((point) => point >= limit * 0.5) ?? limit;
}

export function diffStats(diff: string): { files: number; added: number; removed: number } {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files.add(line);
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files: files.size, added, removed };
}
