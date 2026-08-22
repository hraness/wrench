import { describe, expect, test } from "bun:test";

import type { InputField } from "./model";
import { blueskyWebPlugin } from "./plugins/bluesky-web/plugin";
import { linkedinOfficialPlugin } from "./plugins/linkedin-official/plugin";
import { linkedinWebPlugin } from "./plugins/linkedin-web/plugin";
import { metaWebPlugin } from "./plugins/meta-web/plugin";
import { redditWebPlugin } from "./plugins/reddit-web/plugin";
import { substackWebPlugin } from "./plugins/substack-web/plugin";
import { tiktokWebPlugin } from "./plugins/tiktok-web/plugin";
import { xOfficialPlugin } from "./plugins/x-official/plugin";
import { xWebPlugin } from "./plugins/x-web/plugin";
import { youtubeWebPlugin } from "./plugins/youtube-web/plugin";

type Operation = (typeof xWebPlugin.bindings)[number]["operations"][number];

function binding(plugin: { readonly bindings: readonly { readonly surfaceId: string; readonly operations: readonly Operation[] }[] }, surfaceId: string) {
  const result = plugin.bindings.find((candidate) => candidate.surfaceId === surfaceId);
  if (result === undefined) throw new Error(`missing ${surfaceId} provider binding`);
  return result;
}

function operation(
  plugin: { readonly bindings: readonly { readonly surfaceId: string; readonly operations: readonly Operation[] }[] },
  surfaceId: string,
  name: "media.publish" | "posts.publish",
): Operation {
  const matches = binding(plugin, surfaceId).operations.filter((candidate) =>
    candidate.name === name);
  const result = matches.sort((left, right) =>
    right.contractVersion - left.contractVersion)[0];
  if (result === undefined) throw new Error(`missing ${surfaceId} ${name}`);
  return result;
}

function fileMediaTypes(field: InputField | undefined): readonly string[] {
  if (field?.type === "file") return field.mediaTypes ?? [];
  if (field?.type === "array" && field.items.type === "file") {
    return field.items.mediaTypes ?? [];
  }
  throw new Error("social video media input must be a file or file array");
}

describe("social video provider contracts", () => {
  test("keeps the three already executable MP4 routes observed", () => {
    for (const [plugin, surfaceId] of [
      [xWebPlugin, "x"],
      [xOfficialPlugin, "x"],
      [linkedinOfficialPlugin, "linkedin"],
    ] as const) {
      const publish = operation(plugin, surfaceId, "posts.publish");
      expect(publish.state).toBe("observed");
      expect(fileMediaTypes(publish.input.properties.media)).toContain("video/mp4");
    }
  });

  test("reserves one bounded MP4 route for every remaining requested web surface", () => {
    for (const [plugin, surfaceId] of [
      [linkedinWebPlugin, "linkedin"],
      [blueskyWebPlugin, "bluesky"],
      [substackWebPlugin, "substack"],
      [tiktokWebPlugin, "tiktok"],
      [metaWebPlugin, "instagram"],
      [metaWebPlugin, "threads"],
      [youtubeWebPlugin, "youtube"],
    ] as const) {
      const publish = operation(plugin, surfaceId, "media.publish");
      expect(publish).toMatchObject({
        risk: "R3",
        state: "capture-required",
        dispatch: "single",
      });
      expect(fileMediaTypes(publish.input.properties.media)).toContain("video/mp4");
    }
  });

  test("graduates Reddit native MP4 publishing with an explicit poster and declarations", () => {
    const publish = operation(redditWebPlugin, "reddit", "media.publish");
    expect(publish).toMatchObject({
      risk: "R3",
      state: "observed",
      contractVersion: 9,
      dispatch: "single",
    });
    expect(fileMediaTypes(publish.input.properties.media)).toEqual(["video/mp4"]);
    expect(fileMediaTypes(publish.input.properties.thumbnail)).toEqual([
      "image/jpeg",
      "image/png",
    ]);
    expect(publish.input.required).toEqual([
      "community",
      "title",
      "media",
      "thumbnail",
      "nsfw",
      "spoiler",
      "send_replies",
    ]);
  });

  test("does not widen live-proven image post contracts by analogy", () => {
    for (const [plugin, surfaceId, mediaField] of [
      [linkedinWebPlugin, "linkedin", "media"],
      [blueskyWebPlugin, "bluesky", "media"],
      [substackWebPlugin, "substack", "media"],
      [metaWebPlugin, "threads", "attachment"],
    ] as const) {
      const publish = operation(plugin, surfaceId, "posts.publish");
      expect(publish.state).toBe("observed");
      expect(fileMediaTypes(publish.input.properties[mediaField])).not.toContain("video/mp4");
    }
  });

  test("requires explicit YouTube publication declarations", () => {
    const publish = operation(youtubeWebPlugin, "youtube", "media.publish");
    expect(publish.input.required).toEqual([
      "title",
      "media",
      "visibility",
      "made_for_kids",
      "notify_subscribers",
      "category_id",
    ]);
  });
});
