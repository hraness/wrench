import { describe, expect, test } from "bun:test";

import { parseWrenchArguments } from "./args";

describe("wrench CLI grammar", () => {
  test("parses only one normalized reviewed iMessage transport install source", () => {
    expect(parseWrenchArguments([
      "imessage",
      "transport",
      "install",
      "--binary",
      "/tmp/reviewed-imsg",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "imessage-transport-install",
        binary: "/tmp/reviewed-imsg",
        json: true,
      },
    });
    for (const raw of [
      ["imessage", "transport", "install"],
      ["imessage", "transport", "install", "--binary", "relative-imsg"],
      ["imessage", "transport", "install", "--binary", "/tmp/../tmp/imsg"],
      ["imessage", "send"],
      ["imessage", "transport", "install", "--binary", "/tmp/imsg", "--force"],
    ]) {
      expect(parseWrenchArguments(raw).ok).toBeFalse();
    }
  });

  test("keeps messaging capability data out of argv and requires private output", () => {
    expect(parseWrenchArguments([
      "messaging",
      "resolve",
      "--input",
      "-",
      "--private-output",
      "/tmp/wrench-private/route.json",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "messaging-resolve",
        inputSource: "-",
        privateOutput: "/tmp/wrench-private/route.json",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "messaging",
      "context",
      "--input",
      "@/tmp/wrench-private/context-request.json",
      "--private-output",
      "/tmp/wrench-private/context.json",
    ]).ok).toBeTrue();
    for (const input of [
      '{"routeRef":"wmroute_private"}',
      "@relative.json",
      "wmroute_private",
    ]) {
      expect(parseWrenchArguments([
        "messaging",
        "context",
        "--input",
        input,
        "--private-output",
        "/tmp/wrench-private/context.json",
      ]).ok).toBeFalse();
    }
    expect(parseWrenchArguments([
      "messaging",
      "routes",
      "--input",
      "-",
    ]).ok).toBeFalse();
  });

  test.each([
    { raw: [] },
    { raw: ["help"] },
    { raw: ["--help"] },
    { raw: ["-h"] },
  ] as const)(
    "accepts only the exact help form: %j",
    ({ raw }) => {
      expect(parseWrenchArguments(raw)).toEqual({
        ok: true,
        value: { command: "help" },
      });
    },
  );

  test("keeps capture ergonomic for direct URLs and explicit commands", () => {
    expect(parseWrenchArguments(["https://example.com/post", "named-clip", "--force"])).toEqual({
      ok: true,
      value: {
        command: "clip",
        arguments: ["https://example.com/post", "named-clip", "--force"],
      },
    });
    expect(parseWrenchArguments(["clip", "https://example.com/post", "--stdout"])).toEqual({
      ok: true,
      value: {
        command: "clip",
        arguments: ["https://example.com/post", "--stdout"],
      },
    });
    expect(parseWrenchArguments(["read", "https://example.com/post", "--json"])).toEqual({
      ok: true,
      value: {
        command: "read",
        arguments: ["https://example.com/post", "--json"],
      },
    });
  });

  test("routes verified media commands through the owned media runtime without changing bare URL clipping", () => {
    const url = "https://media.example/video";
    expect(parseWrenchArguments(["archive", url, "--refresh", "--json"])).toEqual({
      ok: true,
      value: { command: "media", arguments: ["archive", url, "--refresh", "--json"] },
    });
    expect(parseWrenchArguments(["media", url, "--output", "/tmp/library"])).toEqual({
      ok: true,
      value: { command: "media", arguments: ["archive", url, "--output", "/tmp/library"] },
    });
    expect(parseWrenchArguments(["media", "transcript", url, "--lang", "de"])).toEqual({
      ok: true,
      value: { command: "media", arguments: ["transcript", url, "--lang", "de"] },
    });
    for (const mode of ["audio", "video", "transcript"] as const) {
      expect(parseWrenchArguments([mode, url])).toEqual({
        ok: true,
        value: { command: "media", arguments: [mode, url] },
      });
    }
    expect(parseWrenchArguments(["verify", "/tmp/wrench-media/item", "--json"])).toEqual({
      ok: true,
      value: { command: "media", arguments: ["verify", "/tmp/wrench-media/item", "--json"] },
    });
    expect(parseWrenchArguments([
      "transcriber", "setup", "--engine", "whisper-cpp", "--model", "/tmp/model.bin",
    ])).toEqual({
      ok: true,
      value: {
        command: "media",
        arguments: ["transcriber", "setup", "--engine", "whisper-cpp", "--model", "/tmp/model.bin"],
      },
    });
    expect(parseWrenchArguments([url])).toEqual({
      ok: true,
      value: { command: "clip", arguments: [url] },
    });
  });

  test("parses the bounded Beeper Message Like Me export command", () => {
    expect(parseWrenchArguments([
      "beeper",
      "export-message-like-me",
      "--auth",
      "beeper-main",
      "--output",
      "/tmp/message-like-me",
      "--limit-chats",
      "100",
      "--limit-messages",
      "5000",
      "--max-participants",
      "2000",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "beeper-export-message-like-me",
        authId: "beeper-main",
        output: "/tmp/message-like-me",
        limitChats: 100,
        limitMessages: 5000,
        maxParticipants: 2000,
        json: true,
      },
    });
    for (const raw of [
      ["beeper", "export-message-like-me", "--auth", "beeper-main"],
      [
        "beeper", "export-message-like-me", "--auth", "beeper-main",
        "--output", "relative",
      ],
      [
        "beeper", "export-message-like-me", "--auth", "beeper-main",
        "--output", "/tmp/export", "--limit-chats", "0",
      ],
      ["beeper", "messages"],
      [
        "beeper", "export-message-like-me", "--auth", "beeper-main",
        "--output", "/tmp/export", "--max-participants", "2001",
      ],
    ]) {
      expect(parseWrenchArguments(raw).ok).toBeFalse();
    }
  });

  test("parses only the transparent one-account WhatsApp Message Like Me export", () => {
    expect(parseWrenchArguments([
      "whatsapp",
      "export-message-like-me",
      "--auth",
      "whatsapp-main",
      "--output",
      "/tmp/whatsapp-message-like-me",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "whatsapp-export-message-like-me",
        authId: "whatsapp-main",
        output: "/tmp/whatsapp-message-like-me",
        json: true,
      },
    });
    for (const raw of [
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main"],
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main", "--output", "relative"],
      ["whatsapp", "messages"],
      ["whatsapp", "export-message-like-me", "--auth", "Bad ID", "--output", "/tmp/export"],
      ["whatsapp", "export-message-like-me", "--auth", `a${"b".repeat(48)}`, "--output", "/tmp/export"],
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main", "--output", "/"],
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main", "--output", "/tmp/export\nother"],
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main", "--output", `/tmp/${"é".repeat(2_046)}`],
      ["whatsapp", "export-message-like-me", "--auth", "whatsapp-main", "--output", "/tmp/export", "--limit-messages", "1"],
    ]) expect(parseWrenchArguments(raw).ok).toBeFalse();
  });

  test("parses the path-free Beeper contact interaction export", () => {
    expect(parseWrenchArguments([
      "beeper",
      "export-contact-interactions",
      "--auth",
      "beeper-main",
      "--limit-chats",
      "500",
      "--limit-messages",
      "10000",
      "--max-participants",
      "2000",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "beeper-export-contact-interactions",
        authId: "beeper-main",
        limitChats: 500,
        limitMessages: 10000,
        maxParticipants: 2000,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "beeper",
      "export-contact-interactions",
      "--auth",
      "beeper-main",
      "--output",
      "/tmp/must-not-exist",
    ])).toEqual({
      ok: false,
      message:
        "beeper export-contact-interactions writes its body-free artifact to stdout and does not accept --output",
    });
    expect(parseWrenchArguments([
      "beeper", "export-contact-interactions", "--auth", "beeper-main",
      "--max-participants", "2001",
    ]).ok).toBeFalse();
  });

  test("parses only the bounded Apple Photos contact-evidence export", () => {
    expect(parseWrenchArguments([
      "apple-photos",
      "export-contact-evidence",
      "--library",
      "/private/tmp/Family.photoslibrary",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "apple-photos-export-contact-evidence",
        library: "/private/tmp/Family.photoslibrary",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "apple-photos",
      "export-contact-evidence",
    ])).toEqual({
      ok: true,
      value: {
        command: "apple-photos-export-contact-evidence",
        json: false,
      },
    });
    for (const raw of [
      ["apple-photos", "read"],
      ["apple-photos", "export-contact-evidence", "--library", "relative.photoslibrary"],
      ["apple-photos", "export-contact-evidence", "--library", "/private/tmp/Photos.sqlite"],
      ["apple-photos", "export-contact-evidence", "--output", "/private/output"],
      ["apple-photos", "export-contact-evidence", "--json", "--json"],
    ]) expect(parseWrenchArguments(raw).ok).toBeFalse();
  });

  test("parses adapter and capability management", () => {
    expect(parseWrenchArguments(["capabilities", "linkedin", "--json"])).toEqual({
      ok: true,
      value: { command: "capabilities", adapterId: "linkedin", json: true },
    });
    expect(parseWrenchArguments([
      "adapter",
      "scaffold",
      "--site",
      "acme",
      "--display-name",
      "Acme",
      "--origin",
      "https://www.acme.example",
      "--operation",
      "messaging.send",
      "--risk",
      "R3",
      "--evidence",
      "/private/evidence.json",
      "--candidate",
      "4",
      "--output",
      "/private/scaffold",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-scaffold",
        site: "acme",
        displayName: "Acme",
        origin: "https://www.acme.example",
        operation: "messaging.send",
        risk: "R3",
        evidence: "/private/evidence.json",
        candidate: 4,
        output: "/private/scaffold",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "adapter",
      "init",
      "linkedin",
      "--origin",
      "https://www.linkedin.com",
      "--output",
      "./linkedin-adapter",
      "--force",
    ])).toEqual({
      ok: true,
      value: {
        command: "adapter-init",
        id: "linkedin",
        target: { kind: "origin", origin: "https://www.linkedin.com" },
        output: "./linkedin-adapter",
        force: true,
      },
    });
    expect(parseWrenchArguments([
      "adapter",
      "init",
      "youtube-publisher",
      "--platform",
      "youtube",
      "--output",
      "./youtube-adapter",
    ])).toEqual({
      ok: true,
      value: {
        command: "adapter-init",
        id: "youtube-publisher",
        target: { kind: "platform", surfaceId: "youtube" },
        output: "./youtube-adapter",
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "adapter", "init", "substack-reader", "--platform", "substack", "--output", "./substack-adapter",
    ])).toEqual({
      ok: true,
      value: {
        command: "adapter-init",
        id: "substack-reader",
        target: { kind: "platform", surfaceId: "substack" },
        output: "./substack-adapter",
        force: false,
      },
    });
    expect(parseWrenchArguments(["adapter", "validate", "./wrench-adapter.json", "--json"])).toEqual({
      ok: true,
      value: { command: "adapter-validate", path: "./wrench-adapter.json", json: true },
    });
    expect(parseWrenchArguments(["adapter", "sync-bundled", "--json"])).toEqual({
      ok: true,
      value: { command: "adapter-sync-bundled", json: true },
    });
    expect(parseWrenchArguments(["adapter", "install", "./wrench-adapter.json", "--force"])).toEqual({
      ok: true,
      value: { command: "adapter-install", path: "./wrench-adapter.json", force: true },
    });
    expect(parseWrenchArguments([
      "adapter",
      "install",
      "./wrench-adapter.json",
      "--upgrade-from",
      "./wrench-adapter.v1.json",
      "--upgrade-from",
      "./wrench-adapter.v2.json",
    ])).toEqual({
      ok: true,
      value: {
        command: "adapter-install",
        path: "./wrench-adapter.json",
        upgradeFrom: [
          "./wrench-adapter.v1.json",
          "./wrench-adapter.v2.json",
        ],
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "adapter",
      "install",
      "./wrench-adapter.json",
      "--force",
      "--upgrade-from",
      "./wrench-adapter.v1.json",
    ])).toEqual({
      ok: false,
      message: "adapter install accepts --force or --upgrade-from, not both",
    });
    expect(parseWrenchArguments(["adapter", "remove", "linkedin", "--yes"])).toEqual({
      ok: true,
      value: { command: "adapter-remove", id: "linkedin", yes: true },
    });
    expect(parseWrenchArguments([
      "adapter",
      "scaffold",
      "--site",
      "acme",
      "--display-name",
      "Acme",
      "--origin",
      "https://www.acme.example",
      "--operation",
      "direct-messaging.send-message",
      "--risk",
      "R1",
      "--evidence",
      "/private/evidence.json",
      "--candidate",
      "-1",
      "--output",
      "/private/scaffold",
    ])).toEqual({
      ok: false,
      message: "adapter scaffold --candidate must be a zero-based integer",
    });
  });

  test("parses source plugin discovery through singular and plural command names", () => {
    expect(parseWrenchArguments(["plugin", "list"])).toEqual({
      ok: true,
      value: { command: "plugin-list", json: false },
    });
    expect(parseWrenchArguments(["plugins", "list", "--json"])).toEqual({
      ok: true,
      value: { command: "plugin-list", json: true },
    });
    expect(parseWrenchArguments(["plugin", "show", "meta-web", "--json"])).toEqual({
      ok: true,
      value: { command: "plugin-show", id: "meta-web", json: true },
    });
    expect(parseWrenchArguments(["plugins", "show", "x"])).toEqual({
      ok: true,
      value: { command: "plugin-show", id: "x", json: false },
    });
    const longestPluginId = `a${"b".repeat(62)}`;
    expect(parseWrenchArguments(["plugin", "show", longestPluginId])).toEqual({
      ok: true,
      value: { command: "plugin-show", id: longestPluginId, json: false },
    });
    expect(parseWrenchArguments([
      "plugin",
      "scaffold",
      "--site",
      "acme",
      "--display-name",
      "Acme",
      "--origin",
      "https://www.acme.example",
      "--operation",
      "direct-messaging.send-message",
      "--risk",
      "R1",
      "--evidence",
      "/private/evidence.json",
      "--candidate",
      "0",
      "--output",
      "src/plugins/acme-web",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-scaffold",
        site: "acme",
        displayName: "Acme",
        origin: "https://www.acme.example",
        operation: "direct-messaging.send-message",
        risk: "R1",
        evidence: "/private/evidence.json",
        candidate: 0,
        output: "src/plugins/acme-web",
        json: true,
      },
    });
    expect(parseWrenchArguments(["plugins", "check", "src/plugins/acme-web", "--json"])).toEqual({
      ok: true,
      value: {
        command: "plugin-check",
        path: "src/plugins/acme-web",
        json: true,
      },
    });
    const longestSiteId = `a${"b".repeat(58)}`;
    expect(parseWrenchArguments([
      "plugin", "scaffold",
      "--site", longestSiteId,
      "--display-name", "Longest valid site",
      "--origin", "https://www.example.com",
      "--operation", "feeds.read",
      "--risk", "R1",
      "--evidence", "/private/evidence.json",
      "--candidate", "0",
      "--output", `src/plugins/${longestSiteId}-web`,
    ])).toMatchObject({
      ok: true,
      value: { command: "plugin-scaffold", site: longestSiteId },
    });
  });

  test("parses the portable plugin lifecycle with explicit code trust and CAS identities", () => {
    expect(parseWrenchArguments([
      "plugin",
      "init",
      "acme-api",
      "--display-name",
      "Acme API",
      "--surface",
      "acme",
      "--origin",
      "https://api.acme.example",
      "--operation",
      "feeds.read",
      "--transport",
      "provider-api",
      "--scope-set",
      "feeds.read,profile.read",
      "--scope-set",
      "feeds.admin",
      "--coverage",
      "feed,profile",
      "--output",
      "./acme-plugin",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-init",
        id: "acme-api",
        displayName: "Acme API",
        surfaceId: "acme",
        origin: "https://api.acme.example",
        operation: "feeds.read",
        transport: "provider-api",
        requiredScopeSets: [
          ["feeds.read", "profile.read"],
          ["feeds.admin"],
        ],
        coverage: ["feed", "profile"],
        output: "./acme-plugin",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "plugin", "init", "acme-web",
      "--display-name", "Acme web",
      "--surface", "acme",
      "--origin", "https://www.acme.example",
      "--operation", "feeds.read",
      "--output", "./acme-web",
    ])).toMatchObject({
      ok: true,
      value: {
        command: "plugin-init",
        transport: "web-session-api",
      },
    });
    expect(parseWrenchArguments([
      "plugin", "test", "./acme-plugin", "--trust-code", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-test",
        path: "./acme-plugin",
        trustCode: true,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "plugin", "test", "./acme-plugin",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-test",
        path: "./acme-plugin",
        trustCode: false,
        json: false,
      },
    });
    expect(parseWrenchArguments([
      "plugin", "pack", "./acme-plugin",
      "--output", "./acme.wrenchplugin",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-pack",
        path: "./acme-plugin",
        output: "./acme.wrenchplugin",
        json: false,
      },
    });
    const digest = "a".repeat(64);
    expect(parseWrenchArguments([
      "plugin", "install", "./acme.wrenchplugin",
      "--trust-code", "--expected-current", digest, "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-install",
        path: "./acme.wrenchplugin",
        trustCode: true,
        expectedCurrent: digest,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "plugin", "disable", "acme-api",
      "--expected-current", digest,
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-disable",
        id: "acme-api",
        expectedCurrent: digest,
        json: false,
      },
    });
    expect(parseWrenchArguments([
      "plugin", "remove", "acme-api",
      "--expected-current", digest, "--yes", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "plugin-remove",
        id: "acme-api",
        expectedCurrent: digest,
        yes: true,
        json: true,
      },
    });
    expect(parseWrenchArguments(["plugin", "doctor", "--json"])).toEqual({
      ok: true,
      value: { command: "plugin-doctor", json: true },
    });
    expect(parseWrenchArguments([
      "plugin", "init", "acme-api",
      "--display-name", "Acme",
      "--surface", "acme",
      "--origin", "https://api.acme.example",
      "--operation", "feeds.read",
      "--transport", "provider-api",
      "--output", "./acme",
    ])).toEqual({
      ok: false,
      message:
        "provider-api plugin init requires --scope-set and --coverage",
    });
  });

  test("parses reviewed policy inspection and local thread splitting", () => {
    expect(parseWrenchArguments(["platforms", "x", "--json"])).toEqual({
      ok: true,
      value: { command: "platforms", surfaceId: "x", json: true },
    });
    expect(parseWrenchArguments(["platforms"])).toEqual({
      ok: true,
      value: { command: "platforms", json: false },
    });
    expect(parseWrenchArguments(["thread", "split", "bluesky", "--text", "one post", "--json"])).toEqual({
      ok: true,
      value: {
        command: "thread-split",
        surfaceId: "bluesky",
        textSource: "one post",
        json: true,
      },
    });
    expect(parseWrenchArguments(["thread", "split", "threads", "--text", "@draft.txt"])).toEqual({
      ok: true,
      value: {
        command: "thread-split",
        surfaceId: "threads",
        textSource: "@draft.txt",
        json: false,
      },
    });
    expect(parseWrenchArguments(["thread", "split", "x", "--text", "-"])).toMatchObject({
      ok: true,
      value: { command: "thread-split", textSource: "-" },
    });
    expect(parseWrenchArguments([
      "thread", "publish", "x",
      "--adapter", "x-main",
      "--text", "@draft.txt",
      "--auth", "arc-main",
      "--preview",
      "--headed",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "thread-publish",
        surfaceId: "x",
        adapterId: "x-main",
        textSource: "@draft.txt",
        authId: "arc-main",
        preview: true,
        headed: true,
        json: true,
      },
    });
  });

  test("parses secret-free auth locators and explicit removal", () => {
    expect(parseWrenchArguments([
      "auth", "login", "gmail-main",
      "--client-file", "/private/google-desktop-client.json",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-login",
        id: "gmail-main",
        provider: "gmail",
        clientFile: "/private/google-desktop-client.json",
        openBrowser: true,
        force: false,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "auth", "login", "gmail-main",
      "--provider", "gmail",
      "--client-file", "/private/google-desktop-client.json",
      "--no-open",
      "--force",
    ])).toMatchObject({
      ok: true,
      value: { openBrowser: false, force: true },
    });
    expect(parseWrenchArguments([
      "auth",
      "add",
      "linkedin",
      "--cookie-source",
      "chrome",
      "--cookie-profile",
      "Profile 2",
      "--subject",
      "urn:li:person:viewer-2",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "linkedin",
        cookieSource: "chrome",
        cookieProfile: "Profile 2",
        subject: "urn:li:person:viewer-2",
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth",
      "add",
      "linkedin-live",
      "--browser-profile",
      "Work",
      "--browser-executable",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "--trust-profile-egress",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "linkedin-live",
        browserProfile: "Work",
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        trustProfileEgress: true,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "arc-main", "--cookie-source", "arc", "--cookie-profile", "Default", "--force",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "arc-main",
        cookieSource: "arc",
        cookieProfile: "Default",
        trustProfileEgress: false,
        force: true,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "whatsapp-main",
      "--browser-profile", "/private/Arc/User Data/Profile 1",
      "--trust-profile-egress",
      "--cookie-source", "arc",
      "--cookie-profile", "Profile 1",
      "--subject", "15576933",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "whatsapp-main",
        browserProfile: "/private/Arc/User Data/Profile 1",
        cookieSource: "arc",
        cookieProfile: "Profile 1",
        subject: "15576933",
        trustProfileEgress: true,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "cookies-file", "--cookies-file", "./private-cookies.json", "--subject", "viewer_123",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "cookies-file",
        cookiesFile: "./private-cookies.json",
        subject: "viewer_123",
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "x-api",
      "--oauth-provider", "x",
      "--token-file", "./secrets/x-access-token",
      "--scopes", "users.read, tweet.write,tweet.read",
      "--subject", "2244994945",
      "--force",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "x-api",
        oauthProvider: "x",
        tokenFile: "./secrets/x-access-token",
        scopes: ["tweet.read", "tweet.write", "users.read"],
        subject: "2244994945",
        trustProfileEgress: false,
        force: true,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "mastodon-api",
      "--oauth-provider", "mastodon",
      "--token-file", "./secrets/mastodon-access-token",
      "--scopes", "read,write:statuses",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "mastodon-api",
        oauthProvider: "mastodon",
        tokenFile: "./secrets/mastodon-access-token",
        scopes: ["read", "write:statuses"],
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "whatsapp-protocol", "--linked-device", "whatsapp",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "whatsapp-protocol",
        linkedDeviceProvider: "whatsapp",
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "whatsapp-custom",
      "--linked-device", "whatsapp",
      "--device-store", "/private/whatsapp-store",
      "--subject", "whatsapp:pn:15551234567",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "whatsapp-custom",
        linkedDeviceProvider: "whatsapp",
        deviceStore: "/private/whatsapp-store",
        subject: "whatsapp:pn:15551234567",
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "signal-custom",
      "--linked-device", "signal",
      "--device-store", "/private/signal-store",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "signal-custom",
        linkedDeviceProvider: "signal",
        deviceStore: "/private/signal-store",
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments([
      "auth", "pair", "whatsapp-protocol", "--phone", "+15551234567",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-pair",
        id: "whatsapp-protocol",
        phone: "+15551234567",
      },
    });
    expect(parseWrenchArguments([
      "auth", "sync", "whatsapp-protocol", "--once", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-sync",
        id: "whatsapp-protocol",
        once: true,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "auth", "add", "linkedin-api",
      "--oauth-provider", "linkedin",
      "--token-file", "/private/linkedin-token",
      "--scopes", "w_member_social,openid",
    ])).toEqual({
      ok: true,
      value: {
        command: "auth-add",
        id: "linkedin-api",
        oauthProvider: "linkedin",
        tokenFile: "/private/linkedin-token",
        scopes: ["openid", "w_member_social"],
        trustProfileEgress: false,
        force: false,
      },
    });
    expect(parseWrenchArguments(["auth", "remove", "linkedin", "--yes"])).toEqual({
      ok: true,
      value: { command: "auth-remove", id: "linkedin", yes: true },
    });
    expect(parseWrenchArguments(["auth", "bind", "arc-main", "--site", "x", "--json"])).toEqual({
      ok: true,
      value: { command: "auth-bind", id: "arc-main", site: "x", force: false, json: true },
    });
    expect(parseWrenchArguments(["auth", "bind", "arc-main", "--site", "linkedin", "--force"])).toEqual({
      ok: true,
      value: { command: "auth-bind", id: "arc-main", site: "linkedin", force: true, json: false },
    });
    expect(parseWrenchArguments(["auth", "bind", "arc-main", "--site", "facebook"])).toEqual({
      ok: true,
      value: { command: "auth-bind", id: "arc-main", site: "facebook", force: false, json: false },
    });
    expect(parseWrenchArguments(["auth", "bind", "arc-main", "--site", "example-social"])).toEqual({
      ok: true,
      value: {
        command: "auth-bind",
        id: "arc-main",
        site: "example-social",
        force: false,
        json: false,
      },
    });
  });

  test("parses the derive lifecycle without swallowing browser arguments", () => {
    expect(parseWrenchArguments(["derive", "list", "--json"])).toEqual({
      ok: true,
      value: { command: "derive-list", json: true },
    });
    expect(parseWrenchArguments([
      "derive",
      "start",
      "linkedin",
      "https://www.linkedin.com/messaging/",
      "--auth",
      "linkedin-live",
      "--content",
      "text",
      "--domains",
      "www.linkedin.com,accounts.example.com",
      "--cookie-origin",
      "https://accounts.example.com",
      "--fixture",
      "grandpa.png",
      "--fixture",
      "second.jpg",
      "--allow-remote-actions",
      "--headed",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-start",
        adapterId: "linkedin",
        url: "https://www.linkedin.com/messaging/",
        authId: "linkedin-live",
        allowRemoteActions: true,
        contentMode: "text",
        browserDomains: ["www.linkedin.com", "accounts.example.com"],
        cookieOrigins: ["https://accounts.example.com"],
        fixtureSources: ["grandpa.png", "second.jpg"],
        headed: true,
      },
    });
    expect(parseWrenchArguments([
      "derive",
      "browser",
      "derive-123",
      "--json",
      "--",
      "find",
      "role",
      "button",
      "click",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-browser",
        id: "derive-123",
        browserArguments: ["find", "role", "button", "click"],
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "review", "derive-123", "--offset", "50", "--limit", "25", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-review",
        id: "derive-123",
        selection: { kind: "list", offset: 50, limit: 25 },
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "review", "derive-123", "--entry", "42", "--fixtures", "-", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-review",
        id: "derive-123",
        selection: { kind: "entry", entryIndex: 42, stdinMode: "fixtures" },
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "review", "derive-123", "--entry", "7", "--field-names", "-", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-review",
        id: "derive-123",
        selection: { kind: "entry", entryIndex: 7, stdinMode: "field-names" },
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "review", "derive-123", "--entry", "8", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-review",
        id: "derive-123",
        selection: { kind: "entry", entryIndex: 8, stdinMode: "none" },
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "review", "derive-123", "--review-origin", "https://upload.example.com", "--limit", "25", "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-review",
        id: "derive-123",
        reviewOrigin: "https://upload.example.com",
        selection: { kind: "list", offset: 0, limit: 25 },
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive",
      "finish",
      "derive-123",
      "--output",
      "./linkedin-adapter",
      "--review-origin",
      "https://upload.example.com",
      "--platform",
      "linkedin",
      "--force",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "derive-finish",
        id: "derive-123",
        output: "./linkedin-adapter",
        reviewOrigin: "https://upload.example.com",
        surfaceId: "linkedin",
        force: true,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "derive", "analyze", "capture.har",
      "--adapter", "facebook-page",
      "--origin", "https://www.facebook.com",
      "--output", "./facebook-page-adapter",
      "--platform", "facebook-page",
    ])).toMatchObject({
      ok: true,
      value: { command: "derive-analyze", surfaceId: "facebook-page" },
    });
  });

  test.each([
    [["derive", "start", "example", "https://example.com", "--fixture", "image.png"], "requires --allow-remote-actions"],
    [["derive", "start", "example", "https://example.com", "--cookie-origin", "http://accounts.example.com", "--domains", "example.com,accounts.example.com"], "exact HTTPS origin"],
    [["derive", "start", "example", "https://example.com", "--cookie-origin", "https://accounts.example.com/path", "--domains", "example.com,accounts.example.com"], "exact HTTPS origin"],
    [["derive", "start", "example", "https://example.com", "--cookie-origin", "https://accounts.example.com"], "covered by --domains"],
    [["derive", "start", "example", "https://example.com", "--cookie-origin", "https://example.com", "--cookie-origin", "https://example.com/"], "unique exact HTTPS origins"],
    [["derive", "start", "example", "https://example.com", "--args", "--no-first-run"], "unknown option"],
    [["derive", "review", "derive-123", "--entry", "20000"], "0 to 19999"],
    [["derive", "review", "derive-123", "--limit", "0"], "1 to 100"],
    [["derive", "review", "derive-123", "--entry", "1", "--offset", "2"], "cannot be combined"],
    [["derive", "review", "derive-123", "--fixtures", "-"], "requires --entry"],
    [["derive", "review", "derive-123", "--entry", "1", "--fixtures", "fixtures.json"], "stdin"],
    [["derive", "review", "derive-123", "--field-names", "-"], "requires --entry"],
    [["derive", "review", "derive-123", "--entry", "1", "--field-names", "fields.json"], "stdin"],
    [["derive", "review", "derive-123", "--entry", "1", "--fixtures", "-", "--field-names", "-"], "mutually exclusive"],
    [["derive", "review", "derive-123", "--review-origin", "http://upload.example.com"], "exact HTTPS origin"],
    [["derive", "review", "derive-123", "--review-origin", "https://upload.example.com/"], "exact HTTPS origin"],
    [["derive", "review", "derive-123", "--review-origin", "https://upload.example.com/path"], "exact HTTPS origin"],
    [["derive", "review", "derive-123", "--review-origin", "https://upload.example.com?secret=never-print"], "exact HTTPS origin"],
    [["derive", "review", "derive-123", "--review-origin", "https://user:password@upload.example.com"], "exact HTTPS origin"],
    [["derive", "review", "derive-123", "--review-origin", "https://upload.example.com", "--review-origin", "https://upload.example.com"], "more than once"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "http://upload.example.com"], "exact HTTPS origin"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "https://upload.example.com/"], "exact HTTPS origin"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "https://upload.example.com/path"], "exact HTTPS origin"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "https://upload.example.com?secret=never-print"], "exact HTTPS origin"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "https://user:password@upload.example.com"], "exact HTTPS origin"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin", "https://upload.example.com", "--review-origin", "https://upload.example.com"], "more than once"],
    [["derive", "finish", "derive-123", "--output", "./derived", "--review-origin"], "requires a value"],
  ])("rejects unsafe derive origin grammar %#", (arguments_, message) => {
    const parsed = parseWrenchArguments(arguments_);
    expect(parsed.ok).toBeFalse();
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });

  test("parses invocation preview, confirmation, and receipts", () => {
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.send",
      "--input",
      "@message.json",
      "--auth",
      "linkedin-live",
      "--preview",
      "--headed",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "invoke",
        adapterId: "linkedin",
        operationId: "messaging.send",
        inputSource: "@message.json",
        authId: "linkedin-live",
        duplicateRiskOf: [],
        preview: true,
        cacheOnly: false,
        projectionIdentityOnly: false,
        headed: true,
        json: true,
      },
    });
    expect(parseWrenchArguments(["confirm", "a".repeat(64), "--json"])).toEqual({
      ok: true,
      value: {
        command: "confirm",
        digest: "a".repeat(64),
        headed: false,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "confirm",
      "a".repeat(64),
      "--private-output",
      "/tmp/wrench-private/messaging-run.json",
      "--receipt-binding-output",
      "/tmp/wrench-private/messaging-receipt.json",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "confirm",
        digest: "a".repeat(64),
        headed: false,
        privateOutput: "/tmp/wrench-private/messaging-run.json",
        receiptBindingOutput: "/tmp/wrench-private/messaging-receipt.json",
        json: true,
      },
    });
    const runId = "00000000-0000-4000-8000-000000000000";
    expect(parseWrenchArguments([
      "messaging",
      "reconcile",
      runId,
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "messaging-reconcile",
        runId,
        json: true,
      },
    });
    expect(parseWrenchArguments(["messaging", "reconcile", runId, "--private-output"]))
      .toEqual({
        ok: false,
        message: "messaging reconcile accepts only --json",
      });
    expect(parseWrenchArguments([
      "runs",
      "show",
      runId,
      "--private-output",
      "/tmp/wrench-private/messaging-run.json",
      "--receipt-binding-output",
      "/tmp/wrench-private/messaging-receipt.json",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "runs-show",
        runId,
        privateOutput: "/tmp/wrench-private/messaging-run.json",
        receiptBindingOutput: "/tmp/wrench-private/messaging-receipt.json",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "confirm",
      "a".repeat(64),
      "--private-output",
      "relative.json",
    ])).toEqual({
      ok: false,
      message: "confirm --private-output must be a normalized absolute path",
    });
    expect(parseWrenchArguments(["confirm", "a".repeat(64), "--idempotency-key", "new-key"]).ok).toBeFalse();
    expect(parseWrenchArguments(["linkedin", "messaging.send", "--input", "{}"])).toEqual({
      ok: true,
      value: {
        command: "invoke",
        adapterId: "linkedin",
        operationId: "messaging.send",
        inputSource: "{}",
        duplicateRiskOf: [],
        preview: false,
        cacheOnly: false,
        projectionIdentityOnly: false,
        headed: false,
        json: false,
      },
    });
    expect(parseWrenchArguments(["run", "linkedin", "messaging.send", "--preview"])).toMatchObject({
      ok: true,
      value: { command: "invoke", adapterId: "linkedin", operationId: "messaging.send", preview: true },
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--cache-only",
      "--json",
    ])).toMatchObject({
      ok: true,
      value: {
        command: "invoke",
        adapterId: "linkedin",
        operationId: "messaging.list",
        cacheOnly: true,
        preview: false,
        headed: false,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--cache-only",
      "--preview",
    ])).toEqual({
      ok: false,
      message: "invoke --cache-only cannot be combined with --preview",
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--cache-only",
      "--headed",
    ])).toEqual({
      ok: false,
      message: "invoke --cache-only never opens a browser and cannot be combined with --headed",
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--projection-identity-only",
      "--json",
    ])).toMatchObject({
      ok: true,
      value: {
        command: "invoke",
        projectionIdentityOnly: true,
        cacheOnly: false,
        preview: false,
        headed: false,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--projection-identity-only",
      "--cache-only",
    ])).toEqual({
      ok: false,
      message: "invoke --projection-identity-only cannot be combined with --preview or --cache-only",
    });
    expect(parseWrenchArguments([
      "invoke",
      "linkedin",
      "messaging.list",
      "--projection-identity-only",
      "--headed",
    ])).toEqual({
      ok: false,
      message: "invoke --projection-identity-only never opens a browser and cannot be combined with --headed",
    });
    expect(parseWrenchArguments([
      "omni",
      "read",
      "--input",
      "-",
      "--cache-only",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "omni-read",
        inputSource: "-",
        cacheOnly: true,
        identityOnly: false,
        fromExactCache: false,
        headed: false,
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "omni",
      "read",
      "--input",
      "@view.json",
      "--from-exact-cache",
    ])).toMatchObject({
      ok: true,
      value: {
        command: "omni-read",
        inputSource: "@view.json",
        fromExactCache: true,
      },
    });
    expect(parseWrenchArguments(["omni", "read"])).toEqual({
      ok: false,
      message: "omni read requires --input <json|@file|->",
    });
    expect(parseWrenchArguments([
      "omni", "read", "--input", "-", "--cache-only", "--identity-only",
    ])).toEqual({
      ok: false,
      message: "omni read accepts only one of --cache-only, --identity-only, or --from-exact-cache",
    });
    expect(parseWrenchArguments([
      "omni", "read", "--input", "-", "--from-exact-cache", "--headed",
    ])).toEqual({
      ok: false,
      message: "omni read cache, identity, and exact-cache rebuild modes never open a browser and cannot use --headed",
    });
    expect(parseWrenchArguments(["runs", "show", "00000000-0000-4000-8000-000000000000", "--json"])).toEqual({
      ok: true,
      value: {
        command: "runs-show",
        runId: "00000000-0000-4000-8000-000000000000",
        json: true,
      },
    });
    expect(parseWrenchArguments(["runs", "list", "--json"])).toEqual({
      ok: true,
      value: { command: "runs-list", json: true },
    });
    expect(parseWrenchArguments([
      "runs",
      "reconcile",
      "00000000-0000-4000-8000-000000000000",
      "--input",
      "@original-input.json",
      "--json",
    ])).toEqual({
      ok: true,
      value: {
        command: "runs-reconcile",
        runId: "00000000-0000-4000-8000-000000000000",
        inputSource: "@original-input.json",
        json: true,
      },
    });
    expect(parseWrenchArguments([
      "runs",
      "reconcile",
      "00000000-0000-4000-8000-000000000000",
    ])).toEqual({
      ok: true,
      value: {
        command: "runs-reconcile",
        runId: "00000000-0000-4000-8000-000000000000",
        json: false,
      },
    });
    expect(parseWrenchArguments(["plans", "list", "--json"])).toEqual({
      ok: true,
      value: { command: "plans-list", json: true },
    });
    expect(parseWrenchArguments(["plans", "cancel", "a".repeat(64), "--yes"])).toEqual({
      ok: true,
      value: { command: "plans-cancel", digest: "a".repeat(64), yes: true },
    });
  });

  test("parses bounded explicit duplicate-risk source runs", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(parseWrenchArguments([
      "invoke", "x-web", "posts.publish",
      "--input", "{}", "--auth", "x-main", "--preview",
      "--duplicate-risk-of", first,
    ])).toMatchObject({
      ok: true,
      value: { duplicateRiskOf: [first] },
    });
    for (const values of [
      ["not-a-run"],
      [first, first],
      [first, second],
      Array.from({ length: 26 }, (_, index) =>
        `00000000-0000-4000-8${String(index).padStart(3, "0")}-000000000000`),
    ]) {
      const raw = [
        "invoke", "x-web", "posts.publish", "--preview",
        ...values.flatMap((value) => ["--duplicate-risk-of", value]),
      ];
      expect(parseWrenchArguments(raw).ok).toBeFalse();
    }
    expect(parseWrenchArguments([
      "thread", "publish", "x", "--adapter", "x-web", "--text", "hello",
      "--auth", "x-main", "--preview", "--duplicate-risk-of", first,
    ])).toEqual({
      ok: false,
      message: "unknown option: --duplicate-risk-of",
    });
  });

  test("preserves compatible action aliases", () => {
    expect(parseWrenchArguments(["capture", "https://example.com"])).toEqual({
      ok: true,
      value: { command: "clip", arguments: ["https://example.com"] },
    });
    expect(parseWrenchArguments(["inspect", "https://example.com"])).toEqual({
      ok: true,
      value: { command: "read", arguments: ["https://example.com"] },
    });
    expect(parseWrenchArguments(["auth", "forget", "linkedin", "--yes"])).toEqual({
      ok: true,
      value: { command: "auth-remove", id: "linkedin", yes: true },
    });
    expect(parseWrenchArguments(["derive", "begin", "linkedin", "https://www.linkedin.com"])).toEqual({
      ok: true,
      value: {
        command: "derive-start",
        adapterId: "linkedin",
        url: "https://www.linkedin.com",
        authId: "linkedin",
        allowRemoteActions: false,
        contentMode: "none",
        browserDomains: ["www.linkedin.com"],
        cookieOrigins: [],
        fixtureSources: [],
        headed: false,
      },
    });
  });

  test.each([
    { arguments: ["help", "capabilities"], message: "help accepts no arguments" },
    { arguments: ["--help", "--json"], message: "help accepts no arguments" },
    { arguments: ["-h", "doctor"], message: "help accepts no arguments" },
    { arguments: ["doctor", "--verbose"], message: "doctor accepts only --json" },
    { arguments: ["capabilities", "one", "two"], message: "capabilities accepts one optional adapter ID" },
    { arguments: ["capabilities", "--json", "--json"], message: "capabilities accepts one optional adapter ID" },
    { arguments: ["plugin"], message: "plugin requires list, show, scaffold, init, check" },
    { arguments: ["plugins", "unknown"], message: "plugin requires list, show, scaffold, init, check" },
    { arguments: ["plugin", "list", "x"], message: "plugin list accepts only --json" },
    { arguments: ["plugin", "show"], message: "plugin show requires a plugin ID" },
    { arguments: ["plugin", "show", "X"], message: "plugin ID must be lowercase kebab-case" },
    { arguments: ["plugin", "show", `a${"b".repeat(63)}`], message: "at most 63 characters" },
    { arguments: ["plugins", "show", "x", "--json", "--json"], message: "plugin show accepts only --json" },
    { arguments: ["plugin", "check", "--json"], message: "plugin check requires a plugin directory" },
    { arguments: ["plugin", "check", "src/plugins/x-web", "--verbose"], message: "plugin check accepts only --json" },
    {
      arguments: [
        "plugin", "scaffold",
        "--site", "acme",
        "--display-name", "Acme",
        "--origin", "https://www.acme.example",
        "--operation", "feeds.read",
        "--risk", "R0",
        "--evidence", "/private/evidence.json",
        "--candidate", "0",
        "--output", "src/plugins/acme-web",
      ],
      message: "plugin scaffold --risk must be R1, R2, or R3",
    },
    {
      arguments: [
        "plugin", "scaffold",
        "--site", `a${"b".repeat(59)}`,
        "--display-name", "Too long",
        "--origin", "https://www.example.com",
        "--operation", "feeds.read",
        "--risk", "R1",
        "--evidence", "/private/evidence.json",
        "--candidate", "0",
        "--output", "src/plugins/too-long-web",
      ],
      message: "at most 59 characters",
    },
    { arguments: ["auth", "add", "LinkedIn", "--cookie-source", "chrome"], message: "lowercase kebab-case" },
    { arguments: ["auth", "add", "linkedin"], message: "exactly one" },
    {
      arguments: ["auth", "add", "linkedin", "--cookie-source", "chrome", "--cookies-file", "cookies.json"],
      message: "exactly one",
    },
    {
      arguments: [
        "auth", "add", "linkedin", "--cookie-source", "chrome",
        "--browser-executable", "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ],
      message: "requires --browser-profile",
    },
    { arguments: ["auth", "add", "linkedin", "--cookie-profile", "Work", "--cookies-file", "cookies.json"], message: "requires --cookie-source" },
    {
      arguments: ["auth", "add", "whatsapp", "--browser-profile", "Work", "--trust-profile-egress", "--cookie-profile", "Profile 1"],
      message: "requires --cookie-source",
    },
    {
      arguments: ["auth", "add", "whatsapp", "--browser-profile", "Work", "--trust-profile-egress", "--cookies-file", "cookies.json"],
      message: "exactly one",
    },
    {
      arguments: [
        "auth", "add", "linkedin-api", "--oauth-provider", "linkedin", "--token-file", "/private/token",
        "--scopes", "openid", "--cookie-source", "arc",
      ],
      message: "cannot be combined",
    },
    {
      arguments: [
        "auth", "add", "x-api", "--oauth-provider", "x", "--token-file", "/private/token",
        "--scopes", "tweet.read", "--browser-profile", "Work", "--trust-profile-egress",
      ],
      message: "cannot be combined",
    },
    {
      arguments: ["auth", "add", "x-api", "--oauth-provider", "x", "--scopes", "tweet.read"],
      message: "requires --oauth-provider, --token-file, and --scopes",
    },
    {
      arguments: [
        "auth", "add", "x-api", "--oauth-provider", "Mastodon", "--token-file", "/private/token", "--scopes", "tweet.read",
      ],
      message: "lowercase kebab-case provider surface ID",
    },
    {
      arguments: [
        "auth", "add", "x-api", "--oauth-provider", "x", "--token-file", "/private/token", "--scopes", "tweet.read,tweet.read",
      ],
      message: "duplicates",
    },
    {
      arguments: ["auth", "add", "whatsapp", "--device-store", "/private/store"],
      message: "--linked-device must be a lowercase kebab-case provider surface ID",
    },
    {
      arguments: [
        "auth", "add", "whatsapp", "--linked-device", "whatsapp",
        "--cookie-source", "arc",
      ],
      message: "cannot be combined",
    },
    {
      arguments: ["auth", "pair", "whatsapp", "--phone", "not-a-phone"],
      message: "international phone number",
    },
    {
      arguments: ["auth", "sync", "whatsapp"],
      message: "requires --once",
    },
    {
      arguments: [
        "auth", "add", "x-api", "--oauth-provider", "x", "--token-file", "/private/token", "--scopes", "tweet.read,,users.read",
      ],
      message: "provider scope names or canonical HTTPS scope URLs",
    },
    {
      arguments: [
        "auth", "add", "x-api", "--oauth-provider", "x", "--token-file", "/private/token", "--scopes", "tweet read",
      ],
      message: "without whitespace",
    },
    {
      arguments: [
        "auth", "add", "linkedin-api", "--oauth-provider", "linkedin", "--token-file", "/private/token",
        "--scopes", "openid", "--subject", "urn:li:person:abc\nspoofed",
      ],
      message: "invalid subject",
    },
    {
      arguments: ["auth", "add", "linkedin", "--cookie-source", "arc", "--subject", "viewer name"],
      message: "invalid subject",
    },
    {
      arguments: ["auth", "bind", "arc-main", "--site", "../example"],
      message: "lowercase-kebab-case-surface-id",
    },
    { arguments: ["platforms", "myspace"], message: "unknown platform surface" },
    { arguments: ["platforms", "x", "--json", "--json"], message: "one optional surface ID" },
    { arguments: ["thread"], message: "requires split" },
    { arguments: ["thread", "split", "reddit", "--text"], message: "--text requires a value" },
    { arguments: ["thread", "split", "myspace", "--text", "draft"], message: "unknown platform surface" },
    { arguments: ["adapter", "init", "linkedin", "--origin", "https://www.linkedin.com"], message: "requires --output" },
    { arguments: ["adapter", "init", "linkedin", "--output", "./out"], message: "exactly one of --origin or --platform" },
    {
      arguments: [
        "adapter", "init", "linkedin", "--origin", "https://www.linkedin.com", "--platform", "linkedin", "--output", "./out",
      ],
      message: "exactly one of --origin or --platform",
    },
    { arguments: ["derive", "start", "linkedin", "https://www.linkedin.com", "--content", "all"], message: "none or text" },
    { arguments: ["derive", "browser", "derive-123", "--"], message: "agent-browser command" },
    { arguments: ["invoke", "linkedin", "send"], message: "dotted semantic capability" },
    { arguments: ["invoke", "linkedin", "messaging.send", "--preview", "--preview"], message: "more than once" },
    { arguments: ["confirm", "digest", "--wat"], message: "unknown option" },
    { arguments: ["runs", "show"], message: "requires a run ID" },
    { arguments: ["runs", "show", "not-a-run"], message: "lowercase UUID" },
    { arguments: ["runs", "reconcile"], message: "requires a run ID" },
    { arguments: ["runs", "reconcile", "not-a-run"], message: "lowercase UUID" },
    {
      arguments: [
        "runs", "reconcile", "00000000-0000-4000-8000-000000000000",
        "--input",
      ],
      message: "--input requires a value",
    },
    {
      arguments: [
        "runs", "reconcile", "00000000-0000-4000-8000-000000000000",
        "--input", "{}", "--input", "{}",
      ],
      message: "--input was provided more than once",
    },
    {
      arguments: [
        "runs", "reconcile", "00000000-0000-4000-8000-000000000000",
        "--retry",
      ],
      message: "unknown option",
    },
  ])("rejects invalid or ambiguous grammar: $arguments", ({ arguments: raw, message }) => {
    const result = parseWrenchArguments(raw);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.message).toContain(message);
  });

  test("requires explicit profile-egress trust at the CLI boundary", () => {
    const result = parseWrenchArguments([
      "auth",
      "add",
      "linkedin-live",
      "--browser-profile",
      "Work",
    ]);
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.message).toContain("--trust-profile-egress");
  });
});
