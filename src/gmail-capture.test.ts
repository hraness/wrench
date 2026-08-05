import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureArguments } from "@hraness/kb/capture";
import type { WrenchAuth } from "./auth";
import {
  runGmailCapture,
  type GmailCaptureDependencies,
} from "./gmail-capture";
import {
  parseGmailThread,
  parseGmailThreadUrl,
  resolveGmailThreadBodies,
} from "./providers/gmail-api";

const SUBJECT = "person@example.com";
const THREAD_ID = "18fabc123";
const SOURCE_URL = new URL(
  `https://mail.google.com/mail/u/0/#all/${THREAD_ID}`,
);
const CANONICAL_URL =
  `https://mail.google.com/mail/u/${encodeURIComponent(SUBJECT)}/#all/${THREAD_ID}`;
const NUMERIC_SLOT_WARNING =
  "The copied Gmail URL used a browser-local numeric account slot; the stored OAuth subject supplied the captured account identity.";

type OutputCapture = {
  readonly output: {
    readonly stdout: (value: string) => void;
    readonly stderr: (value: string) => void;
  };
  readonly stdout: () => string;
  readonly stderr: () => string;
};

function outputCapture(): OutputCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function captureOptions(
  outputBase: string,
  overrides: Partial<CaptureArguments> = {},
): CaptureArguments {
  return {
    command: "capture",
    url: SOURCE_URL,
    currentTab: false,
    slug: undefined,
    mode: "auto",
    scope: "auto",
    media: "all",
    evidence: "none",
    htmlFile: undefined,
    outputBase,
    force: false,
    stdout: false,
    json: false,
    quiet: true,
    browserProfile: undefined,
    browserLive: false,
    cdp: undefined,
    cookieSources: [],
    cookieProfile: undefined,
    cookiesFile: undefined,
    timeoutMs: 1_000,
    maxItems: 20,
    maxDepth: 8,
    maxHtmlBytes: 1024 * 1024,
    maxAssetBytes: 1024 * 1024,
    maxTotalAssetBytes: 2 * 1024 * 1024,
    allowPrivateNetwork: false,
    userAgent: "gmail-capture-test",
    ...overrides,
  };
}

function oauthAuth(root: string, subject = SUBJECT): WrenchAuth {
  const path = join(root, "gmail-token.json");
  const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    provider: "gmail",
    subject,
    scopes,
    accessToken: "unit-test-access-token",
    expiresAt: null,
  })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    schemaVersion: 1,
    id: "gmail-test",
    kind: "oauth-token-file",
    provider: "gmail",
    path,
    scopes,
    subject,
  };
}

function message(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const projected = {
    id: "message-1",
    headers: {
      from: "Alice <alice@example.com>",
      to: SUBJECT,
      cc: null,
      bcc: null,
      subject: "Private project update",
      date: "Wed, 05 Aug 2026 12:00:00 -0400",
      messageId: "<message-1@example.com>",
      inReplyTo: null,
    },
    body: { text: "Hello from the complete Gmail thread." },
    attachments: [],
    ...overrides,
  };
  const attachments = Array.isArray(projected.attachments)
    ? projected.attachments.map((attachment, index) => ({
        partId: `projected-${index + 1}`,
        contentDisposition: "attachment" as const,
        ...(attachment as Record<string, unknown>),
      }))
    : projected.attachments;
  return { ...projected, attachments };
}

function expectedSlug(subject = SUBJECT, threadId = THREAD_ID): string {
  const digest = createHash("sha256")
    .update("gmail-thread\0", "utf8")
    .update(subject.toLocaleLowerCase("en-US"), "utf8")
    .update("\0", "utf8")
    .update(threadId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `gmail-thread-${digest}`;
}

function thread(messages: readonly unknown[]): Record<string, unknown> {
  return { id: THREAD_ID, messages };
}

function dependencies(
  projectedThread: unknown,
  overrides: GmailCaptureDependencies = {},
): GmailCaptureDependencies {
  return {
    fetch: () => Promise.reject(new Error("unexpected raw HTTP request")),
    parseThreadUrl: () => ({
      accountLocator: "0",
      view: "all",
      threadId: THREAD_ID,
      canonicalUrl: SOURCE_URL.href,
    }),
    buildThreadUrl: () => CANONICAL_URL,
    getProfile: () => Promise.resolve({ emailAddress: SUBJECT }),
    fetchThread: () => Promise.resolve(projectedThread),
    parseThread: (value) => value,
    now: () => new Date("2026-08-05T16:00:00.000Z"),
    ...overrides,
  };
}

function withFixture(
  run: (root: string, outputRoot: string, auth: WrenchAuth) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wrench-gmail-capture-test-"));
  chmodSync(root, 0o700);
  const outputRoot = join(root, "clips", "gmail");
  const auth = oauthAuth(root);
  return run(root, outputRoot, auth).finally(() => rmSync(root, {
    recursive: true,
    force: true,
  }));
}

describe("Gmail thread capture", () => {
  test("atomically stores verified content-addressed attachments with a private tree", async () => {
    await withFixture(async (root, outputRoot, auth) => {
      const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
      const digest = createHash("sha256").update(attachmentBytes).digest("hex");
      const bodySecret = "gmail-body-secret-unique";
      const signedUrlSecret = "gmail-signed-url-secret";
      const projected = thread([
        message({
          body: {
            text: `<script>unsafe()</script>\nAuthorization: Bearer ${bodySecret}\nhttps://storage.example/file?X-Amz-Signature=${signedUrlSecret}&X-Amz-Credential=opaque\n[click](javascript:alert(1))`,
          },
          attachments: [{
            attachmentId: "attachment-private-id",
            filename: "../../token=foreign-filename.pdf",
            mimeType: "application/pdf",
            size: attachmentBytes.byteLength,
          }],
        }),
      ]);
      const io = outputCapture();
      let attachmentFetches = 0;
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(projected, {
          parseThreadUrl: parseGmailThreadUrl,
          resolveAttachment: () => {
            attachmentFetches += 1;
            return Promise.resolve(attachmentBytes);
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(attachmentFetches).toBe(1);
      const slug = expectedSlug();
      const bundle = join(outputRoot, slug);
      const markdownPath = join(bundle, `${slug}.md`);
      const assetPath = join(bundle, "assets", `${digest}.bin`);
      const manifestPath = join(bundle, "capture.json");
      const provenancePath = join(bundle, "gmail.json");
      const markdown = readFileSync(markdownPath, "utf8");
      const manifestText = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(manifestText) as {
        readonly sourceUrl: string;
        readonly canonicalUrl: string;
        readonly assets: readonly {
          readonly source: string;
          readonly url: string;
          readonly path: string;
          readonly mimeType: string;
          readonly bytes: number;
          readonly sha256: string;
        }[];
        readonly warnings: readonly string[];
      };
      const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
        readonly schemaVersion: number;
        readonly sourceUrl: string;
        readonly canonicalUrl: string;
        readonly accountSubject: string;
        readonly accountBinding: string;
        readonly thread: {
          readonly id: string;
          readonly messages: readonly {
            readonly headers: {
              readonly from: string | null;
              readonly to: string | null;
              readonly cc: string | null;
              readonly bcc: string | null;
              readonly subject: string | null;
              readonly date: string | null;
              readonly messageId: string | null;
              readonly inReplyTo: string | null;
            };
            readonly attachments: readonly {
              readonly partId: string;
              readonly attachmentId: string | null;
              readonly path: string | null;
              readonly sha256: string | null;
            }[];
          }[];
        };
      };

      expect(readFileSync(assetPath)).toEqual(Buffer.from(attachmentBytes));
      expect(markdown).toContain(`assets/${digest}.bin`);
      expect(markdown).toContain("&lt;script&gt;unsafe\\(\\)&lt;/script&gt;");
      expect(markdown).not.toContain(bodySecret);
      expect(markdown).not.toContain(signedUrlSecret);
      expect(markdown).not.toContain("attachment-private-id");
      expect(manifest.sourceUrl).toBe(SOURCE_URL.href);
      expect(manifest.canonicalUrl).toBe(CANONICAL_URL);
      expect(manifest.assets).toEqual([{
        source: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/attachments/attachment-private-id",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1/attachments/attachment-private-id",
        path: `assets/${digest}.bin`,
        mimeType: "application/octet-stream",
        bytes: attachmentBytes.byteLength,
        sha256: digest,
      }]);
      expect(manifest.warnings).toEqual([NUMERIC_SLOT_WARNING]);
      expect(provenance).toMatchObject({
        schemaVersion: 2,
        sourceUrl: SOURCE_URL.href,
        canonicalUrl: CANONICAL_URL,
        accountSubject: SUBJECT,
        accountBinding: "numeric-slot-rebound",
        thread: {
          id: THREAD_ID,
          messages: [{
            headers: {
              from: "Alice <alice@example.com>",
              to: SUBJECT,
              cc: null,
              bcc: null,
              subject: "Private project update",
              date: "Wed, 05 Aug 2026 12:00:00 -0400",
              messageId: "<message-1@example.com>",
              inReplyTo: null,
            },
            attachments: [{
              partId: "projected-1",
              attachmentId: "attachment-private-id",
              path: `assets/${digest}.bin`,
              sha256: digest,
            }],
          }],
        },
      });
      expect(manifestText).not.toContain(bodySecret);
      expect(manifestText).not.toContain(signedUrlSecret);
      expect(manifestText).toContain("attachment-private-id");
      expect(statSync(bundle).mode & 0o777).toBe(0o700);
      expect(statSync(join(bundle, "assets")).mode & 0o777).toBe(0o700);
      expect(statSync(markdownPath).mode & 0o777).toBe(0o600);
      expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
      expect(statSync(provenancePath).mode & 0o777).toBe(0o600);
      expect(statSync(assetPath).mode & 0o777).toBe(0o600);
      expect(io.stdout()).not.toContain(root);
      expect(io.stdout()).not.toContain(bodySecret);
      expect(io.stdout()).not.toContain(signedUrlSecret);
      expect(io.stdout()).not.toContain("foreign-filename");
      expect(io.stdout()).not.toContain(THREAD_ID);
      expect(io.stderr()).toBe(`warning: ${NUMERIC_SLOT_WARNING}\n`);
    });
  });

  test("writes schema-2 headers for every message with explicit null provenance", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const projected = thread([
        message({
          id: "message-1",
          headers: {
            from: "Alice <alice@example.com>",
            to: SUBJECT,
            cc: "Team <team@example.com>",
            bcc: null,
            subject: "First",
            date: "Wed, 05 Aug 2026 12:00:00 -0400",
            messageId: "<message-1@example.com>",
            inReplyTo: null,
          },
        }),
        message({
          id: "message-2",
          headers: {
            from: null,
            to: null,
            cc: null,
            bcc: null,
            subject: null,
            date: null,
            messageId: "<message-2@example.com>",
            inReplyTo: "<message-1@example.com>",
          },
        }),
      ]);
      const io = outputCapture();

      expect(await runGmailCapture(
        captureOptions(outputRoot, { json: true, media: "none" }),
        auth,
        {},
        io.output,
        dependencies(projected),
      )).toBe(0);

      const provenance = JSON.parse(readFileSync(
        join(outputRoot, expectedSlug(), "gmail.json"),
        "utf8",
      )) as {
        readonly schemaVersion: number;
        readonly thread: {
          readonly messages: readonly {
            readonly id: string;
            readonly headers: Record<string, string | null>;
          }[];
        };
      };
      expect(provenance.schemaVersion).toBe(2);
      expect(provenance.thread.messages).toEqual([
        expect.objectContaining({
          id: "message-1",
          headers: {
            from: "Alice <alice@example.com>",
            to: SUBJECT,
            cc: "Team <team@example.com>",
            bcc: null,
            subject: "First",
            date: "Wed, 05 Aug 2026 12:00:00 -0400",
            messageId: "<message-1@example.com>",
            inReplyTo: null,
          },
        }),
        expect.objectContaining({
          id: "message-2",
          headers: {
            from: null,
            to: null,
            cc: null,
            bcc: null,
            subject: null,
            date: null,
            messageId: "<message-2@example.com>",
            inReplyTo: "<message-1@example.com>",
          },
        }),
      ]);
    });
  });

  test("rejects an omitted schema-2 header instead of forging null provenance", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const io = outputCapture();
      const projected = thread([message({
        headers: {
          from: "Alice <alice@example.com>",
          to: SUBJECT,
          cc: null,
          bcc: null,
          subject: "Missing reply provenance",
          date: "Wed, 05 Aug 2026 12:00:00 -0400",
          messageId: "<message-1@example.com>",
        },
      })]);

      expect(await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(projected),
      )).toBe(1);
      expect(io.stderr()).toContain("invalid thread projection");
      expect(existsSync(outputRoot)).toBeFalse();
    });
  });

  test("preserves parsed attachment identity to capture inline MIME body data", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const attachmentBytes = new Uint8Array([9, 8, 7, 6, 5]);
      const digest = createHash("sha256").update(attachmentBytes).digest("hex");
      const secondAttachmentBytes = new Uint8Array([1, 3, 5, 7]);
      const secondDigest = createHash("sha256")
        .update(secondAttachmentBytes)
        .digest("hex");
      const rawThread = {
        id: THREAD_ID,
        messages: [{
          id: "inline-message",
          threadId: THREAD_ID,
          payload: {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "To", value: SUBJECT },
              { name: "Subject", value: "Inline attachment" },
            ],
            parts: [
              {
                partId: "0",
                mimeType: "text/plain",
                filename: "",
                headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
                body: {
                  size: 5,
                  data: Buffer.from("Hello").toString("base64url"),
                },
              },
              {
                partId: "1",
                mimeType: "application/pdf",
                filename: "inline.pdf",
                headers: [{ name: "Content-Type", value: "application/pdf" }],
                body: {
                  size: attachmentBytes.byteLength,
                  data: Buffer.from(attachmentBytes).toString("base64url"),
                },
              },
              {
                partId: "2",
                mimeType: "text/plain",
                filename: "inline-notes.txt",
                headers: [{ name: "Content-Type", value: "text/plain" }],
                body: {
                  size: secondAttachmentBytes.byteLength,
                  data: Buffer.from(secondAttachmentBytes).toString("base64url"),
                },
              },
            ],
          },
        }],
      };
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(rawThread, { parseThread: parseGmailThread }),
      );

      expect(exitCode).toBe(0);
      const slug = expectedSlug();
      const bundle = join(outputRoot, slug);
      expect(readFileSync(join(bundle, "assets", `${digest}.bin`))).toEqual(
        Buffer.from(attachmentBytes),
      );
      expect(readFileSync(join(bundle, "assets", `${secondDigest}.bin`))).toEqual(
        Buffer.from(secondAttachmentBytes),
      );
      const markdown = readFileSync(
        join(bundle, `${slug}.md`),
        "utf8",
      );
      expect(markdown).toContain(`assets/${digest}.bin`);
      expect(markdown).toContain(`assets/${secondDigest}.bin`);
      const manifest = JSON.parse(readFileSync(join(bundle, "capture.json"), "utf8")) as {
        readonly assets: readonly {
          readonly source: string;
          readonly url: string;
          readonly path: string;
        }[];
      };
      const messageEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/messages/inline-message";
      expect(manifest.assets).toHaveLength(2);
      expect(manifest.assets.every((asset) =>
        asset.source === messageEndpoint && asset.url === messageEndpoint))
        .toBeTrue();
      expect(manifest.assets.map((asset) => asset.path).sort()).toEqual([
        `assets/${digest}.bin`,
        `assets/${secondDigest}.bin`,
      ].sort());
      expect(io.stderr()).toBe(`warning: ${NUMERIC_SLOT_WARNING}\n`);
    });
  });

  test("deduplicates byte-identical cross-MIME occurrences without losing provenance", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const bytes = new Uint8Array([4, 2, 4, 2]);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const projected = thread([message({
        attachments: [{
          attachmentId: "first-occurrence",
          filename: "first.pdf",
          mimeType: "application/pdf",
          size: bytes.byteLength,
        }, {
          attachmentId: "second-occurrence",
          contentDisposition: "inline",
          filename: "second.html",
          mimeType: "text/html",
          size: bytes.byteLength,
        }],
      })]);
      const io = outputCapture();
      expect(await runGmailCapture(
        captureOptions(outputRoot, { json: true }),
        auth,
        {},
        io.output,
        dependencies(projected, {
          resolveAttachment: () => Promise.resolve(bytes),
        }),
      )).toBe(0);

      const bundle = join(outputRoot, expectedSlug());
      const manifest = JSON.parse(readFileSync(join(bundle, "capture.json"), "utf8")) as {
        readonly assets: readonly {
          readonly path: string;
          readonly mimeType: string;
        }[];
      };
      const provenance = JSON.parse(readFileSync(join(bundle, "gmail.json"), "utf8")) as {
        readonly thread: {
          readonly messages: readonly {
            readonly attachments: readonly {
              readonly partId: string;
              readonly attachmentId: string | null;
              readonly contentDisposition: "attachment" | "inline" | null;
              readonly filename: string;
              readonly mimeType: string;
              readonly declaredBytes: number;
              readonly path: string | null;
              readonly sha256: string | null;
              readonly capturedBytes: number | null;
            }[];
          }[];
        };
      };
      expect(manifest.assets).toHaveLength(1);
      expect(manifest.assets[0]).toMatchObject({
        path: `assets/${digest}.bin`,
        mimeType: "application/octet-stream",
      });
      expect(readdirSync(join(bundle, "assets"))).toEqual([`${digest}.bin`]);
      expect(provenance.thread.messages[0]?.attachments).toEqual([
        {
          partId: "projected-1",
          attachmentId: "first-occurrence",
          contentDisposition: "attachment",
          filename: "first.pdf",
          mimeType: "application/pdf",
          declaredBytes: 4,
          path: `assets/${digest}.bin`,
          sha256: digest,
          capturedBytes: 4,
        },
        {
          partId: "projected-2",
          attachmentId: "second-occurrence",
          contentDisposition: "inline",
          filename: "second.html",
          mimeType: "text/html",
          declaredBytes: 4,
          path: `assets/${digest}.bin`,
          sha256: digest,
          capturedBytes: 4,
        },
      ]);
      expect(JSON.parse(io.stdout())).toMatchObject({
        capturedAttachmentCount: 2,
        capturedFileCount: 1,
      });
    });
  });

  test("uses one inert MIME-independent extension for every stored attachment", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const values = [
        { bytes: new Uint8Array([1]), filename: "mismatch.html", mimeType: "application/pdf" },
        { bytes: new Uint8Array([2]), filename: "unknown.html", mimeType: "application/octet-stream" },
        { bytes: new Uint8Array([3]), filename: "active.html", mimeType: "text/html" },
      ] as const;
      const projected = thread([message({
        attachments: values.map((value, index) => ({
          attachmentId: `attachment-${index}`,
          filename: value.filename,
          mimeType: value.mimeType,
          size: value.bytes.byteLength,
        })),
      })]);
      const io = outputCapture();
      expect(await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(projected, {
          resolveAttachment: (_client, attachment) => {
            const index = Number(attachment.attachmentId?.slice(-1));
            return Promise.resolve(values[index]?.bytes ?? new Uint8Array());
          },
        }),
      )).toBe(0);
      const assets = readdirSync(join(outputRoot, expectedSlug(), "assets")).sort();
      expect(assets).toEqual(values.map((value) =>
        `${createHash("sha256").update(value.bytes).digest("hex")}.bin`).sort());
      expect(assets.some((name) => name.endsWith(".html") || name.endsWith(".exe"))).toBeFalse();
    });
  });

  test("fetches external text bodies before rendering and file attachments before commit", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const externalBody = "Hello from the externally stored body";
      const attachmentBytes = new Uint8Array([5, 4, 3, 2]);
      const digest = createHash("sha256").update(attachmentBytes).digest("hex");
      const rawThread = {
        id: THREAD_ID,
        messages: [{
          id: "external-message",
          threadId: THREAD_ID,
          payload: {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers: [{ name: "Subject", value: "External attachment" }],
            parts: [{
              partId: "0",
              mimeType: "text/plain",
              filename: "",
              headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
              body: {
                attachmentId: "external-body",
                size: Buffer.byteLength(externalBody),
              },
            }, {
              partId: "1",
              mimeType: "application/pdf",
              filename: "external.pdf",
              headers: [{ name: "Content-Type", value: "application/pdf" }],
              body: {
                attachmentId: "external-attachment",
                size: attachmentBytes.byteLength,
              },
            }],
          },
        }],
      };
      const requests: Array<{ readonly url: string; readonly method: string }> = [];
      const fetch: NonNullable<GmailCaptureDependencies["fetch"]> = (input, init = {}) => {
        const url = input instanceof Request
          ? new URL(input.url)
          : new URL(input);
        requests.push({ url: url.href, method: init.method ?? "GET" });
        let body: unknown;
        if (url.pathname.endsWith("/profile")) {
          body = {
            emailAddress: SUBJECT,
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: "123",
          };
        } else if (url.pathname.endsWith(`/threads/${THREAD_ID}`)) {
          body = rawThread;
        } else if (url.pathname.endsWith("/attachments/external-body")) {
          body = {
            attachmentId: "external-body",
            size: Buffer.byteLength(externalBody),
            data: Buffer.from(externalBody).toString("base64url"),
          };
        } else if (url.pathname.endsWith("/attachments/external-attachment")) {
          body = {
            attachmentId: "external-attachment",
            size: attachmentBytes.byteLength,
            data: Buffer.from(attachmentBytes).toString("base64url"),
          };
        } else {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      };
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        { fetch, now: () => new Date("2026-08-05T16:00:00.000Z") },
      );

      expect(exitCode).toBe(0);
      expect(requests.map((request) => ({
        method: request.method,
        pathname: new URL(request.url).pathname,
      }))).toEqual([
        {
          method: "GET",
          pathname: "/gmail/v1/users/me/profile",
        },
        {
          method: "GET",
          pathname: `/gmail/v1/users/me/threads/${THREAD_ID}`,
        },
        {
          method: "GET",
          pathname: "/gmail/v1/users/me/messages/external-message/attachments/external-body",
        },
        {
          method: "GET",
          pathname: "/gmail/v1/users/me/messages/external-message/attachments/external-attachment",
        },
      ]);
      const requestUrls = requests.map((request) => new URL(request.url));
      expect(requestUrls[0]?.searchParams.get("fields")).toBe(
        "emailAddress,messagesTotal,threadsTotal,historyId",
      );
      expect(requestUrls[1]?.searchParams.get("format")).toBe("full");
      expect(requestUrls[1]?.searchParams.get("fields")).toBe(
        "id,snippet,historyId,messages(id,threadId,labelIds,snippet,historyId,internalDate,payload(partId,mimeType,filename,headers(name,value),body(attachmentId,size,data),parts),sizeEstimate)",
      );
      expect(requestUrls[1]?.searchParams.get("fields")).not.toContain(
        "classificationLabelValues",
      );
      expect(requestUrls.slice(2).map((url) => url.searchParams.get("fields")))
        .toEqual(["attachmentId,size,data", "attachmentId,size,data"]);
      const slug = expectedSlug();
      expect(readFileSync(join(outputRoot, slug, `${slug}.md`), "utf8"))
        .toContain(externalBody);
      expect(readFileSync(join(outputRoot, slug, "assets", `${digest}.bin`))).toEqual(
        Buffer.from(attachmentBytes),
      );
      expect(io.stderr()).toBe(`warning: ${NUMERIC_SLOT_WARNING}\n`);
    });
  });

  test("does not persist when external body resolution fails", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const externalBody = "unavailable external body";
      const failureSecret = "private-external-body-failure";
      const rawThread = {
        id: THREAD_ID,
        messages: [{
          id: "external-body-message",
          threadId: THREAD_ID,
          payload: {
            partId: "",
            mimeType: "text/plain",
            filename: "",
            headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
            body: {
              attachmentId: "external-body-failure",
              size: Buffer.byteLength(externalBody),
            },
          },
        }],
      };
      let bodyFetches = 0;
      let resolverCalls = 0;
      const fetch: NonNullable<GmailCaptureDependencies["fetch"]> = (input) => {
        const url = input instanceof Request
          ? new URL(input.url)
          : new URL(input);
        if (url.pathname.endsWith("/profile")) {
          return Promise.resolve(new Response(JSON.stringify({
            emailAddress: SUBJECT,
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: "123",
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        if (url.pathname.endsWith(`/threads/${THREAD_ID}`)) {
          return Promise.resolve(new Response(JSON.stringify(rawThread), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        if (url.pathname.endsWith("/attachments/external-body-failure")) {
          bodyFetches += 1;
          return Promise.reject(new Error(failureSecret));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        {
          fetch,
          now: () => new Date("2026-08-05T16:00:00.000Z"),
          resolveThreadBodies: (...input) => {
            resolverCalls += 1;
            return resolveGmailThreadBodies(...input);
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(resolverCalls).toBe(1);
      expect(bodyFetches).toBe(1);
      expect(existsSync(outputRoot)).toBeFalse();
      expect(io.stderr()).toContain("invalid thread projection");
      expect(io.stderr()).not.toContain(failureSecret);
      expect(io.stderr()).not.toContain(externalBody);
    });
  });

  test("inspect with media none renders sanitized Markdown without writes or attachment fetches", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const bodySecret = "inspect-body-secret-unique";
      const projected = thread([
        message({
          body: { text: `Visible prose. token=${bodySecret}` },
          attachments: [{
            attachmentId: "attachment-1",
            filename: "notes.txt",
            mimeType: "text/plain",
            size: 12,
          }],
        }),
      ]);
      let attachmentFetches = 0;
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot, {
          command: "inspect",
          url: new URL(CANONICAL_URL),
          media: "none",
          stdout: true,
        }),
        auth,
        {},
        io.output,
        dependencies(projected, {
          parseThreadUrl: parseGmailThreadUrl,
          resolveAttachment: () => {
            attachmentFetches += 1;
            return Promise.resolve(new Uint8Array());
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(attachmentFetches).toBe(0);
      expect(existsSync(outputRoot)).toBe(false);
      expect(io.stdout()).toContain("Visible prose\\.");
      expect(io.stdout()).toContain("content not captured");
      expect(io.stdout()).not.toContain(bodySecret);
      expect(io.stdout()).not.toContain("javascript:");
      expect(io.stderr()).toBe("");
    });
  });

  test("capture with media none persists metadata but skips every attachment byte", async () => {
    await withFixture(async (root, outputRoot, auth) => {
      const bodySecret = "media-none-body-secret";
      const projected = thread([
        message({
          body: { text: `Metadata-only body token=${bodySecret}` },
          attachments: [{
            attachmentId: "attachment-1",
            filename: "private-name.txt",
            mimeType: "text/plain",
            size: 12,
          }],
        }),
      ]);
      let attachmentResolutions = 0;
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot, {
          media: "none",
          json: true,
          maxAssetBytes: 3,
          maxTotalAssetBytes: 3,
        }),
        auth,
        {},
        io.output,
        dependencies(projected, {
          resolveAttachment: () => {
            attachmentResolutions += 1;
            return Promise.resolve(new Uint8Array(12));
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(attachmentResolutions).toBe(0);
      const slug = expectedSlug();
      const bundle = join(outputRoot, slug);
      expect(existsSync(join(bundle, "assets"))).toBe(false);
      const markdown = readFileSync(join(bundle, `${slug}.md`), "utf8");
      expect(markdown).toContain("content not captured");
      expect(markdown).not.toContain(bodySecret);
      const summary = JSON.parse(io.stdout()) as Record<string, unknown>;
      expect(summary).toMatchObject({
        ok: true,
        discoveredAttachmentCount: 1,
        capturedAttachmentCount: 0,
        capturedFileCount: 0,
        capturedBytes: 0,
        warnings: [NUMERIC_SLOT_WARNING],
      });
      expect(io.stdout()).not.toContain(root);
      expect(io.stdout()).not.toContain(bodySecret);
      expect(io.stdout()).not.toContain("private-name");
      expect(io.stderr()).toBe("");
    });
  });

  test("binds the authenticated profile before fetching private thread content", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      let threadFetches = 0;
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(thread([message()]), {
          getProfile: () => Promise.resolve({ emailAddress: "other@example.com" }),
          fetchThread: () => {
            threadFetches += 1;
            return Promise.resolve(thread([message()]));
          },
        }),
      );

      expect(exitCode).toBe(1);
      expect(threadFetches).toBe(0);
      expect(existsSync(outputRoot)).toBe(false);
      expect(io.stderr()).toContain("does not match the auth locator subject");
      expect(io.stderr()).not.toContain(SUBJECT);
      expect(io.stderr()).not.toContain("other@example.com");
    });
  });

  test("accepts the exact eight-digit Gmail account slot grammar", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot, {
          command: "inspect",
          url: new URL(
            `https://mail.google.com/mail/u/12345678/#all/${THREAD_ID}`,
          ),
          media: "none",
          stdout: true,
        }),
        auth,
        {},
        io.output,
        dependencies(thread([message()]), {
          parseThreadUrl: parseGmailThreadUrl,
        }),
      );

      expect(exitCode).toBe(0);
      expect(existsSync(outputRoot)).toBe(false);
      expect(io.stdout()).toContain("Hello from the complete Gmail thread");
      expect(io.stderr()).toBe(`warning: ${NUMERIC_SLOT_WARNING}\n`);
    });
  });

  test("rejects attachment count, per-file, and total bounds before fetching bytes", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const cases = [
        {
          name: "count",
          options: { maxItems: 1 },
          attachments: [
            { attachmentId: "a", filename: "a.bin", mimeType: "application/octet-stream", size: 1 },
            { attachmentId: "b", filename: "b.bin", mimeType: "application/octet-stream", size: 1 },
          ],
          error: "attachment file limit",
        },
        {
          name: "per-file",
          options: { maxAssetBytes: 3, maxTotalAssetBytes: 10 },
          attachments: [
            { attachmentId: "a", filename: "a.bin", mimeType: "application/octet-stream", size: 4 },
          ],
          error: "per-file byte limit",
        },
        {
          name: "total",
          options: { maxAssetBytes: 5, maxTotalAssetBytes: 5 },
          attachments: [
            { attachmentId: "a", filename: "a.bin", mimeType: "application/octet-stream", size: 3 },
            { attachmentId: "b", filename: "b.bin", mimeType: "application/octet-stream", size: 3 },
          ],
          error: "total byte limit",
        },
      ] as const;
      for (const fixture of cases) {
        let attachmentFetches = 0;
        const io = outputCapture();
        const exitCode = await runGmailCapture(
          captureOptions(join(outputRoot, fixture.name), fixture.options),
          auth,
          {},
          io.output,
          dependencies(thread([message({ attachments: fixture.attachments })]), {
            resolveAttachment: () => {
              attachmentFetches += 1;
              return Promise.resolve(new Uint8Array());
            },
          }),
        );
        expect(exitCode).toBe(1);
        expect(attachmentFetches).toBe(0);
        expect(io.stderr()).toContain(fixture.error);
        expect(existsSync(join(outputRoot, fixture.name))).toBe(false);
      }
    });
  });

  test("rejects rendered metadata overflow before attachment fetch or staging", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      let attachmentFetches = 0;
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot, { maxHtmlBytes: 256 }),
        auth,
        {},
        io.output,
        dependencies(thread([message({
          body: { text: "" },
          attachments: [{
            attachmentId: "long-label",
            filename: `${"x".repeat(900)}.pdf`,
            mimeType: "application/pdf",
            size: 1,
          }],
        })]), {
          resolveAttachment: () => {
            attachmentFetches += 1;
            return Promise.resolve(new Uint8Array([1]));
          },
        }),
      );
      expect(exitCode).toBe(1);
      expect(attachmentFetches).toBe(0);
      expect(io.stderr()).toContain("rendered Gmail thread exceeds");
      expect(existsSync(outputRoot)).toBeFalse();
    });
  });

  test("uses opaque collision-resistant default slugs without exposing thread IDs", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const prefix = "a".repeat(240);
      const ids = [`${prefix}first-thread-id`, `${prefix}second-thread-i`];
      expect(ids.every((id) => id.length === 255)).toBeTrue();
      const slugs: string[] = [];
      for (const id of ids) {
        const io = outputCapture();
        const projected = { ...thread([message()]), id };
        expect(await runGmailCapture(
          captureOptions(outputRoot, {
            command: "inspect",
            stdout: true,
            json: true,
            media: "none",
          }),
          auth,
          {},
          io.output,
          dependencies(projected, {
            parseThreadUrl: () => ({
              accountLocator: "0",
              view: "all",
              threadId: id,
              canonicalUrl: SOURCE_URL.href,
            }),
            buildThreadUrl: (account) =>
              `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${id}`,
          }),
        )).toBe(0);
        const summary = JSON.parse(io.stdout()) as { readonly slug: string };
        slugs.push(summary.slug);
        expect(summary.slug).toMatch(/^gmail-thread-[a-f0-9]{32}$/u);
        expect(io.stdout()).not.toContain(id);
      }
      expect(slugs[0]).not.toBe(slugs[1]);
      expect(existsSync(outputRoot)).toBeFalse();
    });
  });

  test("rolls back earlier staged files when a later attachment fails size verification", async () => {
    await withFixture(async (_root, outputRoot, auth) => {
      const projected = thread([
        message({
          attachments: [{
            attachmentId: "attachment-1",
            filename: "first.txt",
            mimeType: "text/plain",
            size: 3,
          }, {
            attachmentId: "attachment-2",
            filename: "second.txt",
            mimeType: "text/plain",
            size: 4,
          }],
        }),
      ]);
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot),
        auth,
        {},
        io.output,
        dependencies(projected, {
          resolveAttachment: (_client, attachment) => Promise.resolve(
            attachment.attachmentId === "attachment-1"
              ? new Uint8Array([1, 2, 3])
              : new Uint8Array([4, 5, 6]),
          ),
        }),
      );

      expect(exitCode).toBe(1);
      expect(io.stderr()).toContain("did not match its declared byte size");
      expect(existsSync(outputRoot)).toBe(true);
      expect(readdirSync(outputRoot)).toEqual([]);
    });
  });

  test("keeps foreign body text, thrown payloads, and filesystem paths out of summaries", async () => {
    await withFixture(async (root, outputRoot, auth) => {
      const secret = "foreign-thread-body-secret";
      const io = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions(outputRoot, { json: true }),
        auth,
        {},
        io.output,
        dependencies(thread([message({ body: { text: secret } })]), {
          parseThread: () => {
            throw new Error(`raw provider body ${secret} token=also-secret path=${root}`);
          },
        }),
      );

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(io.stdout()) as Record<string, unknown>;
      expect(parsed).toEqual({
        ok: false,
        error: "Gmail returned an invalid thread projection",
      });
      expect(io.stdout()).not.toContain(secret);
      expect(io.stdout()).not.toContain(root);
      expect(io.stderr()).toBe("");
    });
  });

  test("rejects unsupported acquisition and media semantics before reading private auth state", async () => {
    const missingAuth: WrenchAuth = {
      schemaVersion: 1,
      id: "gmail-missing",
      kind: "oauth-token-file",
      provider: "gmail",
      path: "/private/does-not-exist",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      subject: SUBJECT,
    };
    for (const [options, expected] of [
      [{ mode: "file", htmlFile: "/private/source.html" }, "accepts only --mode auto"],
      [{ mode: "http" }, "accepts only --mode auto"],
      [{ media: "images" }, "attachments use --media all or --media none"],
    ] as const) {
      const current = outputCapture();
      const exitCode = await runGmailCapture(
        captureOptions("/private/not-used", options),
        missingAuth,
        {},
        current.output,
        dependencies(thread([message()])),
      );
      expect(exitCode).toBe(1);
      expect(current.stderr()).toContain(expected);
      expect(current.stderr()).not.toContain("does-not-exist");
    }
  });
});
