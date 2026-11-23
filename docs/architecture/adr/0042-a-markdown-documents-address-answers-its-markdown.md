# 0042 — A Markdown document's `.md` address answers its own Markdown

**Status** Accepted · **Spec** §2, §8, §19 · **Amends** [0030](0030-agents-read-a-markdown-reading.md) §3 and §7

## Context

ADR 0030 §2 made the reading the default for HTML and never for Markdown, because a Markdown document's source is already what an agent should read. `get_document` and `bikeshed get` kept to that. `/d/<id>.md` did not: it converted every version's HTML entry, so a Markdown document's address answered Markdown made back from the HTML compiled from Markdown.

On 2026-11-23 a speaker-notes document showed what that costs. Its reading opened with "It is not the source: never send it back as an update", above text that was the source with losses: `<mark>[what it did]</mark>` read as `[what it did]`, and a tight list came back loose. It said a stylesheet was left out, which was Bikeshed's own theme, not anything the author wrote, and it pointed at `as: "source"`, a call that makes no difference for Markdown.

It also left a gap. `update_document` refuses Markdown sent to an HTML document (ADR 0030 §5), but nothing refused that reading sent back to a Markdown document, which would have published its front matter and its losses as the next version.

## Decision

1. **A Markdown document's `.md` address answers its own Markdown.** For a version whose `format` is `markdown` and whose `sourceEntry` the version lists, `/d/<id>.md` answers that file byte for byte, under front matter, then a blank line. A Markdown version that names no source answers the reading, as before. HTML documents are unchanged.
2. **It still says what it is.** An agent with only an address cannot ask which kind it got, so the front matter keeps the reading's shape: `source` (a fixed sentence: the Markdown the document is written in, the front matter not part of it, to revise send only what follows it, and quote its words rather than its Markdown), `title`, `document`, `version` and `original`, the bare Markdown at its versioned address. It is written by `lib/markdown/source.ts`, apart from `reading.ts`, because a change to `reading.ts` would make every kept reading again (ADR 0033). ADR 0030 §3's "a source never carries front matter" still holds for `get_document` and `bikeshed get`, which answer a source bare.
3. **Bikeshed's own front matter is refused on the way back.** `update_document` refuses content for a Markdown document that opens with a `---` block holding the `source` line or a reading's `reading` line, exactly, and says to send only what follows it. An author's own front matter has neither line and publishes as text, as it always has.

## Consequences

- A source's relative links stay as written, so `chart.png` read at `/d/<id>.md` resolves against `/d/`. `original` and the `Link` header name the address they resolve against. A reading's addresses were absolute; a source's are the author's.
- Nothing is converted for a Markdown document's address any more. Readings already kept for Markdown versions are no longer read, and go when their version does.
- Text copied from the address with its front matter fails loudly instead of publishing the front matter. Text saved before the sentence is ever reworded would slip past the refusal, because the check matches the exact line.
- `publish_document` is not guarded: a new document overwrites nothing, and its author sees what was published.

## What would change this

- Agents routinely sending back the front matter despite the refusal. Then the address answers the source bare and carries what it is in headers alone.
- Authors relying on the address for pictures. Then relative destinations are made absolute, and the address answers a reading of the source rather than the source.
- The sentence needing to change. Then the refusal matches each sentence it ever had, not only the current one.
