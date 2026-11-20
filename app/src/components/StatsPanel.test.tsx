// SPDX-License-Identifier: Apache-2.0
// The Activity panel is one feed, newest first, whose filter applies to every row and which pages back (SPEC §17).

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "../activity";
import type { DocMeta } from "../types";

const { fetchActivity } = vi.hoisted(() => ({ fetchActivity: vi.fn() }));
vi.mock("../activity", async () => ({ ...(await vi.importActual<typeof import("../activity")>("../activity")), fetchActivity }));
vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));
vi.mock("../firestore", async () => ({
  ...(await vi.importActual<typeof import("../firestore")>("../firestore")),
  listDocViewers: async () => [],
}));

import { StatsPanel } from "./StatsPanel";
import { ToastProvider } from "./Toast";

const META = { docId: "d", title: "Plan", stats: { views: 2, totalMs: 60_000, commits: 2 } } as unknown as DocMeta;
const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 12, m)).toISOString();
const PAGE1: ActivityItem[] = [
  { id: "r1", type: "read", at: at(6), by: "own@example.com", channel: "mcp", via: "personal token “agent”", automated: true, version: "v2", ms: 0 },
  { id: "e4", type: "access.changed", at: at(5), by: "own@example.com", channel: "app", via: "“Claude” (connected app)", automated: true, added: ["a@example.com"] },
  { id: "e2", type: "version.published", at: at(3), by: "own@example.com", channel: "web", automated: false, version: "v2", origin: "edit" },
];
const PAGE2: ActivityItem[] = [
  { id: "e1", type: "version.published", at: at(1), by: "own@example.com", channel: "cli", via: "CLI on mbp", automated: true, version: "v1", origin: "upload" },
];

async function open(meta: DocMeta = META, canSeeDetail = true) {
  render(
    <ToastProvider>
      <MemoryRouter>
        <StatsPanel meta={meta} canSeeDetail={canSeeDetail} onClose={() => {}} />
      </MemoryRouter>
    </ToastProvider>,
  );
  await act(async () => {});
}

const rows = () =>
  // The feed is the last list: the Readers list above it is a paragraph when nobody has read it.
  within([...document.querySelectorAll("ul.activity-feed")].at(-1) as HTMLElement)
    .queryAllByRole("listitem")
    .map((li) => li.textContent);

/** What acted, as a row's badge has it: null for a person in the browser. */
const how = (row: number) =>
  [...document.querySelectorAll("ul.activity-feed")].at(-1)!.querySelectorAll("li")[row].querySelector(".badge-automated")?.getAttribute("title") ?? null;

beforeEach(() => {
  fetchActivity.mockReset();
  fetchActivity.mockImplementation(async (_doc: string, before?: string) => (before === "c1" ? { items: PAGE2, next: null } : { items: PAGE1, next: "c1" }));
});

describe("the visits", () => {
  it("say how many came through an embed, to any member, and nothing when none did", async () => {
    const embedded = { ...META, stats: { ...META.stats, views: 9, embeds: 4 } } as unknown as DocMeta;
    await open(embedded, false);
    // Four of the nine, not four more: the tile still says nine.
    expect(document.querySelector(".stat-value")?.textContent).toBe("9");
    expect(document.querySelector(".stat-label")?.textContent).toBe("visits · 4 in embeds");
  });

  it("say nothing about embeds for a document nobody has embedded", async () => {
    await open(META, false);
    expect(document.querySelector(".stat-label")?.textContent).toBe("visits");
  });
});

describe("the Activity feed", () => {
  it("is one list, newest first, each row saying who, what, and through what", async () => {
    await open();
    expect(rows()).toEqual([
      expect.stringContaining("Ownread it"),
      expect.stringContaining("gave a@example.com access"),
      expect.stringContaining("published a version from the editor"),
    ]);
    expect(how(0)).toBe("Done through personal token “agent”, not by a person in the browser");
    expect(how(1)).toBe("Done through “Claude” (connected app), not by a person in the browser");
    expect(how(2)).toBeNull();
  });

  it("filters every kind of row, not only reads: an app's grant is automation", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain("gave a@example.com access");
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(rows()).toEqual([expect.stringContaining("published a version from the editor")]);
  });

  it("says a date made it private as the date's own doing, with no agent badge", async () => {
    fetchActivity.mockImplementation(async () => ({
      items: [{ id: "x1", type: "doc.expired", at: at(7), by: null, channel: "system", via: "its end date", automated: true, from: "unlisted", expiresAt: Date.parse(at(7)) }],
      next: null,
    }));
    await open();
    expect(rows()).toEqual([expect.stringContaining("Its end datepassed: it is now private, and its link stopped working")]);
    expect(how(0)).toBeNull();
  });

  it("shows earlier activity on request, from where the last page ended", async () => {
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show earlier activity" }));
    });
    expect(fetchActivity).toHaveBeenLastCalledWith("d", "c1");
    expect(rows()).toHaveLength(4);
    expect(how(3)).toBe("Done through CLI on mbp, not by a person in the browser");
    expect(screen.queryByRole("button", { name: "Show earlier activity" })).toBeNull();
  });

  it("shows a fork as the UTC day it was sent as, even west of Greenwich, where that day's midnight is the day before", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      fetchActivity.mockImplementation(async () => ({ items: [{ id: "f1", type: "fork.created", at: "2026-10-29" }], next: null }));
      await open();
      expect(rows()).toEqual([expect.stringContaining("Someoneforked a version")]);
      expect(rows()[0]).toContain("29, 2026");
      expect(rows()[0]).not.toContain("28");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
