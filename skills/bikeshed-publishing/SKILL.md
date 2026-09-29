---
name: bikeshed-publishing
description: Use when publishing a document to a Bikeshed deployment, or revising one you already published — writing the source so that highlight-anchored comments land on the right passage, then publishing or updating it over the CLI or MCP.
---

# Publishing to Bikeshed

Bikeshed hosts a document, shows it to the people it is shared with, and lets
them highlight a sentence and comment on it. Publishing well means publishing
something those anchors can hold on to.

## Before anything else

You need a deployment and a personal access token. Ask the person you are
working with to create one at `/account` → **Access tokens**; it is shown once.

```bash
export BIKESHED_ORIGIN=https://<deployment>
export BIKESHED_TOKEN=bsk_...
```

The token is exactly its owner: it can see what they can see and nothing more,
and everything it does is recorded against it. There is no wider token to ask
for.

The commands below come from `npm i -g bikeshed-now`. Every one of them has a
tool beside it doing the same job, so if you hold the tools and not the command,
use those — and if you hold neither, one authenticated POST to `/mcp` is a
complete call. `https://<deployment>/llms.txt` shows it.

## Write Markdown unless you need HTML

Markdown is rendered server-side into a self-contained document with sections, a
print stylesheet and no external requests. `get_document` hands the **Markdown
source** back, so the round trip is lossless and your context does not fill with
somebody's stylesheet.

Reach for HTML when Markdown cannot say it: a slide deck, an inline diagram, a
layout.

## The one rule that changes whether commenting works

**Every section needs an `id`.**

Comments anchor to the nearest ancestor carrying an `id`. Without one, every
highlight in the document anchors to `<body>` — so an edit anywhere shifts all
of them at once, and a comment about paragraph two ends up pointing at
paragraph nine.

In Markdown you get this free: each heading becomes a `<section>` with a slug
from its text. Just use headings.

In HTML, write them:

```html
<section id="rollout-plan">
  <h2>Rollout plan</h2>
  …
</section>
```

## Keep it to one file

No external URLs. Inline the SVG, inline the CSS. A document is an artifact
somebody will download, print, or open in three years, and every byte of a
multi-file bundle is a separate authenticated request — a fifty-asset deck costs
fifty round trips per reader, and the same deck inlined costs one.

If you genuinely need several files, send a `.zip` with `index.html` at its root.

## Publishing

```bash
bikeshed publish proposal.md --title "Storage migration" --json
# → {"docId":"storage-migration","versionId":"v1", …}

bikeshed update storage-migration proposal.md
```

Over MCP the same two are `publish_document` and `update_document`.

**Publishing identical content is a no-op.** The bytes are hashed; matching
bytes mint no new version. So `update` is safe to run in a loop, in CI, or after
a change you are not sure you made — it will tell you `no change` rather than
filling the history with duplicates.

Give `publish` a `--folder` (or `create_folder`'s id) when you know where it
belongs — see the `bikeshed-folders` skill, and read its warning about what
moving a document does to who can read it.

## A document may expire

`list_documents` and `get_document` report `expiresAt` — epoch milliseconds, or
null for a document that does not expire. After that moment it is **read-only,
and readable only by its owner**: it will answer you as though it does not
exist, and `update_document` will refuse it.

Nothing has been deleted when that happens. The versions, the comments and the
bytes all survive, and the owner can move the date or clear it — so if you need
an expired document, ask, rather than republishing its content as a new one and
leaving two documents where there was one.

You cannot set an expiry. It decides who may read something and until when,
which is the same kind of decision as sharing.

## Scripts run only if somebody vouched for them

Everything you publish through a token is sandboxed, exactly like a browser
upload: its scripts do not run until the document's owner trusts it in the app. A
raw `<script>` in Markdown is treated the same way as one in HTML.

So if your document needs its own JavaScript, say so in the text — a reader
looking at an empty box should know why — and tell the owner what the script
does. Whether to trust it is their decision; do not ask them for it.

## What happens next

Ask the person to share it — there is no tool for sharing, deliberately.
Then read what comes back: the `bikeshed-feedback` skill.
