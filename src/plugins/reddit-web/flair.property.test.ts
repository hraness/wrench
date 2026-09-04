import { expect, test } from "bun:test";
import { assertProperty, fc } from "../../test-support";
import { REDDIT_FLAIR_OPERATION_NAMES, parseRedditFlairInput } from "./flair";

test("arbitrary flair input either parses exactly or fails with bounded diagnostics", () => {
  assertProperty(fc.property(fc.constantFrom(...REDDIT_FLAIR_OPERATION_NAMES), fc.jsonValue(),
    (operation, input) => {
      let result;
      try {
        result = parseRedditFlairInput(operation, input);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message.length).toBeLessThan(160);
        return;
      }
      expect(result.target.community).toMatch(/^[A-Za-z0-9_]{2,21}$/u);
      expect(result.action).toBe(operation.endsWith(".select") ? "select" : "choices");
    }));
});

test("every unknown input field is rejected rather than reaching a provider", () => {
  assertProperty(fc.property(fc.string({ minLength: 1, maxLength: 64 }), fc.jsonValue(),
    (key, value) => {
      fc.pre(key !== "community");
      expect(() => parseRedditFlairInput("flair.user.choices", {
        community: "example", [key]: value,
      })).toThrow("unsupported fields");
    }));
});
