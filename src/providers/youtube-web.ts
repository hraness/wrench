import { createHash } from "node:crypto";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_WALK_NODES = 250_000;
const MAX_WALK_DEPTH = 80;

type JsonRecord = Record<string, unknown>;

export type YouTubeInnertubeContext = {
  readonly client: Readonly<Record<string, string | number | boolean>>;
  readonly user?: Readonly<Record<string, string | boolean>>;
  readonly request?: Readonly<Record<string, boolean>>;
};

export type YouTubeBootstrapConfig = {
  readonly apiKey: string;
  readonly bootstrapLoggedIn: boolean;
  readonly clientName: string;
  readonly clientNameHeader: string;
  readonly clientVersion: string;
  readonly context: YouTubeInnertubeContext;
  readonly sessionIndex: string;
  readonly delegatedSessionId: string | null;
  readonly visitorData: string | null;
};

export type YouTubeProjectedItem = {
  readonly kind: "video" | "playlist" | "channel" | "post";
  readonly id: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly description: string | null;
  readonly published: string | null;
  readonly duration: string | null;
  readonly views: string | null;
};

export type YouTubeProjectedComment = {
  readonly id: string;
  readonly parentId: string | null;
  readonly authorChannelId: string | null;
  readonly author: string | null;
  readonly body: string;
  readonly published: string | null;
  readonly votes: string | null;
  readonly heartedByCreator: boolean;
  readonly pinned: boolean;
};

export type YouTubeProjectedPost = {
  readonly id: string;
  readonly authorChannelId: string | null;
  readonly author: string | null;
  readonly body: string;
  readonly published: string | null;
  readonly likes: string | null;
  readonly attachmentKinds: readonly string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum = 32_768,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function optionalBoundedString(value: unknown, maximum = 32_768): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\0\r]/u.test(value)
    ? value
    : null;
}

function boundedIntegerString(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 99) {
    return String(value);
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]?)$/u.test(value)) return value;
  throw new Error(`${label} must be an account index between 0 and 99`);
}

function balancedJsonObject(text: string, start: number): { readonly value: unknown; readonly end: number } {
  if (text[start] !== "{") throw new Error("YouTube configuration did not begin with an object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    if (index - start + 1 > MAX_CONFIG_BYTES) {
      throw new Error("YouTube configuration exceeded its reviewed byte limit");
    }
    try {
      return { value: JSON.parse(text.slice(start, index + 1)) as unknown, end: index + 1 };
    } catch {
      // Some first-party scripts use JavaScript object syntax rather than JSON.
      // Never evaluate it; reviewed fields must also appear in a strict JSON
      // ytcfg object or the bootstrap fails closed below.
      return { value: undefined, end: index + 1 };
    }
  }
  throw new Error("YouTube configuration contained an unterminated object");
}

function ytcfgObjects(html: string): readonly JsonRecord[] {
  if (html.length > MAX_CONFIG_BYTES) throw new Error("YouTube bootstrap exceeded its reviewed byte limit");
  const result: JsonRecord[] = [];
  const prefix = "ytcfg.set(";
  let offset = 0;
  while (offset < html.length) {
    const found = html.indexOf(prefix, offset);
    if (found < 0) break;
    const candidate = found + prefix.length;
    let objectStart = candidate;
    while (objectStart < html.length && /\s/u.test(html[objectStart]!)) objectStart += 1;
    if (html[objectStart] === "{") {
      const parsed = balancedJsonObject(html, objectStart);
      if (isRecord(parsed.value)) result.push(parsed.value);
      offset = parsed.end;
    } else {
      offset = candidate;
    }
  }
  if (result.length < 1) throw new Error("YouTube bootstrap omitted its ytcfg objects");
  return Object.freeze(result);
}

function uniqueConfigValue(configs: readonly JsonRecord[], key: string): unknown {
  const values = configs.filter((config) => Object.hasOwn(config, key)).map((config) => config[key]);
  if (values.length < 1) return undefined;
  const encoded = new Set(values.map((value) => JSON.stringify(value)));
  if (encoded.size !== 1) throw new Error(`YouTube bootstrap contained conflicting ${key} values`);
  return values[0];
}

function optionalContextScalar(
  value: JsonRecord,
  key: string,
  maximum: number,
): string | number | boolean | undefined {
  const candidate = value[key];
  if (typeof candidate === "boolean") return candidate;
  if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return candidate;
  if (
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= maximum
    && !/[\0\r]/u.test(candidate)
  ) return candidate;
  return undefined;
}

function reviewedContext(value: unknown, clientName: string, clientVersion: string): YouTubeInnertubeContext {
  const source = record(value, "YouTube INNERTUBE_CONTEXT");
  const sourceClient = record(source.client, "YouTube INNERTUBE_CONTEXT.client");
  const client: Record<string, string | number | boolean> = { clientName, clientVersion };
  for (const [key, maximum] of [
    ["hl", 32],
    ["gl", 8],
    ["visitorData", 4096],
    ["platform", 64],
    ["clientFormFactor", 64],
    ["originalUrl", 2048],
    ["utcOffsetMinutes", 16],
    ["timeZone", 128],
    ["userAgent", 1024],
  ] as const) {
    const candidate = optionalContextScalar(sourceClient, key, maximum);
    if (candidate !== undefined) client[key] = candidate;
  }
  const sourceUser = isRecord(source.user) ? source.user : null;
  const user: Record<string, string | boolean> = {};
  if (sourceUser !== null) {
    const lockedSafetyMode = sourceUser.lockedSafetyMode;
    if (typeof lockedSafetyMode === "boolean") user.lockedSafetyMode = lockedSafetyMode;
    const onBehalfOfUser = optionalBoundedString(sourceUser.onBehalfOfUser, 512);
    if (onBehalfOfUser !== null) user.onBehalfOfUser = onBehalfOfUser;
  }
  const sourceRequest = isRecord(source.request) ? source.request : null;
  const request = sourceRequest !== null && typeof sourceRequest.useSsl === "boolean"
    ? { useSsl: sourceRequest.useSsl }
    : undefined;
  return Object.freeze({
    client: Object.freeze(client),
    ...(Object.keys(user).length === 0 ? {} : { user: Object.freeze(user) }),
    ...(request === undefined ? {} : { request: Object.freeze(request) }),
  });
}

export function parseYouTubeBootstrapHtml(html: string): YouTubeBootstrapConfig {
  const configs = ytcfgObjects(html);
  const apiKey = boundedString(uniqueConfigValue(configs, "INNERTUBE_API_KEY"), "YouTube INNERTUBE_API_KEY", 256);
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(apiKey)) {
    throw new Error("YouTube INNERTUBE_API_KEY had an invalid public-key shape");
  }
  const contextValue = uniqueConfigValue(configs, "INNERTUBE_CONTEXT");
  const contextRecord = record(contextValue, "YouTube INNERTUBE_CONTEXT");
  const contextClient = record(contextRecord.client, "YouTube INNERTUBE_CONTEXT.client");
  const clientName = boundedString(
    contextClient.clientName ?? uniqueConfigValue(configs, "INNERTUBE_CONTEXT_CLIENT_NAME"),
    "YouTube client name",
    64,
  );
  if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(clientName)) throw new Error("YouTube client name is invalid");
  const clientVersion = boundedString(
    contextClient.clientVersion ?? uniqueConfigValue(configs, "INNERTUBE_CONTEXT_CLIENT_VERSION"),
    "YouTube client version",
    128,
  );
  if (!/^[A-Za-z0-9._-]{3,128}$/u.test(clientVersion)) throw new Error("YouTube client version is invalid");
  const clientNameHeader = boundedIntegerString(
    uniqueConfigValue(configs, "INNERTUBE_CONTEXT_CLIENT_NAME"),
    "YouTube numeric client name",
  );
  const loggedIn = uniqueConfigValue(configs, "LOGGED_IN");
  if (typeof loggedIn !== "boolean") throw new Error("YouTube bootstrap omitted its login-state flag");
  const sessionIndex = boundedIntegerString(
    uniqueConfigValue(configs, "SESSION_INDEX") ?? 0,
    "YouTube session index",
  );
  const delegatedSessionId = optionalBoundedString(
    uniqueConfigValue(configs, "DELEGATED_SESSION_ID"),
    512,
  );
  const context = reviewedContext(contextRecord, clientName, clientVersion);
  const visitorData = optionalBoundedString(context.client.visitorData, 4096);
  return Object.freeze({
    apiKey,
    bootstrapLoggedIn: loggedIn,
    clientName,
    clientNameHeader,
    clientVersion,
    context,
    sessionIndex,
    delegatedSessionId,
    visitorData,
  });
}

export function createYouTubeSapisidAuthorization(
  sapisid: string,
  nowMs: number,
  origin = YOUTUBE_ORIGIN,
): string {
  if (origin !== YOUTUBE_ORIGIN) throw new Error("YouTube SAPISIDHASH origin is not reviewed");
  if (
    typeof sapisid !== "string"
    || sapisid.length < 8
    || sapisid.length > 4096
    || /[\0\r\n\s]/u.test(sapisid)
  ) throw new Error("YouTube SAPISID cookie is invalid");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("YouTube authorization time is invalid");
  const timestamp = Math.floor(nowMs / 1000);
  const digest = createHash("sha1")
    .update(`${timestamp} ${sapisid} ${origin}`, "utf8")
    .digest("hex");
  return `SAPISIDHASH ${timestamp}_${digest}`;
}

function walkRecords(value: unknown, label: string): readonly JsonRecord[] {
  const result: JsonRecord[] = [];
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_WALK_NODES) throw new Error(`${label} exceeded its reviewed node limit`);
    if (current.depth > MAX_WALK_DEPTH) throw new Error(`${label} exceeded its reviewed nesting limit`);
    if (Array.isArray(current.value)) {
      if (current.value.length > 10_000) throw new Error(`${label} contained an oversized array`);
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    result.push(current.value);
    const values = Object.values(current.value);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ value: values[index], depth: current.depth + 1 });
    }
  }
  return Object.freeze(result);
}

function simpleText(value: unknown, maximum = 32_768): string | null {
  if (typeof value === "string") return optionalBoundedString(value, maximum);
  if (!isRecord(value)) return null;
  const direct = optionalBoundedString(value.simpleText, maximum);
  if (direct !== null) return direct;
  if (!Array.isArray(value.runs) || value.runs.length > 1_000) return null;
  let result = "";
  for (const run of value.runs) {
    if (!isRecord(run) || typeof run.text !== "string" || run.text.length > maximum) return null;
    result += run.text;
    if (result.length > maximum) return null;
  }
  return result.length > 0 ? result : null;
}

function channelIdFromEndpoint(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const browse = isRecord(value.browseEndpoint) ? value.browseEndpoint : null;
  const candidate = browse?.browseId;
  return typeof candidate === "string" && /^UC[A-Za-z0-9_-]{22}$/u.test(candidate)
    ? candidate
    : null;
}

function canonicalYouTubePath(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const command = isRecord(value.commandMetadata) ? value.commandMetadata : null;
  const web = command !== null && isRecord(command.webCommandMetadata) ? command.webCommandMetadata : null;
  const url = optionalBoundedString(web?.url, 2048);
  return url !== null && url.startsWith("/") && !url.startsWith("//") ? url : null;
}

function uniqueStrings(values: readonly (string | null)[], label: string): readonly string[] {
  const unique = [...new Set(values.filter((value): value is string => value !== null))];
  if (unique.length > 1000) throw new Error(`${label} exceeded its reviewed identity limit`);
  return Object.freeze(unique);
}

function identityCandidates(value: unknown): readonly string[] {
  const records = walkRecords(value, "YouTube account response");
  return uniqueStrings(records.flatMap((item) => {
    const candidates: (string | null)[] = [];
    for (const key of ["channelId", "externalChannelId", "browseId"] as const) {
      const candidate = item[key];
      candidates.push(
        typeof candidate === "string" && /^UC[A-Za-z0-9_-]{22}$/u.test(candidate)
          ? candidate
          : null,
      );
    }
    return candidates;
  }), "YouTube account response");
}

function selectedIdentityCandidates(value: unknown): readonly string[] {
  const selected: string[] = [];
  for (const item of walkRecords(value, "YouTube account list response")) {
    if (item.isSelected !== true && item.selected !== true && item.isCurrentAccount !== true) continue;
    selected.push(...identityCandidates(item));
  }
  return uniqueStrings(selected, "YouTube selected account response");
}

function selectedGaiaCandidates(value: unknown): readonly string[] {
  const selected: string[] = [];
  for (const item of walkRecords(value, "YouTube account list response")) {
    if (item.isSelected !== true && item.selected !== true && item.isCurrentAccount !== true) continue;
    for (const nested of walkRecords(item, "YouTube selected account")) {
      const candidate = nested.obfuscatedGaiaId ?? nested.gaiaId;
      if (typeof candidate === "string" && /^[0-9]{1,32}$/u.test(candidate)) {
        selected.push(candidate);
      }
    }
  }
  return uniqueStrings(selected, "YouTube selected Gaia account");
}

export function youtubeCurrentSubject(
  accountMenu: unknown,
  accountsList: unknown,
  delegatedSessionId: string | null = null,
): string {
  assertYouTubeResponseSuccess(accountMenu, "YouTube account menu");
  assertYouTubeResponseSuccess(accountsList, "YouTube accounts list");
  const menuCandidates = identityCandidates(accountMenu);
  const selectedCandidates = selectedIdentityCandidates(accountsList);
  const listCandidates = selectedCandidates.length > 0 ? selectedCandidates : identityCandidates(accountsList);
  const intersection = menuCandidates.filter((candidate) => listCandidates.includes(candidate));
  const candidates = intersection.length > 0
    ? uniqueStrings(intersection, "YouTube current account")
    : menuCandidates.length === 1 && listCandidates.length === 0
      ? menuCandidates
      : listCandidates.length === 1 && menuCandidates.length === 0
        ? listCandidates
        : [];
  if (candidates.length !== 1) {
    throw new Error("YouTube account endpoints did not bind one unique current channel");
  }
  const gaiaCandidates = selectedGaiaCandidates(accountsList);
  if (gaiaCandidates.length > 1) {
    throw new Error("YouTube accounts list did not bind one unique selected Gaia account");
  }
  if (
    delegatedSessionId !== null
    && !/^[A-Za-z0-9_-]{1,128}$/u.test(delegatedSessionId)
  ) throw new Error("YouTube bootstrap exposed an invalid delegated-session identity");
  return [
    `youtube:channel:${candidates[0]!}`,
    ...(gaiaCandidates.length === 0 ? [] : [`gaia:${gaiaCandidates[0]!}`]),
    ...(delegatedSessionId === null ? [] : [`delegate:${delegatedSessionId}`]),
  ].join("/");
}

export function assertYouTubeResponseSuccess(value: unknown, label: string): JsonRecord {
  const envelope = record(value, `${label} response`);
  if (envelope.error !== undefined) throw new Error(`${label} response contained an API error`);
  for (const item of walkRecords(envelope.alerts, `${label} alerts`)) {
    if (item.type === "ERROR") throw new Error(`${label} response contained an error alert`);
  }
  return envelope;
}

function projectionFromRenderer(renderer: JsonRecord): YouTubeProjectedItem | null {
  const videoId = optionalBoundedString(renderer.videoId, 64);
  const playlistId = optionalBoundedString(renderer.playlistId, 256);
  const postId = optionalBoundedString(renderer.postId, 256);
  const directChannelId = optionalBoundedString(renderer.channelId, 64);
  const kind = videoId !== null && /^[A-Za-z0-9_-]{11}$/u.test(videoId)
    ? "video"
    : playlistId !== null && /^[A-Za-z0-9_-]{2,256}$/u.test(playlistId)
      ? "playlist"
      : postId !== null && /^[A-Za-z0-9_-]{10,256}$/u.test(postId)
        ? "post"
        : directChannelId !== null && /^UC[A-Za-z0-9_-]{22}$/u.test(directChannelId)
          ? "channel"
          : null;
  if (kind === null) return null;
  const id = kind === "video"
    ? videoId!
    : kind === "playlist"
      ? playlistId!
      : kind === "post"
        ? postId!
        : directChannelId!;
  const ownerEndpoint = isRecord(renderer.ownerText) && Array.isArray(renderer.ownerText.runs)
    ? (renderer.ownerText.runs.find(isRecord)?.navigationEndpoint ?? null)
    : null;
  const authorEndpoint = isRecord(renderer.authorText) && Array.isArray(renderer.authorText.runs)
    ? (renderer.authorText.runs.find(isRecord)?.navigationEndpoint ?? null)
    : null;
  const channelId = kind === "channel"
    ? id
    : channelIdFromEndpoint(ownerEndpoint) ?? channelIdFromEndpoint(authorEndpoint)
      ?? optionalBoundedString(renderer.channelId, 64);
  const title = simpleText(renderer.title) ?? simpleText(renderer.headline)
    ?? simpleText(renderer.contentText) ?? simpleText(renderer.name);
  const endpoint = renderer.navigationEndpoint ?? renderer.endpoint;
  const url = canonicalYouTubePath(endpoint)
    ?? (kind === "video" ? `/watch?v=${id}` : kind === "channel" ? `/channel/${id}` : null);
  return Object.freeze({
    kind,
    id,
    title,
    url,
    channelId: channelId !== null && /^UC[A-Za-z0-9_-]{22}$/u.test(channelId) ? channelId : null,
    channelName: simpleText(renderer.ownerText) ?? simpleText(renderer.shortBylineText)
      ?? simpleText(renderer.longBylineText) ?? simpleText(renderer.authorText),
    description: simpleText(renderer.descriptionSnippet, 4096)
      ?? simpleText(renderer.descriptionText, 4096)
      ?? simpleText(renderer.contentText, 4096),
    published: simpleText(renderer.publishedTimeText, 256),
    duration: simpleText(renderer.lengthText, 256),
    views: simpleText(renderer.viewCountText, 256)
      ?? simpleText(renderer.shortViewCountText, 256),
  });
}

export function projectYouTubeItems(
  value: unknown,
  limit: number,
): { readonly items: readonly YouTubeProjectedItem[]; readonly continuation: string | null; readonly truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("YouTube projection limit must be between 1 and 100");
  }
  const records = walkRecords(value, "YouTube browse response");
  const items: YouTubeProjectedItem[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    const renderer = Object.entries(item)
      .filter(([key, candidate]) => key.endsWith("Renderer") && isRecord(candidate))
      .map(([, candidate]) => candidate as JsonRecord)
      .find((candidate) => projectionFromRenderer(candidate) !== null);
    const projection = renderer === undefined ? projectionFromRenderer(item) : projectionFromRenderer(renderer);
    if (projection === null) continue;
    const key = `${projection.kind}:${projection.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(projection);
  }
  const continuations = uniqueStrings(records.map((item) => {
    const command = isRecord(item.continuationCommand) ? item.continuationCommand : null;
    const token = optionalBoundedString(command?.token, 8192);
    return token;
  }), "YouTube continuation");
  return Object.freeze({
    items: Object.freeze(items.slice(0, limit)),
    continuation: continuations[0] ?? null,
    truncated: items.length > limit || continuations.length > 0,
  });
}

export function projectYouTubeMedia(value: unknown, expectedVideoId: string): Readonly<Record<string, unknown>> {
  const envelope = assertYouTubeResponseSuccess(value, "YouTube player");
  const details = record(envelope.videoDetails, "YouTube player.videoDetails");
  if (details.videoId !== expectedVideoId) throw new Error("YouTube player response did not bind the requested video");
  const microformat = isRecord(envelope.microformat) && isRecord(envelope.microformat.playerMicroformatRenderer)
    ? envelope.microformat.playerMicroformatRenderer
    : {};
  const keywords = Array.isArray(details.keywords)
    ? details.keywords.filter((item): item is string =>
      typeof item === "string" && item.length > 0 && item.length <= 256).slice(0, 100)
    : [];
  const countries = Array.isArray(microformat.availableCountries)
    ? microformat.availableCountries.filter((item): item is string =>
      typeof item === "string" && /^[A-Z]{2}$/u.test(item)).slice(0, 300)
    : [];
  const playability = isRecord(envelope.playabilityStatus) ? envelope.playabilityStatus : {};
  return Object.freeze({
    videoId: expectedVideoId,
    title: optionalBoundedString(details.title, 1024),
    channelId: optionalBoundedString(details.channelId, 64),
    author: optionalBoundedString(details.author, 512),
    lengthSeconds: optionalBoundedString(details.lengthSeconds, 32),
    viewCount: optionalBoundedString(details.viewCount, 32),
    shortDescription: optionalBoundedString(details.shortDescription, 16_384),
    keywords: Object.freeze(keywords),
    isLiveContent: details.isLiveContent === true,
    playability: optionalBoundedString(playability.status, 64),
    publishDate: optionalBoundedString(microformat.publishDate, 64),
    uploadDate: optionalBoundedString(microformat.uploadDate, 64),
    category: optionalBoundedString(microformat.category, 256),
    familySafe: microformat.isFamilySafe === true,
    availableCountries: Object.freeze(countries),
  });
}

function attachmentKinds(renderer: JsonRecord): readonly string[] {
  const keys = new Set<string>();
  for (const item of walkRecords(renderer, "YouTube Community post")) {
    for (const key of Object.keys(item)) {
      if (key === "backstageImageRenderer" || key === "imageRenderer") keys.add("image");
      if (key === "videoRenderer") keys.add("video");
      if (key === "pollRenderer" || key === "backstagePollRenderer") keys.add("poll");
      if (key === "playlistRenderer") keys.add("playlist");
      if (key === "quizRenderer") keys.add("quiz");
    }
  }
  return Object.freeze([...keys].sort());
}

export function projectYouTubePost(value: unknown, expectedPostId: string): YouTubeProjectedPost {
  assertYouTubeResponseSuccess(value, "YouTube Community post");
  const renderers: JsonRecord[] = [];
  for (const item of walkRecords(value, "YouTube Community post response")) {
    for (const key of ["backstagePostRenderer", "postRenderer"] as const) {
      if (isRecord(item[key]) && item[key].postId === expectedPostId) renderers.push(item[key]);
    }
  }
  if (renderers.length !== 1) throw new Error("YouTube Community response did not bind one exact requested post");
  const renderer = renderers[0]!;
  const body = simpleText(renderer.contentText, 16_384) ?? simpleText(renderer.content, 16_384);
  if (body === null) throw new Error("YouTube Community post omitted its bounded body");
  const authorRun = isRecord(renderer.authorText) && Array.isArray(renderer.authorText.runs)
    ? renderer.authorText.runs.find(isRecord)
    : undefined;
  return Object.freeze({
    id: expectedPostId,
    authorChannelId: channelIdFromEndpoint(authorRun?.navigationEndpoint),
    author: simpleText(renderer.authorText, 512),
    body,
    published: simpleText(renderer.publishedTimeText, 256),
    likes: simpleText(renderer.voteCount, 256)
      ?? simpleText(renderer.likeCount, 256),
    attachmentKinds: attachmentKinds(renderer),
  });
}

export function youtubePostBrowseRequest(
  value: unknown,
  expectedPostId: string,
): { readonly browseId: string; readonly params: string } {
  assertYouTubeResponseSuccess(value, "YouTube Community URL resolution");
  const expectedPath = `/post/${expectedPostId}`;
  const candidates: { readonly browseId: string; readonly params: string }[] = [];
  for (const item of walkRecords(value, "YouTube Community URL resolution")) {
    const endpoint = isRecord(item.endpoint) ? item.endpoint : item;
    const browse = isRecord(endpoint.browseEndpoint) ? endpoint.browseEndpoint : null;
    if (browse === null) continue;
    const command = isRecord(endpoint.commandMetadata) ? endpoint.commandMetadata : null;
    const web = command !== null && isRecord(command.webCommandMetadata)
      ? command.webCommandMetadata
      : null;
    const returnedPath = optionalBoundedString(web?.url, 2048);
    const browseId = optionalBoundedString(browse.browseId, 256);
    const params = optionalBoundedString(browse.params, 8192);
    if (returnedPath !== expectedPath || browseId === null || params === null) continue;
    if (!/^[A-Za-z0-9_-]{2,256}$/u.test(browseId) || !/^[A-Za-z0-9_=-]{8,8192}$/u.test(params)) {
      throw new Error("YouTube Community URL resolution returned an invalid browse binding");
    }
    candidates.push({ browseId, params });
  }
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.browseId}\0${candidate.params}`,
    candidate,
  ]));
  if (unique.size !== 1) {
    throw new Error("YouTube Community URL resolution did not bind one exact post browse request");
  }
  return Object.freeze(unique.values().next().value!);
}

function commentProjection(renderer: JsonRecord): YouTubeProjectedComment | null {
  const id = optionalBoundedString(renderer.commentId, 256);
  if (id === null || !/^[A-Za-z0-9_.-]{8,256}$/u.test(id)) return null;
  const body = simpleText(renderer.contentText, 16_384)
    ?? simpleText(renderer.commentText, 16_384)
    ?? simpleText(renderer.content, 16_384);
  if (body === null) return null;
  const authorRun = isRecord(renderer.authorText) && Array.isArray(renderer.authorText.runs)
    ? renderer.authorText.runs.find(isRecord)
    : undefined;
  const parentId = optionalBoundedString(renderer.parentCommentId, 256);
  return Object.freeze({
    id,
    parentId,
    authorChannelId: channelIdFromEndpoint(renderer.authorEndpoint)
      ?? channelIdFromEndpoint(authorRun?.navigationEndpoint),
    author: simpleText(renderer.authorText, 512),
    body,
    published: simpleText(renderer.publishedTimeText, 256),
    votes: simpleText(renderer.voteCount, 256),
    heartedByCreator: renderer.isHearted === true
      || isRecord(renderer.creatorHeart) || isRecord(renderer.creatorHeartButton),
    pinned: renderer.pinnedCommentBadge !== undefined || renderer.isPinned === true,
  });
}

function entityCommentProjection(payload: JsonRecord): YouTubeProjectedComment | null {
  const properties = isRecord(payload.properties) ? payload.properties : null;
  const author = isRecord(payload.author) ? payload.author : null;
  const toolbar = isRecord(payload.toolbar) ? payload.toolbar : null;
  if (properties === null) return null;
  const id = optionalBoundedString(properties.commentId, 256);
  if (id === null || !/^[A-Za-z0-9_.-]{8,256}$/u.test(id)) return null;
  const content = isRecord(properties.content) ? properties.content : null;
  const body = simpleText(properties.content, 16_384)
    ?? optionalBoundedString(content?.content, 16_384);
  if (body === null) return null;
  const channelId = optionalBoundedString(author?.channelId, 64);
  const parentId = optionalBoundedString(properties.parentCommentId, 256);
  return Object.freeze({
    id,
    parentId: parentId !== null && /^[A-Za-z0-9_.-]{8,256}$/u.test(parentId) ? parentId : null,
    authorChannelId: channelId !== null && /^UC[A-Za-z0-9_-]{22}$/u.test(channelId)
      ? channelId
      : null,
    author: optionalBoundedString(author?.displayName, 512),
    body,
    published: optionalBoundedString(properties.publishedTime, 256),
    votes: optionalBoundedString(toolbar?.likeCountNotliked, 256)
      ?? optionalBoundedString(toolbar?.likeCountLiked, 256),
    heartedByCreator: toolbar?.heartState === "TOOLBAR_HEART_STATE_HEARTED",
    pinned: properties.isPinned === true,
  });
}

export function projectYouTubeComments(
  value: unknown,
  limit: number,
): { readonly comments: readonly YouTubeProjectedComment[]; readonly continuation: string | null; readonly truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("YouTube comment limit must be between 1 and 100");
  }
  assertYouTubeResponseSuccess(value, "YouTube comments");
  const records = walkRecords(value, "YouTube comments response");
  const comments: YouTubeProjectedComment[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    const entity = isRecord(item.commentEntityPayload)
      ? entityCommentProjection(item.commentEntityPayload)
      : null;
    const projected = entity ?? [
      isRecord(item.commentRenderer) ? item.commentRenderer : null,
      isRecord(item.commentViewModel) ? item.commentViewModel : null,
      item,
    ].map((candidate) => candidate === null ? null : commentProjection(candidate))
      .find((candidate): candidate is YouTubeProjectedComment => candidate !== null);
    if (projected === undefined || seen.has(projected.id)) continue;
    seen.add(projected.id);
    comments.push(projected);
  }
  const continuations = uniqueStrings(records.map((item) => {
    const command = isRecord(item.continuationCommand) ? item.continuationCommand : null;
    return optionalBoundedString(command?.token, 8192);
  }), "YouTube comments continuation");
  return Object.freeze({
    comments: Object.freeze(comments.slice(0, limit)),
    continuation: continuations[0] ?? null,
    truncated: comments.length > limit || continuations.length > 0,
  });
}

export function findYouTubeCommentsContinuation(value: unknown): string | null {
  for (const item of walkRecords(value, "YouTube next response")) {
    const section = isRecord(item.itemSectionRenderer) ? item.itemSectionRenderer : null;
    const targetId = optionalBoundedString(section?.targetId, 256);
    if (section === null || targetId === null || !targetId.includes("comment")) continue;
    const tokens = uniqueStrings(walkRecords(section, "YouTube comments section").map((recordValue) => {
      const command = isRecord(recordValue.continuationCommand) ? recordValue.continuationCommand : null;
      return optionalBoundedString(command?.token, 8192);
    }), "YouTube comments section continuation");
    if (tokens.length > 1) throw new Error("YouTube comments section exposed ambiguous continuations");
    if (tokens.length === 1) return tokens[0]!;
  }
  return null;
}

export function assertYouTubeVideoBinding(value: unknown, expectedVideoId: string, label: string): void {
  const matches = new Set<string>();
  for (const item of walkRecords(value, label)) {
    for (const key of ["videoId", "currentVideoId"] as const) {
      const candidate = item[key];
      if (typeof candidate === "string" && /^[A-Za-z0-9_-]{11}$/u.test(candidate)) matches.add(candidate);
    }
  }
  if (!matches.has(expectedVideoId)) throw new Error(`${label} did not bind the requested video`);
}

export function youtubeLikeState(value: unknown, expectedVideoId: string): boolean {
  assertYouTubeResponseSuccess(value, "YouTube like readback");
  assertYouTubeVideoBinding(value, expectedVideoId, "YouTube like readback");
  const states = new Set<boolean>();
  for (const item of walkRecords(value, "YouTube like readback")) {
    const icon = isRecord(item.defaultIcon) ? item.defaultIcon.iconType
      : isRecord(item.icon) ? item.icon.iconType
        : null;
    if (icon === "LIKE" && typeof item.isToggled === "boolean") states.add(item.isToggled);
    if (item.likeStatus === "LIKE") states.add(true);
    if (item.likeStatus === "INDIFFERENT") states.add(false);
  }
  if (states.size !== 1) throw new Error("YouTube like readback did not expose one exact state");
  return states.values().next().value!;
}

function exactOpaqueParams(value: unknown, label: string): string {
  const params = boundedString(value, label, 8192);
  if (!/^[A-Za-z0-9_=%-]{8,8192}$/u.test(params)) {
    throw new Error(`${label} had an invalid first-party parameter shape`);
  }
  return params;
}

export function youtubeLikeMutationRequest(
  value: unknown,
  expectedVideoId: string,
  desired: boolean,
): {
  readonly endpoint: "like/like" | "like/removelike";
  readonly body: Readonly<Record<string, unknown>>;
} {
  assertYouTubeResponseSuccess(value, "YouTube like command discovery");
  assertYouTubeVideoBinding(value, expectedVideoId, "YouTube like command discovery");
  const apiUrl = desired ? "/youtubei/v1/like/like" : "/youtubei/v1/like/removelike";
  const expectedStatus = desired ? "LIKE" : "INDIFFERENT";
  const paramsKey = desired ? "likeParams" : "removeLikeParams";
  const candidates: Readonly<Record<string, unknown>>[] = [];
  const likeControls: unknown[] = [];
  for (const item of walkRecords(value, "YouTube like-control discovery")) {
    const primary = isRecord(item.videoPrimaryInfoRenderer)
      ? item.videoPrimaryInfoRenderer
      : null;
    const actions = primary !== null && isRecord(primary.videoActions)
      ? primary.videoActions
      : null;
    const menu = actions !== null && isRecord(actions.menuRenderer) ? actions.menuRenderer : null;
    if (!Array.isArray(menu?.topLevelButtons) || menu.topLevelButtons.length > 100) continue;
    for (const button of menu.topLevelButtons) {
      if (!isRecord(button)) continue;
      const modern = isRecord(button.segmentedLikeDislikeButtonViewModel)
        ? button.segmentedLikeDislikeButtonViewModel
        : null;
      const legacy = isRecord(button.segmentedLikeDislikeButtonRenderer)
        ? button.segmentedLikeDislikeButtonRenderer
        : null;
      if (modern !== null && modern.likeButtonViewModel !== undefined) {
        likeControls.push(modern.likeButtonViewModel);
      }
      if (legacy !== null && legacy.likeButton !== undefined) likeControls.push(legacy.likeButton);
    }
  }
  for (const root of likeControls) {
    for (const item of walkRecords(root, "YouTube like control")) {
      const command = isRecord(item.commandMetadata) ? item.commandMetadata : null;
      const web = command !== null && isRecord(command.webCommandMetadata)
        ? command.webCommandMetadata
        : null;
      const payload = isRecord(item.likeEndpoint) ? item.likeEndpoint : null;
      if (web?.apiUrl !== apiUrl || payload === null) continue;
      const target = record(payload.target, "YouTube like command target");
      if (target.videoId !== expectedVideoId || payload.status !== expectedStatus) continue;
      candidates.push(Object.freeze({
        status: expectedStatus,
        target: Object.freeze({ videoId: expectedVideoId }),
        [paramsKey]: exactOpaqueParams(payload[paramsKey], `YouTube ${paramsKey}`),
      }));
    }
  }
  const unique = new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate]));
  if (unique.size !== 1) throw new Error("YouTube did not expose one exact current like command");
  return Object.freeze({
    endpoint: desired ? "like/like" : "like/removelike",
    body: unique.values().next().value!,
  });
}

export function youtubeWatchLaterState(value: unknown, expectedVideoId: string): boolean {
  assertYouTubeResponseSuccess(value, "YouTube save readback");
  assertYouTubeVideoBinding(value, expectedVideoId, "YouTube save readback");
  const states = new Set<boolean>();
  for (const item of walkRecords(value, "YouTube save readback")) {
    if (item.playlistId !== "WL") continue;
    if (!Array.isArray(item.actions) || item.actions.length > 100) continue;
    for (const action of item.actions) {
      if (!isRecord(action)) continue;
      if (action.action === "ACTION_ADD_VIDEO" && action.addedVideoId === expectedVideoId) {
        states.add(false);
      }
      if (action.action === "ACTION_REMOVE_VIDEO" && action.removedVideoId === expectedVideoId) {
        states.add(true);
      }
    }
  }
  if (states.size !== 1) throw new Error("YouTube save readback did not expose one exact Watch Later state");
  return states.values().next().value!;
}

export function youtubeSubscriptionMutationRequest(
  value: unknown,
  expectedChannelId: string,
  desired: boolean,
): {
  readonly endpoint: "subscription/subscribe" | "subscription/unsubscribe";
  readonly body: Readonly<Record<string, unknown>>;
} {
  assertYouTubeResponseSuccess(value, "YouTube subscription command discovery");
  const apiUrl = desired
    ? "/youtubei/v1/subscription/subscribe"
    : "/youtubei/v1/subscription/unsubscribe";
  const endpointKey = desired ? "subscribeEndpoint" : "unsubscribeEndpoint";
  const candidates: Readonly<Record<string, unknown>>[] = [];
  for (const item of walkRecords(value, "YouTube subscription command discovery")) {
    const command = isRecord(item.commandMetadata) ? item.commandMetadata : null;
    const web = command !== null && isRecord(command.webCommandMetadata)
      ? command.webCommandMetadata
      : null;
    const payload = isRecord(item[endpointKey]) ? item[endpointKey] : null;
    if (web?.apiUrl !== apiUrl || payload === null) continue;
    if (
      !Array.isArray(payload.channelIds)
      || payload.channelIds.length !== 1
      || payload.channelIds[0] !== expectedChannelId
    ) continue;
    candidates.push(Object.freeze({
      channelIds: Object.freeze([expectedChannelId]),
      params: exactOpaqueParams(payload.params, "YouTube subscription params"),
    }));
  }
  const unique = new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate]));
  if (unique.size !== 1) {
    throw new Error("YouTube did not expose one exact current subscription command");
  }
  return Object.freeze({
    endpoint: desired ? "subscription/subscribe" : "subscription/unsubscribe",
    body: unique.values().next().value!,
  });
}

export function youtubeSubscriptionState(value: unknown, expectedChannelId: string): boolean {
  assertYouTubeResponseSuccess(value, "YouTube subscription readback");
  const channelIds = new Set<string>();
  const entityStates = new Set<boolean>();
  const legacyStates = new Set<boolean>();
  for (const item of walkRecords(value, "YouTube subscription readback")) {
    for (const key of ["channelId", "externalId", "browseId"] as const) {
      const candidate = item[key];
      if (typeof candidate === "string" && /^UC[A-Za-z0-9_-]{22}$/u.test(candidate)) {
        channelIds.add(candidate);
      }
    }
    const stateEntity = isRecord(item.subscriptionStateEntity)
      ? item.subscriptionStateEntity
      : null;
    if (typeof stateEntity?.subscribed === "boolean") entityStates.add(stateEntity.subscribed);
    if (typeof item.subscribed === "boolean") legacyStates.add(item.subscribed);
    if (item.subscriptionState === "SUBSCRIBED") legacyStates.add(true);
    if (item.subscriptionState === "NOT_SUBSCRIBED") legacyStates.add(false);
  }
  if (!channelIds.has(expectedChannelId)) {
    throw new Error("YouTube subscription readback did not bind the requested channel");
  }
  const states = entityStates.size > 0 ? entityStates : legacyStates;
  if (states.size !== 1) throw new Error("YouTube subscription readback did not expose one exact state");
  return states.values().next().value!;
}
