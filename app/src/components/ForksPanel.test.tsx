// SPDX-License-Identifier: Apache-2.0
// The forks panel tells each reader only what they could open (SPEC §21).

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ForksPanel, forkCountSentence } from "./ForksPanel";
import type { Lineage } from "../forks";

function mount(props: Partial<Parameters<typeof ForksPanel>[0]> & { lineage: Lineage | null }) {
  const onRefresh = vi.fn();
  render(
    <MemoryRouter>
      <ForksPanel
        title="Q3 plan"
        forked
        isOwner={false}
        signedIn
        failed={false}
        onRefresh={onRefresh}
        onClose={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onRefresh };
}

describe("forkCountSentence", () => {
  it.each([
    [1, 0, "Forked once."],
    [3, 0, "Forked 3 times."],
    [1, 1, "Forked once, into a document you can't open."],
    [3, 3, "Forked 3 times, into documents you can't open."],
    [3, 1, "Forked 3 times. The one you can't open isn't listed."],
    [5, 2, "Forked 5 times. The 2 you can't open aren't listed."],
  ])("%i forks, %i hidden", (total, hidden, sentence) => {
    expect(forkCountSentence(total, hidden)).toBe(sentence);
  });
});

describe("the forks panel", () => {
  it("asks for a fresh answer every time it opens", () => {
    const { onRefresh } = mount({ lineage: null });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("links each hop to the version forked, and says where the walk stopped", () => {
    mount({
      lineage: {
        forked: true,
        ancestors: [
          { docId: "beta", title: "Beta", versionId: "v1", ownerEmail: "b@example.com", changed: true },
          { docId: "alpha", title: "Alpha", versionId: "v2" },
        ],
        hiddenAncestor: true,
      },
    });
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("href")).toBe("/d/beta/v1");
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("/d/alpha/v2");
    expect(screen.getByText("v1 · b@example.com")).toBeDefined();
    expect(screen.getByText(/forked from a document you can't open/)).toBeDefined();
    expect(screen.getByText(/The original has changed since this was forked/)).toBeDefined();
    expect(screen.getByRole("link", { name: "See it as it is now" }).getAttribute("href")).toBe("/d/beta");
  });

  it("names nothing when the very first hop is closed to the reader", () => {
    mount({ lineage: { forked: true, ancestors: [], hiddenAncestor: true } });
    expect(screen.getByText("A document you can't open.")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says an original was deleted forever, rather than that it cannot be opened", () => {
    mount({ lineage: { forked: true, ancestors: [], hiddenAncestor: false, deletedAncestor: true } });
    expect(screen.getByText("A document that has since been deleted.")).toBeDefined();
    expect(screen.queryByText(/can't open/)).toBeNull();
    cleanup();
    mount({ lineage: { forked: true, ancestors: [{ docId: "beta", title: "Beta", versionId: "v1" }], hiddenAncestor: false, deletedAncestor: true } });
    expect(screen.getByText("…which was forked from a document that has since been deleted.")).toBeDefined();
  });

  it("gives the owner the count and the forks they can open, and nobody else", () => {
    const lineage: Lineage = {
      forked: false,
      ancestors: [],
      hiddenAncestor: false,
      forks: {
        total: 3,
        hidden: 1,
        visible: [
          { docId: "f1", title: "Ana's take", visibility: "public", forkedAt: Date.UTC(2026, 9, 1) },
          { docId: "f2", title: "Team copy", visibility: "private", forkedAt: null, ownerEmail: "lee@example.com" },
        ],
      },
    };
    mount({ forked: false, isOwner: true, lineage });
    expect(screen.getByText("Forked 3 times. The one you can't open isn't listed.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Ana's take" }).getAttribute("href")).toBe("/d/f1");
    expect(screen.getByText("Private · lee@example.com")).toBeDefined();
  });

  it("does not show a reader an inventory that is not theirs", () => {
    mount({
      isOwner: false,
      lineage: {
        forked: true,
        ancestors: [],
        hiddenAncestor: true,
        forks: { total: 1, hidden: 0, visible: [{ docId: "f1", title: "x", visibility: "public", forkedAt: null }] },
      },
    });
    expect(screen.queryByText(/Forked once/)).toBeNull();
  });

  it("asks an anonymous reader to sign in rather than showing nothing", () => {
    const { onRefresh } = mount({ signedIn: false, lineage: null });
    expect(screen.getByText(/Sign in to see what this document was forked from/)).toBeDefined();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
