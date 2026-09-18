// SPDX-License-Identifier: Apache-2.0
// Presentation mode hides chrome that is NOT inside the viewer (SPEC §6d).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The bug this pins shipped, and hid in plain sight for the usual reason: the
 * selectors read correctly.
 *
 * `is-presenting` was applied to the viewer's own div. But the application
 * header is a SIBLING of <main>, not a descendant of the viewer, so
 * `.is-presenting .app-header` never matched and presenting left the header on
 * screen over the document. `.is-presenting .viewer` never matched either —
 * `.viewer` carried the class rather than descending from it.
 *
 * Both failures are about ANCESTRY, so the test builds the real ancestry:
 *
 *   body > .app-shell > .app-header          (sibling of main)
 *                     > .main > .viewer      (where the class used to go)
 *                             > .consent      (sibling of the route content)
 */

const VIEWER_CSS = readFileSync(
  join(__dirname, "..", "styles", "viewer.css"),
  "utf8",
);

function buildShell() {
  document.head.innerHTML = `<style>${VIEWER_CSS}</style>`;
  document.body.className = "";
  document.body.innerHTML = `
    <div class="app-shell">
      <header class="app-header">header</header>
      <main class="main">
        <div class="viewer"><div class="viewer-toolbar">toolbar</div></div>
        <aside class="consent">consent</aside>
      </main>
    </div>`;
  return {
    header: document.querySelector(".app-header")!,
    viewer: document.querySelector(".viewer")!,
    toolbar: document.querySelector(".viewer-toolbar")!,
    consent: document.querySelector(".consent")!,
  };
}

const hidden = (el: Element) => getComputedStyle(el).display === "none";

describe("presentation mode", () => {
  afterEach(() => {
    document.body.classList.remove("is-presenting");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("hides the header, the toolbar and the consent banner from <body>", () => {
    const { header, toolbar, consent } = buildShell();
    expect(hidden(header)).toBe(false);

    document.body.classList.add("is-presenting");

    // The header is the one that regressed: it is outside the viewer entirely.
    expect(hidden(header), "the application header must not sit over a presentation").toBe(true);
    expect(hidden(toolbar)).toBe(true);
    // And the consent banner, which would otherwise be the ONLY chrome left on
    // a full-window document.
    expect(hidden(consent), "an unanswered cookie banner must not sit over a presentation").toBe(true);
  });

  it("does NOT work when the class is on the viewer — the original bug", () => {
    const { header, viewer } = buildShell();
    viewer.classList.add("is-presenting");

    expect(
      hidden(header),
      "this is the bug: from .viewer the header is unreachable, so it stayed visible",
    ).toBe(false);
  });
});
