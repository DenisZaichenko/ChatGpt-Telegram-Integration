import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const markdown = new Marked({ gfm: true, breaks: true, async: false });
markdown.use({ renderer: {
  // Conversation text is data, never application HTML. Keep literal HTML visible.
  html: ({ text }) => escapeHtml(text),
  // Do not fetch tracking images embedded in arbitrary conversation content.
  image: ({ text }) => `<span>${escapeHtml(text ? `[Изображение: ${text}]` : "[Изображение]")}</span>`,
} });

export function messageHtml(text: string): string {
  const parsed = markdown.parse(readableMessage(text), { async: false });
  const html = sanitizeHtml(parsed, {
    allowedTags: ["p", "br", "strong", "em", "del", "s", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "hr", "a", "span", "input"],
    allowedAttributes: { a: ["href", "title", "target", "rel"], code: ["class"], th: ["align"], td: ["align"], ol: ["start"], input: ["type", "checked", "disabled"] },
    allowedClasses: { code: [/^language-[\w-]+$/] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attributes) => {
        const href = attributes.href ?? "";
        let safe = false;
        try { safe = ["http:", "https:", "mailto:"].includes(new URL(href).protocol); } catch { /* local file references remain readable but are not web links */ }
        return safe
          ? { tagName: "a", attribs: { href, target: "_blank", rel: "noopener noreferrer", ...(attributes.title ? { title: attributes.title } : {}) } }
          : { tagName: "span", attribs: {} };
      },
      input: (_tag, attributes) => ({ tagName: "input", attribs: { type: "checkbox", disabled: "", ...(attributes.checked !== undefined ? { checked: "" } : {}) } }),
    },
  });
  return html.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="message-table" role="region" aria-label="Таблица сообщения" tabindex="0"><table>$1</table></div>');
}

function readableMessage(text: string): string {
  const reply = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!reply) return text;
  try {
    const items: unknown = JSON.parse(reply[1]!);
    if (!Array.isArray(items) || !items.length || !items.every((item) => item && typeof item.question === "string" && typeof item.answer === "string")) return text;
    return items.map(({ question, answer }: { question: string; answer: string }) => `**Вопрос:** ${literalMarkdown(question)}\n\n**Ответ:** ${literalMarkdown(answer)}`).join("\n\n---\n\n");
  } catch { return text; }
}

function literalMarkdown(value: string): string { return value.replace(/[\\`*_{}\[\]()#+.!|>~<-]/g, "\\$&"); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
