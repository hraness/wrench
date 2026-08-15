import { describe, expect, test } from "bun:test";

import {
  ProviderHttpClient,
  type ProviderFetch,
} from "../provider-http";
import {
  buildGmailThreadUrl,
  createGmailApiClient,
  fetchGmailAttachmentBytes,
  fetchGmailContacts,
  fetchGmailMessageInteractionMetadata,
  fetchGmailMessageList,
  fetchGmailMessageMetadata,
  fetchGmailThread,
  fetchGmailThreadList,
  fetchGmailThreadMetadata,
  getAuthenticatedGmailProfile,
  listGmailSendAsAliases,
  parseGmailThread,
  parseGmailThreadUrl,
  resolveGmailAttachmentBytes,
  resolveGmailThreadBodies,
} from "./gmail-api";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function client(fetch: ProviderFetch) {
  return createGmailApiClient({
    http: new ProviderHttpClient(fetch, 30_000, 16 * 1024 * 1024),
    accessToken: "unit-test-access-token",
    subject: "Person@Example.com",
  });
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

function fullThread() {
  const inline = new Uint8Array([1, 2, 3]);
  const html = "<script>secret()</script><p>HTML fallback &amp; safe</p>";
  return {
    id: "thread_1",
    snippet: "Thread preview",
    historyId: "91",
    messages: [{
      id: "message_1",
      threadId: "thread_1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Message preview",
      historyId: "90",
      internalDate: "1785801600000",
      sizeEstimate: 2_048,
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers: [
          { name: "From", value: "Friend <friend@example.com>" },
          { name: "To", value: "Person <person@example.com>" },
          { name: "Subject", value: "A thread" },
          { name: "Date", value: "Tue, 4 Aug 2026 20:00:00 +0000" },
          { name: "Message-ID", value: "<message@example.com>" },
        ],
        body: { size: 0 },
        parts: [{
          partId: "1",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
          body: { size: 17, data: encoded("Plain body\nline 2") },
        }, {
          partId: "2",
          mimeType: "text/html",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: {
            size: Buffer.byteLength(html, "utf8"),
            data: encoded(html),
          },
        }, {
          partId: "3",
          mimeType: "application/pdf",
          filename: "report.pdf",
          headers: [],
          body: {
            attachmentId: `${"opaque+/=".repeat(300)}tail`,
            size: 4,
          },
        }, {
          partId: "4",
          mimeType: "image/png",
          filename: "pixel.png",
          headers: [],
          body: { size: inline.byteLength, data: Buffer.from(inline).toString("base64url") },
        }],
      },
    }],
  } as const;
}

function threadWithParts(parts: readonly unknown[]) {
  return {
    id: "thread_mime",
    messages: [{
      id: "message_mime",
      threadId: "thread_mime",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts,
      },
    }],
  };
}

describe("official Gmail API helpers", () => {
  test("binds the OAuth subject with an exact read-only profile GET", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const api = client((input, init = {}) => {
      requests.push({ url: urlOf(input), init });
      return Promise.resolve(json({
        emailAddress: "person@example.com",
        messagesTotal: 12,
        threadsTotal: 7,
        historyId: "99",
      }));
    });
    expect(await getAuthenticatedGmailProfile(api)).toEqual({
      emailAddress: "person@example.com",
      messagesTotal: 12,
      threadsTotal: 7,
      historyId: "99",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) throw new Error("expected one profile request");
    expect(request.url.origin + request.url.pathname)
      .toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(request.url.searchParams.get("fields"))
      .toBe("emailAddress,messagesTotal,threadsTotal,historyId");
    expect(requests[0]?.init.method).toBe("GET");
    expect(new Headers(requests[0]?.init.headers).get("authorization"))
      .toBe("Bearer unit-test-access-token");

    const mismatched = createGmailApiClient({
      http: new ProviderHttpClient(() => Promise.resolve(json({
        emailAddress: "other@example.com",
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: "1",
      })), 30_000, 1_024 * 1_024),
      accessToken: "unit-test-access-token",
      subject: "person@example.com",
    });
    await expectRejected(
      getAuthenticatedGmailProfile(mismatched),
      "does not match the OAuth locator subject",
    );
  });

  test("lists only bounded canonical send-as aliases under the mailbox read grant", async () => {
    const requests: URL[] = [];
    const api = client(input => {
      requests.push(urlOf(input));
      return Promise.resolve(json({
        sendAs: [
          { sendAsEmail: "person@example.com" },
          { sendAsEmail: "Alias@Example.com", verificationStatus: "pending" },
        ],
      }));
    });
    expect(await listGmailSendAsAliases(api)).toEqual([
      "alias@example.com",
      "person@example.com",
    ]);
    expect(requests[0]?.pathname)
      .toBe("/gmail/v1/users/me/settings/sendAs");
    expect(requests[0]?.searchParams.get("fields"))
      .toBe("sendAs(sendAsEmail,verificationStatus)");

    const missingSubject = client(() => Promise.resolve(json({
      sendAs: [{ sendAsEmail: "alias@example.com", verificationStatus: "accepted" }],
    })));
    await expectRejected(
      listGmailSendAsAliases(missingSubject),
      "does not contain the authenticated subject",
    );
  });

  test("pins exact Gmail partial-response masks without classification labels", async () => {
    const requests: URL[] = [];
    const api = client((input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/threads")) return Promise.resolve(json({}));
      if (url.pathname.endsWith("/messages")) return Promise.resolve(json({}));
      if (url.pathname.includes("/attachments/")) {
        return Promise.resolve(json({ attachmentId: "attachment_1", size: 0, data: "" }));
      }
      if (url.pathname.includes("/threads/")) {
        return Promise.resolve(json({ id: "thread_1", messages: [] }));
      }
      if (url.pathname.includes("/messages/")) return Promise.resolve(json({ id: "message_1" }));
      throw new Error(`unexpected request ${url.href}`);
    });
    await fetchGmailThreadList(api, {
      limit: 1,
      pageToken: null,
      query: null,
      labelIds: [],
      includeSpamTrash: false,
    });
    await fetchGmailMessageList(api, {
      limit: 1,
      pageToken: null,
      query: "in:anywhere",
    });
    await fetchGmailThread(api, "thread_1");
    await fetchGmailThreadMetadata(api, "thread_1");
    await fetchGmailMessageMetadata(api, "message_1");
    await fetchGmailMessageInteractionMetadata(api, "message_1");
    await fetchGmailAttachmentBytes(api, "message_1", "attachment_1");

    const fields = requests.map((url) => url.searchParams.get("fields"));
    expect(fields[0]).toBe("threads(id,snippet,historyId),nextPageToken,resultSizeEstimate");
    expect(fields[1]).toBe("messages(id,threadId),nextPageToken,resultSizeEstimate");
    const messageFields = "id,threadId,labelIds,snippet,historyId,internalDate,payload(partId,mimeType,filename,headers(name,value),body(attachmentId,size,data),parts),sizeEstimate";
    expect(fields[2]).toBe(`id,snippet,historyId,messages(${messageFields})`);
    expect(fields[3]).toBe(fields[2]);
    expect(fields[4]).toBe(messageFields);
    expect(fields[5]).toBe("id,threadId,labelIds,internalDate,payload(headers(name,value))");
    expect(fields[6]).toBe("attachmentId,size,data");
    expect(fields.every((value) => !value?.includes("classificationLabelValues"))).toBeTrue();
  });

  test("requests only address headers for contact interaction metadata", async () => {
    const requests: URL[] = [];
    const api = client((input) => {
      requests.push(urlOf(input));
      return Promise.resolve(json({
        id: "message_1",
        threadId: "thread_1",
        labelIds: ["SENT"],
        internalDate: "1785888000000",
        payload: {
          headers: [
            { name: "From", value: "person@example.com" },
            { name: "To", value: "friend@example.com" },
          ],
        },
      }));
    });

    await expect(fetchGmailMessageInteractionMetadata(api, "message_1"))
      .resolves.toMatchObject({
        id: "message_1",
        threadId: "thread_1",
        from: "person@example.com",
        to: "friend@example.com",
      });

    const request = requests[0];
    if (request === undefined) throw new Error("expected one interaction metadata request");
    expect(request.searchParams.get("format")).toBe("metadata");
    expect(request.searchParams.get("fields"))
      .toBe("id,threadId,labelIds,internalDate,payload(headers(name,value))");
    expect(request.searchParams.getAll("metadataHeaders"))
      .toEqual(["From", "To", "Cc", "Bcc"]);
    expect(request.searchParams.getAll("metadataHeaders")).not.toContain("Subject");
    expect(request.searchParams.getAll("metadataHeaders")).not.toContain("Date");
    expect(request.searchParams.getAll("metadataHeaders")).not.toContain("Message-ID");
    expect(request.searchParams.getAll("metadataHeaders")).not.toContain("In-Reply-To");
  });

  test("combines repeated destination headers only for interaction metadata", async () => {
    const api = client(() => Promise.resolve(json({
      id: "message_1",
      threadId: "thread_1",
      labelIds: ["SENT"],
      internalDate: "1785888000000",
      payload: {
        headers: [
          { name: "From", value: "person@example.com" },
          { name: "To", value: "first@example.com" },
          { name: "to", value: "second@example.com" },
          { name: "Cc", value: "third@example.com" },
          { name: "CC", value: "fourth@example.com" },
        ],
      },
    })));

    await expect(fetchGmailMessageInteractionMetadata(api, "message_1"))
      .resolves.toMatchObject({
        from: "person@example.com",
        to: "first@example.com, second@example.com",
        cc: "third@example.com, fourth@example.com",
      });

    const duplicateFrom = client(() => Promise.resolve(json({
      id: "message_1",
      payload: { headers: [
        { name: "From", value: "first@example.com" },
        { name: "from", value: "second@example.com" },
      ] },
    })));
    await expectRejected(
      fetchGmailMessageInteractionMetadata(duplicateFrom, "message_1"),
      "headers.from must not be duplicated",
    );

    const unexpected = client(() => Promise.resolve(json({
      id: "message_1",
      payload: { headers: [{ name: "Subject", value: "not requested" }] },
    })));
    await expectRejected(
      fetchGmailMessageInteractionMetadata(unexpected, "message_1"),
      "is outside the reviewed interaction projection",
    );
  });

  test("omits tainted interaction address values without weakening ordinary parsing", async () => {
    const metadata = (value: unknown) => client(() => Promise.resolve(json({
      id: "message_1",
      labelIds: ["SENT"],
      payload: { headers: [
        { name: "From", value: "person@example.com" },
        { name: "To", value },
        { name: "Cc", value: "safe@example.com" },
      ] },
    })));
    for (const value of [
      "tainted\u0000@example.com",
      "a".repeat(64 * 1024 + 1),
      "\ud800",
    ]) {
      await expect(fetchGmailMessageInteractionMetadata(metadata(value), "message_1"))
        .resolves.toMatchObject({
        from: "person@example.com",
        to: null,
        cc: "safe@example.com",
      });
    }

    await expectRejected(
      fetchGmailMessageInteractionMetadata(metadata(42), "message_1"),
      "must be bounded text without unsafe controls",
    );

    const invalidName = client(() => Promise.resolve(json({
      id: "message_1",
      payload: { headers: [{ name: "T\u0000o", value: "person@example.com" }] },
    })));
    await expectRejected(
      fetchGmailMessageInteractionMetadata(invalidName, "message_1"),
      "must be bounded text without unsafe controls",
    );

    expect(() => parseGmailThread({
      id: "thread_1",
      messages: [{
        id: "message_1",
        payload: {
          partId: "",
          mimeType: "application/octet-stream",
          filename: "",
          headers: [{ name: "To", value: "tainted\u0000@example.com" }],
        },
      }],
    })).toThrow("must be bounded text without unsafe controls");
  });

  test("parses copied mailbox, label, category, and search URLs into a stable thread target", () => {
    const built = buildGmailThreadUrl("Person@Example.com", "thread_1", "inbox");
    expect(parseGmailThreadUrl(new URL(built))).toEqual({
      accountLocator: "Person@Example.com",
      view: "inbox",
      sourceView: "inbox",
      threadId: "thread_1",
      canonicalUrl: built,
    });
    for (const source of [
      "sent",
      "drafts",
      "spam",
      "trash",
      "starred",
      "important",
      "category/primary",
      "label/Project%20One",
      "search/from%3Afriend%40example.com",
    ]) {
      const parsed = parseGmailThreadUrl(new URL(
        `https://mail.google.com/mail/u/Person%40Example.com/#${source}/thread_1`,
      ));
      expect(parsed).toMatchObject({
        accountLocator: "Person@Example.com",
        view: "all",
        sourceView: source,
        threadId: "thread_1",
      });
      expect(parsed.canonicalUrl).toBe(
        "https://mail.google.com/mail/u/Person%40Example.com/#all/thread_1",
      );
    }
  });

  test("rejects compose/settings and encoded layout controls in thread selectors", () => {
    for (const fragment of [
      "compose/thread_1",
      "settings/thread_1",
      "search/hello%0Aworld/thread_1",
      "label/hello%09world/thread_1",
      "search//thread_1",
    ]) {
      expect(() => parseGmailThreadUrl(new URL(
        `https://mail.google.com/mail/u/0/#${fragment}`,
      ))).toThrow();
    }
  });

  test("projects one render-safe body and resolves inline and opaque-ID attachments", async () => {
    const thread = parseGmailThread(fullThread());
    expect(thread.messages[0]?.body).toEqual({
      text: "Plain body\nline 2",
      source: "text/plain",
    });
    expect(thread.messages[0]?.attachments).toHaveLength(2);
    expect(JSON.stringify(thread)).not.toContain("AQID");
    const inline = thread.messages[0]?.attachments[1];
    if (inline === undefined) throw new Error("expected inline fixture attachment");
    const noNetworkClient = client(() => {
      throw new Error("inline resolution must not use HTTP");
    });
    expect([...await resolveGmailAttachmentBytes(noNetworkClient, inline)])
      .toEqual([1, 2, 3]);

    const requests: URL[] = [];
    const externalClient = client((input) => {
      requests.push(urlOf(input));
      return Promise.resolve(json({ size: 4, data: Buffer.from([4, 5, 6, 7]).toString("base64url") }));
    });
    const external = thread.messages[0]?.attachments[0];
    if (external === undefined) throw new Error("expected external fixture attachment");
    expect([...await resolveGmailAttachmentBytes(externalClient, external)])
      .toEqual([4, 5, 6, 7]);
    expect(requests[0]?.hostname).toBe("gmail.googleapis.com");
    expect(requests[0]?.pathname).toContain("/attachments/");
    expect(requests[0]?.pathname).toContain("%2F");
  });

  test("classifies blank-name disposition text and inline binary without consuming ordinary text", async () => {
    const ordinaryText = "ordinary inline body";
    const attachedText = "blank-name text attachment";
    const inlineBinary = new Uint8Array([0, 1, 2, 255]);
    const thread = parseGmailThread(threadWithParts([{
      partId: "body.1",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "Content-Type", value: "text/plain; charset=utf-8" },
        { name: "Content-Disposition", value: " INLINE " },
      ],
      body: { size: Buffer.byteLength(ordinaryText), data: encoded(ordinaryText) },
    }, {
      partId: "attachment.1",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "Content-Type", value: "text/plain; charset=utf-8" },
        { name: "Content-Disposition", value: "Attachment" },
      ],
      body: { size: Buffer.byteLength(attachedText), data: encoded(attachedText) },
    }, {
      partId: "attachment.2",
      mimeType: "application/octet-stream",
      filename: "",
      headers: [{ name: "Content-Disposition", value: "inline; handling=required" }],
      body: {
        size: inlineBinary.byteLength,
        data: Buffer.from(inlineBinary).toString("base64url"),
      },
    }]));

    expect(thread.messages[0]?.body).toEqual({
      text: ordinaryText,
      source: "text/plain",
    });
    expect(thread.messages[0]?.attachments).toEqual([{
      attachmentId: null,
      partId: "attachment.1",
      messageId: "message_mime",
      filename: "",
      mimeType: "text/plain",
      contentDisposition: "attachment",
      size: Buffer.byteLength(attachedText),
    }, {
      attachmentId: null,
      partId: "attachment.2",
      messageId: "message_mime",
      filename: "",
      mimeType: "application/octet-stream",
      contentDisposition: "inline",
      size: inlineBinary.byteLength,
    }]);
    const noNetworkClient = client(() => {
      throw new Error("inline resolution must not use HTTP");
    });
    const textAttachment = thread.messages[0]?.attachments[0];
    const binaryAttachment = thread.messages[0]?.attachments[1];
    if (textAttachment === undefined || binaryAttachment === undefined) {
      throw new Error("expected both inline attachment fixtures");
    }
    expect(Buffer.from(await resolveGmailAttachmentBytes(noNetworkClient, textAttachment)).toString())
      .toBe(attachedText);
    expect([...await resolveGmailAttachmentBytes(noNetworkClient, binaryAttachment)])
      .toEqual([...inlineBinary]);
  });

  test("resolves externally stored plain and HTML leaves as bounded bodies, not attachments", async () => {
    const plain = "External plain body";
    const html = "<script>hidden()</script><p>External <b>HTML</b> &amp; safe</p>";
    const parsed = parseGmailThread({
      id: "thread_external",
      messages: [{
        id: "message_plain",
        threadId: "thread_external",
        payload: {
          partId: "",
          mimeType: "text/plain",
          filename: "",
          headers: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
            { name: "Content-Disposition", value: "inline" },
          ],
          body: { attachmentId: "body_plain", size: Buffer.byteLength(plain) },
        },
      }, {
        id: "message_html",
        threadId: "thread_external",
        payload: {
          partId: "",
          mimeType: "text/html",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: { attachmentId: "body_html", size: Buffer.byteLength(html) },
        },
      }],
    }, {
      maxBodyBytes: Buffer.byteLength(plain) + Buffer.byteLength(html),
    });
    expect(parsed.messages.map((message) => message.attachments)).toEqual([[], []]);
    expect(JSON.stringify(parsed)).not.toContain("body_plain");

    const requests: URL[] = [];
    const api = client((input, init = {}) => {
      const url = urlOf(input);
      requests.push(url);
      expect(init.method).toBe("GET");
      if (url.pathname.endsWith("/attachments/body_plain")) {
        return Promise.resolve(json({ size: Buffer.byteLength(plain), data: encoded(plain) }));
      }
      if (url.pathname.endsWith("/attachments/body_html")) {
        return Promise.resolve(json({ size: Buffer.byteLength(html), data: encoded(html) }));
      }
      throw new Error(`unexpected request ${url.href}`);
    });
    const resolved = await resolveGmailThreadBodies(api, parsed);
    expect(resolved.messages[0]?.body).toEqual({
      text: plain,
      source: "text/plain",
    });
    expect(resolved.messages[1]?.body).toEqual({
      text: "External HTML & safe",
      source: "text/html",
    });
    expect(resolved.messages.map((message) => message.attachments)).toEqual([[], []]);
    expect(requests.map((url) => url.pathname)).toEqual([
      "/gmail/v1/users/me/messages/message_plain/attachments/body_plain",
      "/gmail/v1/users/me/messages/message_html/attachments/body_html",
    ]);
    expect(await resolveGmailThreadBodies(api, resolved)).toBe(resolved);
  });

  test("fails closed on external body size, wire, and aggregate thread bounds", async () => {
    const external = {
      id: "thread_external",
      messages: [{
        id: "message_external",
        threadId: "thread_external",
        payload: {
          partId: "",
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { attachmentId: "body_external", size: 5 },
        },
      }],
    };
    expect(() => parseGmailThread(external, { maxBodyBytes: 4 }))
      .toThrow("exceeds 4 rendered bytes");

    const parsed = parseGmailThread(external, { maxBodyBytes: 5 });
    await expectRejected(resolveGmailThreadBodies(client(() =>
      Promise.resolve(json({ size: 4, data: encoded("four") }))), parsed),
    "does not match its declared byte size");
    await expectRejected(resolveGmailThreadBodies(client(() =>
      Promise.resolve(json({ size: 5, data: encoded("12345") }))), parsed, 20),
    "provider response exceeds 20 bytes");

    const twoMessages = {
      id: "thread_aggregate",
      messages: ["one", "two"].map((body, index) => ({
        id: `message_${index}`,
        threadId: "thread_aggregate",
        payload: {
          partId: "",
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { size: Buffer.byteLength(body), data: encoded(body) },
        },
      })),
    };
    expect(() => parseGmailThread(twoMessages, { maxBodyBytes: 5 }))
      .toThrow("exceeds 5 rendered bytes");
    expect(parseGmailThread(twoMessages, { maxBodyBytes: 6 }).messages.map((message) =>
      message.body.text)).toEqual(["one", "two"]);

    const mixedInlineExternal = {
      id: "thread_mixed_aggregate",
      messages: [{
        id: "message_inline",
        threadId: "thread_mixed_aggregate",
        payload: {
          partId: "",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
          body: { size: 3, data: encoded("one") },
        },
      }, {
        id: "message_external",
        threadId: "thread_mixed_aggregate",
        payload: {
          partId: "",
          mimeType: "text/plain",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
          body: { attachmentId: "external_body", size: 3 },
        },
      }],
    };
    expect(() => parseGmailThread(mixedInlineExternal, { maxBodyBytes: 5 }))
      .toThrow("exceeds 5 rendered bytes");
    const mixedParsed = parseGmailThread(mixedInlineExternal, { maxBodyBytes: 6 });
    const mixedResolved = await resolveGmailThreadBodies(client((input) => {
      expect(urlOf(input).pathname).toEndWith("/attachments/external_body");
      return Promise.resolve(json({ size: 3, data: encoded("two") }));
    }), mixedParsed);
    expect(mixedResolved.messages.map((message) => message.body.text))
      .toEqual(["one", "two"]);
  });

  test("retains filename-only attachments and validates disposition filename metadata", () => {
    const thread = parseGmailThread(threadWithParts([{
      partId: "named",
      mimeType: "application/pdf",
      filename: "report.pdf",
      headers: [],
      body: { attachmentId: "external", size: 10 },
    }, {
      partId: "extended",
      mimeType: "application/pdf",
      filename: "résumé.pdf",
      headers: [{
        name: "Content-Disposition",
        value: "ATTACHMENT; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      }],
      body: { attachmentId: "external-2", size: 11 },
    }]));
    expect(thread.messages[0]?.attachments[0]).toMatchObject({
      partId: "named",
      filename: "report.pdf",
      contentDisposition: null,
    });
    expect(thread.messages[0]?.attachments[1]).toMatchObject({
      partId: "extended",
      filename: "résumé.pdf",
      contentDisposition: "attachment",
    });

    for (const disposition of [
      "attachment; filename=one.pdf; FILENAME=one.pdf",
      "attachment; filename=\"unterminated",
      "attachment; filename*=UTF-8''one.pdf; filename=one.pdf",
      "attachment; filename*0*=UTF-8''one; filename*1*=.pdf",
      "form-data; filename=report.pdf",
      "attachment\r\nBcc: recipient@example.com",
    ]) {
      expect(() => parseGmailThread(threadWithParts([{
        partId: "ambiguous",
        mimeType: "application/pdf",
        filename: "report.pdf",
        headers: [{ name: "Content-Disposition", value: disposition }],
        body: { attachmentId: "external", size: 10 },
      }]))).toThrow();
    }
    expect(() => parseGmailThread(threadWithParts([{
      partId: "mismatch",
      mimeType: "application/pdf",
      filename: "report.pdf",
      headers: [{ name: "Content-Disposition", value: "attachment; filename=other.pdf" }],
      body: { attachmentId: "external", size: 10 },
    }]))).toThrow("filename does not match");
    expect(() => parseGmailThread(threadWithParts([{
      partId: "duplicate-header",
      mimeType: "application/pdf",
      filename: "report.pdf",
      headers: [
        { name: "Content-Disposition", value: "attachment" },
        { name: "content-disposition", value: "attachment" },
      ],
      body: { attachmentId: "external", size: 10 },
    }]))).toThrow("must not be duplicated");
  });

  test("requires unique nonempty attachment part IDs and enforces an optional reviewed depth", () => {
    const attachment = {
      partId: "duplicate",
      mimeType: "application/octet-stream",
      filename: "",
      headers: [{ name: "Content-Disposition", value: "attachment" }],
      body: { data: encoded("a"), size: 1 },
    };
    expect(() => parseGmailThread(threadWithParts([attachment, attachment])))
      .toThrow("must be unique within its message");
    expect(() => parseGmailThread(threadWithParts([{ ...attachment, partId: "" }])))
      .toThrow("must be nonempty for an attachment part");

    const nested = threadWithParts([{
      partId: "container",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [],
      body: { size: 0 },
      parts: [{
        partId: "body",
        mimeType: "text/plain",
        filename: "",
        headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        body: { size: 4, data: encoded("body") },
      }],
    }]);
    expect(parseGmailThread(nested, { maxDepth: 2 }).messages[0]?.body.text).toBe("body");
    expect(parseGmailThread(nested, { maxDepth: 2, maxBodyBytes: 4 })
      .messages[0]?.body.text).toBe("body");
    expect(() => parseGmailThread(nested, { maxDepth: 2, maxBodyBytes: 3 }))
      .toThrow("exceeds 3 rendered bytes");
    expect(() => parseGmailThread(nested, { maxBodyBytes: 64 * 1024 * 1024 + 1 }))
      .toThrow("must be an integer from 1 through 67108864");
    expect(() => parseGmailThread(nested, { maxDepth: 1 }))
      .toThrow("exceeds the reviewed MIME tree bound");
    expect(() => parseGmailThread(nested, { maxDepth: 33 }))
      .toThrow("must be an integer from 0 through 32");
    expect(() => parseGmailThread(nested, { maxDepth: 1.5 }))
      .toThrow("must be an integer from 0 through 32");
  });

  test("enforces strict UTF-8 MIME Content-Type fields and reviewed Gmail dates", () => {
    const textPart = (contentType: string, data = Buffer.from("body", "utf8")) => ({
      partId: "body",
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Content-Type", value: contentType }],
      body: { size: data.byteLength, data: data.toString("base64url") },
    });
    expect(parseGmailThread(threadWithParts([
      textPart("text/plain; charset=\"UTF-8\"; format=flowed"),
    ])).messages[0]?.body.text).toBe("body");
    for (const contentType of [
      "text/html; charset=utf-8",
      "text/plain; charset=iso-8859-1",
      "text/plain; charset=utf-8; CHARSET=utf-8",
      "text/plain; charset=\"unterminated",
    ]) {
      expect(() => parseGmailThread(threadWithParts([textPart(contentType)]))).toThrow();
    }
    expect(() => parseGmailThread(threadWithParts([
      textPart("text/plain; charset=utf-8", Buffer.from([0xc3])),
    ]))).toThrow("valid UTF-8 text");

    const threadWithDate = (value: string): Record<string, unknown> => {
      const thread = structuredClone(fullThread()) as Record<string, unknown>;
      const message = (thread.messages as Record<string, unknown>[])[0];
      const payload = message?.payload as Record<string, unknown>;
      const headers = payload.headers as Record<string, unknown>[];
      const date = headers.find((header) => header.name === "Date");
      if (date === undefined) throw new Error("expected Date fixture");
      date.value = value;
      return thread;
    };

    for (const [source, normalized] of [
      [
        "Tue,\r\n 4 Aug 2026 20:00:00 +0000 (mail gateway (UTC))",
        "Tue, 4 Aug 2026 20:00:00 +0000 (mail gateway (UTC))",
      ],
      [
        "Fri, 21 Nov 97 09(comment): 55 : 06 GMT (legacy)",
        "Fri, 21 Nov 97 09(comment): 55 : 06 GMT (legacy)",
      ],
      [
        "Fri, 21 Nov 1997 04:55:06 EST",
        "Fri, 21 Nov 1997 04:55:06 EST",
      ],
      [
        "13 Feb 1969 23:32 -0330 (Newfoundland Time)",
        "13 Feb 1969 23:32 -0330 (Newfoundland Time)",
      ],
      [
        "Tue, 4 Aug 2026 20:00:00 +9959",
        "Tue, 4 Aug 2026 20:00:00 +9959",
      ],
      [
        "Tue, 4 Aug 2026 20:00:60 +0000",
        "Tue, 4 Aug 2026 20:00:60 +0000",
      ],
      [
        "Sun, 21 Nov 49 09:55:06 GMT",
        "Sun, 21 Nov 49 09:55:06 GMT",
      ],
      [
        "Tue, 21 Nov 50 09:55:06 GMT",
        "Tue, 21 Nov 50 09:55:06 GMT",
      ],
      [
        "Tue, 4 Aug 2026 20:00:00 A",
        "Tue, 4 Aug 2026 20:00:00 A",
      ],
      [
        "Tue, 4 Aug 2026 20:00:00 z",
        "Tue, 4 Aug 2026 20:00:00 z",
      ],
    ] as const) {
      expect(parseGmailThread(threadWithDate(source)).messages[0]?.date).toBe(normalized);
    }

    for (const [source, message] of [
      ["Sun, 29 Feb 2026 25:00:00 +2460", "invalid calendar date"],
      ["Mon, 4 Aug 2026 20:00:00 +0000", "day-of-week inconsistent"],
      ["Tue, 4 Aug 2026 20:00:00 +9960", "invalid calendar date"],
      ["Tue, 4 Aug 2026 20:00:61 +0000", "invalid calendar date"],
      ["Tue, 4 Aug 2026 20:00:00 J", "ambiguous or unsupported named zone"],
      ["Tue, 4 Aug 2026 20:00:00 CET", "ambiguous or unsupported named zone"],
      ["Tue, 4 Aug 2026 20:00:00 +0000 (unterminated", "unterminated comment"],
      ["Tue, 4 Aug 2026 20:00:00 +0000\nBcc: injected@example.com", "unsafe bare line feed"],
      ["Tue, 4 Aug 2026 20:00:00 +0000\r(comment)", "unsafe or ambiguous line fold"],
      ["Tue, 4 Aug 2026 20:00:00 +0000\r\nBcc: injected@example.com", "unsafe or ambiguous line fold"],
    ] as const) {
      expect(() => parseGmailThread(threadWithDate(source))).toThrow(message);
    }
  });

  test("hard-caps direct decoded body.data across a thread at seven MiB", () => {
    const directThread = (bytes: number) => threadWithParts([{
      partId: "body",
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
      body: {
        size: bytes,
        data: Buffer.alloc(bytes, 0x61).toString("base64url"),
      },
    }]);
    const maximum = 7 * 1024 * 1024;
    expect(parseGmailThread(directThread(maximum)).messages[0]?.body.text?.length)
      .toBe(maximum);
    expect(() => parseGmailThread(directThread(maximum + 1)))
      .toThrow("decoded body.data aggregate");
  });

  test("checks the operation deadline during a linear HTML scan", () => {
    const html = `<p>${"x".repeat(64 * 1024)}</p>`;
    let checkpoints = 0;
    expect(() => parseGmailThread(threadWithParts([{
      partId: "body",
      mimeType: "text/html",
      filename: "",
      headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: { size: Buffer.byteLength(html), data: encoded(html) },
    }]), {
      deadlineCheckpoint: () => {
        checkpoints += 1;
        if (checkpoints === 8) throw new Error("deterministic deadline checkpoint");
      },
    })).toThrow("deterministic deadline checkpoint");
    expect(checkpoints).toBe(8);
  });

  test("retains People metadata and exact field values while dropping signed photo URLs", async () => {
    const requests: URL[] = [];
    const api = client((input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({
          connections: [{ resourceName: "people/c123" }],
          totalItems: 1,
        }));
      }
      return Promise.resolve(json({
        responses: [{
          requestedResourceName: "people/c123",
          httpStatusCode: 200,
          status: {},
          person: {
            resourceName: "people/c123",
            etag: "person-etag",
            metadata: {
              sources: [{
                type: "CONTACT",
                id: "source-1",
                etag: "source-etag",
                updateTime: "2026-08-04T20:00:00.123456789Z",
              }],
              deleted: false,
            },
            names: [{
              displayName: "Friend",
              metadata: {
                primary: true,
                sourcePrimary: true,
                verified: false,
                source: { type: "CONTACT", id: "source-1" },
              },
            }],
            emailAddresses: [{
              value: "Friend+Tag@Example.com",
              type: "work",
              metadata: { primary: true, source: { type: "CONTACT", id: "source-1" } },
            }, {
              value: "friend+tag@example.com",
              type: "other",
            }],
            phoneNumbers: [{
              value: "+1 (212) 555-1212",
              canonicalForm: "+12125551212",
              type: "mobile",
            }],
            organizations: [{
              name: "Example Co",
              title: "Engineer",
              department: "Research",
              type: "work",
              current: true,
            }],
            photos: [{
              url: "https://lh3.googleusercontent.com/photo?token=secret",
              default: false,
            }],
          },
        }],
      }));
    });
    const page = await fetchGmailContacts(api, {
      collection: "contacts",
      limit: 25,
      pageToken: null,
    });
    expect(page.contacts[0]).toMatchObject({
      resourceName: "people/c123",
      etag: "person-etag",
      metadata: {
        deleted: false,
        sources: [{
          type: "CONTACT",
          id: "source-1",
          etag: "source-etag",
          updateTime: "2026-08-04T20:00:00.123456789Z",
        }],
      },
      displayName: "Friend",
      emailAddresses: [{
        value: "Friend+Tag@Example.com",
        canonicalValue: "friend+tag@example.com",
        type: "work",
      }],
      phoneNumbers: [{
        value: "+1 (212) 555-1212",
        canonicalForm: "+12125551212",
        type: "mobile",
      }],
      photoUrl: null,
    });
    expect(requests[0]?.hostname).toBe("people.googleapis.com");
    expect(requests[0]?.pathname).toBe("/v1/people/me/connections");
    expect(requests[0]?.searchParams.get("fields"))
      .toBe("connections(resourceName),nextPageToken,totalItems");
    expect(requests[1]?.pathname).toBe("/v1/people:batchGet");
    expect(requests[1]?.searchParams.getAll("resourceNames")).toEqual(["people/c123"]);
    expect(requests[1]?.searchParams.get("fields")).not.toContain("classificationLabelValues");
  });

  test("reorders People batch results and rejects duplicate, missing, extra, or failed entries", async () => {
    const person = (resourceName: string) => ({ resourceName });
    const run = (responses: readonly unknown[]) => fetchGmailContacts(client((input) => {
      const url = urlOf(input);
      return Promise.resolve(json(url.pathname.endsWith("/connections")
        ? {
            connections: [{ resourceName: "people/c1" }, { resourceName: "people/c2" }],
            totalItems: 2,
          }
        : { responses }));
    }), { collection: "contacts", limit: 2, pageToken: null });

    const reordered = await run([{
      requestedResourceName: "people/c2",
      status: { code: 0 },
      person: person("people/current_c2"),
    }, {
      requestedResourceName: "people/c1",
      httpStatusCode: 200,
      person: person("people/c1"),
    }]);
    expect(reordered.contacts.map((contact) => contact.resourceName))
      .toEqual(["people/c1", "people/current_c2"]);

    await expectRejected(run([{
      requestedResourceName: "people/c1",
      status: {},
      person: person("people/c1"),
    }, {
      requestedResourceName: "people/c1",
      status: {},
      person: person("people/c1_again"),
    }]), "is duplicated");
    await expectRejected(run([{
      requestedResourceName: "people/c1",
      status: {},
      person: person("people/c1"),
    }]), "is missing a requested resource name");
    await expectRejected(run([{
      requestedResourceName: "people/c1",
      status: {},
      person: person("people/c1"),
    }, {
      requestedResourceName: "people/c3",
      status: {},
      person: person("people/c3"),
    }]), "was not requested");
    await expectRejected(run([{
      requestedResourceName: "people/c1",
      status: { code: 7 },
    }, {
      requestedResourceName: "people/c2",
      status: {},
      person: person("people/c2"),
    }]), "does not report success");

    await expectRejected(fetchGmailContacts(client(() => {
      throw new Error("an over-limit request must not dispatch");
    }), {
      collection: "contacts",
      limit: 201,
      pageToken: null,
    }), "integer from 1 through 200");
  });

  test("rejects calendar-invalid People timestamps", async () => {
    const api = client((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({ connections: [{ resourceName: "people/c1" }] }));
      }
      return Promise.resolve(json({ responses: [{
        requestedResourceName: "people/c1",
        status: {},
        person: {
          resourceName: "people/c1",
          metadata: {
            sources: [{ type: "CONTACT", id: "source", updateTime: "2026-02-29T00:00:00Z" }],
          },
        },
      }] }));
    });
    await expectRejected(
      fetchGmailContacts(api, {
        collection: "contacts",
        limit: 1,
        pageToken: null,
      }),
      "valid UTC calendar date and time",
    );
  });

  test("lists Other contacts directly with their limited People projection", async () => {
    const requests: URL[] = [];
    const api = client((input) => {
      const url = urlOf(input);
      requests.push(url);
      return Promise.resolve(json({
        otherContacts: [{
          resourceName: "otherContacts/c123",
          etag: "other-etag",
          metadata: {
            sources: [{
              type: "OTHER_CONTACT",
              id: "other-source-1",
              updateTime: "2026-08-13T20:00:00Z",
            }],
          },
          names: [{ displayName: "Other Friend" }],
          emailAddresses: [{ value: "other.friend@example.com" }],
          phoneNumbers: [{ value: "+1 787 555 0100" }],
          photos: [{
            url: "https://lh3.googleusercontent.com/plain-photo",
            default: false,
          }],
        }],
        nextPageToken: "other-page-2",
        totalSize: 300,
      }));
    });
    const page = await fetchGmailContacts(api, {
      collection: "other-contacts",
      limit: 100,
      pageToken: "other-page-1",
    });
    expect(page).toMatchObject({
      contacts: [{
        resourceName: "otherContacts/c123",
        displayName: "Other Friend",
        emailAddresses: [{
          value: "other.friend@example.com",
          canonicalValue: "other.friend@example.com",
        }],
        organizations: [],
      }],
      nextPageToken: "other-page-2",
      totalItems: 300,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/otherContacts");
    expect(requests[0]?.searchParams.get("pageSize")).toBe("100");
    expect(requests[0]?.searchParams.get("pageToken")).toBe("other-page-1");
    expect(requests[0]?.searchParams.get("readMask"))
      .toBe("metadata,names,emailAddresses,phoneNumbers,photos");
    expect(requests[0]?.searchParams.get("sources"))
      .toBe("READ_SOURCE_TYPE_CONTACT");
    expect(requests[0]?.searchParams.get("fields"))
      .toContain("otherContacts(resourceName,etag,metadata");
    expect(requests[0]?.searchParams.get("fields")).not.toContain("organizations");
  });

  test("rejects widened or mismatched Other contacts pages", async () => {
    const run = (body: unknown) => fetchGmailContacts(client(() =>
      Promise.resolve(json(body))), {
      collection: "other-contacts",
      limit: 10,
      pageToken: null,
    });
    await expectRejected(run({
      otherContacts: [{ resourceName: "people/not-an-other-contact" }],
    }), "must identify an Other contact");
    await expectRejected(run({
      otherContacts: [
        { resourceName: "otherContacts/duplicate" },
        { resourceName: "otherContacts/duplicate" },
      ],
    }), "contains duplicate resource names");
    await expectRejected(run({
      otherContacts: [],
      nextSyncToken: "unrequested-sync-token",
    }), "contains unreviewed property nextSyncToken");
  });

  test("rejects response shape widening and MIME size ambiguity", () => {
    expect(() => parseGmailThread({ ...fullThread(), unexpected: true })).toThrow(
      "contains unreviewed property unexpected",
    );
    const fixture = structuredClone(fullThread()) as Record<string, unknown>;
    const messages = fixture.messages as Record<string, unknown>[];
    const payload = messages[0]?.payload as Record<string, unknown>;
    const parts = payload.parts as Record<string, unknown>[];
    parts[0] = {
      ...parts[0],
      body: { size: 999, data: encoded("Plain body\nline 2") },
    };
    expect(() => parseGmailThread(fixture)).toThrow("size does not match decoded data");
  });
});
