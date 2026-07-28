import { describe, expect, it } from "vitest";
import { telegramHtml } from "../src/telegram-format.js";

describe("Telegram formatting", () => {
  it("renders labels, emphasis, links, and fenced code as safe Telegram HTML", () => {
    const rendered = telegramHtml("[project / Chat]\n**Done** [docs](https://example.com)\n```text\n/pair code\n```");
    expect(rendered).toContain("<b>[project / Chat]</b>");
    expect(rendered).toContain("<b>Done</b>");
    expect(rendered).toContain('<a href="https://example.com">docs</a>');
    expect(rendered).toContain('<pre><code class="language-text">/pair code</code></pre>');
  });

  it("escapes repository-controlled HTML", () => {
    expect(telegramHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
