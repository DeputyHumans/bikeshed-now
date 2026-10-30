// SPDX-License-Identifier: Apache-2.0
// A document's details tell a member its whole story and a reader without the record only its length and date (SPEC §4, §17).

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { originOfVersion } from "../provenance";
import type { DocMeta, DocVersion, PublicDoc } from "../types";

vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));

import { DetailsPanel } from "./DetailsPanel";

const ts = (iso: string) => ({ toDate: () => new Date(iso), toMillis: () => Date.parse(iso) }) as never;
const META = {
  docId: "plan",
  title: "Plan",
  ownerEmail: "ana@example.com",
  currentVersion: "v2",
  createdAt: ts("2026-10-01T09:00:00Z"),
  updatedAt: ts("2026-10-29T12:00:00Z"),
  latest: { version: "v2", at: ts("2026-10-28T12:00:00Z"), byEmail: "ana@example.com", channel: "app", via: "“Claude” (connected app)", origin: "edit", words: 2380 },
  draft: { updatedAt: ts("2026-10-29T10:00:00Z"), updatedByEmail: "bo@example.com" },
} as unknown as DocMeta;
const VERSIONS = [
  { versionId: "v1", publishedAt: ts("2026-10-01T09:00:00Z"), publishedByEmail: "ana@example.com", publishedBy: { channel: "web" }, publishedVia: "upload", words: 300 },
  { versionId: "v2", publishedAt: ts("2026-10-28T12:00:00Z"), publishedByEmail: "ana@example.com", publishedBy: { channel: "app", via: "“Claude” (connected app)" }, origin: "edit", words: 2380 },
] as unknown as DocVersion[];

function open(props: Partial<Parameters<typeof DetailsPanel>[0]>) {
  render(
    <MemoryRouter>
      <DetailsPanel title="Plan" docId="plan" meta={null} publicDoc={null} versions={[]} viewing="v2" words={undefined} slides={0} showDraft={false} onClose={() => {}} {...props} />
    </MemoryRouter>,
  );
  return screen.getByRole("dialog");
}

describe("a document's details", () => {
  it("tell a member how long it is, when it was made and updated, by whom and through what, and every version", () => {
    const dialog = open({ meta: META, versions: VERSIONS, words: 2380, showDraft: true });
    expect(dialog.textContent).toContain("10 min read · 2,380 words");
    expect(dialog.textContent).toContain("by ana@example.com");
    expect(within(dialog).getAllByText("via “Claude” (connected app)").length).toBeGreaterThan(0);
    expect(dialog.textContent).toContain("Changes saved");
    const rows = [...dialog.querySelectorAll(".details-versions li")].map((li) => li.textContent);
    expect(rows[0]).toMatch(/^v2 · current.*published from the editor.*via “Claude” \(connected app\)/);
    expect(rows[1]).toMatch(/^v1.*uploaded by ana@example.com/);
    expect(rows[1]).not.toContain("via");
  });

  it("say when the current version was published, falling back as the card does for a document not summarized yet", () => {
    const unsummarized = { ...META, latest: undefined } as unknown as DocMeta;
    const dialog = open({ meta: unsummarized, versions: VERSIONS });
    expect(within(dialog).getByText("Updated").nextElementSibling?.textContent).not.toBe("…");
  });

  it("say nothing of who published from a summary that is of an older version", () => {
    const behind = { ...META, latest: { ...META.latest, version: "v1" } } as unknown as DocMeta;
    const dialog = open({ meta: behind, versions: VERSIONS });
    expect(within(dialog).getByText("Updated").nextElementSibling?.textContent).not.toMatch(/\(v1\)/);
  });

  it("keep an unpublished draft to the document's editors", () => {
    expect(open({ meta: META, versions: VERSIONS, showDraft: false }).textContent).not.toContain("Changes saved");
  });

  it("tell a reader without the record its length and date and nobody's name", () => {
    // POST /unlock's answer, as JSON carries it: the time in epoch milliseconds.
    const publicDoc = { currentVersion: "v2", words: 476, updatedAt: Date.parse("2026-10-28T12:00:00Z") } as unknown as PublicDoc;
    const dialog = open({ publicDoc, words: 476 });
    expect(dialog.textContent).toContain("2 min read · 476 words");
    expect(within(dialog).getByText("Updated").nextElementSibling?.textContent, "the date the answer carries").toMatch(/2026/);
    expect(dialog.textContent).not.toMatch(/@|via|Created|Versions/);
  });

  it("read an older version's arrival from the field it was stored in, a duplicate as the fork it was", () => {
    const older = [
      { versionId: "v1", publishedAt: ts("2026-09-01T09:00:00Z"), publishedByEmail: "ana@example.com", publishedVia: "duplicate" },
      { versionId: "v2", publishedAt: ts("2026-09-02T09:00:00Z"), publishedByEmail: "ana@example.com", publishedVia: "editor" },
    ] as unknown as DocVersion[];
    const rows = [...open({ meta: META, versions: older }).querySelectorAll(".details-versions li")].map((li) => li.textContent);
    expect(rows[0]).toContain("published from the editor");
    expect(rows[1]).toContain("made as a fork");
  });

  it("read how a version arrived exactly as the server does (origin-vectors.json)", () => {
    const file = join(__dirname, "..", "..", "..", "functions", "test", "fixtures", "origin-vectors.json");
    const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: Array<{ name: string; version: Record<string, unknown>; origin: string | null }> };
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect(originOfVersion(c.version), c.name).toBe(c.origin);
  });

  it("say a deck's slides, and an uncounted document as such", () => {
    expect(open({ slides: 12 }).textContent).toContain("Not counted yet · 12 slides");
  });
});
