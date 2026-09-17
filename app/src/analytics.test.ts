// SPDX-License-Identifier: Apache-2.0
// No identifier ever reaches a third party (SPEC §15).

import { describe, expect, it } from "vitest";
import { buildEvent, routePattern, type AnalyticsEvent } from "./analytics";

/**
 * The comment in analytics.ts explains why. This is the part that is actually
 * true: an assertion over every event shape that nothing identifying appears in
 * a payload, so a future parameter cannot quietly ride along.
 */

const IDENTIFIERS = [
  "q3-acquisition-memo",
  "Q3 Acquisition Memo",
  "ana@example.com",
  "Design team",
  "v3",
];

const EVERY_EVENT: AnalyticsEvent[] = [
  { name: "page_view", params: { page_path: "/d/:docId/:versionId" } },
  { name: "login", params: { method: "google" } },
  { name: "sign_up", params: { method: "github" } },
  { name: "doc_publish", params: { source: "upload", format: "markdown" } },
  { name: "doc_open", params: { format: "html", sandboxed: true } },
  { name: "annotation_create", params: {} },
  { name: "comment_create", params: {} },
  { name: "version_commit", params: { format: "html" } },
  { name: "export", params: { kind: "pdf" } },
  { name: "share_grant", params: { role: "editor", principal: "team" } },
  { name: "trust_grant", params: { scope: "global" } },
];

describe("routePattern", () => {
  it("reduces a document URL to its pattern", () => {
    /**
     * THE important one. getAnalytics() sends page_location — the full URL —
     * and this app's URLs are /d/{docId}/{versionId}, where the slug is
     * frequently the confidential thing. A real corpus has slugs like
     * "q3-acquisition-memo".
     */
    expect(routePattern("/d/q3-acquisition-memo")).toBe("/d/:docId");
    expect(routePattern("/d/q3-acquisition-memo/v3")).toBe("/d/:docId/:versionId");
  });

  it("reduces a folder URL to its pattern", () => {
    expect(routePattern("/folder/board-materials")).toBe("/folder/:folderId");
  });

  it("leaves static routes alone", () => {
    expect(routePattern("/")).toBe("/");
    expect(routePattern("/account")).toBe("/account");
    expect(routePattern("/signup")).toBe("/signup");
  });
});

describe("buildEvent", () => {
  it("sets all three page fields to the pattern, not just page_path", () => {
    // Leaving any of them to gtag's defaults re-introduces the full URL.
    const built = buildEvent({
      name: "page_view",
      params: { page_path: "/d/:docId/:versionId" },
    });
    expect(built.params.page_path).toBe("/d/:docId/:versionId");
    expect(built.params.page_location).toBe("/d/:docId/:versionId");
    expect(built.params.page_title).toBe("/d/:docId/:versionId");
  });

  it("emits only enums, counts and booleans", () => {
    for (const event of EVERY_EVENT) {
      const built = buildEvent(event);
      for (const [key, value] of Object.entries(built.params)) {
        expect(["string", "number", "boolean"], `${event.name}.${key}`).toContain(
          typeof value,
        );
      }
    }
  });

  it("never carries an identifier in any event", () => {
    for (const event of EVERY_EVENT) {
      const serialized = JSON.stringify(buildEvent(event));
      for (const identifier of IDENTIFIERS) {
        expect(
          serialized.toLowerCase(),
          `${event.name} leaked ${identifier}`,
        ).not.toContain(identifier.toLowerCase());
      }
      expect(serialized, `${event.name} leaked an address`).not.toMatch(/@/);
    }
  });

  it("covers every event the union declares", () => {
    // A new event added to the union without a case here would otherwise never
    // be checked against the assertion above.
    const covered = new Set(EVERY_EVENT.map((e) => e.name));
    expect(covered.size).toBe(11);
  });
});
