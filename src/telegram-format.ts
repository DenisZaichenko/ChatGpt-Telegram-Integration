const TOKEN = "\u0000TG_TOKEN_";

export function telegramHtml(markdown: string): string {
  const tokens: string[] = [];
  const protect = (html: string): string => {
    const id = tokens.push(html) - 1;
    return `${TOKEN}${id}\u0000`;
  };

  let text = markdown.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
    return protect(`<pre><code${className}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
  });
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, title: string, rawUrl: string) => {
    const url = safeUrl(rawUrl);
    return url ? protect(`<a href="${escapeAttribute(url)}">${escapeHtml(title)}</a>`) : `${title} (${rawUrl})`;
  });

  text = escapeHtml(text);
  text = text.replace(/^######?\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^####?\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^##?\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^\[([^\]\n]+)\]$/gm, "<b>[$1]</b>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  text = text.replace(/^\s*[-*]\s+/gm, "• ");
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");

  for (let index = 0; index < tokens.length; index += 1) {
    text = text.replace(`${TOKEN}${index}\u0000`, tokens[index]!);
  }
  return text;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "tg:"].includes(url.protocol) ? value : null;
  } catch { return null; }
}
