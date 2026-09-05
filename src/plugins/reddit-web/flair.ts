import type { InputField, InputSchema } from "../../model";
import type { WebSessionContract } from "../../web-session-contract-definitions";

export const REDDIT_FLAIR_OPERATION_NAMES = [
  "flair.user.choices",
  "flair.post.choices",
  "flair.user.select",
  "flair.post.select",
] as const;

export type RedditFlairOperation = (typeof REDDIT_FLAIR_OPERATION_NAMES)[number];

type FlairChoicesTarget = Readonly<{
  kind: "user" | "post";
  community: string;
}>;

type FlairSelectionTarget =
  | Readonly<{ kind: "user"; community: string }>
  | Readonly<{ kind: "post"; community: string; postId: string }>;

export type RedditFlairInput =
  | Readonly<{ action: "choices"; target: FlairChoicesTarget }>
  | Readonly<{
      action: "select";
      target: FlairSelectionTarget;
      templateId: string;
      expectedText: string;
    }>;

export type RedditFlairChoice = Readonly<{
  templateId: string;
  text: string;
  textEditable: boolean;
  position: "left" | "right";
  selected: boolean;
}>;

export type RedditFlairChoices = Readonly<{
  schemaVersion: 1;
  community: string;
  kind: "user" | "post";
  choices: readonly RedditFlairChoice[];
  selectedTemplateId: string | null;
  selectedText: string | null;
}>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set(required);
  if (
    keys.length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) throw new Error(`${label} changed its reviewed fields`);
}

function templateId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)
  ) throw new Error(`${label} must be a canonical template ID`);
  return value;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function position(value: unknown, label: string): "left" | "right" {
  if (value !== "left" && value !== "right") {
    throw new Error(`${label} must be left or right`);
  }
  return value;
}

function cssClass(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (
    typeof value !== "string"
    || value.length > 128
    || /[^A-Za-z0-9 _-]/u.test(value)
  ) throw new Error(`${label} changed shape`);
}

function htmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...attributes.matchAll(new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "giu",
  ))];
  if (matches.length > 1) {
    throw new Error(`Reddit flair selector repeated its ${name} attribute`);
  }
  const match = matches[0];
  return match?.[1] ?? match?.[2] ?? null;
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(
          decimal ?? hexadecimal!,
          decimal === undefined ? 16 : 10,
        );
        if (
          !Number.isSafeInteger(codePoint)
          || codePoint < 0
          || codePoint > 0x10ffff
        ) return "\uFFFD";
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return "\uFFFD";
        }
      }
      switch (named?.toLowerCase()) {
        case "amp": return "&";
        case "apos": return "'";
        case "gt": return ">";
        case "lt": return "<";
        case "nbsp": return " ";
        case "quot": return "\"";
        default: return entity;
      }
    },
  );
}

function plainHtmlText(value: string, label: string): string {
  const result = decodeHtml(value.replace(/<[^>]*>/gu, ""))
    .replace(/\s+/gu, " ")
    .trim();
  return text(result, label);
}

function classTokens(attributes: string): readonly string[] {
  const value = htmlAttribute(attributes, "class");
  return value === null
    ? Object.freeze([])
    : Object.freeze(value.trim().split(/\s+/u).filter(Boolean));
}

function hasClass(html: string, tag: string, className: string): boolean {
  const expression = new RegExp(`<${tag}\\b([^>]*)>`, "giu");
  return [...html.matchAll(expression)].some((match) =>
    classTokens(match[1] ?? "").includes(className));
}

function parseRedditFlairChoicesHtml(
  value: string,
  target: FlairChoicesTarget,
): RedditFlairChoices {
  if (
    value.length < 1
    || new TextEncoder().encode(value).byteLength > 512 * 1024
    || value.includes("\0")
  ) throw new Error("Reddit flair selector HTML exceeded its reviewed bound");
  if (/<(?:body|html|iframe|script)\b/iu.test(value)) {
    throw new Error("Reddit flair selector returned a full or active document");
  }
  const headings = [...value.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/giu)];
  if (
    headings.length !== 1
    || plainHtmlText(headings[0]?.[1] ?? "", "Reddit flair selector heading").length < 1
  ) throw new Error("Reddit flair selector changed its heading");

  const listItems = [...value.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/giu)];
  const openingItems = [...value.matchAll(/<li\b[^>]*>/giu)].length;
  const closingItems = [...value.matchAll(/<\/li\s*>/giu)].length;
  if (openingItems !== listItems.length || closingItems !== listItems.length) {
    throw new Error("Reddit flair selector changed its list structure");
  }

  if (listItems.length === 0) {
    const errors = [...value.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/giu)]
      .filter((match) => classTokens(match[1] ?? "").includes("error"));
    if (
      errors.length !== 1
      || plainHtmlText(errors[0]?.[2] ?? "", "Reddit flair unavailable text").length < 1
      || hasClass(value, "div", "flairoptionpane")
      || /<form\b/iu.test(value)
    ) throw new Error("Reddit flair selector omitted its reviewed unavailable state");
    return Object.freeze({
      schemaVersion: 1,
      community: target.community,
      kind: target.kind,
      choices: Object.freeze([]),
      selectedTemplateId: null,
      selectedText: null,
    });
  }

  if (!hasClass(value, "div", "flairoptionpane")) {
    throw new Error("Reddit flair selector omitted its option pane");
  }
  const forms = [...value.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)]
    .filter((match) => decodeHtml(htmlAttribute(match[1] ?? "", "action") ?? "")
      === "/post/selectflair");
  if (forms.length !== 1) {
    throw new Error("Reddit flair selector changed its selection form");
  }
  const templateInputs = [...(forms[0]?.[2] ?? "").matchAll(/<input\b([^>]*)>/giu)]
    .filter((match) => htmlAttribute(match[1] ?? "", "name") === "flair_template_id");
  if (
    templateInputs.length !== 1
    || htmlAttribute(templateInputs[0]?.[1] ?? "", "type")?.toLowerCase() !== "hidden"
  ) throw new Error("Reddit flair selector changed its template binding");

  const allowedClasses = new Set([
    "flairsample-left",
    "flairsample-right",
    "selected",
    "texteditable",
  ]);
  const seen = new Set<string>();
  const choices = listItems.map((match, index): RedditFlairChoice => {
    const attributes = match[1] ?? "";
    const classes = classTokens(attributes);
    if (
      new Set(classes).size !== classes.length
      || classes.some((candidate) => !allowedClasses.has(candidate))
    ) {
      throw new Error(`Reddit flair choice ${index} changed its class set`);
    }
    const positions = classes.filter((candidate) =>
      candidate === "flairsample-left" || candidate === "flairsample-right");
    if (positions.length !== 1) {
      throw new Error(`Reddit flair choice ${index} changed its position`);
    }
    const id = templateId(
      htmlAttribute(attributes, "id"),
      `Reddit flair choice ${index} template ID`,
    );
    if (seen.has(id)) throw new Error("Reddit flair response repeated a template ID");
    seen.add(id);
    const labels = [...(match[2] ?? "").matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/giu)]
      .filter((span) => {
        const tokens = classTokens(span[1] ?? "");
        return tokens.includes("flair") || tokens.includes("linkflairlabel");
      });
    if (labels.length !== 1) {
      throw new Error(`Reddit flair choice ${index} changed its visible label`);
    }
    return Object.freeze({
      templateId: id,
      text: plainHtmlText(labels[0]?.[2] ?? "", `Reddit flair choice ${index} text`),
      textEditable: classes.includes("texteditable"),
      position: positions[0] === "flairsample-left" ? "left" : "right",
      selected: classes.includes("selected"),
    });
  });
  const selected = choices.filter((choice) => choice.selected);
  if (selected.length > 1) {
    throw new Error("Reddit flair selector marked multiple current choices");
  }
  return Object.freeze({
    schemaVersion: 1,
    community: target.community,
    kind: target.kind,
    choices: Object.freeze(choices),
    selectedTemplateId: selected[0]?.templateId ?? null,
    selectedText: selected[0]?.text ?? null,
  });
}

export function parseRedditFlairChoicesResponse(
  value: unknown,
  target: FlairChoicesTarget,
): RedditFlairChoices {
  if (!/^[A-Za-z0-9_]{2,21}$/u.test(target.community)) {
    throw new Error("Reddit flair community must be an exact subreddit name");
  }
  if (typeof value === "string") {
    return parseRedditFlairChoicesHtml(value, target);
  }
  const root = record(value, "Reddit flair response");
  exactKeys(root, ["choices", "current"], "Reddit flair response");
  if (!Array.isArray(root.choices) || root.choices.length > 350) {
    throw new Error("Reddit flair choices exceeded their reviewed bound");
  }

  const current = record(root.current, "Reddit flair current selection");
  exactKeys(
    current,
    ["flair_css_class", "flair_position", "flair_template_id", "flair_text"],
    "Reddit flair current selection",
  );
  cssClass(current.flair_css_class, "Reddit flair current CSS class", true);
  position(current.flair_position, "Reddit flair current position");
  const selectedTemplateId = current.flair_template_id === null
    ? null
    : templateId(current.flair_template_id, "Reddit flair current template ID");
  const selectedText = nullableText(current.flair_text, "Reddit flair current text");
  if ((selectedTemplateId === null) !== (selectedText === null)) {
    throw new Error("Reddit flair current selection was incomplete");
  }

  const seen = new Set<string>();
  const choices = root.choices.map((rawChoice, index): RedditFlairChoice => {
    const choice = record(rawChoice, `Reddit flair choice ${index}`);
    exactKeys(
      choice,
      [
        "flair_css_class",
        "flair_position",
        "flair_template_id",
        "flair_text",
        "flair_text_editable",
      ],
      `Reddit flair choice ${index}`,
    );
    cssClass(choice.flair_css_class, `Reddit flair choice ${index} CSS class`);
    const id = templateId(
      choice.flair_template_id,
      `Reddit flair choice ${index} template ID`,
    );
    if (seen.has(id)) throw new Error("Reddit flair response repeated a template ID");
    seen.add(id);
    if (typeof choice.flair_text_editable !== "boolean") {
      throw new Error(`Reddit flair choice ${index} editability must be boolean`);
    }
    return Object.freeze({
      templateId: id,
      text: text(choice.flair_text, `Reddit flair choice ${index} text`),
      textEditable: choice.flair_text_editable,
      position: position(
        choice.flair_position,
        `Reddit flair choice ${index} position`,
      ),
      selected: selectedTemplateId === id,
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    community: target.community,
    kind: target.kind,
    choices: Object.freeze(choices),
    selectedTemplateId,
    selectedText,
  });
}

export function isRedditFlairOperation(value: string): value is RedditFlairOperation {
  return REDDIT_FLAIR_OPERATION_NAMES.some((operation) => operation === value);
}

export function parseRedditFlairInput(
  operation: RedditFlairOperation,
  value: unknown,
): RedditFlairInput {
  if (!isRedditFlairOperation(operation)) {
    throw new Error("Unsupported Reddit flair operation");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reddit flair input must be an object");
  }
  const input = value as Record<string, unknown>;
  const isPost = operation.startsWith("flair.post.");
  const isSelect = operation.endsWith(".select");
  const required = [
    "community",
    ...(isPost && isSelect ? ["post_id"] : []),
    ...(isSelect ? ["template_id", "expected_text"] : []),
  ];
  if (
    Object.keys(input).length !== required.length
    || required.some((key) => !Object.hasOwn(input, key))
  ) throw new Error("Reddit flair input contains missing or unsupported fields");
  const community = input.community;
  if (typeof community !== "string" || !/^[A-Za-z0-9_]{2,21}$/u.test(community)) {
    throw new Error("Reddit flair community must be an exact subreddit name");
  }
  if (!isSelect) {
    return {
      action: "choices",
      target: { kind: isPost ? "post" : "user", community },
    };
  }

  let target: FlairSelectionTarget = { kind: "user", community };
  if (isPost) {
    const postId = input.post_id;
    if (typeof postId !== "string" || !/^t3_[a-z0-9]{1,32}$/u.test(postId)) {
      throw new Error("Reddit post flair requires an exact post fullname");
    }
    target = { kind: "post", community, postId };
  }
  const selectedTemplateId = templateId(
    input.template_id,
    "Reddit flair selection",
  );
  const expectedText = input.expected_text;
  if (
    typeof expectedText !== "string"
    || expectedText.length < 1
    || expectedText.length > 256
    || /[\u0000-\u001f\u007f]/u.test(expectedText)
    || expectedText.trim() !== expectedText
  ) throw new Error("Reddit flair selection requires a bounded exact label");
  return {
    action: "select",
    target,
    templateId: selectedTemplateId,
    expectedText,
  };
}

const communityField = {
  type: "string",
  description: "Exact subreddit name without r/",
  minLength: 2,
  maxLength: 21,
} as const satisfies InputField;

export const redditFlairContracts: readonly WebSessionContract[] = Object.freeze(
  REDDIT_FLAIR_OPERATION_NAMES.map((operation): WebSessionContract => {
    const isPost = operation.startsWith("flair.post.");
    const isSelect = operation.endsWith(".select");
    const properties: Record<string, InputField> = { community: communityField };
    if (isPost && isSelect) {
      properties.post_id = {
        type: "string",
        description: "Exact t3_ fullname of the current account's post",
        minLength: 4,
        maxLength: 35,
      };
    }
    if (isSelect) {
      properties.template_id = {
        type: "string",
        description: "Exact self-selectable template ID from a fresh choices read",
        minLength: 36,
        maxLength: 36,
      };
      properties.expected_text = {
        type: "string",
        description: "Exact label from that same choices read; not custom flair text",
        minLength: 1,
        maxLength: 256,
      };
    }
    const input: InputSchema = {
      properties: Object.freeze(properties),
      required: Object.freeze(Object.keys(properties)),
    };
    return Object.freeze({
      site: "reddit",
      operation,
      contractVersion: 1,
      risk: isSelect ? (isPost ? "R3" : "R2") : "R1",
      input,
      sideEffect: isSelect
        ? (isPost
          ? "Select one flair on the current account's exact post"
          : "Select one community user flair for the current account")
        : "none",
      idempotency: isSelect ? "local-at-most-once" : "none",
      dedupeWindowMs: isSelect ? 300_000 : 0,
      state: isSelect ? "capture-required" : "observed",
      dispatch: isSelect ? "single" : "none",
      implementation: isSelect
        ? "Reddit flair selection requires reviewed same-account mutation and readback evidence; no request is installed"
        : "bound current-account modhash plus exact old-Reddit flairselector JSON with strict template projection",
    });
  }),
);
