import { expect, test } from "bun:test";

import { renderAskAiAboutThis } from "./build";

const subjectUrl = "https://wrench.rip/provider-capabilities/";
const prompt = `Tell me about ${subjectUrl}`;
const expectedDestinations = [
  ["chatgpt", "https://chatgpt.com/", "q"],
  ["claude", "https://claude.ai/new", "q"],
  ["perplexity", "https://perplexity.ai/", "q"],
  ["grok", "https://x.com/i/grok", "text"],
] as const;

test("renders one crawlable Ask AI row with exact provider prompts", () => {
  const html = renderAskAiAboutThis(subjectUrl);

  expect(html.match(/<nav\b/gu)).toHaveLength(1);
  expect(html).toContain('aria-label="Ask AI about this"');
  expect(html).toContain('data-slot="ask-ai-about-this"');
  expect(html.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4);

  for (const [provider, baseUrl, parameter] of expectedDestinations) {
    const destination = new URL(baseUrl);
    destination.searchParams.set(parameter, prompt);
    expect(html).toContain(`data-ask-ai-provider="${provider}"`);
    expect(html).toContain(`href="${destination.href.replaceAll("&", "&amp;")}"`);
  }

  expect(html.match(/target="_blank"/gu)).toHaveLength(4);
  expect(html.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4);
});
