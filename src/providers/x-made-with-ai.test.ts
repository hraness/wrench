import { describe, expect, test } from "bun:test";

import {
  rejectXTweetMadeWithAiLabel,
  X_UNLABELED_COPY_POLICY_ERROR,
  XUnlabeledCopyPolicyError,
  xTweetHasMadeWithAiLabel,
} from "./x-made-with-ai";

const unlabeled = {
  rest_id: "2091626299513041128",
  legacy: {
    full_text: "I used AI as a tool. This copy is mine.",
    user_id_str: "1",
  },
  note_tweet: {
    note_tweet_results: {
      result: { text: "Made with AI appears only in the supplied copy." },
    },
  },
};

describe("X Made with AI tweet label detection", () => {
  test("ignores user-authored text that mentions AI", () => {
    expect(xTweetHasMadeWithAiLabel(unlabeled)).toBeFalse();
    expect(() => rejectXTweetMadeWithAiLabel(unlabeled)).not.toThrow();
  });

  test("detects the live-UI disclosure fields used by TweetDetail and CreateTweet", () => {
    const labeled = [
      { ...unlabeled, content_disclosure: { label: "Made with AI" } },
      { ...unlabeled, made_with_ai: true },
      { ...unlabeled, ai_generated: true },
      { ...unlabeled, tweet_interstitial: { display_type: "AIGeneratedContent", text: { text: "Made with AI" } } },
      { ...unlabeled, semantic_annotations: [{ name: "trainedAlgorithmicMedia" }] },
      { ...unlabeled, card: { legacy: { name: "ai_generated_disclosure", binding_values: [] } } },
      { ...unlabeled, legacy: { ...unlabeled.legacy, ai_highlight_label: "Made with Grok" } },
    ];
    for (const tweet of labeled) {
      expect(xTweetHasMadeWithAiLabel(tweet)).toBeTrue();
    }
  });

  test("throws the unlabeled-copy policy error without deleting", () => {
    expect(() => rejectXTweetMadeWithAiLabel(
      { made_with_ai: true },
      { id: "2091626299513041128", url: "https://x.com/i/status/2091626299513041128" },
    )).toThrow(XUnlabeledCopyPolicyError);
    try {
      rejectXTweetMadeWithAiLabel({ content_disclosure: "Made with AI" }, {
        id: "1",
        url: "https://x.com/i/status/1",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(XUnlabeledCopyPolicyError);
      expect((error as XUnlabeledCopyPolicyError).message).toBe(X_UNLABELED_COPY_POLICY_ERROR);
      expect((error as XUnlabeledCopyPolicyError).post).toEqual({
        id: "1",
        url: "https://x.com/i/status/1",
      });
    }
  });
});
