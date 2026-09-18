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
