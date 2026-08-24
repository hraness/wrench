import { describe, expect, test } from "bun:test";

import {
  exactPageTarget,
  fileChooserBackendNode,
  localBrowserCdpUrl,
  PrivateCdpClient,
} from "./derivation-file-chooser";

type TestCdpRecord = Record<string, unknown>;

type TestCdpListener = (event: MessageEvent) => void;
type TestCdpResponder = (
  request: TestCdpRecord,
  send: (value: unknown) => void,
) => void;

class TestCdpSocket {
  readonly #listeners = new Map<string, Set<TestCdpListener>>();
  readonly #respond: TestCdpResponder;
  readyState: number = WebSocket.OPEN;

  constructor(respond: TestCdpResponder) {
    this.#respond = respond;
  }

  addEventListener(type: string, listener: TestCdpListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<TestCdpListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(message: string): void {
    const request = JSON.parse(message) as TestCdpRecord;
    this.#respond(request, (value) => {
      this.#emit("message", { data: JSON.stringify(value) } as MessageEvent);
    });
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", {} as MessageEvent);
  }

  #emit(type: string, event: MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function withPrivateCdpClient(
  respond: TestCdpResponder,
  exercise: (client: PrivateCdpClient) => Promise<void>,
): Promise<void> {
  type PrivateCdpClientConstructor = new (socket: WebSocket) => PrivateCdpClient;
  const Client = PrivateCdpClient as unknown as PrivateCdpClientConstructor;
  const client = new Client(new TestCdpSocket(respond) as unknown as WebSocket);
  try {
    await exercise(client);
  } finally {
    client.close();
  }
}

describe("derivation native file chooser", () => {
  test("accepts only a private loopback browser CDP URL", () => {
    expect(localBrowserCdpUrl("ws://127.0.0.1:49152/devtools/browser/abc_DEF-123")).toBe(
      "ws://127.0.0.1:49152/devtools/browser/abc_DEF-123",
    );
    for (const value of [
      "wss://127.0.0.1:49152/devtools/browser/id",
      "ws://example.com:49152/devtools/browser/id",
      "ws://user:pass@127.0.0.1:49152/devtools/browser/id",
      "ws://127.0.0.1:49152/devtools/page/id",
      "ws://127.0.0.1:49152/devtools/browser/id?token=secret",
      null,
    ]) expect(() => localBrowserCdpUrl(value)).toThrow("invalid private CDP URL");
  });

  test("binds exactly one current page target and rejects drift", () => {
    const currentUrl = "https://www.reddit.com/user/example/submit/?type=IMAGE";
    const result = {
      targetInfos: [
        {
          attached: true,
          browserContextId: "context-1",
          canAccessOpener: false,
          targetId: "0123456789ABCDEF0123456789ABCDEF",
          title: "Create post",
          type: "page",
          url: currentUrl,
        },
        {
          attached: true,
          targetId: "FEDCBA9876543210FEDCBA9876543210",
          title: "worker",
          type: "service_worker",
          url: "https://www.reddit.com/sw.js",
        },
      ],
    };
    expect(exactPageTarget(result, currentUrl)).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(() => exactPageTarget({ ...result, extra: true }, currentUrl)).toThrow("changed shape");
    expect(() => exactPageTarget({
      targetInfos: [...result.targetInfos, { ...result.targetInfos[0] }],
    }, currentUrl)).toThrow("one exact derivation page target");
    expect(() => exactPageTarget({
      targetInfos: [{ ...result.targetInfos[0], unknown: true }],
    }, currentUrl)).toThrow("changed shape");
  });

  test("parses one exact chooser event with matching multiplicity", () => {
    expect(fileChooserBackendNode({
      backendNodeId: 42,
      frameId: "frame-1",
      mode: "selectSingle",
    }, false)).toBe(42);
    expect(() => fileChooserBackendNode({
      backendNodeId: 42,
      frameId: "frame-1",
      mode: "selectSingle",
    }, true)).toThrow("changed shape");
    expect(() => fileChooserBackendNode({
      backendNodeId: 42,
      frameId: "frame-1",
      mode: "selectSingle",
      path: "/private/file.mp4",
    }, false)).toThrow("changed shape");
  });

  test("binds ordinary and flattened-session responses while preserving events", async () => {
    await withPrivateCdpClient((request, send) => {
      if (request.method === "Target.getTargets") {
        send({ id: request.id, result: { targetInfos: [] } });
        return;
      }
      send({
        method: "Page.fileChooserOpened",
        params: { backendNodeId: 42, frameId: "frame-1", mode: "selectSingle" },
        sessionId: request.sessionId,
      });
      send({ id: request.id, result: {}, sessionId: request.sessionId });
    }, async (client) => {
      expect(await client.send("Target.getTargets")).toEqual({ targetInfos: [] });
      const chooser = client.event("Page.fileChooserOpened", "session-1");
      expect(await client.send("Page.enable", {}, "session-1")).toEqual({});
      expect(await chooser).toEqual({
        backendNodeId: 42,
        frameId: "frame-1",
        mode: "selectSingle",
      });
    });
  });

  test("rejects missing, mismatched, or extra flattened-session response binding", async () => {
    const responses = [
      (id: unknown) => ({ id, result: {} }),
      (id: unknown) => ({ id, result: {}, sessionId: "session-2" }),
      (id: unknown) => ({ id, result: {}, sessionId: "session-1", unexpected: true }),
    ];
    for (const response of responses) {
      await withPrivateCdpClient((request, send) => {
        send(response(request.id));
      }, async (client) => {
        await expect(client.send("Runtime.enable", {}, "session-1"))
          .rejects.toThrow("private CDP response changed shape");
      });
    }
  });

  test("rejects a session-bound ordinary response and keeps exact errors categorical", async () => {
    await withPrivateCdpClient((request, send) => {
      send({ id: request.id, result: {}, sessionId: "session-1" });
    }, async (client) => {
      await expect(client.send("Target.getTargets"))
        .rejects.toThrow("private CDP response changed shape");
    });

    await withPrivateCdpClient((request, send) => {
      send({
        error: { code: -32_000, message: "private provider detail" },
        id: request.id,
      });
    }, async (client) => {
      let failure: unknown = null;
      try {
        await client.send("Target.getTargets");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : "")
        .toBe("private CDP command failed");
      expect(failure instanceof Error ? failure.message : "")
        .not.toContain("private provider detail");
    });
  });
});
