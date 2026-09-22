// SPDX-License-Identifier: Apache-2.0
// What the viewer says above a document whose scripts are blocked (SPEC §6c).

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
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
