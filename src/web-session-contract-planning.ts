import type {
  BrowserDispatchPlan,
  OperationInput,
} from "./model";
import type { WebSessionContract } from "./web-session-contract-definitions";

export function planWebSessionContractDispatches(
  selected: WebSessionContract,
  input: OperationInput,
): readonly BrowserDispatchPlan[] {
  if (selected.state !== "observed") {
    throw new Error(
      `${selected.site} ${selected.operation} is capture-required: ${selected.implementation}`,
    );
  }
  if (selected.dispatch === "none") return [];
  if (selected.dispatch === "single") {
    return [{
      id: selected.operation,
      description: `Dispatch one reviewed ${selected.operation} internal API action`,
    }];
  }
  if (selected.dispatch === "article-rich-draft") {
    const inlineImages = input.inline_images;
    if (inlineImages !== undefined && !Array.isArray(inlineImages)) {
      throw new Error("X rich Article inline_images must be an array");
    }
    const imageCount = Array.isArray(inlineImages) ? inlineImages.length : 0;
    const updating = input.draft_id !== undefined;
    const hasCover = input.cover_image !== undefined;
    const dispatches: BrowserDispatchPlan[] = Array.from({ length: imageCount }, (_value, index) => ({
      id: `articles.media.inline[${index + 1}]`,
      description: `Upload reviewed X Article inline image ${index + 1}`,
    }));
    if (hasCover) {
      dispatches.push({
        id: "articles.media.cover",
        description: "Upload reviewed X Article cover image",
      });
    }
    if (updating) {
      dispatches.push({
        id: "articles.title",
        description: "Update the exact private X Article draft title",
      });
      dispatches.push({
        id: "articles.content",
        description: "Replace the exact private X Article draft rich content",
      });
    } else {
      dispatches.push({
        id: "articles.create",
        description: "Create one exact private rich X Article draft",
      });
    }
    if (hasCover) {
      dispatches.push({
        id: "articles.cover",
        description: "Attach the exact cover to the private X Article draft",
      });
    }
    if (dispatches.length > 25) {
      throw new Error("X rich Article workflow exceeds its 25-dispatch bound");
    }
    return Object.freeze(dispatches);
  }
  const items = input.items;
  if (
    !Array.isArray(items)
    || items.length < 1
    || items.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      "authenticated thread contract requires a non-empty string items input",
    );
  }
  return items.map((_item, index) => ({
    id: `${selected.operation}[${index + 1}]`,
    description: index === 0
      ? "Publish reviewed thread root"
      : `Publish reviewed thread reply ${index}`,
  }));
}
