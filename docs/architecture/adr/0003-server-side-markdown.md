# 0003 — Compile Markdown on the server, once per version

**Status** Accepted · **Spec** §11

## Context

Markdown had to become a first-class source format: uploadable, WYSIWYG-editable,
versioned, annotated, exported and counted exactly like a hand-authored HTML
bundle. The obvious implementation is a client-side renderer, which is how most
Markdown editors work.

It would have cost the app two runtime dependencies against a budget of seven,
and — worse — it would have introduced a second place where a document's bytes
are decided. Every existing invariant assumes the bundle in the bucket *is* the
document.

## Decision

**Markdown compiles to an HTML bundle at write time, on the server, exactly once
per version. The client never renders Markdown.**

```
docs/{docId}/{vN}/index.md      authored source, canonical
docs/{docId}/{vN}/index.html    compiled entry, what the iframe loads
```

`entry` still points at the HTML, so `contentProxy`, `downloadBundle`, export
and every ACL path are **unchanged code**. `format`, `sourceEntry` and
`rendererVersion` are recorded on the version.

Editing stays `execCommand` on the rendered DOM ([0007](0007-execcommand-over-schema-editor.md));
saving converts DOM → Markdown with `turndown`, also server-side. One
implementation, in one runtime.

## Consequences

- Both files sit inside the hashed bundle, so content-hash idempotency holds
  unchanged: republishing identical Markdown is still a no-op.
- A renderer upgrade changes the rendered bytes and therefore the hash, so it
  mints a new version. That is correct — the rendering *is* part of the artifact
  — and `rendererVersion` makes it auditable. The renderer is pinned to an exact
  version and a bump is a documented migration.
- The first save normalizes (`*` bullets → `-`, setext → ATX). After that it
  must be **idempotent**, which is the contract the round-trip tests enforce and
  the reason editing a Markdown document cannot degrade it one save at a time.
- The editor palette is restricted to what Markdown can express. Unsupported
  controls are **disabled with a tooltip**, not hidden — a control that appears
  to work and then loses your formatting is worse than one visibly unavailable.
- Raw HTML in Markdown flows through the existing trust model rather than a new
  sanitizer policy. One concept, not two.

## What would change this

If a live-preview-while-typing experience is ever required, the client would
need a renderer and this decision would have to be revisited — with the explicit
understanding that the *stored* bytes must still be produced by the server, or
the hash stops meaning anything.
