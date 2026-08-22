import { describe, expect, test } from "bun:test";

import {
  exactPageTarget,
  fileChooserBackendNode,
  localBrowserCdpUrl,
} from "./derivation-file-chooser";

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
});
