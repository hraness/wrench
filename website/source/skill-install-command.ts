export type CopyMethod = "clipboard" | "fallback" | "manual";

type ClipboardWriter = Readonly<{
  writeText: (value: string) => Promise<void>;
}>;

export async function copyText(
  value: string,
  clipboard: ClipboardWriter | undefined,
  fallback: () => boolean,
): Promise<CopyMethod> {
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(value);
      return "clipboard";
    } catch {
      // A denied or unavailable async clipboard falls through to selection-based copy.
    }
  }

  try {
    return fallback() ? "fallback" : "manual";
  } catch {
    return "manual";
  }
}

function selectVisibleCommand(command: HTMLElement, documentValue: Document): void {
  command.focus();
  const selection = documentValue.getSelection();
  if (selection === null) return;
  const range = documentValue.createRange();
  range.selectNodeContents(command);
  selection.removeAllRanges();
  selection.addRange(range);
}

function legacyCopy(
  value: string,
  command: HTMLElement,
  documentValue: Document,
): boolean {
  if (typeof documentValue.execCommand !== "function") {
    selectVisibleCommand(command, documentValue);
    return false;
  }

  const textarea = documentValue.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  documentValue.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = documentValue.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  if (!copied) selectVisibleCommand(command, documentValue);
  return copied;
}

export function initializeSkillInstallCommands(
  documentValue: Document,
  navigatorValue: Navigator,
): void {
  const roots = documentValue.querySelectorAll<HTMLElement>("[data-skill-install]");
  for (const root of roots) {
    if (root.dataset.skillInstallReady === "true") continue;
    const command = root.querySelector<HTMLElement>("[data-skill-install-command]");
    const button = root.querySelector<HTMLButtonElement>("[data-skill-install-copy]");
    const label = root.querySelector<HTMLElement>("[data-skill-install-copy-label]");
    const status = root.querySelector<HTMLElement>("[data-skill-install-status]");
    if (command === null || button === null || label === null || status === null) continue;
    const commandText = command.textContent?.trim() ?? "";
    if (commandText === "") continue;

    root.dataset.skillInstallReady = "true";
    button.hidden = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    button.addEventListener("click", async () => {
      if (resetTimer !== undefined) clearTimeout(resetTimer);
      button.disabled = true;
      button.dataset.copyState = "copying";
      label.textContent = "Copying";
      status.textContent = "";

      let clipboard: ClipboardWriter | undefined;
      try {
        clipboard = navigatorValue.clipboard;
      } catch {
        // Some embedded browsers can deny access while reading the clipboard property.
      }
      const method = await copyText(
        commandText,
        clipboard,
        () => legacyCopy(commandText, command, documentValue),
      );

      button.disabled = false;
      if (method === "manual") {
        button.dataset.copyState = "manual";
        label.textContent = "Selected";
        status.textContent = "Command selected. Press Command+C or Control+C to copy it.";
      } else {
        button.dataset.copyState = "copied";
        label.textContent = "Copied";
        status.textContent = "Agent Skill install command copied to the clipboard.";
        button.focus();
      }

      resetTimer = setTimeout(() => {
        button.dataset.copyState = "idle";
        label.textContent = "Copy";
        status.textContent = "";
      }, 3_000);
    });
  }
}

if (typeof document !== "undefined" && typeof navigator !== "undefined") {
  initializeSkillInstallCommands(document, navigator);
}
