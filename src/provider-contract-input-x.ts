import type { OperationInput } from "./model";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";

function isFileInputValue(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { readonly kind?: unknown }).kind === "file"
    && typeof (value as { readonly reference?: unknown }).reference === "string";
}

export function xProviderConditionalInputIssues(
  action: ProviderPluginOperationName,
  input: OperationInput,
): readonly string[] {
  const issues: string[] = [];
  const xId = (name: string, value: unknown): void => {
    if (typeof value === "string" && !/^[0-9]{1,19}$/u.test(value)) {
      issues.push(`input.${name} must be a 1-19 digit X object ID`);
    }
  };
  const xConversationId = (name: string, value: unknown): void => {
    if (
      typeof value === "string"
      && !/^(?:[0-9]{15,19}|[0-9]{1,19}-[0-9]{1,19})$/u.test(value)
    ) {
      issues.push(`input.${name} must be an exact legacy X DM conversation ID`);
    }
  };
  if (action === "feeds.read") {
    const feedLabel = typeof input.feed === "string" ? input.feed : "unknown feed";
    if (
      (input.feed === "user" || input.feed === "mentions")
      && typeof input.user_id !== "string"
    ) {
      issues.push("input.user_id is required for user and mentions feeds");
    }
    if (input.feed === "list" && typeof input.list_id !== "string") {
      issues.push("input.list_id is required for the list feed");
    }
    if (input.feed === "recent-search" && typeof input.query !== "string") {
      issues.push("input.query is required for recent-search");
    }
    if (
      input.feed !== "user"
      && input.feed !== "mentions"
      && input.user_id !== undefined
    ) {
      issues.push("input.user_id is accepted only for user and mentions feeds");
    }
    if (input.feed !== "list" && input.list_id !== undefined) {
      issues.push("input.list_id is accepted only for the list feed");
    }
    if (input.feed !== "recent-search" && input.query !== undefined) {
      issues.push("input.query is accepted only for recent-search");
    }
    const supportsTimeAndIdBounds = input.feed === "home-reverse-chronological"
      || input.feed === "user"
      || input.feed === "mentions"
      || input.feed === "recent-search";
    for (const name of ["since_id", "until_id", "start_time", "end_time"] as const) {
      if (!supportsTimeAndIdBounds && input[name] !== undefined) {
        issues.push(`input.${name} is not accepted for ${feedLabel}`);
      }
    }
    if (input.feed !== "home-reverse-chronological" && input.feed !== "user") {
      if (input.exclude_replies !== undefined) {
        issues.push(`input.exclude_replies is not accepted for ${feedLabel}`);
      }
      if (input.exclude_reposts !== undefined) {
        issues.push(`input.exclude_reposts is not accepted for ${feedLabel}`);
      }
    }
    if (input.feed !== "recent-search" && input.sort !== undefined) {
      issues.push("input.sort is accepted only for recent-search");
    }
    xId("user_id", input.user_id);
    xId("list_id", input.list_id);
    xId("since_id", input.since_id);
    xId("until_id", input.until_id);
    if (
      (input.feed === "user" || input.feed === "mentions")
      && typeof input.limit === "number"
      && input.limit < 5
    ) {
      issues.push("input.limit must be at least 5 for user and mentions feeds");
    }
    if (
      input.feed === "recent-search"
      && typeof input.limit === "number"
      && input.limit < 10
    ) {
      issues.push("input.limit must be at least 10 for recent-search");
    }
    for (const name of ["start_time", "end_time"] as const) {
      const value = input[name];
      if (
        typeof value === "string"
        && (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value)
          || !Number.isFinite(Date.parse(value))
        )
      ) {
        issues.push(`input.${name} must be a valid UTC RFC 3339 timestamp`);
      }
    }
  }
  if (action === "posts.read" && Array.isArray(input.post_ids)) {
    for (const [index, value] of input.post_ids.entries()) {
      xId(`post_ids[${index}]`, value);
    }
    if (
      input.post_ids.every((value) => typeof value === "string")
      && new Set(input.post_ids).size !== input.post_ids.length
    ) {
      issues.push("input.post_ids must contain unique X post IDs");
    }
  }
  if (action === "comments.read") xId("post_id", input.post_id);
  if (action === "messaging.list") {
    const needsTarget = input.view === "participant"
      || input.view === "conversation"
      || input.view === "chat-events";
    if (needsTarget && typeof input.target_id !== "string") {
      issues.push(
        "input.target_id is required for participant, conversation, and chat-events views",
      );
    }
    if (
      (input.view === "all" || input.view === "chat-conversations")
      && input.target_id !== undefined
    ) {
      issues.push(`input.target_id is not accepted when view is ${input.view}`);
    }
    if (input.view === "participant") xId("target_id", input.target_id);
    if (input.view === "conversation") {
      xConversationId("target_id", input.target_id);
    }
    if (
      input.view === "chat-events"
      && typeof input.target_id === "string"
      && !/^(?:[0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19}|g[0-9]{1,19})$/u.test(
        input.target_id,
      )
    ) {
      issues.push(
        "input.target_id must be an exact X Chat recipient or conversation ID",
      );
    }
    if (
      input.view === "chat-events"
      && typeof input.target_id === "string"
      && input.target_id.includes("-")
    ) {
      const [left, right] = input.target_id.split("-");
      if (left === right) {
        issues.push(
          "input.target_id must identify two different X Chat participants",
        );
      }
    }
  }
  if (action === "messaging.read") xId("event_id", input.event_id);
  if (action === "messaging.send") {
    if (input.target_kind === "participant") xId("target_id", input.target_id);
    if (input.target_kind === "conversation") {
      xConversationId("target_id", input.target_id);
    }
    if (
      input.target_kind === "conversation"
      && typeof input.target_id === "string"
      && input.target_id.includes("-")
    ) {
      const [left, right] = input.target_id.split("-");
      if (left === right) {
        issues.push(
          "input.target_id must identify two different legacy X DM participants",
        );
      }
    }
    if (typeof input.body !== "string" && !isFileInputValue(input.media)) {
      issues.push("input.body or input.media is required for an X Direct Message");
    }
    if (input.media_alt_text !== undefined && !isFileInputValue(input.media)) {
      issues.push("input.media_alt_text requires input.media");
    }
  }
  if (action === "posts.publish") {
    const hasPoll = Array.isArray(input.poll_options)
      || input.poll_duration_minutes !== undefined;
    if (
      hasPoll
      && (
        !Array.isArray(input.poll_options)
        || typeof input.poll_duration_minutes !== "number"
      )
    ) {
      issues.push(
        "input.poll_options and input.poll_duration_minutes must be supplied together",
      );
    }
    if (hasPoll && Array.isArray(input.media)) {
      issues.push("input.media and poll inputs are mutually exclusive");
    }
    if (
      typeof input.body !== "string"
      && !Array.isArray(input.media)
      && !hasPoll
    ) {
      issues.push(
        "input.body, input.media, or complete poll inputs are required for an X post",
      );
    }
    if (input.made_with_ai === true && !Array.isArray(input.media)) {
      issues.push(
        "input.made_with_ai can be true only when reviewed media is attached",
      );
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(input.media)) {
        issues.push("input.media_alt_texts requires input.media");
      } else if (
        !Array.isArray(input.media_alt_texts)
        || input.media_alt_texts.length !== input.media.length
      ) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
    xId("community_id", input.community_id);
  }
  if (action === "replies.create") {
    xId("target_post_id", input.target_post_id);
    if (typeof input.body !== "string" && !Array.isArray(input.media)) {
      issues.push("input.body or input.media is required for an X reply");
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(input.media)) {
        issues.push("input.media_alt_texts requires input.media");
      } else if (
        !Array.isArray(input.media_alt_texts)
        || input.media_alt_texts.length !== input.media.length
      ) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
  }
  if (action === "threads.publish") {
    const media = input.media;
    const indices = input.media_item_indices;
    if (Array.isArray(media) !== Array.isArray(indices)) {
      issues.push("input.media and input.media_item_indices must be supplied together");
    }
    if (
      Array.isArray(media)
      && Array.isArray(indices)
      && media.length !== indices.length
    ) {
      issues.push("input.media_item_indices must align one-to-one with input.media");
    }
    if (Array.isArray(indices) && Array.isArray(input.items)) {
      for (const [index, value] of indices.entries()) {
        if (
          typeof value === "number"
          && (
            !Number.isSafeInteger(value)
            || value < 1
            || value > input.items.length
          )
        ) {
          issues.push(
            `input.media_item_indices[${index}] must name an existing one-based thread item`,
          );
        }
      }
    }
    if (input.media_alt_texts !== undefined) {
      if (!Array.isArray(media)) {
        issues.push("input.media_alt_texts requires input.media");
      } else if (
        !Array.isArray(input.media_alt_texts)
        || input.media_alt_texts.length !== media.length
      ) {
        issues.push("input.media_alt_texts must align one-to-one with input.media");
      }
    }
  }
  if (action === "posts.repost" || action === "content.save") {
    xId("post_id", input.post_id);
  }
  for (const name of ["limit", "poll_duration_minutes"] as const) {
    const value = input[name];
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      issues.push(`input.${name} must be a safe integer`);
    }
  }
  if (
    action === "articles.publish"
    && input.cover_alt_text !== undefined
    && !isFileInputValue(input.cover)
  ) {
    issues.push("input.cover_alt_text requires input.cover");
  }
  return issues;
}
