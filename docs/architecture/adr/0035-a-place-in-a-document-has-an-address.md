# 0035 — A place in a document has an address, after `#`

**Status** Accepted · **Spec** §6, §6d, §6e, §14, §19

## Context

People share documents by pasting links, and Bikeshed and agents hand links out: the comment email, an agent's reply. Every one of those links opened a document at its top. Nothing could point at a comment thread, a slide or a section, so "see slide 7" or "look at my reply" meant scrolling for it, and on a deck that runs its own script even selecting a thread did not show its slide (fixed alongside, SPEC §6).

Three things already held. The part of an address after `#` survives sign-in, because `next` carries it. Comment threads belong to the version they were made on (`docs/{id}/versions/{v}/annotations/{t}`), and `/d/<id>/<head>` reads as the current version. And a deck's script keeps its own `#…` inside the frame, in a format that differs between frameworks (`#5`, `#/4`, `#slide=5`), which the viewer never reads (SPEC §6d).

## Decision

1. **The place goes after `#` on Bikeshed's own address**, in three forms (`app/src/viewer/target.ts`):

   | Target | Form |
   |---|---|
   | A section or slide its author gave an id | `#<id>`, percent-encoded, found by `getElementById` |
   | A slide with no id | `#slide=<n>`, from 1, in reading order |
   | A comment thread | `#comment=<thread>`, on `/d/<id>/<the thread's version>` |

   `?k=` stays before it. The two reserved forms win over an author's id spelled the same way, and such an id is never linked by.
2. **A comment link always names its thread's version**, even when copied from an unpinned address, so it keeps working after the next version is published and is the same link the email and the agent tools give.
3. **A link lands once per arrival.** An arrival is a page load, or the router moving to an address the viewer did not write itself. A redraw, a peer or a frame reload never moves the reader. A thread waits for its version's threads to answer, and a slide or a section waits for the deck to measure the document. A thread that is not there, or that the reader cannot see, opens the document with a notice saying so: sign in, or no comments through a folder's link. A slide or a section that is not there opens the document as usual.
4. **On a paged deck the address follows the slide.** It is replaced, never pushed, with the router's own state kept, and only when the slide changes, so a link's own target stays in the address until the reader moves. A frame that loads again goes back to the slide in it. A document without pages keeps whatever address it was opened with.
5. **"Copy link" is offered where a link is made:** on every thread card, in the selection controls for any reader (beside Comment and Suggest edit where those apply), and as "Copy link to this slide" in a deck's menu. A copy builds on the reader's own address, its path and `?k=`, and adds no key or access it did not carry. The comment email links to the thread; `get_comments` gives every thread a `url`, and `add_comment`, `reply_to_comment` and `suggest_edit` give the thread's `threadUrl`.

## Alternatives

| | Where the place goes | Why not |
|---|---|---|
| B | In the query, `?slide=5&comment=…` | The server would see it, so a public deck's link preview could show the slide. But thread ids would reach server logs, the shell's cache and preview rules would need new fields, it would mix with `?k=`, and the preview would only help public and unlisted documents. It can still be added beside these links without breaking them. |
| C | In the path, `/d/<id>/<v>/slide/5` | New routes, new hosting rewrites and a new preview parser, a clash with `/d/<id>/<version>`, and nothing gained over `#`. |
| — | A link icon beside every heading | It would put a node into somebody else's document, which the decoration invariant forbids (CLAUDE.md, SPEC §7). |
| — | The address following the scroll in every document | It would rewrite the address on every scroll, and many documents have no ids to name. Only a deck, whose slide is the unit a reader means, follows. |

## Consequences

- A link opened by a reader who cannot see the thread lands on the document and tells them why. After sign-in they come back to the thread, because `next` keeps the `#`.
- **A link describes what its copier saw.** An editor reading a draft copies the draft's slides. A slide with an id links by the id, so only unnamed slides can move. Links to the published head shift as slides are added before an unnamed one; a pinned version never changes.
- A deck whose script ignores arrow keys cannot be driven from the address, exactly as it cannot be driven from the rail (SPEC §6d).
- A link preview shows the document, never the slide or the comment.
- `target.test.ts`, `useTarget.test.tsx`, `Sidebar.test.tsx` and `SelectionFab.link.test.tsx` pin the forms, the landing, the address following, the return after a reload and every Copy link. Each has a negative control.

## What would change this

- People asking for a slide in a link's preview. Then add a `?` form beside these links, read only by the shell.
- An owned deck format, or decks agreeing on one hash format. Then the viewer could hand the deck its own place instead of paging there.
- The address following slides proving noisy, for example in history tools or analytics. Then follow only on "Copy link".
