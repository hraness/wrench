import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skillRoot = join(import.meta.dir, "..", "skills", "wrench");

function readSkill(relativePath: string): string {
  return readFileSync(join(skillRoot, relativePath), "utf8");
}

describe("packaged Wrench skill X AI disclosure", () => {
  test("routes user-supplied cross-post copy through a fail-closed unlabeled rule", () => {
    const skill = readSkill("SKILL.md");
    expect(skill).toContain("references/x-ai-disclosure.md");
    expect(skill).toContain("made_with_ai");
    expect(skill).toContain("sparkle Made with AI");

    const disclosure = readSkill("references/x-ai-disclosure.md");
    expect(disclosure).toContain("Made with AI");
    expect(disclosure).toContain("Made with Grok");
    expect(disclosure).toContain("Content disclosure");
    expect(disclosure).toContain("live permalink");
    expect(disclosure).toContain("the publish failed");
    expect(disclosure).toContain("Do not delete or repost unless the user asks");
    expect(disclosure).toContain("Prefer a Wrench transport");
    expect(disclosure).toContain("semantic_annotation_ids");
    expect(disclosure).toContain("explicitly authorized `made_with_ai: true`");
    expect(disclosure).toContain("outside this workflow");
    expect(disclosure).toContain("Do not report success");
    expect(disclosure).toContain("pixels-only");
    expect(disclosure).toContain("caBX");
    expect(disclosure).toContain("locked");
    expect(disclosure).toContain("auto-label");

    const crossPost = readSkill("references/cross-posting.md");
    expect(crossPost).toContain("x-ai-disclosure.md");
    expect(crossPost).toContain("sparkle Made with AI");
    expect(crossPost).toContain("Do not click the X composer");
  });
});
