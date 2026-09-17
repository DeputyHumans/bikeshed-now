# Testing notes

## What jsdom does not do, and what to do instead

These cost a day each if you find them by debugging. They are listed here so
nobody has to.

| Missing | Consequence | What to do instead |
|---|---|---|
| `document.execCommand` | Every `EditToolbar` command is a no-op | Test the pure half. `rewriteLegacyFontTags` is exported precisely so the `<font size>` normalization can be asserted by constructing the nodes directly |
| `getBoundingClientRect()` returns zeros | Anything positioned from a rect renders at 0,0 | The FAB's placement is extracted into `fabPosition()`, a pure function over numbers. Test that |
| `Range.getClientRects()` returns nothing | The peer overlay draws no rectangles | Assert the overlay's STRUCTURE — that it exists, is marked as ours, and is stripped — not its geometry |
| No canvas | `html-to-image` cannot rasterize | PNG export is covered by the marking unit tests plus the emulator walkthrough, not by a unit test |
| No real layout | `scrollIntoView`, `IntersectionObserver` are stubs | Assert the call happened, not what it looked like |

## What is actually worth testing here

Coverage is enforced on `annotation/`, `export/`, `workspace/`, `brand/` and
`stats.ts` — the modules where a regression is silent. A bug in a dialog is
visible the first time somebody opens it; a bug in `serializeCleanHtml`
publishes corrupted bytes and nobody notices until the document is wrong.

`viewer/invariant.test.tsx` is the one to read first. It drives the
reading-to-editing transition on the hard path — where the iframe does NOT
remount — and asserts that nothing this app injected survives into the bytes
that would be published.
