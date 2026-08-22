import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skillRoot = join(import.meta.dir, "..", "skills", "wrench");

function readSkill(relativePath: string): string {
  return readFileSync(join(skillRoot, relativePath), "utf8");
}

describe("packaged Wrench skill X AI disclosure", () => {
  test("routes X posting through a fail-closed unlabeled-copy rule", () => {
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
    expect(disclosure).toContain("Do not report success");

    const crossPost = readSkill("references/cross-posting.md");
    expect(crossPost).toContain("x-ai-disclosure.md");
    expect(crossPost).toContain("sparkle Made with AI");
    expect(crossPost).toContain("Do not click the X composer");
  });
});
