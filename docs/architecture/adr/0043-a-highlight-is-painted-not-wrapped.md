# 0043 — A highlight is painted, not wrapped

**Status** Accepted · **Spec** §6, §6a, §22

## Context

A comment's passage was drawn by wrapping each run of its text in `<mark class="bshd-hl">`, and a suggestion's replacement hung off the last wrapper as generated content. That is a new element inside somebody else's layout, and on a deck built from flex and grid it rearranged the slide. In a flex or grid container a run of text is one anonymous item; a mark around part of it makes three, each placed and spaced on its own, so `justify-content: space-between` threw the words apart. The mark's 1 px border widened a tight line until it wrapped, and the document's own rules, `:first-child` or `mark { … }`, could match it. Every reader got every comment's marks, live, so commenting on the PPFA vendor deck broke its slides for everybody reading it.

The CSS Custom Highlight API paints a range the way a selection is painted, with no node. The suggestion review already marked its target with it (SPEC §22). Measured in Chromium 159, WebKit 27.2 and Firefox 159 through Playwright: all three paint a highlight's background, underline and line-through in HTML text, and find text under a point. Chromium and Firefox paint it inside SVG `<text>`; WebKit does not.

## Decision

1. **HTML text is painted.** A thread's passage is registered as ranges in the frame window's `CSS.highlights`, one highlight per thread named for it (`bshd-hl-c-<id>`, `bshd-hl-s-<id>` for a suggestion) so devtools and a test can tell which thread a range is, in its author's colour, the selected thread above them, with the rules in an adopted stylesheet where the browser has one, else in our own `<style>` (`annotation/paint.ts`). Nothing enters the document's body: no node, no attribute, no box.
2. **The look is what a highlight can paint:** a tint and a 2 px underline in the author's colour; the line struck through for a suggestion; the selected thread's tint heavier; a stronger tint on a coarse pointer; nothing in print. A highlight cannot draw the border and halo the mark survived a dark slide with, so the underline carries the colour there.
3. **A click finds its passage by where it lands** (`paintedAt`): inside one of the passage's line boxes, on text the reader can see, not under something else of the page, the smallest passage winning where two overlap. The hand shows over one by toggling a rule in the stylesheet, so hovering writes nothing to the document.
4. **A suggestion's replacement is a label of ours,** in an own-marked layer beside the passage, just above the end of its last line, its words as generated content from an attribute so they are in no text node (`annotation/labels.ts`). It is drawn only where its passage can be seen.
5. **SVG text keeps a `<tspan>`,** because WebKit paints no highlight there. SVG text has no flex or grid to break, and a `<tspan>` with no position of its own moves no glyph. The strip unwraps it as before, and still unwraps a `<mark>` should one reach it.

## Consequences

- Commenting never changes a document's layout in HTML, on any slide, for any reader.
- Text that is not shown is not painted, so a deck that stacks its slides shows a slide's highlights on that slide alone, at no cost.
- Painted ranges are live, so they follow the text as it lays out again without a redraw.
- Where a frame delivers no events to the viewer (WebKit, a document whose scripts are blocked), tapping a highlight in HTML text cannot open its thread: there is no element to take focus. The comments panel still opens it. Pavel accepted this.
- A browser without the API (before Chrome 105, Safari 17.2, Firefox 140) shows no highlights in HTML text; the threads are still in the panel.
- The serializer and the dev-only assertion lose a contamination class: a painted highlight is never in the bytes. The assertion now also fails on a painted highlight left behind in edit mode, and on the label layer, which is an injected node like the peer overlay.

## What would change this

- WebKit painting highlights inside SVG `<text>`. Then the `<tspan>` goes too, and so does the last wrapper.
- A treatment a highlight cannot paint becoming necessary, such as a border a reader on a dark slide cannot do without. Then it is drawn in an overlay, as a peer's selection is, never as a wrapper.
- A browser this product must support without the API. Then that browser gets an overlay, not marks.
