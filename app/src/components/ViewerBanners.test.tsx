// SPDX-License-Identifier: Apache-2.0
// What the viewer says above a document: scripts blocked, a draft on screen (SPEC §6a, §6c).

import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ViewerBanners } from "./ViewerBanners";

describe("the trust banner", () => {
  test("does not promise content to a reader who is looking at nothing", () => {
    // A deck that generates its slides ships an empty container, so "parts of
    // it may look empty" describes a page that is entirely empty — which reads
    // as the app being broken rather than as a decision the reader can undo.
    const { rerender } = render(<ViewerBanners offerTrust onOpenTrust={() => {}} />);
    expect(screen.getByText(/parts of it may look empty/i)).toBeTruthy();

    rerender(<ViewerBanners offerTrust scriptsBuildContent onOpenTrust={() => {}} />);
    expect(screen.queryByText(/parts of it may look empty/i)).toBeNull();
    expect(screen.getByText(/nothing to show yet/i)).toBeTruthy();

    // Either way the way out is the same one.
    expect(screen.getByRole("button", { name: /review/i })).toBeTruthy();
  });
});

describe("the draft banner", () => {
  const DRAFT = { byEmail: "bo@example.com", byYou: false, when: "5m ago", version: "v1" };

  test("says the page is unpublished work, whose it is, and what everyone else sees", () => {
    render(<ViewerBanners draft={DRAFT} onEdit={() => {}} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("You're reading unpublished edits, last saved by bo@example.com 5m ago.");
    expect(text).toContain("Everyone else still sees v1");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  test("calls the reader's own save theirs", () => {
    render(<ViewerBanners draft={{ ...DRAFT, byYou: true, when: "" }} />);
    expect(screen.getByRole("status").textContent).toContain("last saved by you. Everyone");
  });

  test("is not there when the page is the published version", () => {
    const { container } = render(<ViewerBanners draft={null} />);
    expect(container.textContent).toBe("");
  });
});


test("an archive explains its read-only state and opens latest", () => {
  const latest = vi.fn();
  render(<ViewerBanners historical onOpenNewVersion={latest} />);
  expect(screen.getByRole("status").textContent).toContain("read-only");
  fireEvent.click(screen.getByRole("button", { name: "Open latest" }));
  expect(latest).toHaveBeenCalledOnce();
});
