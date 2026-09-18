# 0007 — Edit with `execCommand`, not a schema editor

**Status** Accepted · **Spec** §7

## Context

Documents here are hand-authored HTML: decks with inline SVG and `<defs>`,
folded `<details>` trees, scroll observers, print stylesheets. People want to
fix a sentence without leaving the tool.

Every serious editor framework — ProseMirror, Slate, Lexical — parses a document
into its own schema, renders from that schema, and serializes back. Anything the
schema cannot express is dropped on import.

For this content, import **is** destruction. A deck round-tripped through a
document schema comes back as paragraphs.

## Decision

Edit the **actual authored DOM**. Set `contentEditable` on the document body
inside the same-origin iframe and drive formatting with `document.execCommand`.
Nothing is parsed, normalized or reconstructed; the bytes that come back are the
bytes that went in, plus the edit.

`serializeCleanHtml` is what makes that a guarantee rather than a hope: it
strips own-marked nodes, unwraps highlight `<mark>`s preserving children, drops
`[contenteditable]`, and drops any asset tag absent from the `authoredAssets`
baseline captured at load.

## Consequences

- **A round trip is an identity function on a clean document.** That is the
  single most valuable test in the app.
- `execCommand` is deprecated, inconsistent across engines, and emits `<font>`
  tags. Deprecated here means "no longer specified", not "removed" — every
  engine still implements it, and no replacement API exists. The `<font size=7>`
  output is rewritten explicitly, and that rewrite is unit-tested by
  constructing the nodes directly, because jsdom does not implement
  `execCommand` at all.
- Editing is **unconditionally script-free**. If the bundle's own JS ran while
  editing, generated DOM would be serialized as static markup while its
  generator stayed in place, and every later render would append another copy.
- Decoration must never reach the serialized output. Four independent legs hold
  that invariant: a tagged union that makes annotating-while-editing
  unrepresentable, effect-cleanup ordering, an unconditional strip plus a
  dev-only assertion, and the serializer itself as defence in depth.
- Peer presence renders as an **overlay**, never inline DOM, specifically so it
  cannot become a third contaminant class.

## What would change this

A standards-track replacement for `execCommand` with equivalent
edit-in-place semantics. The `contentEditable` Editing API work has been
dormant for years; if it lands, this becomes a mechanical swap that preserves
the decision rather than reversing it.

What would *not* change it: `execCommand` being deprecated. It was already
deprecated when this was chosen.
