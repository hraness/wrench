type JsonRecord = Record<string, unknown>;

type PendingResponse = {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly sessionId: string | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
};

type PendingEvent = {
  readonly method: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: JsonRecord) => void;
  readonly sessionId: string;
  readonly timer: ReturnType<typeof setTimeout>;
};

const cdpMessageMaximumBytes = 1024 * 1024;
const cdpCommandTimeoutMs = 10_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} changed shape`);
  }
}

function boundedIdentifier(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

export function localBrowserCdpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error("managed browser returned an invalid private CDP URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("managed browser returned an invalid private CDP URL");
  }
  if (
    url.protocol !== "ws:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "localhost")
    || url.port === ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/u.test(url.pathname)
  ) throw new Error("managed browser returned an invalid private CDP URL");
  return url.href;
}

export function parsePrivateCdpTargetId(value: unknown): string {
  const result = boundedIdentifier(value, "managed browser target ID", 128);
  if (!/^[A-Fa-f0-9]{16,128}$/u.test(result)) {
    throw new Error("managed browser target ID is invalid");
  }
  return result;
}

export function exactPageTarget(result: unknown, currentUrl: string): string {
  if (!isRecord(result)) throw new Error("managed browser target listing changed shape");
  const resultKeys = Object.keys(result).sort();
  if (resultKeys.length !== 1 || resultKeys[0] !== "targetInfos") {
    throw new Error(`managed browser target listing changed shape (${resultKeys.slice(0, 20).join(",")})`);
  }
  if (!Array.isArray(result.targetInfos) || result.targetInfos.length > 100) {
    throw new Error("managed browser target listing changed shape");
  }
  const allowed = new Set([
    "attached",
    "browserContextId",
    "canAccessOpener",
    "openerFrameId",
    "openerId",
    "parentFrameId",
    "parentId",
    "subtype",
    "targetId",
    "title",
    "type",
    "url",
  ]);
  const matches: string[] = [];
  for (const candidate of result.targetInfos) {
    if (!isRecord(candidate)) {
      throw new Error("managed browser target listing changed shape");
    }
    const unexpected = Object.keys(candidate).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(`managed browser target listing changed shape (${unexpected.slice(0, 20).sort().join(",")})`);
    }
    const type = boundedIdentifier(candidate.type, "managed browser target type", 64);
    if (
      typeof candidate.url !== "string"
      || candidate.url.length > 64 * 1024
      || /[\0\r\n]/u.test(candidate.url)
    ) throw new Error("managed browser target listing changed shape");
    const url = candidate.url;
    if (type !== "page" || url !== currentUrl) continue;
    matches.push(parsePrivateCdpTargetId(candidate.targetId));
  }
  if (matches.length !== 1) {
    throw new Error("managed browser did not expose one exact derivation page target");
  }
  return matches[0] as string;
}

export function fileChooserBackendNode(
  value: unknown,
  requiresMultiple: boolean,
): number {
  if (!isRecord(value)) throw new Error("managed file chooser event changed shape");
  exactKeys(value, ["backendNodeId", "frameId", "mode"], "managed file chooser event");
  boundedIdentifier(value.frameId, "managed file chooser frame ID", 128);
  if (
    !Number.isSafeInteger(value.backendNodeId)
    || (value.backendNodeId as number) < 1
    || (value.backendNodeId as number) > 2_147_483_647
    || (value.mode !== "selectSingle" && value.mode !== "selectMultiple")
    || (requiresMultiple && value.mode !== "selectMultiple")
  ) throw new Error("managed file chooser event changed shape");
  return value.backendNodeId as number;
}

export class PrivateCdpClient {
  readonly #events = new Set<PendingEvent>();
  readonly #pending = new Map<number, PendingResponse>();
  readonly #socket: WebSocket;
  #closed = false;
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#fail(new Error("private CDP connection closed")));
    socket.addEventListener("error", () => this.#fail(new Error("private CDP connection failed")));
  }

  static async connect(url: string): Promise<PrivateCdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("private CDP connection timed out")), cdpCommandTimeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("private CDP connection failed"));
      }, { once: true });
    });
    return new PrivateCdpClient(socket);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const event of this.#events) {
      clearTimeout(event.timer);
      event.reject(error);
    }
    this.#events.clear();
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string" || Buffer.byteLength(event.data, "utf8") > cdpMessageMaximumBytes) {
      this.#fail(new Error("private CDP message changed shape"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      this.#fail(new Error("private CDP message changed shape"));
      return;
    }
    if (!isRecord(value)) {
      this.#fail(new Error("private CDP message changed shape"));
      return;
    }
    if (Number.isSafeInteger(value.id)) {
      const pending = this.#pending.get(value.id as number);
      if (pending === undefined) return;
      this.#pending.delete(value.id as number);
      clearTimeout(pending.timer);
      const hasResult = Object.hasOwn(value, "result");
      const hasError = Object.hasOwn(value, "error");
      const expectedKeys = pending.sessionId === undefined
        ? ["id", hasResult ? "result" : "error"]
        : ["id", hasResult ? "result" : "error", "sessionId"];
      if (
        hasResult === hasError
        || (pending.sessionId !== undefined && value.sessionId !== pending.sessionId)
      ) {
        pending.reject(new Error("private CDP response changed shape"));
        return;
      }
      try {
        exactKeys(value, expectedKeys, "private CDP response");
      } catch {
        pending.reject(new Error("private CDP response changed shape"));
        return;
      }
      if (hasError) {
        if (!isRecord(value.error)) {
          pending.reject(new Error("private CDP response changed shape"));
          return;
        }
        pending.reject(new Error("private CDP command failed"));
        return;
      }
      pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string" || !isRecord(value.params)) return;
    for (const waiter of this.#events) {
      if (waiter.method !== value.method || value.sessionId !== waiter.sessionId) continue;
      this.#events.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(value.params);
      return;
    }
  }

  send(method: string, parameters: JsonRecord = {}, sessionId?: string): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("private CDP connection is unavailable"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("private CDP command timed out"));
      }, cdpCommandTimeoutMs);
      this.#pending.set(id, { reject, resolve, sessionId, timer });
      this.#socket.send(JSON.stringify({ id, method, params: parameters, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  event(method: string, sessionId: string): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const waiter: PendingEvent = {
        method,
        reject,
        resolve,
        sessionId,
        timer: setTimeout(() => {
          this.#events.delete(waiter);
          reject(new Error("managed file chooser event timed out"));
        }, cdpCommandTimeoutMs),
      };
      this.#events.add(waiter);
    });
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close();
    }
    this.#fail(new Error("private CDP connection closed"));
  }
}

export function exactPrivateCdpSessionId(result: unknown): string {
  if (!isRecord(result)) throw new Error("managed browser attachment changed shape");
  exactKeys(result, ["sessionId"], "managed browser attachment");
  return boundedIdentifier(result.sessionId, "managed browser session ID", 128);
}

export function assertEmptyPrivateCdpResult(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} changed shape`);
  exactKeys(value, [], label);
}

function resolvedNodeObjectId(value: unknown): string {
  if (!isRecord(value)) throw new Error("managed file chooser node resolution changed shape");
  exactKeys(value, ["object"], "managed file chooser node resolution");
  if (!isRecord(value.object)) throw new Error("managed file chooser node resolution changed shape");
  const allowed = new Set([
    "className",
    "customPreview",
    "deepSerializedValue",
    "description",
    "objectId",
    "preview",
    "subtype",
    "type",
    "unserializableValue",
    "value",
  ]);
  if (Object.keys(value.object).some((key) => !allowed.has(key)) || value.object.type !== "object") {
    throw new Error("managed file chooser node resolution changed shape");
  }
  return boundedIdentifier(value.object.objectId, "managed file chooser object ID", 512);
}

function fileInputDispatchResult(value: unknown, expectedCount: number): void {
  if (!isRecord(value)) throw new Error("managed file chooser dispatch changed shape");
  exactKeys(value, ["result"], "managed file chooser dispatch");
  if (!isRecord(value.result)) throw new Error("managed file chooser dispatch changed shape");
  const allowed = new Set(["description", "type", "value"]);
  if (
    Object.keys(value.result).some((key) => !allowed.has(key))
    || value.result.type !== "object"
    || !isRecord(value.result.value)
  ) throw new Error("managed file chooser dispatch changed shape");
  exactKeys(value.result.value, ["after", "before"], "managed file chooser dispatch result");
  if (
    (value.result.value.before !== 0 && value.result.value.before !== expectedCount)
    || !Number.isSafeInteger(value.result.value.after)
    || (value.result.value.after as number) < 0
    || (value.result.value.after as number) > expectedCount
  ) throw new Error("managed file chooser did not retain the staged fixtures");
}

export async function uploadThroughInterceptedFileChooser(input: {
  readonly cdpUrl: string;
  readonly click: () => Promise<void>;
  readonly currentUrl: string;
  readonly filePaths: readonly string[];
}): Promise<void> {
  if (input.filePaths.length < 1 || input.filePaths.length > 20) {
    throw new Error("managed file chooser fixture count is invalid");
  }
  const client = await PrivateCdpClient.connect(localBrowserCdpUrl(input.cdpUrl));
  let sessionId: string | null = null;
  let interceptionEnabled = false;
  try {
    const targetId = exactPageTarget(await client.send("Target.getTargets"), input.currentUrl);
    sessionId = exactPrivateCdpSessionId(await client.send("Target.attachToTarget", { flatten: true, targetId }));
    assertEmptyPrivateCdpResult(await client.send("Page.enable", {}, sessionId), "managed browser Page.enable response");
    assertEmptyPrivateCdpResult(
      await client.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId),
      "managed browser chooser interception response",
    );
    interceptionEnabled = true;
    const chooser = client.event("Page.fileChooserOpened", sessionId);
    await input.click();
    const backendNodeId = fileChooserBackendNode(await chooser, input.filePaths.length > 1);
    assertEmptyPrivateCdpResult(
      await client.send("DOM.setFileInputFiles", { backendNodeId, files: [...input.filePaths] }, sessionId),
      "managed browser file selection response",
    );
    const objectId = resolvedNodeObjectId(await client.send("DOM.resolveNode", { backendNodeId }, sessionId));
    try {
      fileInputDispatchResult(await client.send("Runtime.callFunctionOn", {
        arguments: [{ value: input.filePaths.length }],
        functionDeclaration: "function(expectedCount){if(!(this instanceof HTMLInputElement)||this.type!=='file'||this.files===null)throw new Error('invalid managed file chooser node');const before=this.files.length;if(before===expectedCount){this.dispatchEvent(new Event('input',{bubbles:true,composed:true}));this.dispatchEvent(new Event('change',{bubbles:true,composed:true}))}return{after:this.files===null?-1:this.files.length,before}}",
        objectId,
        returnByValue: true,
      }, sessionId), input.filePaths.length);
    } finally {
      await client.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
    }
  } finally {
    if (sessionId !== null && interceptionEnabled) {
      await client.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId).catch(() => undefined);
    }
    if (sessionId !== null) {
      await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
    client.close();
  }
}
