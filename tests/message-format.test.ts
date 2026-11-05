import { describe, expect, it } from "vitest";
import { messageHtml } from "../src/message-format.js";

describe("message Markdown", () => {
  it("renders headings, emphasis, lists, quotes, code, tables and task lists", () => {
    const html = messageHtml('### Check\n\n**bold** and *italic* and ~~old~~ with `--browser`\n\n- first\n- second\n\n3. third\n\n> quote\n\n```ts\nconst safe = "<div>";\n```\n\n| Scenario | Result |\n|---|---:|\n| Desktop | OK |\n\n- [x] done\n- [ ] pending');
    for (const fragment of ['<h3>Check</h3>', '<strong>bold</strong>', '<em>italic</em>', '<del>old</del>', '<code>--browser</code>', '<ul>', '<ol start="3">', '<blockquote>', '<pre><code class="language-ts">', '&lt;div&gt;', 'class="message-table"', '<table>', '<td align="right">OK</td>', 'type="checkbox" disabled checked', 'type="checkbox" disabled']) {
      expect(html).toContain(fragment);
    }
  });

  it("keeps line breaks and encodes HTML code as text", () => {
    expect(messageHtml("first\nsecond")).toContain("first<br />second");
    expect(messageHtml('`<script>alert(1)</script>`')).toContain('<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>');
  });

  it("escapes raw HTML without allowing scripts, SVG, styles or event handlers", () => {
    const html = messageHtml('<script>alert(1)</script>\n\n<svg onload="alert(1)"></svg>\n\n<img src=x onerror=alert(1)>\n\n<style>body{display:none}</style>\n\n<iframe src="https://evil.test"></iframe>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<(script|svg|img|style|iframe)\b/i);
    expect(html).not.toMatch(/<[^>]+\bon\w+=/i);
  });

  it("allows only absolute web/mail links and adds opener protection", () => {
    const html = messageHtml('[web](https://example.test "Example") [email](mailto:hello@example.test) [http](http://example.test)');
    expect(html).toContain('href="https://example.test" target="_blank" rel="noopener noreferrer" title="Example"');
    expect(html).toContain('href="mailto:hello@example.test"');
    expect(html).toContain('href="http://example.test"');
    for (const url of ['javascript:alert%281%29', 'data:text/html;base64,abc', 'vbscript:msgbox%281%29', 'file:///etc/passwd', '//evil.test', '/local/file.ts', 'codex://threads/id', 'jav&#x61;script:alert%281%29']) {
      const blocked = messageHtml(`[readable](${url})`);
      expect(blocked).toContain('readable');
      expect(blocked).not.toContain('href=');
    }
  });

  it("does not load embedded remote images", () => {
    const html = messageHtml('![diagram](https://tracking.test/pixel.png) ![](data:image/png;base64,abc)');
    expect(html).toContain('[Изображение: diagram]');
    expect(html).not.toMatch(/<img|src=|tracking\.test/);
  });

  it("renders structured replies as readable questions and answers, without internal IDs", () => {
    const html = messageHtml(`<send_user_message_question_reply>${JSON.stringify([
      { questionItemId: 'private-id', question: 'Создать чат?', answer: 'Да, проверь **это** <script> и [ссылку](https://example.test)' },
      { question: 'Второй вопрос', answer: 'Ответ\nс переносом' },
    ])}</send_user_message_question_reply>`);
    expect(html).toContain('<strong>Вопрос:</strong> Создать чат?');
    expect(html).toContain('<strong>Ответ:</strong> Да, проверь **это** &lt;script&gt;');
    expect(html).toContain('Ответ<br />с переносом');
    expect(html).not.toMatch(/private-id|questionItemId|send_user_message_question_reply|<script|<a /);
  });

  it.each(['broken JSON', '[]', '{}', '[{"question":"Q","answer":1}]'])("keeps malformed reply payloads visible: %s", (payload) => {
    const html = messageHtml(`<send_user_message_question_reply>${payload}</send_user_message_question_reply>`);
    expect(html).toContain('&lt;send_user_message_question_reply&gt;');
    expect(html).toContain(payload);
  });
});
