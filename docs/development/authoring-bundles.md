# Authoring a document

What makes an HTML or Markdown document work well here — and the two properties
that silently degrade if you skip them.

The shipped samples are the worked examples: `content/bikeshed-tour/` (scripted
HTML), `content/design-review-shortener/` (script-free HTML) and
`content/markdown-reference/` (Markdown). Copy one and edit it.

---

## The two rules that actually matter

### 1. Put an `id` on every section

Comment anchors scope to the **nearest `id`-bearing ancestor** of the selected
text. That scope is what makes a highlight survive an edit: a quote anchored
inside `<section id="risks">` is re-found by searching that section, so adding
three paragraphs to a different section cannot move it.

Without ids, every anchor in the document scopes to `<body>`. The quote is then
searched across the whole document, and the position fallback is an offset into
the whole document — so an edit anywhere can shift or mis-resolve a highlight
somewhere else entirely.

```html
<section id="risks">
  <h2>Risks</h2>
  <p>…</p>
</section>
```

This is the single highest-value thing you can do to a document, and it costs
one attribute per section. Markdown gets it for free: the renderer wraps each
heading and its content in `<section id="<slug>">` using GitHub-style slugs.

### 2. Keep it self-contained

**No external URLs.** No CDN fonts, no hosted stylesheets, no remote images, no
analytics snippet. Three reasons, in order of how much they will cost you:

- **Privacy.** People mark these documents confidential. Every external request
  tells a third party the reader's IP, user agent and referring URL.
- **It has to render offline** — in an air-gapped deployment, and inside the
  print iframe used for PDF export.
- **An untrusted document renders with scripts disabled**, so anything that
  depends on fetching at runtime will simply not be there.

Inline your CSS. Inline your SVG. Base64 a raster image only if you truly need
one — and prefer SVG, which scales, prints and recolours.

---

## Cost: prefer one file

**Every byte of every document is proxied through a Cloud Function.** A
fifty-asset deck is fifty function invocations per reader; the same deck with
its CSS and SVG inlined is one.

Multi-file bundles are fully supported — upload a `.zip` and reference
`styles.css` or `diagram.svg` normally — but single-file is the default worth
reaching for. The samples are all single-file at 5–31 KB.

---

## HTML

### Structure

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>What this document is</title>
  <style>/* everything, inline */</style>
</head>
<body>
  <section id="summary">…</section>
  <section id="detail">…</section>
</body>
</html>
```

`<title>` becomes the fallback document title when a manifest does not give one.
It is also the title a shared link unfurls with, and beside it a
`<meta name="description">` and a `<meta property="og:image">` — an absolute
URL, or a path to a raster image bundled with the document — shape the link
preview when the link is shared. Declare a description: the fallback is an
excerpt of the first words after the `<h1>`, and it reads only the first
256 KiB of the file, so a bundle that inlines large assets above its text has
no fallback at all.

### Scripts

Scripts are allowed and work — after somebody vouches for the document.

An uploaded or forked document renders with `sandbox="allow-same-origin"`
and no `allow-scripts`, so its JavaScript does not run. A **trust prompt appears
only if the document actually contains a `<script>`**, which is why
`design-review-shortener` never prompts and `bikeshed-tour` does. A document
published through the operator CLI is trusted on arrival.

Two consequences for authoring:

- **Write markup that degrades.** `design-review-shortener` navigates with a
  static `<nav>` of `<a href="#s-3">` links, which need no JavaScript at all. A
  scripted dot-nav that generates its own buttons is inert until trusted.
- **Generated DOM is marked, not serialized.** If your script fills
  `<nav id="dot-nav"></nav>`, leave it empty in the markup. The editor marks
  such containers by attribute so their generated children are stripped on save
  — otherwise every edit would bake one more copy of the generated content into
  the file while the generator stayed in place.

### Details, print and export

- **`<details>` works, including nested.** Rehydration opens every collapsed
  ancestor of a highlight, not just the nearest, so a comment on text inside a
  folded section still scrolls to it.
- **Add `@media print`.** PDF export renders the document in a print iframe. A
  document with no print styles exports as a screen layout on paper.
- **Inline `<svg>` exports individually.** Each diagram can be saved as SVG, and
  each section as PNG. A raster image can do neither.

---

## Markdown

Upload `.md` or `.markdown`, or a zip whose entry is `index.md`. It is compiled
to an HTML bundle **on the server, once per version**, and both files are stored
([ADR 0003](../architecture/adr/0003-server-side-markdown.md)):

```
index.md      your source, canonical, downloadable
index.html    the compiled entry, what the viewer loads
```

CommonMark plus GFM: tables, task lists, strikethrough, fenced code with a
language, autolinks. Headings become `<section id="<slug>">` with deduped
GitHub-style slugs, so anchoring works without you doing anything.

**Editing is WYSIWYG with a restricted palette.** Controls Markdown cannot
express — font family, font size, text colour, highlight colour, alignment — are
**disabled with a tooltip explaining why**, not hidden. A control that appears
to work and then loses your formatting is worse than one that is visibly
unavailable.

**Three things to expect.** The first save normalizes your Markdown: `*` bullets
become `-`, setext headings become ATX, and hard-wrapped prose is joined into one
line per paragraph. After that first pass it is idempotent, which is a tested
contract, not a hope.

`~~strikethrough~~` round-trips as `~strikethrough~` — GFM accepts both, so it
renders identically and is stable thereafter. It is the one lossy
normalization, recorded here rather than discovered.

**HTML comments are preserved**, including the SPDX header the samples open
with. They were not always: turndown never visits comment nodes, so an early
version deleted every comment on the first save. Lossy *and* idempotent is the
worst shape a normalization can have — it destroys something once and then looks
stable forever — so this one is tested in six shapes, including an empty comment
and one that lives beside an authored `<div>`.

Raw HTML in Markdown passes straight through and obeys the same trust model as
any other document. A `<script>` in your Markdown makes it a scripted document.

---

## Publishing from the repository

Put the bundle in `content/<docId>/bundle/` with a manifest beside it:

```json
{
  "title": "A tour of Bikeshed",
  "slug": "bikeshed-tour",
  "entry": "index.html",
  "owner": "owner@example.com",
  "viewers": ["reviewer@example.com", "team:design"],
  "label": "v1"
}
```

```bash
node scripts/publish.mjs --doc bikeshed-tour --account you@example.com --dry-run
node scripts/publish.mjs --doc bikeshed-tour --account you@example.com
```

**Republishing identical bytes is a no-op.** The bundle is hashed — files sorted
by path, each framed with its length — and an identical hash prints
`already published as vN` and writes nothing. Safe in a loop, in CI, and in
front of an agent that cannot remember what it already did.

Flags override the manifest, so one bundle can be published under several titles
or grants without editing the file.

---

## Limits and rejections

| | |
|---|---|
| Maximum bundle | 25 MB uncompressed |
| Accepted | `.html`, `.htm`, `.md`, `.markdown`, `.zip` |
| Entry resolution | root `index.html`, then root `index.md`, then a lone `.html`, then a nested `index.html`, then a lone `.md`, then a nested `index.md` |
| Rejected | absolute paths, `..`, backslashes, NUL in any archive path |
| Rejected | an archive entry declaring 0 bytes while carrying more than 64 compressed |
| Ignored | `__MACOSX/`, `.DS_Store`, `Thumbs.db` |
| Stripped | a single shared top-level directory, so `deck/index.html` works |

A zip is sniffed by magic bytes rather than trusted by extension, and the size
cap is applied to the **declared** uncompressed size from the central directory
before anything is decompressed.

HTML wins over Markdown when a bundle ships both at the root. A bundle with an
`index.html` beside an `index.md` has already been compiled, so re-rendering the
Markdown would silently discard whatever the author did to the HTML.

---

## A checklist before you publish

- [ ] Every section has an `id`
- [ ] No `http://` or `https://` in any `src` or `href` to an asset
- [ ] Styles are inline, images are SVG
- [ ] There is an `@media print` block
- [ ] Script-generated containers are empty in the markup
- [ ] `--dry-run` printed the file count, byte count and hash you expected
