<!-- SPDX-License-Identifier: Apache-2.0 -->

# Markdown in Bikeshed

This document is three things at once: a sample you can publish, the
documentation for Markdown support, and the fixture the round-trip tests run
against. That last one matters — it means this file cannot drift away from what
the renderer actually does without a test failing.

Everything below is here because it exercises something specific.

## What happens when you publish this

Markdown compiles to an HTML document **once, on the server, at the moment you
publish**. The result is stored beside the source, both inside the same hashed
bundle, and the compiled HTML is what your browser loads.

Three consequences follow from that, and they are the whole design:

- The client never renders Markdown, so there is no second implementation to
  drift from the first.
- Republishing identical Markdown is a no-op, because the bundle hashes the
  same.
- Upgrading the renderer changes the output and therefore mints a new version.
  That is correct: the rendering is part of the artifact, and the version
  records which renderer produced it.

## Headings become sections

Every heading and the content beneath it is wrapped in a `<section>` with an id
derived from the heading text.

This is not cosmetic. Comments anchor to the nearest ancestor carrying an `id`,
so without it every highlight in the document would anchor to `<body>` — and an
edit anywhere would shift all of them at once. With sections, an edit here
cannot disturb a comment three headings down.

### Nesting works

A level-three heading opens a section inside the level-two one, and closes when
the next heading at that level or above arrives.

## Emphasis and inline marks

*Emphasis*, **strong emphasis**, ~~strikethrough~~, `inline code`, and
`code containing a backtick`.

All of these survive the round trip. Strikethrough is worth naming: a
single-tilde form would re-parse as literal text, so the serializer always
emits two.

## Lists

- Unordered, with a hyphen
- A second item
  - Nested one level
  - And another
- Back out again

1. Ordered lists number themselves
2. So renumbering is not your problem
3. Even after an edit

Task lists render as inert checkboxes — a document is not a form:

- [x] This one is done
- [ ] This one is not

## Tables

| Column | Means | Notes |
| --- | --- | --- |
| Left | the first thing | short |
| Middle | the second thing | also short |
| Right | the third thing | longer, to show wrapping |

## Code

Fenced, with a language:

```js
const contentHash = hash(files);
if (existing.has(contentHash)) return { deduped: true };
```

Fenced, without one:

```
$ bikeshed publish notes.md
published notes v1
```

An indented block normalizes to a fenced one on the first save, which is the
one visible change this document goes through:

    indented code becomes fenced

## Quotes

> A quotation.
>
> > And one nested inside it, which is rarer than you would think.

## Links

An [inline link](https://example.com) and a [reference link][ref], which
becomes inline on the first save.

[ref]: https://example.org

## Raw HTML

Markdown may contain raw HTML, and it passes straight through. It is governed
by the same trust model as a hand-authored document rather than by a separate
sanitizer policy — one concept, not two.

That includes `<script>`. The block below fills the empty `<div>` beside it, so
this document is a *scripted* document: uploaded through the browser it renders
sandboxed and offers the trust prompt, and until somebody vouches for it the
line below stays empty. Published through the CLI it is trusted on arrival and
the line is filled. Nothing about that is specific to Markdown — it is the same
model a hand-authored document obeys.

<div id="generated"></div>

<script>
  document.getElementById("generated").textContent =
    "This line was written by the document's own script.";
</script>

<details>
<summary>Something folded</summary>

Content inside a `<details>` element. When somebody comments on text in here and
the document is reopened, this opens itself so the highlight is visible.

</details>

## What normalizes on the first save

Editing this document and saving it once will change a few things, all of them
harmless and all of them visible at the version boundary:

- A paragraph wrapped across several lines becomes one line
- `*` bullets become `-`
- Setext headings become `#` headings
- Indented code becomes fenced code
- Reference links become inline links
- Indentation regularizes
- Markdown written inside a raw HTML block is kept as the HTML it renders to

After that first pass, saving again changes **nothing**. That idempotence is the
contract, and it is what keeps editing a document from degrading it one save at
a time.

## What Markdown cannot express

The editor's font, size, colour and alignment controls are disabled for a
Markdown document, with a tooltip saying why. They are disabled rather than
hidden on purpose: a control that appears to work and then silently loses your
formatting is worse than one that is visibly unavailable, and one that
disappears leaves you wondering what you did wrong.

If you need those, publish the document as HTML instead.

## Headings

A second heading with the same text as an earlier one, to demonstrate that
slugs deduplicate deterministically — and that editing an unrelated heading does
not renumber this one.
