# 0001 — Render documents in a same-origin iframe

**Status** Accepted · **Spec** §6, §6c

## Context

A reader has to be able to select a passage inside somebody else's HTML document
and attach a comment to it. That requires reaching into the document's DOM:
walking text nodes to describe a selection, and wrapping ranges to draw a
highlight.

The documents are arbitrary hand-authored HTML. They contain scripts. They are
uploaded by one person and read by another.

Three arrangements were available. A cross-origin iframe isolates the document
but makes its DOM unreachable, so annotation needs an injected `annotator.js`
and a `postMessage` protocol for every operation. Rendering into the app's own
DOM gives full access and hands the document the app's origin outright. A
same-origin iframe gives full DOM access and keeps the document in a separate
document context.

## Decision

Render into a **same-origin iframe**, and pay for the access with an explicit
trust model rather than with isolation.

A document that has not been vouched for renders with `sandbox="allow-same-origin"`
and **no** `allow-scripts`. Its JavaScript never runs, so it cannot read the
app origin's auth token or call the API. Annotation and editing keep working
because they are driven by the **parent**: `contentEditable`, `execCommand` and
DOM walks from outside, never scripts inside.

## Consequences

- No message protocol. `describeAnchorFromSelection` and `rangeFromAnchor`
  operate on a real `Document` and are ordinary, testable functions.
- `sandbox` and `allow-scripts` become a security boundary that has to be
  correct every time. `FrameMode` is a discriminated union whose editing variant
  has no `sandboxed` field, so "edit un-sandboxed" is unrepresentable rather
  than merely avoided.
- Trusting a document is a real grant with real consequences, which is why it
  has two scopes ([0002](0002-two-scope-trust.md)) and why the prompt appears
  only when the document actually contains a `<script>`.
- The app's CSS and the document's CSS share a stylesheet cascade only in the
  parent, never inside the frame. Chrome tokens never restyle content.

## What would change this

If browsers ever expose a cross-origin DOM access primitive with a capability
grant — or if documents stop being arbitrary HTML and become a constrained
format we control end to end — the isolation option gets cheap enough to
reconsider. Neither is true today.
