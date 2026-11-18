# 0030 — Agents read an HTML document as a Markdown reading made on read

**Status** Accepted, amended by [0032](0032-a-quote-may-carry-a-space-where-elements-touch.md) (§4: a space where elements touch, and a quote that carries it) and [0033](0033-a-reading-is-kept-once-made.md) (§1: a version's reading is kept once made) · **Spec** §2, §17, §19

## Context

An agent that read an HTML document through `get_document` got the entry file as authored: stylesheets, scripts, inline SVG and base64 images, cut at 200,000 characters with no way to read further over MCP. Most of that is noise to an agent that wants the words, and the publish skill told agents to inline every image as a `data:` URI, so an agent-published page with pictures filled the next agent's context with base64. Markdown documents already read well, because `get_document` returns their source.

Three questions came with any fix. Where the Markdown comes from: written by the author, or made from the HTML. How an agent knows it is not reading the document itself, so it never sends the Markdown back as the page. And how it gets the original, or the rest of a long one.

## Decision

1. **Made from the current HTML, each time it is read.** `lib/markdown/reading.ts` converts the version's entry when `get_document`, `bikeshed get` or `/d/<id>.md` asks. It is a view, like the crawler text of ADR 0028, not content: never stored and never hashed. ADR 0003 compiles Markdown once per version because the rendering IS the artifact a reader sees; this reading is nobody's artifact, so a change to its rules mints no version of anything. An author-written companion was rejected because it goes stale the moment anyone edits the HTML in the app, and nothing would notice.
2. **The default for HTML, never for Markdown.** `get_document` returns an HTML document as a reading unless asked `as: "source"`. A Markdown document returns its source either way: that is already what an agent should read, and what it revises.
3. **It says what it is, in the text and outside it.** Every reading opens with front matter naming it a reading made for agents, never to be sent back, quoted by its words, and giving the version, what was left out and the `original` address, with warnings when a script builds the page or the page was too long to read whole. Outside the text, the result says `as: "markdown"`, the text arrives under `markdown` rather than `source`, and `original` names how to get the source. A source never carries front matter.
4. **No HTML in it, and no escaping.** Anything Markdown cannot say becomes its text or a bracketed placeholder, and text is left unescaped, so the words in a reading are the words `add_comment` looks for.
5. **The original is always one step away.** `as: "source"`, `bikeshed get --source`, the `original` address, and on `/d/<id>.md` a `Link` header. `update_document` refuses content with no HTML tag for an HTML document, naming `as: "source"`.
6. **The rest of a long document by `offset`,** for readings and sources alike, every page from one version: `offset` without `version` is refused.
7. **Its own address for an agent that has only a link.** `/d/<id>.md`, not content negotiation on `/d/<id>`: a separate URL is a separate cache entry, where `Vary: Accept` would be a CDN behaviour nobody can prove locally, and a mistake would serve Markdown to people from cache. A document page names it in `<link rel="alternate" type="text/markdown">`.

## Consequences

- A page its script builds reads as nearly empty. The warning says so and the original is one call away; nothing runs a script to find out.
- `get_document`'s default and `bikeshed get`'s output changed. An agent that revised HTML from the default without `as: "source"` is refused rather than allowed to replace the page with its summary, and the refusal says what to do. What gets past the refusal, a reading of a page whose code samples contain tag text, is why the front matter says what it is first.
- A quote copied with Markdown marks in it, `**` or a list number, is refused as not found. Refused, never misplaced; the front matter and the guide say to quote words.
- The conversion runs on every read and every page. It is synchronous, so `/d/<id>.md` is its own function rather than a branch of the warm document-open path (ADR 0018), and a hostile page costs linear time because scripts, stylesheets, comments and `data:` values are stripped by a scanner before anything is parsed, and at most 2,000,000 characters are parsed.
- The reading is not a security boundary: no CSS is evaluated, so text a class hides still reaches an agent.
- `functions/` now parses HTML into a tree on a request path, through the DOM turndown already brought for saving Markdown documents. No dependency was added.

## What would change this

- Agents routinely asking for `as: "source"` before doing anything else. Then the default is wrong, and the reading becomes the option.
- Conversion showing up in latency: the largest guide taking over a second, or `get_document` timing out. Then a memo per version and read basis, or a reading stored beside the version like a thumbnail.
- Authors asking to say what an agent reads in their own words. Then a companion file in the bundle, with a rule for what happens to it when the HTML is edited.
- A CDN shown to honour `Vary: Accept` on this deployment. Then `/d/<id>` may answer `text/markdown` too, beside the `.md` address.
