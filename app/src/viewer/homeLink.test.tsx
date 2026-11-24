// SPDX-License-Identifier: Apache-2.0
// Where the wordmark goes, across the pages a reader moves through in one tab (SPEC §13).

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Link } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HomeLinkProvider, useClaimHome, useHomeTo } from "./homeLink";

function Wordmark() {
  return (
    <Link to={useHomeTo()} aria-label="Bikeshed home">
      bikeshed
    </Link>
  );
}

function Viewer({ to }: { to: string }) {
  useClaimHome(to);
  return null;
}

/** The shell as App draws it: the header's link, then whatever pages are mounted. */
function Shell({ viewers }: { viewers: { key: string; to: string }[] }) {
  return (
    <MemoryRouter>
      <HomeLinkProvider>
        <Wordmark />
        {viewers.map((v) => (
          <Viewer key={v.key} to={v.to} />
        ))}
      </HomeLinkProvider>
    </MemoryRouter>
  );
}

const home = () => screen.getByRole("link", { name: "Bikeshed home" }).getAttribute("href");

describe("the wordmark's destination", () => {
  it("is Recent with no claim at all, which is every page but a document", () => {
    render(<Shell viewers={[]} />);
    expect(home()).toBe("/");
  });

  it("follows one tab through workspace → document → its folder → workspace, as a reader does it", () => {
    const { rerender } = render(<Shell viewers={[]} />);
    expect(home()).toBe("/");

    // The document opens before its record and the folders have arrived.
    rerender(<Shell viewers={[{ key: "doc-a", to: "/" }]} />);
    expect(home()).toBe("/");
    rerender(<Shell viewers={[{ key: "doc-a", to: "/folder/f1" }]} />);
    expect(home()).toBe("/folder/f1");

    // Another document from the explorer: the viewer is remounted under a new key.
    rerender(<Shell viewers={[{ key: "doc-b", to: "/everything" }]} />);
    expect(home()).toBe("/everything");

    // The wordmark is followed: the viewer goes, and on the folder page it leads to Recent again.
    rerender(<Shell viewers={[]} />);
    expect(home()).toBe("/");
  });

  it("keeps the newer page's claim when an older one lets go after it", () => {
    const { rerender } = render(<Shell viewers={[{ key: "doc-a", to: "/folder/f1" }]} />);
    rerender(<Shell viewers={[{ key: "doc-a", to: "/folder/f1" }, { key: "doc-b", to: "/folder/f2" }]} />);
    expect(home()).toBe("/folder/f2");
    rerender(<Shell viewers={[{ key: "doc-b", to: "/folder/f2" }]} />);
    expect(home()).toBe("/folder/f2");
    rerender(<Shell viewers={[]} />);
    expect(home()).toBe("/");
  });
});
