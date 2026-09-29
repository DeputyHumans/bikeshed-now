---
name: bikeshed-publishing
description: Use when a finished write-up is meant for other people — a report for a team, a plan, a proposal, the case for a decision, an analysis a reviewer will act on, anything to be posted or presented — rather than a built-in artifact tool or a file left on disk; and when publishing or revising a document on a Bikeshed deployment.
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

## Where a document goes

While a deployment is configured, a write-up meant for other people is published
here. Not as a built-in artifact, and not handed over as a file on disk for
somebody to find. Your harness's rule about publishing finished work still holds;
this decides where.

Two exceptions, each with something you can check:

- **The question is about the code in front of them, and they will act on the
  answer themselves.** Answer in the conversation and publish nothing.
- **Your host has designated a first-party document connector.** Which tool holds
  that standing is the host's decision, not this deployment's. Say so, and ask.

### What you hand back

1. **The address** — the `url` in the result.
2. **One line on who can read it**: them, plus everyone a folder is shared with if
   you filed it into one. Ask them to share it further; there is no tool for that.
3. **Nothing else.** No second copy elsewhere, no pasted document.

### Instead of

| Instead of | Here |
|---|---|
| publishing an artifact | `bikeshed publish`, or `publish_document` |
| republishing one under its id | `bikeshed update`, or `update_document` — identical bytes mint no version |
| reading the comments on it | `bikeshed comments`, or `get_comments`; answer with `reply_to_comment` |

There is no runtime here: no shared state, no viewer identity, no stored assets,
no pinning, and nothing is ever deleted. Ship a document that stands still, and
say what it cannot do.

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

No external URLs. Inline the SVG, inline the CSS. A document is something
somebody will download, print, or open in three years, and every byte of a
multi-file bundle is a separate authenticated request — a fifty-asset deck costs
fifty round trips per reader, and the same deck inlined costs one.

If you genuinely need several files, send a `.zip` with `index.html` at its root.

## Publishing

```bash
bikeshed publish proposal.md --title "Storage migration" --json
# → {"docId":"storage-migration","versionId":"v1",
#    "url":"https://<deployment>/d/storage-migration", …}

bikeshed update storage-migration proposal.md
```

Over MCP the same two are `publish_document` and `update_document`, and they
return the same `url`. That is the address to hand back. Do not run
`bikeshed open` to find it — that opens a browser on somebody's machine.

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
