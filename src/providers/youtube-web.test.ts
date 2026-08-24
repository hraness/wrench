import { describe, expect, test } from "bun:test";

import youtubeManifest from "../assets/adapters/youtube/wrench-web-adapter.json";
import {
  createYouTubeSapisidAuthorization,
  findYouTubeCommentsContinuation,
  parseYouTubeBootstrapHtml,
  parseYouTubeInitialDataHtml,
  projectYouTubeProfile,
  projectYouTubeComments,
  projectYouTubeItems,
  projectYouTubeMedia,
  projectYouTubePost,
  youtubeCurrentSubject,
  youtubeLikeMutationRequest,
  youtubeLikeState,
  youtubePostBrowseRequest,
  youtubeProfileBrowseRequest,
  youtubeProfileTarget,
  youtubeSubscriptionState,
  youtubeSubscriptionMutationRequest,
  youtubeVideoDeleteRequest,
  youtubeWatchLaterState,
} from "./youtube-web";

const CHANNEL_ID = `UC${"a".repeat(22)}`;
const OTHER_CHANNEL_ID = `UC${"b".repeat(22)}`;
const GAIA_ID = "123456789012345678901";
const DELEGATE_ID = "delegated-page-id";
const VIDEO_ID = "dQw4w9WgXcQ";
const POST_ID = `Ug${"p".repeat(24)}`;

function bootstrapHtml(overrides: Record<string, unknown> = {}): string {
  return [
    "<!doctype html>",
    `<script>ytcfg.set(${JSON.stringify({
      INNERTUBE_API_KEY: "AIzaSyntheticPublicKey1234567890",
      INNERTUBE_CONTEXT_CLIENT_NAME: 1,
      LOGGED_IN: true,
      SESSION_INDEX: "2",
      DELEGATED_SESSION_ID: "delegated-page-id",
      ...overrides,
    })});</script>`,
    `<script>ytcfg.set(${JSON.stringify({
      INNERTUBE_CONTEXT: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20260722.01.00",
          hl: "en",
          gl: "US",
          visitorData: "visitor-data",
          userAgent: "Synthetic Browser",
          unreviewedSecret: "must-not-be-forwarded",
        },
        user: {
          lockedSafetyMode: false,
          unreviewedUserField: "must-not-be-forwarded",
        },
        request: { useSsl: true, unreviewedRequestField: "must-not-be-forwarded" },
        unreviewedContextField: "must-not-be-forwarded",
      },
    })});</script>`,
  ].join("");
}

describe("YouTube web policy primitives", () => {
  test("ships a schema-v4 manifest with the live-proven internal-API actions", () => {
    expect(youtubeManifest.schemaVersion).toBe(4);
    expect(youtubeManifest.surfaceId).toBe("youtube");
    const observed = [
      "comments.read",
      "feeds.read",
      "media.read",
      "posts.read",
      "profiles.read",
    ] as const;
    const captureRequired = [
      "comments.create",
      "content.delete",
      "content.save",
      "content.edit",
      "content.schedule",
      "likes.set",
      "media.publish",
      "posts.publish",
      "relationships.follow.set",
      "replies.create",
    ] as const;
    expect(Object.keys(youtubeManifest.operations).sort()).toEqual(
      [...observed, ...captureRequired].sort(),
    );
    for (const action of observed) {
      const operation = youtubeManifest.operations[action];
      expect(operation.description.startsWith("Observed contract:")).toBe(true);
      expect(operation.webSession).toMatchObject({ site: "youtube", action });
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
    for (const action of captureRequired) {
      const operation = youtubeManifest.operations[action];
      expect(operation.description.startsWith("Capture-required contract reservation:")).toBe(true);
      expect(operation.webSession).toMatchObject({ site: "youtube", action });
    }
  });

  test("builds only the public-bundle-proven inert video-delete envelope", () => {
    const config = parseYouTubeBootstrapHtml(bootstrapHtml());
    expect(youtubeVideoDeleteRequest(config, VIDEO_ID)).toEqual({
      body: { context: config.context, videoId: VIDEO_ID },
      endpoint: "video/delete",
      method: "POST",
    });
    expect(() => youtubeVideoDeleteRequest(config, "not/a/video"))
      .toThrow("YouTube delete video ID must be exact");
    expect(() => youtubeVideoDeleteRequest({
      ...config,
      context: {
        ...config.context,
        client: { ...config.context.client, clientVersion: "drifted" },
      },
    }, VIDEO_ID)).toThrow("context did not match its reviewed bootstrap");
  });

  test("resolves one exact channel target and projects only exact profile counts", () => {
    const target = youtubeProfileTarget("@wrench_test");
    expect(target).toEqual({
      url: "https://www.youtube.com/@wrench_test",
      handle: "wrench_test",
      channelId: null,
    });
    const browse = youtubeProfileBrowseRequest({
      responseContext: {},
      endpoint: {
        browseEndpoint: {
          browseId: CHANNEL_ID,
          canonicalBaseUrl: "/@wrench_test",
          params: "about-tab-params",
        },
      },
    }, target);
    expect(browse).toEqual({ browseId: CHANNEL_ID });

    const response = {
      responseContext: {},
      metadata: {
        channelMetadataRenderer: {
          externalId: CHANNEL_ID,
          title: "Wrench Test",
          description: "Public channel bio",
          vanityChannelUrl: "https://www.youtube.com/@wrench_test",
        },
      },
      engagementPanels: [{
        engagementPanelSectionListRenderer: {
          content: {
            sectionListRenderer: {
              contents: [{
                itemSectionRenderer: {
                  contents: [{
                    aboutChannelRenderer: {
                      metadata: {
                        aboutChannelViewModel: {
                          channelId: CHANNEL_ID,
                          canonicalChannelUrl: "http://www.youtube.com/@wrench_test",
                          subscriberCountText: "4 subscribers",
                          videoCountText: "11 videos",
                          viewCountText: "2,061 views",
                        },
                      },
                    },
                  }],
                },
              }],
            },
          },
        },
      }],
    };
    expect(projectYouTubeProfile(response, CHANNEL_ID)).toEqual({
      channelId: CHANNEL_ID,
      canonicalUrl: "https://www.youtube.com/@wrench_test",
      handle: "wrench_test",
      displayName: "Wrench Test",
      bio: "Public channel bio",
      subscribers: 4,
      videos: 11,
      views: 2061,
    });

    const rounded = structuredClone(response);
    const about = rounded.engagementPanels[0]!.engagementPanelSectionListRenderer
      .content.sectionListRenderer.contents[0]!.itemSectionRenderer.contents[0]!
      .aboutChannelRenderer.metadata.aboutChannelViewModel;
    about.subscriberCountText = "1.2K subscribers";
    expect(projectYouTubeProfile(rounded, CHANNEL_ID)).toMatchObject({
      subscribers: null,
      videos: 11,
      views: 2061,
    });

    const missingAbout = structuredClone(response);
    missingAbout.engagementPanels = [];
    expect(projectYouTubeProfile(missingAbout, CHANNEL_ID)).toMatchObject({
      subscribers: null,
      videos: null,
      views: null,
    });
  });

  test("binds one live-shaped handle resolution to its exact request URL", () => {
    const target = youtubeProfileTarget("@hraness");
    expect(youtubeProfileBrowseRequest({
      responseContext: {},
      endpoint: {
        commandMetadata: {
          webCommandMetadata: { url: "/youtubei/v1/browse" },
        },
        browseEndpoint: {
          browseId: "UC1234567890123456789012",
          params: "live-response-opaque-params",
        },
      },
    }, target)).toEqual({ browseId: "UC1234567890123456789012" });
  });

  test("parses one strict profile-page initial-data object without evaluation", () => {
    const initialData = {
      responseContext: {},
      metadata: {
        channelMetadataRenderer: {
          externalId: CHANNEL_ID,
          title: "Wrench Test",
        },
      },
    };
    expect(parseYouTubeInitialDataHtml(
      `<script>var ytInitialData = ${JSON.stringify(initialData)};</script>`,
    )).toEqual(initialData);
    expect(() => parseYouTubeInitialDataHtml(
      `<script>var ytInitialData = {};</script><script>window["ytInitialData"] = {"other":true};</script>`,
    )).toThrow("one strict initial-data object");
    expect(() => parseYouTubeInitialDataHtml(
      "<script>var ytInitialData = {notStrictJson:true};</script>",
    )).toThrow("one strict initial-data object");
  });

  test("rejects ambiguous resolution, unbound metadata, and noncanonical profile inputs", () => {
    expect(() => youtubeProfileTarget("https://youtube.com/@wrench_test?feature=share"))
      .toThrow("exact @handle or canonical");
    expect(() => youtubeProfileBrowseRequest({
      responseContext: {},
      endpoints: [
        {
          browseEndpoint: {
            browseId: CHANNEL_ID,
            canonicalBaseUrl: "/@wrench_test",
            params: "first-about-tab-params",
          },
        },
        {
          browseEndpoint: {
            browseId: OTHER_CHANNEL_ID,
            canonicalBaseUrl: "/@wrench_test",
            params: "second-about-tab-params",
          },
        },
      ],
    }, youtubeProfileTarget("@wrench_test"))).toThrow("one exact channel");
    expect(() => projectYouTubeProfile({
      responseContext: {},
      metadata: {
        channelMetadataRenderer: {
          externalId: OTHER_CHANNEL_ID,
          title: "Other",
          description: "Other",
        },
      },
    }, CHANNEL_ID)).toThrow("one exact channel metadata renderer");
  });

  test("parses only reviewed signed-in Innertube bootstrap fields", () => {
    const config = parseYouTubeBootstrapHtml(
      `<script>ytcfg.set({javascriptOnly:'never evaluated'});</script>${bootstrapHtml()}`,
    );
    expect(config.apiKey).toBe("AIzaSyntheticPublicKey1234567890");
    expect(config.bootstrapLoggedIn).toBe(true);
    expect(config.clientName).toBe("WEB");
    expect(config.clientNameHeader).toBe("1");
    expect(config.clientVersion).toBe("2.20260722.01.00");
    expect(config.sessionIndex).toBe("2");
    expect(config.delegatedSessionId).toBe("delegated-page-id");
    expect(config.visitorData).toBe("visitor-data");
    expect(config.context).toEqual({
      client: {
        clientName: "WEB",
        clientVersion: "2.20260722.01.00",
        hl: "en",
        gl: "US",
        visitorData: "visitor-data",
        userAgent: "Synthetic Browser",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    });
    expect(JSON.stringify(config.context)).not.toContain("must-not-be-forwarded");
  });

  test("carries the page login hint while account endpoints remain authoritative", () => {
    expect(parseYouTubeBootstrapHtml(bootstrapHtml({ LOGGED_IN: false })).bootstrapLoggedIn)
      .toBe(false);
    const conflict = `${bootstrapHtml()}<script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaAnotherSyntheticPublicKey9999"});</script>`;
    expect(() => parseYouTubeBootstrapHtml(conflict)).toThrow(
      "conflicting INNERTUBE_API_KEY",
    );
  });

  test("generates a deterministic origin-bound SAPISIDHASH without returning the cookie", () => {
    const value = createYouTubeSapisidAuthorization("sapisid-cookie", 1_700_000_000_000);
    expect(value).toBe(
      "SAPISIDHASH 1700000000_d9e5d0b40bd8d13c106ff9aebaf4cd34bc7b953a",
    );
    expect(value).not.toContain("sapisid-cookie");
    expect(() =>
      createYouTubeSapisidAuthorization("sapisid-cookie", 1_700_000_000_000, "https://evil.example")
    ).toThrow("origin is not reviewed");
  });

  test("binds the selected account only when both first-party account endpoints agree", () => {
    const menu = {
      actions: [{
        openPopupAction: {
          popup: {
            multiPageMenuRenderer: {
              header: {
                activeAccountHeaderRenderer: {
                  serviceEndpoint: { browseEndpoint: { browseId: CHANNEL_ID } },
                },
              },
            },
          },
        },
      }],
    };
    const list = {
      actions: [{
        getMultiPageMenuAction: {
          menu: {
            multiPageMenuRenderer: {
              sections: [{
                accountItemSectionRenderer: {
                  contents: [{
                    accountItemRenderer: {
                      isSelected: true,
                      serviceEndpoint: {
                        browseEndpoint: { browseId: CHANNEL_ID },
                        selectActiveIdentityEndpoint: {
                          supportedTokens: [{
                            accountStateToken: { obfuscatedGaiaId: GAIA_ID },
                          }],
                        },
                      },
                    },
                  }],
                },
              }],
            },
          },
        },
      }],
    };
    expect(youtubeCurrentSubject(menu, list, DELEGATE_ID)).toBe(
      `youtube:channel:${CHANNEL_ID}/gaia:${GAIA_ID}/delegate:${DELEGATE_ID}`,
    );
    const conflicting = structuredClone(list);
    conflicting.actions[0]!.getMultiPageMenuAction.menu.multiPageMenuRenderer.sections[0]!
      .accountItemSectionRenderer.contents[0]!.accountItemRenderer.serviceEndpoint.browseEndpoint.browseId =
      OTHER_CHANNEL_ID;
    expect(() => youtubeCurrentSubject(menu, conflicting)).toThrow(
      "did not bind one unique current channel",
    );
  });

  test("projects bounded feed items and does not return renderer payloads", () => {
    const response = {
      contents: [{
        richItemRenderer: {
          content: {
            videoRenderer: {
              videoId: VIDEO_ID,
              title: { runs: [{ text: "Example video" }] },
              ownerText: {
                runs: [{
                  text: "Example channel",
                  navigationEndpoint: { browseEndpoint: { browseId: CHANNEL_ID } },
                }],
              },
              navigationEndpoint: {
                commandMetadata: { webCommandMetadata: { url: `/watch?v=${VIDEO_ID}` } },
              },
              lengthText: { simpleText: "1:23" },
              viewCountText: { simpleText: "10 views" },
              privateTrackingParams: "must-not-leak",
            },
          },
        },
      }, {
        continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: "opaque-continuation" } },
        },
      }],
    };
    const projected = projectYouTubeItems(response, 1);
    expect(projected).toEqual({
      items: [{
        kind: "video",
        id: VIDEO_ID,
        title: "Example video",
        url: `/watch?v=${VIDEO_ID}`,
        channelId: CHANNEL_ID,
        channelName: "Example channel",
        description: null,
        published: null,
        duration: "1:23",
        views: "10 views",
      }],
      continuation: "opaque-continuation",
      truncated: true,
    });
    expect(JSON.stringify(projected)).not.toContain("privateTrackingParams");
  });

  test("projects player metadata without exposing signed streaming URLs", () => {
    const output = projectYouTubeMedia({
      videoDetails: {
        videoId: VIDEO_ID,
        title: "Example",
        channelId: CHANNEL_ID,
        author: "Channel",
        lengthSeconds: "83",
        viewCount: "10",
        shortDescription: "Description",
        keywords: ["one", "two"],
      },
      playabilityStatus: { status: "OK" },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: "2026-07-22",
          uploadDate: "2026-07-21",
          category: "Education",
          isFamilySafe: true,
          availableCountries: ["US"],
        },
      },
      streamingData: {
        formats: [{ url: "https://secret-playback.example/token" }],
      },
    }, VIDEO_ID);
    expect(output).toEqual({
      videoId: VIDEO_ID,
      title: "Example",
      channelId: CHANNEL_ID,
      author: "Channel",
      lengthSeconds: "83",
      viewCount: "10",
      shortDescription: "Description",
      keywords: ["one", "two"],
      isLiveContent: false,
      playability: "OK",
      publishDate: "2026-07-22",
      uploadDate: "2026-07-21",
      category: "Education",
      familySafe: true,
      availableCountries: ["US"],
    });
    expect(JSON.stringify(output)).not.toContain("secret-playback");
    expect(() => projectYouTubeMedia({ videoDetails: { videoId: "aaaaaaaaaaa" } }, VIDEO_ID))
      .toThrow("did not bind the requested video");
  });

  test("projects one exact Community post and its attachment kinds", () => {
    expect(youtubePostBrowseRequest({
      endpoint: {
        commandMetadata: {
          webCommandMetadata: { url: `/post/${POST_ID}` },
        },
        browseEndpoint: {
          browseId: "FEpost_detail",
          params: "EhhzeW50aGV0aWMtcG9zdC1wYXJhbXM=",
        },
      },
    }, POST_ID)).toEqual({
      browseId: "FEpost_detail",
      params: "EhhzeW50aGV0aWMtcG9zdC1wYXJhbXM=",
    });
    const output = projectYouTubePost({
      contents: [{
        backstagePostRenderer: {
          postId: POST_ID,
          contentText: { runs: [{ text: "Community update" }] },
          authorText: {
            runs: [{
              text: "Channel",
              navigationEndpoint: { browseEndpoint: { browseId: CHANNEL_ID } },
            }],
          },
          publishedTimeText: { simpleText: "1 hour ago" },
          voteCount: { simpleText: "5" },
          backstageAttachment: { backstageImageRenderer: { image: {} } },
        },
      }],
    }, POST_ID);
    expect(output).toEqual({
      id: POST_ID,
      authorChannelId: CHANNEL_ID,
      author: "Channel",
      body: "Community update",
      published: "1 hour ago",
      likes: "5",
      attachmentKinds: ["image"],
    });
  });

  test("finds the comments-only continuation and projects bounded comments", () => {
    const initial = {
      contents: [{
        itemSectionRenderer: {
          targetId: "comments-section",
          contents: [{
            continuationItemRenderer: {
              continuationEndpoint: { continuationCommand: { token: "comments-token" } },
            },
          }],
        },
      }, {
        continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: "recommendations-token" } },
        },
      }],
    };
    expect(findYouTubeCommentsContinuation(initial)).toBe("comments-token");
    const projected = projectYouTubeComments({
      continuationContents: [{
        commentThreadRenderer: {
          comment: {
            commentRenderer: {
              commentId: "comment_123456",
              contentText: { runs: [{ text: "Nice video" }] },
              authorText: {
                runs: [{
                  text: "Viewer",
                  navigationEndpoint: { browseEndpoint: { browseId: OTHER_CHANNEL_ID } },
                }],
              },
              publishedTimeText: { simpleText: "today" },
              voteCount: { simpleText: "2" },
              isHearted: true,
            },
          },
        },
      }],
    }, 10);
    expect(projected.comments).toEqual([{
      id: "comment_123456",
      parentId: null,
      authorChannelId: OTHER_CHANNEL_ID,
      author: "Viewer",
      body: "Nice video",
      published: "today",
      votes: "2",
      heartedByCreator: true,
      pinned: false,
    }]);
    expect(projectYouTubeComments({
      frameworkUpdates: {
        entityBatchUpdate: {
          mutations: [{
            payload: {
              commentEntityPayload: {
                properties: {
                  commentId: "modern.comment_123",
                  content: { content: "Modern comment body" },
                  publishedTime: "1 day ago",
                },
                author: {
                  channelId: OTHER_CHANNEL_ID,
                  displayName: "Modern viewer",
                },
                toolbar: {
                  likeCountNotliked: "12",
                  heartState: "TOOLBAR_HEART_STATE_HEARTED",
                },
              },
            },
          }],
        },
      },
    }, 10).comments).toEqual([{
      id: "modern.comment_123",
      parentId: null,
      authorChannelId: OTHER_CHANNEL_ID,
      author: "Modern viewer",
      body: "Modern comment body",
      published: "1 day ago",
      votes: "12",
      heartedByCreator: true,
      pinned: false,
    }]);
  });

  test("requires unique target-bound desired-state readbacks", () => {
    const likeReadback = {
      currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
      contents: {
        twoColumnWatchNextResults: {
          results: {
            results: {
              contents: [{
                videoPrimaryInfoRenderer: {
                  videoActions: {
                    menuRenderer: {
                      topLevelButtons: [{
                        segmentedLikeDislikeButtonViewModel: {
                          likeButtonViewModel: {
                            commands: [{
                              commandMetadata: {
                                webCommandMetadata: { apiUrl: "/youtubei/v1/like/like" },
                              },
                              likeEndpoint: {
                                status: "LIKE",
                                target: { videoId: VIDEO_ID },
                                likeParams: "syntheticLikeParams0123456789",
                              },
                            }, {
                              commandMetadata: {
                                webCommandMetadata: { apiUrl: "/youtubei/v1/like/removelike" },
                              },
                              likeEndpoint: {
                                status: "INDIFFERENT",
                                target: { videoId: VIDEO_ID },
                                removeLikeParams: "syntheticRemoveLikeParams0123456789",
                              },
                            }],
                          },
                        },
                      }],
                    },
                  },
                },
              }],
            },
          },
        },
      },
      buttons: [{
        toggleButtonRenderer: {
          defaultIcon: { iconType: "LIKE" },
          isToggled: true,
        },
      }],
    };
    expect(youtubeLikeState(likeReadback, VIDEO_ID)).toBe(true);
    expect(youtubeLikeMutationRequest(likeReadback, VIDEO_ID, false)).toEqual({
      endpoint: "like/removelike",
      body: {
        status: "INDIFFERENT",
        target: { videoId: VIDEO_ID },
        removeLikeParams: "syntheticRemoveLikeParams0123456789",
      },
    });
    expect(youtubeWatchLaterState({
      currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
      menu: [{
        playlistEditEndpoint: {
          playlistId: "WL",
          actions: [{
            action: "ACTION_ADD_VIDEO",
            addedVideoId: VIDEO_ID,
          }],
        },
      }],
    }, VIDEO_ID)).toBe(false);
    const subscriptionReadback = {
      metadata: { channelMetadataRenderer: { externalId: CHANNEL_ID } },
      frameworkUpdates: {
        entityBatchUpdate: {
          mutations: [{
            payload: { subscriptionStateEntity: { subscribed: true } },
          }],
        },
      },
      header: {
        subscribeButtonViewModel: {
          subscribeButtonContent: {
            subscribeState: { subscribed: false },
            onTapCommand: {
              innertubeCommand: {
                commandMetadata: {
                  webCommandMetadata: { apiUrl: "/youtubei/v1/subscription/subscribe" },
                },
                subscribeEndpoint: {
                  channelIds: [CHANNEL_ID],
                  params: "syntheticSubscribeParams0123456789",
                },
              },
            },
          },
          unsubscribeButtonContent: {
            subscribeState: { subscribed: true },
            onTapCommand: {
              innertubeCommand: {
                commandMetadata: {
                  webCommandMetadata: { apiUrl: "/youtubei/v1/subscription/unsubscribe" },
                },
                unsubscribeEndpoint: {
                  channelIds: [CHANNEL_ID],
                  params: "syntheticUnsubscribeParams0123456789",
                },
              },
            },
          },
        },
      },
    };
    expect(youtubeSubscriptionState(subscriptionReadback, CHANNEL_ID)).toBe(true);
    expect(youtubeSubscriptionMutationRequest(subscriptionReadback, CHANNEL_ID, true)).toEqual({
      endpoint: "subscription/subscribe",
      body: {
        channelIds: [CHANNEL_ID],
        params: "syntheticSubscribeParams0123456789",
      },
    });
    expect(() => youtubeSubscriptionState({
      metadata: { channelMetadataRenderer: { externalId: OTHER_CHANNEL_ID } },
      header: { subscribeButtonRenderer: { subscribed: true } },
    }, CHANNEL_ID)).toThrow("did not bind the requested channel");
  });
});
