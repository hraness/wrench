const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "pre"]);
const SKIP_ELEMENTS = new Set(["nav", "script", "style", "svg", "template"]);
const SKIP_CLASSES = new Set([
  "card-index",
  "command-label",
  "eyebrow",
  "flow-index",
  "hero-field",
  "hraness-marketing-cta__eyebrow",
  "hraness-marketing-hero__eyebrow",
  "hraness-marketing-install__eyebrow",
  "hraness-marketing-interfaces__label",
  "hraness-marketing-maker__label",
  "hraness-marketing-questions__label",
  "hraness-marketing-section__label",
  "hraness-marketing-trust__label",
  "skill-install-copy",
  "skip-link",
  "visually-hidden",
]);

type HtmlNode =
  | { readonly type: "text"; readonly value: string }
  | {
    readonly attrs: Readonly<Record<string, string>>;
    readonly children: readonly HtmlNode[];
    readonly name: string;
    readonly type: "element";
  };

const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

function parseAttributes(value: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/gu;
  for (const match of value.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function classList(attrs: Readonly<Record<string, string>>): readonly string[] {
  return (attrs.class ?? "").split(/\s+/u).filter((name) => name !== "");
}

function hasSkipClass(attrs: Readonly<Record<string, string>>): boolean {
  return classList(attrs).some((name) => SKIP_CLASSES.has(name));
}

function parseFragment(html: string): readonly HtmlNode[] {
  const root: Extract<HtmlNode, { type: "element" }> = {
    attrs: {},
    children: [],
    name: "#root",
    type: "element",
  };
  const stack: Array<Extract<HtmlNode, { type: "element" }>> = [root];
  let index = 0;

  const append = (node: HtmlNode): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      throw new Error("HTML fragment parser lost its root.");
    }
    (parent.children as HtmlNode[]).push(node);
  };

  while (index < html.length) {
    const current = stack[stack.length - 1];
    if (current === undefined) {
      throw new Error("HTML fragment parser lost its root.");
    }
    if (RAW_TEXT_ELEMENTS.has(current.name) && current.name !== "pre") {
      const close = html.toLowerCase().indexOf(`</${current.name}>`, index);
      const end = close === -1 ? html.length : close;
      if (end > index) append({ type: "text", value: html.slice(index, end) });
      index = close === -1 ? html.length : close;
    }
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("</", index)) {
      const end = html.indexOf(">", index + 2);
      if (end === -1) break;
      const name = html.slice(index + 2, end).trim().toLowerCase();
      index = end + 1;
      if (stack.length > 1 && stack[stack.length - 1]?.name === name) {
        stack.pop();
      }
      continue;
    }
    if (html.startsWith("<", index)) {
      const end = html.indexOf(">", index + 1);
      if (end === -1) break;
      const rawTag = html.slice(index + 1, end).trim();
      index = end + 1;
      const selfClosing = rawTag.endsWith("/");
      const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
      const separator = body.search(/\s/u);
      const name = (separator === -1 ? body : body.slice(0, separator)).toLowerCase();
      if (name === "" || name.startsWith("!")) continue;
      const attrs = parseAttributes(separator === -1 ? "" : body.slice(separator));
      const element: Extract<HtmlNode, { type: "element" }> = {
        attrs,
        children: [],
        name,
        type: "element",
      };
      append(element);
      if (!selfClosing && !VOID_ELEMENTS.has(name)) {
        stack.push(element);
      }
      continue;
    }
    const next = html.indexOf("<", index);
    const end = next === -1 ? html.length : next;
    append({ type: "text", value: decodeEntities(html.slice(index, end)) });
    index = end;
  }
  return root.children;
}

function extractMain(html: string): string {
  const match = /<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("HTML is missing a main landmark.");
  }
  return match[1];
}

function collapseInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]|#])/gu, "\\$1");
}

function resolveHref(href: string, pageUrl: string): string {
  if (href.startsWith("#")) {
    const url = new URL(pageUrl);
    url.hash = href;
    return url.href;
  }
  return new URL(href, pageUrl).href;
}

function markdownImage(
  node: Extract<HtmlNode, { type: "element" }>,
  pageUrl: string,
): string {
  const src = node.attrs.src;
  const alt = node.attrs.alt?.trim();
  if (src === undefined || src === "" || alt === undefined || alt === "") return "";
  return `![${escapeMarkdown(alt)}](${resolveHref(src, pageUrl)})`;
}

function firstElement(
  nodes: readonly HtmlNode[],
  name: string,
): Extract<HtmlNode, { type: "element" }> | undefined {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.name === name) return node;
    const nested = firstElement(node.children, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function inlineNodes(nodes: readonly HtmlNode[], pageUrl: string): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") {
      text += node.value.replace(/\s+/gu, " ");
      continue;
    }
    if (SKIP_ELEMENTS.has(node.name) || node.attrs["aria-hidden"] === "true" || hasSkipClass(node.attrs)) {
      continue;
    }
    if (node.name === "br") {
      text += " ";
      continue;
    }
    if (node.name === "img") {
      text += markdownImage(node, pageUrl);
      continue;
    }
    if (node.name === "code") {
      const content = collapseInline(node.children.map((child) => (
        child.type === "text" ? child.value : ""
      )).join(""));
      text += `\`${content.replaceAll("`", "\\`")}\``;
      continue;
    }
    if (node.name === "strong" || node.name === "b") {
      const content = inlineNodes(node.children, pageUrl);
      text += content === "" ? "" : `**${content}**`;
      continue;
    }
    if (node.name === "em" || node.name === "i") {
      const content = inlineNodes(node.children, pageUrl);
      text += content === "" ? "" : `*${content}*`;
      continue;
    }
    if (node.name === "a") {
      const content = inlineNodes(node.children, pageUrl);
      const href = node.attrs.href;
      if (content === "") continue;
      text += href === undefined ? content : `[${content}](${resolveHref(href, pageUrl)})`;
      continue;
    }
    text += inlineNodes(node.children, pageUrl);
  }
  return collapseInline(text);
}

function collectText(nodes: readonly HtmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") {
      text += node.value;
      continue;
    }
    if (SKIP_ELEMENTS.has(node.name) || node.attrs["aria-hidden"] === "true" || hasSkipClass(node.attrs)) {
      continue;
    }
    text += collectText(node.children);
  }
  return text;
}

function preformattedText(node: Extract<HtmlNode, { type: "element" }>): string {
  const code = node.name === "pre"
    ? node.children.find((child) => child.type === "element" && child.name === "code") ?? node
    : node;
  return collectText(code.type === "element" ? code.children : [code]).replace(/^\n+|\n+$/gu, "");
}

function tableRows(
  node: Extract<HtmlNode, { type: "element" }>,
  pageUrl: string,
): string[][] {
  const rows: string[][] = [];
  const walk = (nodes: readonly HtmlNode[]): void => {
    for (const child of nodes) {
      if (child.type !== "element") continue;
      if (child.name === "tr") {
        const cells = child.children
          .filter((cell): cell is Extract<HtmlNode, { type: "element" }> => (
            cell.type === "element" && (cell.name === "th" || cell.name === "td")
          ))
          .map((cell) => inlineNodes(cell.children, pageUrl).replaceAll("|", "\\|"));
        if (cells.length > 0) rows.push(cells);
        continue;
      }
      walk(child.children);
    }
  };
  walk(node.children);
  return rows;
}

function renderTable(rows: readonly (readonly string[])[]): string {
  if (rows[0] === undefined) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const header = padded[0];
  if (header === undefined) return "";
  const body = padded.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  return `${lines.join("\n")}\n\n`;
}

function renderBlocks(nodes: readonly HtmlNode[], pageUrl: string): string {
  let markdown = "";
  for (const node of nodes) {
    if (node.type === "text") {
      const text = collapseInline(node.value);
      if (text !== "") markdown += `${escapeMarkdown(text)}\n\n`;
      continue;
    }
    if (SKIP_ELEMENTS.has(node.name) || node.attrs["aria-hidden"] === "true" || hasSkipClass(node.attrs)) {
      continue;
    }
    if (node.name === "h1" || node.name === "h2" || node.name === "h3" || node.name === "h4") {
      const level = Number(node.name.slice(1));
      const text = inlineNodes(node.children, pageUrl);
      if (text !== "") markdown += `${"#".repeat(level)} ${text}\n\n`;
      continue;
    }
    if (node.name === "p" || node.name === "a") {
      const text = node.name === "a" ? inlineNodes([node], pageUrl) : inlineNodes(node.children, pageUrl);
      if (text !== "") markdown += `${text}\n\n`;
      continue;
    }
    if (node.name === "pre") {
      markdown += `\`\`\`\n${preformattedText(node)}\n\`\`\`\n\n`;
      continue;
    }
    if (node.name === "figure") {
      const image = firstElement(node.children, "img");
      const renderedImage = image === undefined ? "" : markdownImage(image, pageUrl);
      if (renderedImage !== "") markdown += `${renderedImage}\n\n`;
      const figcaption = firstElement(node.children, "figcaption");
      const caption = figcaption?.children
        .map((child) => inlineNodes([child], pageUrl))
        .filter((part) => part !== "")
        .join(" ") ?? "";
      if (caption !== "") markdown += `${caption}\n\n`;
      continue;
    }
    if (node.name === "img") {
      const renderedImage = markdownImage(node, pageUrl);
      if (renderedImage !== "") markdown += `${renderedImage}\n\n`;
      continue;
    }
    if (node.name === "ul" || node.name === "ol") {
      let index = 1;
      for (const child of node.children) {
        if (child.type !== "element" || child.name !== "li") continue;
        const marker = node.name === "ol" ? `${index}.` : "-";
        const text = inlineNodes(child.children, pageUrl);
        if (text !== "") markdown += `${marker} ${text}\n`;
        index += 1;
      }
      markdown += "\n";
      continue;
    }
    if (node.name === "table") {
      markdown += renderTable(tableRows(node, pageUrl));
      continue;
    }
    if (node.name === "details") {
      const summary = node.children.find((child) => child.type === "element" && child.name === "summary");
      const rest = node.children.filter((child) => child !== summary);
      if (summary?.type === "element") {
        const title = inlineNodes(summary.children, pageUrl);
        if (title !== "") markdown += `### ${title}\n\n`;
      }
      markdown += renderBlocks(rest, pageUrl);
      continue;
    }
    if (node.name === "dt") {
      const text = inlineNodes(node.children, pageUrl);
      if (text !== "") markdown += `**${text}**\n\n`;
      continue;
    }
    if (node.name === "dd") {
      const text = inlineNodes(node.children, pageUrl);
      if (text !== "") markdown += `${text}\n\n`;
      continue;
    }
    if (node.name === "hr") {
      markdown += "---\n\n";
      continue;
    }
    markdown += renderBlocks(node.children, pageUrl);
  }
  return markdown;
}

export function htmlMainToMarkdown(html: string, pageUrl: string): string {
  const markdown = renderBlocks(parseFragment(extractMain(html)), pageUrl)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (markdown === "") {
    throw new Error(`Markdown conversion produced an empty document for ${pageUrl}.`);
  }
  return `${markdown}\n`;
}
