# 0028 — What a crawler can read

**Status** Accepted · **Spec** §2, §17

## Context

A crawler asks `robots.txt` what it may read, and then reads HTML. Bikeshed had no `robots.txt`: Hosting's catch-all answered with the app's HTML. And its HTML held almost no words. `/` is a spinner until the app mounts, and `/d/<id>` loads the document into a frame with JavaScript.

Google and Apple render JavaScript. Vercel and MERJ reported in December 2024 that the other major AI crawlers do not, so those crawlers got a title and a description and nothing else. That is the only measurement we have, and it is not recent.

Nothing said whether public meant AI crawlers too. With no `robots.txt`, every crawler was already free to read a public document, and authors had only been told about search engines.

## Decision

1. **Every crawler may read everything public, AI training crawlers included.** Public has always meant anyone at all. The Share dialog and the terms say so, where an author decides.
2. **One group in `robots.txt`.** Under RFC 9309 a bot obeys only the group that names it, so a list of bots allowed by name would lift every other rule for exactly those bots. `tools/robots.test.mjs` reads the file the way the RFC does, and fails on a second group.
3. **A static file, not a function.** A crawler that gets a 5xx for `robots.txt` stops crawling the site, and a function can be down when Hosting is not. The build fills in the deployment's address.
4. **A public document's words are in its shell, at `/d/<id>`.** A link to `/content/` would have been smaller, but a citation would then land on a bare page at a version-pinned address. The words sit inside `#root`, where the app replaces them on mount, and the app's stylesheet hides them until then. Hidden by the stylesheet and not by an attribute, because a parser reading no CSS must see text. Only the current version of a document meant to be indexed gets them. `functions/` has no HTML parser, so what is written is the shell's own tags around escaped text, on the origin the session cookie lives on.
5. **At `/`, the landing page's own sentences.** A test holds the two together, so there is no second copy to keep up.

## Consequences

- An author who wants a document out of training sets has one way to ask: not making it public. There is no setting per document.
- `robots.txt` is a request. OpenAI's documentation says its rules may not apply to the user-triggered ChatGPT-User, and Perplexity's says Perplexity-User generally ignores them.
- Earlier versions stay readable at `/content/<id>/v<N>/`, because a path rule cannot tell a current version from an old one. `/d/<id>/<version>` is asked to be left alone and carries no words.
- A public document's shell grows by its text, at most the 256 KiB the shell already reads, for everyone who opens it. A browser never shows it.
- A scripted document with no static text keeps the site's text, and a document past 256 KiB is cut there.
- A crawler that runs no JavaScript reads the landing page's text on every other app route, `/terms` included.
- None of this can be seen locally, and whether answers cite Bikeshed cannot be measured from here at all.

## What would change this

- Authors asking to keep public documents out of training sets. Then a group for the training bots, repeating every rule and closing `/d/` and `/content/` to them, or a setting per document, and new words in the terms.
- A major engine treating text hidden this way as cloaking. Then `<noscript>`, which some text extractors drop, or showing it until the app mounts.
- Evidence that AI crawlers render JavaScript as a rule. Then the text comes out, and `/d/<id>` goes back to being a shell.
- Shell size showing up in how fast a document opens. Then a lower cap on the text.
