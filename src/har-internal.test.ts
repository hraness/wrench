import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  analyzeInternalHarValue,
  INTERNAL_HAR_REVIEW_BOUNDS,
  reviewedXGraphQlVariableFieldName,
  type InternalHarCandidate,
} from "./har-internal";
import { xWebQueryDescriptorEvidenceSnapshot } from "./providers/x-web";

type HarEntryOptions = {
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly requestHeaders?: readonly { readonly name: string; readonly value: string }[];
  readonly requestJson?: unknown;
  readonly requestParams?: readonly { readonly name: string; readonly value: string }[];
  readonly requestText?: string;
  readonly requestMimeType?: string;
  readonly responseJson?: unknown;
  readonly responseText?: string;
  readonly responseMimeType?: string;
};

function entry(options: HarEntryOptions): Record<string, unknown> {
  const postData = options.requestJson === undefined
      && options.requestParams === undefined
      && options.requestText === undefined
    ? undefined
    : options.requestJson !== undefined
      ? { mimeType: "application/json", text: JSON.stringify(options.requestJson) }
      : options.requestParams !== undefined
        ? { mimeType: "application/x-www-form-urlencoded", params: options.requestParams }
        : {
            mimeType: options.requestMimeType ?? "application/x-www-form-urlencoded",
            text: options.requestText,
          };
  return {
    request: {
      method: options.method ?? "GET",
      url: options.url,
      headers: options.requestHeaders ?? [],
      queryString: [...new URL(options.url).searchParams].map(([name, value]) => ({ name, value })),
      ...(postData === undefined ? {} : { postData }),
    },
    response: {
      status: options.status ?? 200,
      headers: [{ name: "set-cookie", value: "response-cookie-private" }],
      content: options.responseJson === undefined
        ? {
            mimeType: options.responseMimeType ?? "text/plain",
            text: options.responseText ?? "response-content-private",
          }
        : {
            mimeType: options.responseMimeType ?? "application/json; charset=utf-8",
            text: JSON.stringify(options.responseJson),
          },
    },
  };
}

function har(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { log: { version: "1.2", creator: { name: "test", version: "1" }, entries } };
}

function oneCandidate(value: ReturnType<typeof analyzeInternalHarValue>): InternalHarCandidate {
  expect(value.candidates).toHaveLength(1);
  const candidate = value.candidates[0];
  if (candidate === undefined) throw new Error("missing internal HAR candidate");
  return candidate;
}

function expectNoCredentialFieldNames(candidate: InternalHarCandidate): void {
  for (const name of [
    ...candidate.queryNames,
    ...candidate.requestFieldPaths,
    ...candidate.responseFieldPaths,
  ]) {
    expect(name).not.toMatch(/authorization|cookie|csrf|xsrf|token|secret|password|session|credential|signature/iu);
  }
}

describe("private LinkedIn internal-API HAR evidence", () => {
  test("retains registered operations and structural names while discarding every credential and content value", () => {
    const revision = "0123456789abcdef0123456789abcdef";
    const secondRevision = "abcdef0123456789abcdef0123456789";
    const firstUrl = new URL("https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql");
    firstUrl.searchParams.set("queryId", `messengerConversations.${revision}`);
    firstUrl.searchParams.set("variables", "(count:20,category:PRIMARY_INBOX,secret:query-private-one)");
    firstUrl.searchParams.set("operationName", "MessagingInboxQuery");
    firstUrl.searchParams.set("access_token", "query-auth-private");
    const secondUrl = new URL(firstUrl);
    secondUrl.searchParams.set("queryId", `messengerMessages.${secondRevision}`);
    secondUrl.searchParams.set("variables", "(count:40,secret:query-private-two)");

    const evidence = analyzeInternalHarValue(har([
      entry({
        method: "GET",
        url: firstUrl.href,
        status: 200,
        requestHeaders: [
          { name: "Accept", value: "application/json-private" },
          { name: "X-RestLi-Protocol-Version", value: "2.0.0-private" },
          { name: "Authorization", value: "Bearer linkedin-auth-private" },
          { name: "Cookie", value: "li_at=linkedin-cookie-private" },
          { name: "Csrf-Token", value: "ajax:linkedin-csrf-private" },
          { name: "X-User-Alice", value: "dynamic-header-private" },
        ],
        requestJson: {
          variables: {
            conversationUrn: "urn:li:msg_conversation:linkedin-conversation-private",
            message: { body: "linkedin-message-private" },
            accessToken: "linkedin-body-auth-private",
          },
          "4815162342": { displayName: "linkedin-user-value-private" },
        },
        responseJson: {
          data: {
            messengerConversations: {
              elements: [{
                entityUrn: "urn:li:msg_conversation:linkedin-response-private",
                subject: "linkedin-subject-private",
                sessionToken: "linkedin-response-token-private",
                byId: {
                  "urn:li:fsd_profile:123456": { name: "linkedin-profile-private" },
                },
              }],
            },
          },
        },
      }),
      entry({
        method: "GET",
        url: secondUrl.href,
        status: 201,
        requestHeaders: [{ name: "X-Li-Lang", value: "en_US-private" }],
        requestJson: { variables: { conversationUrn: "second-conversation-private" } },
        responseJson: { data: { messengerConversations: { elements: [] } } },
      }),
      entry({
        url: "https://evil.example/voyager/api/graphql?queryId=messengerMessages.bad-private",
        responseJson: { evil: "external-private" },
      }),
      entry({ url: "https://www.linkedin.com/assets/app.js", responseMimeType: "application/javascript" }),
    ]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T12:00:00.000Z"));

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      adapterId: "linkedin-internal",
      targetOrigin: "https://www.linkedin.com",
      analyzedAt: "2026-07-22T12:00:00.000Z",
      observedEntries: 4,
    });
    expect(evidence.candidates).toHaveLength(2);
    const conversations = evidence.candidates.find((candidate) =>
      candidate.revisions.includes(`queryId=messengerConversations.${revision}`));
    const messages = evidence.candidates.find((candidate) =>
      candidate.revisions.includes(`queryId=messengerMessages.${secondRevision}`));
    expect(conversations).toMatchObject({
      method: "GET",
      origin: "https://www.linkedin.com",
      path: "/voyager/api/voyagerMessagingGraphQL/graphql",
      sampleCount: 1,
      statuses: [200],
      revisions: [`queryId=messengerConversations.${revision}`],
      reviewRequired: true,
    });
    expect(messages).toMatchObject({
      method: "GET",
      origin: "https://www.linkedin.com",
      path: "/voyager/api/voyagerMessagingGraphQL/graphql",
      sampleCount: 1,
      statuses: [201],
      revisions: [`queryId=messengerMessages.${secondRevision}`],
      reviewRequired: true,
    });
    expect(conversations?.queryNames).toEqual(["operationName", "queryId", "variables"]);
    expect(messages?.queryNames).toEqual(["operationName", "queryId", "variables"]);
    expect(conversations?.headerNames).toEqual([
      ":dynamic",
      "accept",
      "authorization",
      "cookie",
      "csrf-token",
      "x-restli-protocol-version",
    ]);
    expect(messages?.headerNames).toEqual(["x-li-lang"]);
    for (const path of [
      "variables",
      "variables.conversationUrn",
      "variables.message",
      "variables.message.body",
      "query.variables.category",
      "query.variables.count",
    ]) expect(conversations?.requestFieldPaths).toContain(path);
    for (const path of [
      "data",
      "data.messengerConversations",
      "data.messengerConversations.elements",
      "data.messengerConversations.elements[].entityUrn",
      "data.messengerConversations.elements[].subject",
    ]) expect(conversations?.responseFieldPaths).toContain(path);
    expect(conversations?.requestFieldPaths).toContain(":dynamic");
    expect(conversations?.responseFieldPaths).toContain("data.messengerConversations.elements[].:dynamic");
    expect(messages?.requestFieldPaths).toContain("variables.conversationUrn");
    expect(messages?.requestFieldPaths).not.toContain("variables.message");
    expect(messages?.requestFieldPaths).not.toContain("query.variables.category");
    if (conversations === undefined || messages === undefined) throw new Error("missing correlated LinkedIn evidence");
    expectNoCredentialFieldNames(conversations);
    expectNoCredentialFieldNames(messages);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "query-private-one",
      "query-private-two",
      "query-auth-private",
      "linkedin-auth-private",
      "linkedin-cookie-private",
      "linkedin-csrf-private",
      "linkedin-message-private",
      "linkedin-conversation-private",
      "linkedin-body-auth-private",
      "4815162342",
      "linkedin-user-value-private",
      "linkedin-response-private",
      "linkedin-subject-private",
      "linkedin-response-token-private",
      "urn:li:fsd_profile:123456",
      "linkedin-profile-private",
      "response-cookie-private",
      "external-private",
      "MessagingInboxQuery",
      "x-user-alice",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("retains reviewed native Article route and document field structure without retaining draft or member values", () => {
    const draftId = "7000000000000000001";
    const profileUrn = "urn:li:fsd_profile:fixture-private";
    const title = "private fixture title";
    const text = "private fixture text";
    const hyperlink = "https://example.com/private-fixture";
    const url = new URL(`https://www.linkedin.com/voyager/api/voyagerPublishingDashFirstPartyArticles/urn:li:fsd_firstPartyArticle:${draftId}`);
    url.searchParams.set("author", profileUrn);
    url.searchParams.set("q", "author");
    url.searchParams.set("start", "0");
    url.searchParams.set("state", "DRAFT");
    const evidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: url.href,
      status: 200,
      requestHeaders: [
        { name: "Authorization", value: "Bearer private" },
      ],
      requestJson: {
        patch: {
          $set: {
            title,
            content: [{
              textBlock: {
                type: "PARAGRAPH",
                content: {
                  text,
                  attributesV2: [{ start: 0, length: 7, detailDataUnion: { hyperlink } }],
                },
              },
            }],
          },
        },
      },
      responseJson: {
        data: { "*elements": [`urn:li:fsd_firstPartyArticle:${draftId}`] },
        included: [{
          entityUrn: `urn:li:fsd_firstPartyArticle:${draftId}`,
          linkedInArticleUrn: `urn:li:linkedInArticle:${draftId}`,
          authors: [{ profileUrn }],
          title,
          contentHtml: `<p>${text}</p>`,
          content: [{ textBlock: { type: "PARAGRAPH", content: { text, attributesV2: [] } } }],
          state: "DRAFT",
          articleType: "FIRST_PARTY_ARTICLE",
          publishedAt: null,
          activityUrn: null,
          ugcPostUrn: null,
          permalink: null,
          version: 2,
          createdAt: 1,
          updatedAt: 2,
        }],
      },
    })]), "linkedin-web", "https://www.linkedin.com", new Date("2026-08-15T12:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate.path).toBe("/voyager/api/voyagerPublishingDashFirstPartyArticles/:segment1");
    expect(candidate.queryNames).toEqual(["author", "q", "start", "state"]);
    expect(candidate.headerNames).toEqual(["authorization"]);
    for (const path of [
      "patch.$set.title",
      "patch.$set.content[].textBlock.type",
      "patch.$set.content[].textBlock.content.text",
      "patch.$set.content[].textBlock.content.attributesV2[].start",
      "patch.$set.content[].textBlock.content.attributesV2[].length",
      "patch.$set.content[].textBlock.content.attributesV2[].detailDataUnion.hyperlink",
    ]) expect(candidate.requestFieldPaths).toContain(path);
    for (const path of [
      "data.:dynamic",
      "included[].entityUrn",
      "included[].linkedInArticleUrn",
      "included[].authors[].profileUrn",
      "included[].title",
      "included[].contentHtml",
      "included[].content[].textBlock.content.attributesV2",
      "included[].state",
      "included[].articleType",
      "included[].publishedAt",
      "included[].activityUrn",
      "included[].ugcPostUrn",
      "included[].permalink",
      "included[].version",
      "included[].createdAt",
      "included[].updatedAt",
    ]) expect(candidate.responseFieldPaths).toContain(path);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [draftId, profileUrn, title, text, hyperlink, "fixture-private"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("private Facebook internal-API HAR evidence", () => {
  test("retains exact Meta routes, reviewed field names, bounded variables shape, and one registered operation without retaining private values", () => {
    const operationName = "CometNewsFeedPaginationQuery";
    const documentId = "9876543210123456789";
    const profileId = "100012345678901";
    const dynamicProfileKey = "pfbid02PrivateProfileKey";
    const variables = JSON.stringify({
      count: 25,
      cursor: "facebook-cursor-private",
      message: { text: "facebook-message-private" },
      users: {
        [dynamicProfileKey]: { name: "facebook-profile-private" },
      },
      [profileId]: { id: "facebook-dynamic-id-private" },
      accessToken: "facebook-variable-token-private",
      fb_dtsg: { message: "facebook-nested-proof-private" },
    });
    const reviewedParams = [
      { name: "variables", value: variables },
      { name: "doc_id", value: documentId },
      { name: "fb_api_req_friendly_name", value: operationName },
      { name: "fb_api_caller_class", value: "RelayModern-private" },
      { name: "av", value: "facebook-actor-private" },
      { name: "__user", value: "facebook-user-private" },
      { name: "__a", value: "facebook-async-private" },
      { name: "__req", value: "facebook-request-private" },
      { name: "__hs", value: "facebook-haste-private" },
      { name: "dpr", value: "facebook-density-private" },
      { name: "__ccg", value: "facebook-connection-private" },
      { name: "__rev", value: "facebook-revision-private" },
      { name: "__s", value: "facebook-session-shape-private" },
      { name: "__hsi", value: "facebook-hsi-private" },
      { name: "__dyn", value: "facebook-dyn-private" },
      { name: "__csr", value: "facebook-csr-private" },
      { name: "__comet_req", value: "facebook-comet-private" },
      { name: "fb_dtsg", value: "facebook-dtsg-private" },
      { name: "jazoest", value: "facebook-jazoest-private" },
      { name: "lsd", value: "facebook-lsd-private" },
      { name: "server_timestamps", value: "facebook-timestamps-private" },
      { name: "access_token", value: "facebook-form-token-private" },
    ] as const;
    const graphQlUrl = new URL("https://www.facebook.com/api/graphql/");
    graphQlUrl.searchParams.set("__a", "facebook-query-async-private");
    graphQlUrl.searchParams.set("__user", "facebook-query-user-private");
    graphQlUrl.searchParams.set("fb_dtsg", "facebook-query-dtsg-private");
    graphQlUrl.searchParams.set("access_token", "facebook-query-token-private");
    const ajaxUrl = new URL("https://www.facebook.com/ajax/qm/");
    ajaxUrl.searchParams.set("__a", "facebook-ajax-async-private");
    ajaxUrl.searchParams.set("__comet_req", "facebook-ajax-comet-private");
    ajaxUrl.searchParams.set("jazoest", "facebook-ajax-jazoest-private");
    ajaxUrl.searchParams.set("secret", "facebook-ajax-secret-private");

    const evidence = analyzeInternalHarValue(har([
      entry({
        method: "POST",
        url: graphQlUrl.href,
        status: 200,
        requestHeaders: [
          { name: "Cookie", value: "c_user=facebook-cookie-user-private; xs=facebook-cookie-xs-private" },
          { name: "Authorization", value: "Bearer facebook-header-token-private" },
          { name: "Content-Type", value: "application/x-www-form-urlencoded-private" },
        ],
        requestParams: reviewedParams,
        responseJson: {
          data: {
            result: {
              items: [{
                id: "facebook-response-id-private",
                message: { text: "facebook-response-message-private" },
                users: {
                  [dynamicProfileKey]: { name: "facebook-response-profile-private" },
                },
              }],
              paging: { cursor: "facebook-response-cursor-private" },
            },
          },
          accessToken: "facebook-response-token-private",
        },
      }),
      entry({
        method: "POST",
        url: ajaxUrl.href,
        status: 204,
        requestParams: [
          { name: "__a", value: "facebook-ajax-form-async-private" },
          { name: "fb_dtsg", value: "facebook-ajax-form-dtsg-private" },
        ],
        responseJson: { data: { result: true } },
      }),
      entry({
        url: "https://www.facebook.com/data/manifest/",
        status: 200,
        responseJson: { data: { items: [] } },
      }),
      entry({
        method: "POST",
        url: "https://evil.example/api/graphql/",
        requestParams: reviewedParams,
        responseJson: { data: { message: "facebook-cross-origin-private" } },
      }),
    ]), "facebook-internal", "https://www.facebook.com", new Date("2026-07-23T12:00:00.000Z"));

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      adapterId: "facebook-internal",
      targetOrigin: "https://www.facebook.com",
      analyzedAt: "2026-07-23T12:00:00.000Z",
      observedEntries: 4,
    });
    expect(evidence.candidates.map((candidate) => candidate.path)).toEqual([
      "/ajax/qm/",
      "/api/graphql/",
      "/data/manifest/",
    ]);
    expect(evidence.candidates.every((candidate) => candidate.reviewRequired)).toBeTrue();
    const graphQl = evidence.candidates.find((candidate) => candidate.path === "/api/graphql/");
    expect(graphQl).toMatchObject({
      method: "POST",
      origin: "https://www.facebook.com",
      sampleCount: 1,
      statuses: [200],
      queryNames: ["__a", "__user", "fb_dtsg"],
      revisions: [`meta=${operationName}.${documentId}`],
      reviewRequired: true,
    });
    for (const name of reviewedParams.slice(0, -1).map((parameter) => parameter.name)) {
      expect(graphQl?.requestFieldPaths).toContain(name);
    }
    expect(graphQl?.requestFieldPaths).toContain(":dynamic");
    for (const path of [
      "variables.count",
      "variables.cursor",
      "variables.message",
      "variables.message.text",
      "variables.users",
      "variables.users.:dynamic.name",
      "variables.fb_dtsg",
      "variables.:dynamic",
    ]) expect(graphQl?.requestFieldPaths).toContain(path);
    expect(graphQl?.requestFieldPaths).not.toContain("variables.fb_dtsg.message");
    for (const path of [
      "data.result.items[].id",
      "data.result.items[].message.text",
      "data.result.items[].users.:dynamic.name",
      "data.result.paging.cursor",
    ]) expect(graphQl?.responseFieldPaths).toContain(path);
    expect(evidence.warnings.some((warning) => warning.includes("inert"))).toBeTrue();

    const ajax = evidence.candidates.find((candidate) => candidate.path === "/ajax/qm/");
    expect(ajax).toMatchObject({
      queryNames: ["__a", "__comet_req", "jazoest"],
      requestFieldPaths: ["__a", "fb_dtsg"],
      revisions: [],
      reviewRequired: true,
    });
    expect(evidence.candidates.find((candidate) => candidate.path === "/data/manifest/")).toMatchObject({
      revisions: [],
      reviewRequired: true,
    });

    const serialized = JSON.stringify(evidence);
    for (const parameter of reviewedParams) {
      if (
        parameter.name !== "doc_id"
        && parameter.name !== "fb_api_req_friendly_name"
      ) expect(serialized).not.toContain(parameter.value);
    }
    for (const forbidden of [
      profileId,
      dynamicProfileKey,
      "facebook-cursor-private",
      "facebook-message-private",
      "facebook-profile-private",
      "facebook-dynamic-id-private",
      "facebook-variable-token-private",
      "facebook-nested-proof-private",
      "RelayModern-private",
      "facebook-actor-private",
      "facebook-user-private",
      "facebook-async-private",
      "facebook-request-private",
      "facebook-haste-private",
      "facebook-density-private",
      "facebook-connection-private",
      "facebook-revision-private",
      "facebook-session-shape-private",
      "facebook-hsi-private",
      "facebook-dyn-private",
      "facebook-csr-private",
      "facebook-comet-private",
      "facebook-dtsg-private",
      "facebook-jazoest-private",
      "facebook-lsd-private",
      "facebook-timestamps-private",
      "facebook-form-token-private",
      "facebook-query-async-private",
      "facebook-query-user-private",
      "facebook-query-dtsg-private",
      "facebook-query-token-private",
      "facebook-ajax-async-private",
      "facebook-ajax-comet-private",
      "facebook-ajax-jazoest-private",
      "facebook-ajax-secret-private",
      "facebook-cookie-user-private",
      "facebook-cookie-xs-private",
      "facebook-header-token-private",
      "facebook-response-id-private",
      "facebook-response-message-private",
      "facebook-response-profile-private",
      "facebook-response-cursor-private",
      "facebook-response-token-private",
      "facebook-cross-origin-private",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("parses agent-browser form text and Meta anti-XSSI response envelopes without retaining values", () => {
    const operationName = "CometNewsFeedPaginationQuery";
    const documentId = "9876543210123456789";
    const variables = JSON.stringify({
      count: 10,
      cursor: "facebook-live-cursor-private",
      users: {
        "100012345678901": { name: "facebook-live-profile-private" },
      },
      fb_dtsg: { message: "facebook-live-nested-proof-private" },
    });
    const body = new URLSearchParams([
      ["variables", variables],
      ["doc_id", documentId],
      ["fb_api_req_friendly_name", operationName],
      ["fb_dtsg", "facebook-live-proof-private"],
      ["lsd", "facebook-live-lsd-private"],
      ["access_token", "facebook-live-token-private"],
    ]).toString();
    const response = `for (;;);${JSON.stringify({
      data: {
        result: {
          items: [{ id: "facebook-live-response-private" }],
          paging: { cursor: "facebook-live-next-private" },
        },
      },
    })}`;
    const evidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: "https://www.facebook.com/api/graphql/",
      requestText: body,
      responseText: response,
      responseMimeType: "text/html; charset=utf-8",
    })]), "facebook-live-shape", "https://www.facebook.com", new Date("2026-07-24T00:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate).toMatchObject({
      path: "/api/graphql/",
      revisions: [`meta=${operationName}.${documentId}`],
    });
    for (const path of [
      "variables",
      "variables.count",
      "variables.cursor",
      "variables.users",
      "variables.users.:dynamic.name",
      "variables.fb_dtsg",
      "doc_id",
      "fb_api_req_friendly_name",
      "fb_dtsg",
      "lsd",
      ":dynamic",
    ]) expect(candidate.requestFieldPaths).toContain(path);
    expect(candidate.requestFieldPaths).not.toContain("variables.fb_dtsg.message");
    for (const path of [
      "data.result.items[].id",
      "data.result.paging.cursor",
    ]) expect(candidate.responseFieldPaths).toContain(path);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "facebook-live-cursor-private",
      "100012345678901",
      "facebook-live-profile-private",
      "facebook-live-nested-proof-private",
      "facebook-live-proof-private",
      "facebook-live-lsd-private",
      "facebook-live-token-private",
      "facebook-live-response-private",
      "facebook-live-next-private",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("keeps same-route Meta operations correlated to their own variables and response shape", () => {
    const firstRevision = "meta=CometNewsFeedPaginationQuery.1111111111111111111";
    const secondRevision = "meta=CometPagesLaunchpointUpdateLastVisitTimeMutation.2222222222222222222";
    const form = (
      friendlyName: string,
      documentId: string,
      variables: Record<string, unknown>,
    ): string => new URLSearchParams([
      ["variables", JSON.stringify(variables)],
      ["fb_api_req_friendly_name", friendlyName],
      ["doc_id", documentId],
    ]).toString();
    const evidence = analyzeInternalHarValue(har([
      entry({
        method: "POST",
        url: "https://www.facebook.com/api/graphql/",
        requestText: form(
          "CometNewsFeedPaginationQuery",
          "1111111111111111111",
          { count: 10, cursor: "first-operation-private" },
        ),
        responseText: `for (;;);${JSON.stringify({
          data: { result: { items: [{ id: "first-response-private" }] } },
        })}`,
        responseMimeType: "text/javascript",
      }),
      entry({
        method: "POST",
        url: "https://www.facebook.com/api/graphql/",
        requestText: form(
          "CometPagesLaunchpointUpdateLastVisitTimeMutation",
          "2222222222222222222",
          { subject: "second-operation-private" },
        ),
        responseText: `for (;;);${JSON.stringify({
          data: { result: { messages: [{ text: "second-response-private" }] } },
        })}`,
        responseMimeType: "text/plain",
      }),
    ]), "facebook-correlated", "https://www.facebook.com", new Date("2026-07-24T00:00:00.000Z"));

    expect(evidence.candidates).toHaveLength(2);
    const first = evidence.candidates.find((candidate) => candidate.revisions.includes(firstRevision));
    const second = evidence.candidates.find((candidate) => candidate.revisions.includes(secondRevision));
    expect(first?.operationType).toBe("unknown");
    expect(second?.operationType).toBe("unknown");
    expect(first?.requestFieldPaths).toContain("variables.count");
    expect(first?.requestFieldPaths).not.toContain("variables.subject");
    expect(first?.responseFieldPaths).toContain("data.result.items[].id");
    expect(first?.responseFieldPaths).not.toContain("data.result.messages");
    expect(second?.requestFieldPaths).toContain("variables.subject");
    expect(second?.requestFieldPaths).not.toContain("variables.count");
    expect(second?.responseFieldPaths).toContain("data.result.messages[].text");
    expect(second?.responseFieldPaths).not.toContain("data.result.items");
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "first-operation-private",
      "first-response-private",
      "second-operation-private",
      "second-response-private",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("rejects missing, duplicate, malformed, oversized, wrong-method, wrong-route, and cross-origin registered-operation pairs", () => {
    const validPair = [
      { name: "fb_api_req_friendly_name", value: "CometFeedQuery" },
      { name: "doc_id", value: "1234567890" },
    ] as const;
    const invalidEntries = [
      [{ name: "fb_api_req_friendly_name", value: "CometFeedQuery" }],
      [
        ...validPair,
        { name: "fb_api_req_friendly_name", value: "CometFeedQuery" },
      ],
      [
        ...validPair,
        { name: "doc_id", value: "1234567890" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: "1InvalidQuery" },
        { name: "doc_id", value: "1234567890" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: "ab" },
        { name: "doc_id", value: "1234567890" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: `A${"b".repeat(161)}` },
        { name: "doc_id", value: "1234567890" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: "CometFeedQuery" },
        { name: "doc_id", value: "1234" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: "CometFeedQuery" },
        { name: "doc_id", value: "12345notdecimal" },
      ],
      [
        { name: "fb_api_req_friendly_name", value: "CometFeedQuery" },
        { name: "doc_id", value: "1".repeat(33) },
      ],
    ];
    const facebookEvidence = analyzeInternalHarValue(har([
      ...invalidEntries.map((requestParams) => entry({
        method: "POST",
        url: "https://www.facebook.com/api/graphql/",
        requestParams,
        responseJson: { data: {} },
      })),
      entry({
        method: "GET",
        url: "https://www.facebook.com/api/graphql/",
        requestParams: validPair,
        responseJson: { data: {} },
      }),
      entry({
        method: "POST",
        url: "https://www.facebook.com/api/graphql",
        requestParams: validPair,
        responseJson: { data: {} },
      }),
      entry({
        method: "POST",
        url: "https://evil.example/api/graphql/",
        requestParams: validPair,
        responseJson: { data: { message: "cross-origin-private" } },
      }),
      entry({
        url: "https://www.facebook.com/AlicePrivateProfile/100012345678901",
        responseJson: { data: { message: "unknown-route-private" } },
      }),
    ]), "facebook-internal", "https://www.facebook.com", new Date("2026-07-23T12:00:00.000Z"));

    expect(facebookEvidence.candidates.every((candidate) => candidate.revisions.length === 0)).toBeTrue();
    expect(facebookEvidence.candidates.some((candidate) => candidate.path === "/:segment1/:segment2")).toBeTrue();
    expect(JSON.stringify(facebookEvidence)).not.toContain("CometFeedQuery");
    expect(JSON.stringify(facebookEvidence)).not.toContain("cross-origin-private");
    expect(JSON.stringify(facebookEvidence)).not.toContain("AlicePrivateProfile");
    expect(JSON.stringify(facebookEvidence)).not.toContain("100012345678901");
    expect(JSON.stringify(facebookEvidence)).not.toContain("unknown-route-private");

    const alternateOriginEvidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: "https://m.facebook.com/api/graphql/",
      requestParams: validPair,
      responseJson: { data: {} },
    })]), "facebook-internal", "https://m.facebook.com", new Date("2026-07-23T12:00:00.000Z"));
    expect(oneCandidate(alternateOriginEvidence).revisions).toEqual([]);
    expect(JSON.stringify(alternateOriginEvidence)).not.toContain("CometFeedQuery");
    expect(JSON.stringify(alternateOriginEvidence)).not.toContain("1234567890");
  });
});

describe("private X internal-API HAR evidence", () => {
  test("retains only non-sensitive GraphQL-safe top-level variable field names", () => {
    expect(reviewedXGraphQlVariableFieldName("articleEntityKey")).toBe("articleEntityKey");
    expect(reviewedXGraphQlVariableFieldName("_draftId2")).toBe("_draftId2");
    for (const value of [
      "authToken",
      "sessionId",
      "article-entity-key",
      "article.entity.key",
      "2articleEntityKey",
      "x".repeat(INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters + 1),
    ]) expect(reviewedXGraphQlVariableFieldName(value)).toBe(":dynamic");
  });

  test("keeps GraphQL operation revisions and field paths but no values, auth material, or dynamic user keys", () => {
    const revision = "zd0F6a_svKAXdlMGbCZDFg";
    const url = new URL(`https://x.com/i/api/graphql/${revision}/DmAllSearchSlice`);
    url.searchParams.set("variables", JSON.stringify({ count: 20, cursor: "x-query-cursor-private" }));
    url.searchParams.set("features", JSON.stringify({ responsive_web_graphql_enabled: true }));
    url.searchParams.set("fieldToggles", JSON.stringify({ withAuxiliaryUserLabels: false }));
    url.searchParams.set("auth_token", "x-query-auth-private");

    const evidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: url.href,
      requestHeaders: [
        { name: "Accept", value: "application/json-x-private" },
        { name: "X-Twitter-Auth-Type", value: "OAuth2Session-private" },
        { name: "Authorization", value: "Bearer x-authorization-private" },
        { name: "Cookie", value: "auth_token=x-cookie-private; ct0=x-csrf-private" },
        { name: "X-Csrf-Token", value: "x-csrf-private" },
      ],
      requestJson: {
        variables: {
          conversation_id: "x-conversation-private",
          text: "x-message-private",
          recipient_ids: ["x-recipient-private"],
        },
        features: { responsive_web_graphql_exclude_directive_enabled: true },
        authorization: "x-body-authorization-private",
        "123456789012345678": { screen_name: "x-dynamic-user-private" },
      },
      responseJson: {
        data: {
          inbox_initial_state: {
            conversations: [{
              conversation_id: "x-response-conversation-private",
              messages: [{ id: "x-response-message-private", text: "x-response-text-private" }],
              authToken: "x-response-auth-private",
            }],
            users: {
              "123456789012345678": { name: "x-response-user-private" },
            },
          },
        },
      },
    })]), "x-internal", "https://x.com", new Date("2026-07-22T12:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate).toMatchObject({
      method: "POST",
      origin: "https://x.com",
      path: "/i/api/graphql/:revision/DmAllSearchSlice",
      sampleCount: 1,
      statuses: [200],
      reviewRequired: true,
    });
    expect(candidate.queryNames).toEqual(["features", "fieldToggles", "variables"]);
    expect(candidate.revisions).toEqual([`graphql=DmAllSearchSlice.${revision}`]);
    expect(candidate.headerNames).toEqual([
      "accept",
      "authorization",
      "cookie",
      "x-csrf-token",
      "x-twitter-auth-type",
    ]);
    for (const path of [
      "variables",
      "variables.conversation_id",
      "variables.recipient_ids",
      "variables.text",
      "features.responsive_web_graphql_exclude_directive_enabled",
      "query.features.responsive_web_graphql_enabled",
      "query.fieldToggles.withAuxiliaryUserLabels",
      "query.variables.count",
      "query.variables.cursor",
    ]) expect(candidate.requestFieldPaths).toContain(path);
    for (const path of [
      "data.inbox_initial_state.conversations[].conversation_id",
      "data.inbox_initial_state.conversations[].messages[].id",
      "data.inbox_initial_state.conversations[].messages[].text",
      "data.inbox_initial_state.users.:dynamic.name",
    ]) expect(candidate.responseFieldPaths).toContain(path);
    expectNoCredentialFieldNames(candidate);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "x-query-cursor-private",
      "x-query-auth-private",
      "x-authorization-private",
      "x-cookie-private",
      "x-csrf-private",
      "x-conversation-private",
      "x-message-private",
      "x-recipient-private",
      "x-body-authorization-private",
      "123456789012345678",
      "x-dynamic-user-private",
      "x-response-conversation-private",
      "x-response-message-private",
      "x-response-text-private",
      "x-response-auth-private",
      "x-response-user-private",
      "response-cookie-private",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("retains reviewed top-level variable schema names only for the exact registered X GraphQL route", () => {
    const operation = "ArticleEntityUpdateTitle";
    const descriptor = xWebQueryDescriptorEvidenceSnapshot.descriptors.find(
      (candidate) => candidate.operationName === operation,
    );
    if (descriptor === undefined) throw new Error("missing X article title descriptor");
    const requestJson = {
      variables: {
        articleEntityId: "private-article-id",
        titlePayload: { "private-user-key": { text: "private-title" } },
        authToken: "private-auth-token",
      },
      features: {},
      queryId: descriptor.queryId,
    };
    const exact = oneCandidate(analyzeInternalHarValue(har([entry({
      method: "POST",
      url: `https://x.com/i/api/graphql/${descriptor.queryId}/${operation}`,
      requestJson,
      responseJson: { data: {} },
    })]), "x-internal", "https://x.com", new Date("2026-08-14T00:00:00.000Z")));
    expect(exact.requestFieldPaths).toContain("variables.articleEntityId");
    expect(exact.requestFieldPaths).toContain("variables.titlePayload");
    expect(exact.requestFieldPaths).not.toContain("variables.authToken");
    expect(JSON.stringify(exact)).not.toContain("private-user-key");

    const stale = oneCandidate(analyzeInternalHarValue(har([entry({
      method: "POST",
      url: `https://x.com/i/api/graphql/${"a".repeat(22)}/${operation}`,
      requestJson,
      responseJson: { data: {} },
    })]), "x-internal", "https://x.com", new Date("2026-08-14T00:00:00.000Z")));
    expect(stale.requestFieldPaths).not.toContain("variables.articleEntityId");
    expect(stale.requestFieldPaths).not.toContain("variables.titlePayload");
  });
});

describe("internal HAR evidence fail-closed boundaries", () => {
  test("rejects malformed roots and non-exact HTTPS targets", () => {
    for (const value of [null, {}, { log: {} }, { log: { entries: "not-an-array" } }]) {
      expect(() => analyzeInternalHarValue(value, "adapter", "https://x.com")).toThrow("HAR must contain log.entries[]");
    }
    for (const origin of [
      "http://x.com",
      "https://x.com/",
      "https://user:password@x.com",
      "https://x.com/path",
    ]) {
      expect(() => analyzeInternalHarValue(har([]), "adapter", origin)).toThrow("target origin must be exact HTTPS");
    }
  });

  test("ignores malformed, cross-origin, unsupported-method, credentialed, and static-resource entries", () => {
    const evidence = analyzeInternalHarValue(har([
      {},
      { request: { method: "GET", url: "not-a-url" }, response: { status: 200 } },
      entry({ url: "https://api.x.com/2/users/me", responseJson: { id: "external-private" } }),
      entry({ url: "https://user:password@x.com/i/api/test", responseJson: { id: "credential-url-private" } }),
      entry({ method: "OPTIONS", url: "https://x.com/i/api/test", responseJson: { id: "options-private" } }),
      entry({ url: "https://x.com/assets/logo.svg", responseMimeType: "image/svg+xml" }),
    ]), "x-internal", "https://x.com", new Date("2026-07-22T12:00:00.000Z"));
    expect(evidence.observedEntries).toBe(6);
    expect(evidence.candidates).toEqual([]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("external-private");
    expect(serialized).not.toContain("credential-url-private");
    expect(serialized).not.toContain("options-private");
    expect(serialized).not.toContain("user:password");
  });

  test("normalizes unknown identifiers and preserves deterministic ordering without retaining their values", () => {
    const evidence = analyzeInternalHarValue(har([
      entry({
        url: "https://x.com/i/api/zeta/12345678901234567890?z=last-private&a=first-private",
        status: 204,
        responseJson: { zeta: "z-private" },
      }),
      entry({
        url: "https://x.com/i/api/alpha/98765432109876543210?b=second-private",
        status: 200,
        responseJson: { alpha: "a-private" },
      }),
    ]), "x-internal", "https://x.com", new Date("2026-07-22T12:00:00.000Z"));
    expect(evidence.candidates).toHaveLength(1);
    expect(evidence.candidates[0]).toMatchObject({
      path: "/i/api/:segment1/:segment2",
      sampleCount: 2,
      statuses: [200, 204],
      queryNames: [":dynamic"],
    });
    const serialized = JSON.stringify(evidence);
    for (const forbidden of ["98765432109876543210", "12345678901234567890", "last-private", "first-private", "second-private", "z-private", "a-private"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("bounds raw URLs and keeps only the first 1,000 query parameters before structural parsing", () => {
    const boundedVariables = encodeURIComponent(JSON.stringify({ text: "bounded-value-private" }));
    const cappedQuery = [
      `variables=${boundedVariables}`,
      ...Array.from(
        { length: INTERNAL_HAR_REVIEW_BOUNDS.maxQueryParameters - 1 },
        () => "cursor=bounded-cursor-private",
      ),
      `features=${encodeURIComponent(JSON.stringify({ responsive_web_graphql_enabled: true }))}`,
    ].join("&");
    const oversizedQuery = `payload=${"x".repeat(INTERNAL_HAR_REVIEW_BOUNDS.maxQueryCharacters + 1)}`;
    const oversizedPath = `/${"p".repeat(INTERNAL_HAR_REVIEW_BOUNDS.maxPathCharacters + 1)}`;
    const overlongUrl = `https://x.com/i/api/messages?${"x".repeat(INTERNAL_HAR_REVIEW_BOUNDS.maxUrlCharacters)}`;
    const evidence = analyzeInternalHarValue(har([
      {
        request: { method: "GET", url: `https://x.com/i/api/messages?${cappedQuery}` },
        response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
      },
      {
        request: { method: "GET", url: `https://x.com/i/api/messages?${oversizedQuery}` },
        response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
      },
      {
        request: { method: "GET", url: `https://x.com${oversizedPath}` },
        response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
      },
      {
        request: { method: "GET", url: overlongUrl },
        response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
      },
    ]), "x-internal", "https://x.com", new Date("2026-07-22T00:00:00.000Z"));

    expect(evidence.observedEntries).toBe(4);
    expect(evidence.candidates).toHaveLength(2);
    const messages = evidence.candidates.find((candidate) => candidate.path === "/i/api/messages");
    expect(messages).toMatchObject({
      sampleCount: 2,
      queryNames: ["cursor", "variables"],
    });
    expect(messages?.queryNames).not.toContain("features");
    expect(messages?.requestFieldPaths).toContain("query.variables.text");
    expect(messages?.requestFieldPaths).not.toContain(
      "query.features.responsive_web_graphql_enabled",
    );
    expect(evidence.candidates.find((candidate) => candidate.path === "/:oversized-path")).toMatchObject({
      sampleCount: 1,
      queryNames: [],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("bounded-value-private");
    expect(serialized).not.toContain("bounded-cursor-private");

    const oversizedQueryId = `messengerMessages.${"a".repeat(
      INTERNAL_HAR_REVIEW_BOUNDS.maxQueryIdCharacters,
    )}`;
    const linkedInEvidence = analyzeInternalHarValue(har([{
      request: {
        method: "GET",
        url: `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${oversizedQueryId}`,
      },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    }]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));
    expect(oneCandidate(linkedInEvidence)).toMatchObject({
      queryNames: ["queryId"],
      revisions: [],
    });
    expect(JSON.stringify(linkedInEvidence)).not.toContain("messengerMessages");
  });

  test("caps header, form, JSON object, and JSON array traversal at shared raw-input bounds", () => {
    const headers = [
      { name: "x".repeat(INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters + 1), value: "oversized" },
      ...Array.from(
        { length: INTERNAL_HAR_REVIEW_BOUNDS.maxHeaderItems - 1 },
        () => ({ name: "accept", value: "header-private" }),
      ),
      { name: "content-type", value: "header-past-cap-private" },
    ];
    const form = [
      ...Array.from(
        { length: INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters },
        () => ({ name: "text", value: "form-private" }),
      ),
      { name: "subject", value: "form-past-cap-private" },
    ];
    const arrayBody = {
      items: [
        ...Array.from(
          { length: INTERNAL_HAR_REVIEW_BOUNDS.maxArrayItems },
          () => ({ text: "array-private" }),
        ),
        { subject: "array-past-cap-private" },
      ],
    };
    const objectEntries: [string, unknown][] = Array.from(
      { length: INTERNAL_HAR_REVIEW_BOUNDS.maxObjectEntries },
      (_value, index) => [`field_${index}`, { text: "object-private" }],
    );
    objectEntries.push(["subject", "object-past-cap-private"]);
    const objectBody: Record<string, unknown> = Object.fromEntries(objectEntries);
    const evidence = analyzeInternalHarValue(har([
      entry({
        method: "POST",
        url: "https://x.com/i/api/messages",
        requestHeaders: headers,
        requestParams: form,
        responseJson: objectBody,
      }),
      entry({
        method: "POST",
        url: "https://x.com/i/api/messages",
        requestJson: arrayBody,
        responseJson: { data: [] },
      }),
    ]), "x-internal", "https://x.com", new Date("2026-07-22T00:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate.headerNames).toEqual(["accept"]);
    expect(candidate.requestFieldPaths).toContain("text");
    expect(candidate.requestFieldPaths).toContain("items[].text");
    expect(candidate.requestFieldPaths).not.toContain("subject");
    expect(candidate.requestFieldPaths).not.toContain("items[].subject");
    expect(candidate.responseFieldPaths).toContain(":dynamic.text");
    expect(candidate.responseFieldPaths).not.toContain("subject");
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "header-past-cap-private",
      "form-past-cap-private",
      "array-past-cap-private",
      "object-past-cap-private",
    ]) expect(serialized).not.toContain(forbidden);
  });

  test("prioritizes ranked candidates within global evidence budgets and caps registered revisions", () => {
    const branchingBody = (depth: number): unknown => depth === 0
      ? true
      : Object.fromEntries(
          ["body", "data", "items", "metadata", "results"].map((key) => [
            key,
            branchingBody(depth - 1),
          ]),
        );
    const lowRanked = Array.from({ length: 20 }, (_value, index) => entry({
      method: "POST",
      url: `https://x.com/api/${Array.from({ length: index + 1 }, () => "opaque").join("/")}`,
      requestJson: branchingBody(5),
      responseJson: {},
    }));
    const highRanked = Array.from({ length: 21 }, () => entry({
      method: "POST",
      url: "https://x.com/api/inbox",
      requestJson: { payload: { text: "ranked-private-value" } },
      responseJson: {},
    }));
    const rankedEvidence = analyzeInternalHarValue(
      har([...lowRanked, ...highRanked]),
      "x-internal",
      "https://x.com",
      new Date("2026-07-22T00:00:00.000Z"),
    );
    const highestRanked = rankedEvidence.candidates[0];
    expect(highestRanked).toMatchObject({
      path: "/api/inbox",
      sampleCount: 21,
    });
    expect(highestRanked?.requestFieldPaths).toContain("payload.text");
    expect(
      rankedEvidence.candidates.reduce(
        (total, candidate) =>
          total + candidate.requestFieldPaths.length + candidate.responseFieldPaths.length,
        0,
      ),
    ).toBeLessThanOrEqual(INTERNAL_HAR_REVIEW_BOUNDS.maxTotalFieldPaths);
    expect(rankedEvidence.warnings.some((warning) => warning.includes("bounded"))).toBeTrue();
    expect(JSON.stringify(rankedEvidence)).not.toContain("ranked-private-value");

    const revisionQueries = (offset: number): string => Array.from(
      { length: INTERNAL_HAR_REVIEW_BOUNDS.maxQueryParameters },
      (_value, index) => {
        const revision = (offset + index).toString(16).padStart(32, "0");
        return `queryId=messengerConversations.${revision}`;
      },
    ).join("&");
    const revisionEvidence = analyzeInternalHarValue(
      har([
        entry({
          url: `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?${revisionQueries(0)}`,
          responseJson: {},
        }),
        entry({
          url: `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?${revisionQueries(1_000)}`,
          responseJson: {},
        }),
      ]),
      "linkedin-internal",
      "https://www.linkedin.com",
      new Date("2026-07-22T00:00:00.000Z"),
    );
    expect(oneCandidate(revisionEvidence).revisions).toHaveLength(
      INTERNAL_HAR_REVIEW_BOUNDS.maxRevisions,
    );
  });

  test("preserves reviewed X Chat route semantics while redacting conversation and user identifiers", () => {
    const conversationId = "1234567890123456789-9876543210987654321";
    const userId = "1234567890123456789";
    const evidence = analyzeInternalHarValue(har([
      entry({
        url: `https://x.com/i/api/2/chat/conversations/${conversationId}/events?cursor=private-cursor`,
        method: "GET",
        status: 200,
        responseJson: { data: [{ encoded_event: "private-ciphertext" }] },
      }),
      entry({
        url: `https://x.com/i/api/2/users/${userId}/public_keys`,
        method: "GET",
        status: 200,
        responseJson: { data: [{ public_key: "private-public-key-material" }] },
      }),
    ]), "x-chat", "https://x.com", new Date("2026-07-22T00:00:00.000Z"));

    expect(evidence.candidates.map((candidate) => candidate.path)).toEqual([
      "/i/api/2/chat/conversations/:segment1/events",
      "/i/api/2/users/:segment1/public_keys",
    ]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(conversationId);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain("private-cursor");
    expect(serialized).not.toContain("private-ciphertext");
    expect(serialized).not.toContain("private-public-key-material");
  });

  test("redacts opaque and human-readable path segments instead of treating their spelling as route semantics", () => {
    const evidence = analyzeInternalHarValue(har([
      entry({
        url: "https://www.linkedin.com/voyager/api/F2JM9rnivTO",
        responseJson: { data: [] },
      }),
      entry({
        url: "https://www.linkedin.com/messages/Alice",
        responseJson: { data: [] },
      }),
      entry({
        url: "https://www.linkedin.com/voyager/api/voyagerFeedDashMainFeed",
        responseJson: { data: [] },
      }),
    ]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));

    expect(evidence.candidates.map((candidate) => candidate.path)).toEqual([
      "/voyager/api/:segment1",
      "/messages/:segment1",
    ]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("F2JM9rnivTO");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("voyagerFeedDashMainFeed");
  });

  test("does not retain registered-looking operation values away from exact provider GraphQL routes", () => {
    const offRoute = new URL("https://www.linkedin.com/messages/Alice");
    offRoute.searchParams.set("operationName", "MessagingInboxQuery");
    offRoute.searchParams.set("queryId", "messengerMessages.abcdef0123456789abcdef0123456789");
    const evidence = analyzeInternalHarValue(har([
      entry({ url: offRoute.href, responseJson: { data: [] } }),
    ]), "internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate.queryNames).toEqual(["operationName", "queryId"]);
    expect(candidate.revisions).toEqual([]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("MessagingInboxQuery");
    expect(serialized).not.toContain("messengerMessages");
    expect(serialized).not.toContain("Alice");

    const wrongMethod = new URL("https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql");
    wrongMethod.searchParams.set("queryId", "messengerMessages.abcdef0123456789abcdef0123456789");
    const wrongMethodEvidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: wrongMethod.href,
      responseJson: { data: [] },
    })]), "internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));
    expect(oneCandidate(wrongMethodEvidence).revisions).toEqual([]);
    expect(JSON.stringify(wrongMethodEvidence)).not.toContain("messengerMessages");

    const xEvidence = analyzeInternalHarValue(har([entry({
      url: "https://x.com/i/api/messages?operationName=DmInboxQuery",
      responseJson: { data: [] },
    })]), "internal", "https://x.com", new Date("2026-07-22T00:00:00.000Z"));
    expect(oneCandidate(xEvidence).revisions).toEqual([]);
    expect(JSON.stringify(xEvidence)).not.toContain("DmInboxQuery");

    const craftedXEvidence = analyzeInternalHarValue(har([entry({
      url: "https://x.com/i/api/graphql/ABCDEFGHIJKLMNOPQRSTUVWX12345678/PrivateAliceQuery",
      responseJson: { data: [] },
    })]), "internal", "https://x.com", new Date("2026-07-22T00:00:00.000Z"));
    expect(oneCandidate(craftedXEvidence)).toMatchObject({
      path: "/i/api/graphql/:revision/:operation",
      revisions: [],
    });
    const craftedXSerialized = JSON.stringify(craftedXEvidence);
    expect(craftedXSerialized).not.toContain("PrivateAliceQuery");
    expect(craftedXSerialized).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX12345678");
  });

  test("redacts dynamic request and response map keys while retaining reviewed structural fields", () => {
    const evidence = analyzeInternalHarValue(har([entry({
      method: "POST",
      url: "https://www.linkedin.com/voyager/api/graphql",
      requestJson: {
        variables: {
          users: {
            Alice: { id: "request-value" },
            F2JM9rnivTO: { name: "request-name" },
          },
        },
      },
      responseJson: {
        data: {
          byId: {
            Alice: { entityUrn: "response-value" },
            F2JM9rnivTO: { subject: "response-subject" },
          },
        },
      },
    })]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));

    const candidate = oneCandidate(evidence);
    expect(candidate.requestFieldPaths).toContain("variables.users.:dynamic.id");
    expect(candidate.responseFieldPaths).toContain("data.byId.:dynamic.entityUrn");
    expect(candidate.responseFieldPaths).toContain("data.byId.:dynamic.subject");
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("F2JM9rnivTO");
  });

  test("property: arbitrary identifier-shaped path segments and JSON map keys never survive evidence", () => {
    const suffix = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), {
      minLength: 3,
      maxLength: 30,
    }).map((characters) => characters.join(""));
    assertProperty(fc.property(suffix, (generatedSuffix) => {
      const dynamicValue = `Content${generatedSuffix}`;
      const evidence = analyzeInternalHarValue(har([entry({
        method: "POST",
        url: `https://www.linkedin.com/messages/${dynamicValue}`,
        requestJson: { variables: { users: { [dynamicValue]: { id: "request-value" } } } },
        responseJson: { data: { byId: { [dynamicValue]: { name: "response-value" } } } },
      })]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));

      const candidate = oneCandidate(evidence);
      expect(candidate.path).toBe("/messages/:segment1");
      expect(candidate.requestFieldPaths).toContain("variables.users.:dynamic.id");
      expect(candidate.responseFieldPaths).toContain("data.byId.:dynamic.name");
      expect(JSON.stringify(evidence)).not.toContain(dynamicValue);
    }));

    assertProperty(fc.property(
      fc.constantFrom("body", "data", "id", "messages", "name", "subject", "text", "users"),
      (dynamicValue) => {
        const evidence = analyzeInternalHarValue(har([entry({
          url: "https://www.linkedin.com/voyager/api/graphql",
          responseJson: { data: { users: { [dynamicValue]: { entityUrn: "response-value" } } } },
        })]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));
        const candidate = oneCandidate(evidence);
        expect(candidate.responseFieldPaths).toContain("data.users.:dynamic.entityUrn");
        expect(candidate.responseFieldPaths).not.toContain(`data.users.${dynamicValue}`);
      },
    ));

    assertProperty(fc.property(suffix, (generatedSuffix) => {
      const dynamicHeaderName = `x-user-${generatedSuffix}`.toLowerCase();
      const evidence = analyzeInternalHarValue(har([entry({
        url: "https://www.linkedin.com/voyager/api/graphql",
        requestHeaders: [{ name: dynamicHeaderName, value: "header-value" }],
        responseJson: { data: [] },
      })]), "linkedin-internal", "https://www.linkedin.com", new Date("2026-07-22T00:00:00.000Z"));
      expect(oneCandidate(evidence).headerNames).toEqual([":dynamic"]);
      expect(JSON.stringify(evidence)).not.toContain(dynamicHeaderName);
    }));
  });
});
