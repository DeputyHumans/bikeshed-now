// SPDX-License-Identifier: Apache-2.0
// What the viewer says about an expiry, and to whom (SPEC §17).

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ViewerBanners } from "./ViewerBanners";

describe("the expiry banner", () => {
  test("says nothing when there is nothing to say", () => {
    const { container } = render(<ViewerBanners expiry={null} />);
    expect(container.textContent).toBe("");
  });

  test("an upcoming expiry is stated plainly, with no alarm", () => {
    render(<ViewerBanners expiry={{ label: "Expires in 3 days", expired: false, isOwner: true }} />);
    expect(screen.getByText("Expires in 3 days")).toBeTruthy();
  });

  test("never claims anything was deleted", () => {
    // "Expired" reads as "deleted" to almost everybody, and this product does
    // not delete documents at all — the versions, the comments and the bytes
    // all survive. The banner has to say so or it teaches the wrong model.
    for (const isOwner of [true, false]) {
      const { container, unmount } = render(
        <ViewerBanners expiry={{ label: "Expired", expired: true, isOwner }} />,
      );
      expect(container.textContent).toMatch(/expired/i);
      // The one permitted use of the word is the denial, so it is removed
      // before checking that nothing else claims a removal.
      const rest = (container.textContent ?? "").replace("Nothing has been deleted", "");
      expect(rest).not.toMatch(/deleted|removed|gone/i);
      unmount();
    }
  });

  test("tells a reviewer who can fix it, and does not tell them they can", () => {
    // The owner is the only person who can still open an expired document, so
    // "only you can open it" is flatly untrue for anybody else.
    render(<ViewerBanners expiry={{ label: "Expired", expired: true, isOwner: false }} />);
    expect(screen.getByRole("status").textContent).toMatch(/its owner can restore it/i);
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  test("gives the owner the way to undo it, attached to the message", () => {
    render(<ViewerBanners expiry={{ label: "Expired", expired: true, isOwner: true }} />);
    expect(screen.getByRole("status").textContent).toMatch(/only you can open it/i);
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });
});

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
