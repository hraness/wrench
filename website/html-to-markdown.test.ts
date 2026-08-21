import { describe, expect, test } from "bun:test";

import { htmlMainToMarkdown } from "./html-to-markdown";

describe("HTML main-to-markdown conversion", () => {
  test("keeps headings, links, code, lists, tables, and disclosures", () => {
    const markdown = htmlMainToMarkdown(`
      <html><body>
        <main>
          <div aria-hidden="true" class="hero-field"><span>🔧</span></div>
          <h1>Install Wrench</h1>
          <a class="button" href="#start">Get started</a>
          <p>Use <code>wrench doctor</code> and the <a href="/security/">security guide</a>.</p>
          <pre><code>wrench read https://example.com/article</code></pre>
          <ul><li>One <strong>exact</strong> account</li><li>Second</li></ul>
          <table>
            <thead><tr><th>Command</th><th>Result</th></tr></thead>
            <tbody><tr><th>wrench URL</th><td>Durable Markdown</td></tr></tbody>
          </table>
          <details><summary>Is Wrench an AI agent?</summary><p>No. Your agent owns the model.</p></details>
        </main>
      </body></html>
    `, "https://wrench.rip/getting-started/");

    expect(markdown).toBe([
      "# Install Wrench",
      "",
      "[Get started](https://wrench.rip/getting-started/#start)",
      "",
      "Use `wrench doctor` and the [security guide](https://wrench.rip/security/).",
      "",
      "```",
      "wrench read https://example.com/article",
      "```",
      "",
      "- One **exact** account",
      "- Second",
      "",
      "| Command | Result |",
      "| --- | --- |",
      "| wrench URL | Durable Markdown |",
      "",
      "### Is Wrench an AI agent?",
      "",
      "No. Your agent owns the model.",
      "",
    ].join("\n"));
    expect(markdown).not.toContain("🔧");
    expect(markdown).not.toContain("<");
  });

  test("rejects pages without a main landmark or convertible content", () => {
    expect(() => htmlMainToMarkdown("<html><body><p>none</p></body></html>", "https://wrench.rip/"))
      .toThrow("main landmark");
    expect(() => htmlMainToMarkdown("<main><div aria-hidden=\"true\">x</div></main>", "https://wrench.rip/"))
      .toThrow("empty document");
  });
});
