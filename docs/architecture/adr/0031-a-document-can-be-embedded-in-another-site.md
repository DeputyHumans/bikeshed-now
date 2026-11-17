# 0031 — A document can be embedded in another site

**Status** Accepted · **Spec** §2, §4, §15, §17, §23

## Context

People want to put a Bikeshed document on a page of their own: a team wiki, a product site, a status page. It already half worked, by accident. A document's bytes at `/content/<id>/<version>/` carry no frame headers, because the app's own same-origin frame needs them not to ([0001](0001-same-origin-iframe.md)). So any site could frame them. What it got was pinned to one version, counted nothing, and broke every link: a link replaced the embed, and `target="_blank"` did nothing in a sandboxed frame.

The obvious alternative, letting another site frame `/d/<id>`, is the one thing the frame headers exist to prevent. The app shell can reach `/signup` and the consent page by client-side navigation, so every app-shell path refuses to be framed (SPEC §23).

## Decision

1. **A separate page, `/embed/<id>[/<version>][?k=]`, is the supported way.** `docShell` serves it from the existing warm function. It is not the app: no router, no sign-in, no Firestore, nothing a framing page could make somebody click that would change anything. It frames the document's bytes exactly as the viewer does, with the reading sandbox, and opens a link that leaves the document in a new tab.
2. **What it may show is decided anonymously, by `decideShell`.** Public documents, unlisted ones with their key, and what a folder's reach opens. The session cookie is `SameSite=Strict`, so a page on another site presents no caller anyway. Every other answer, absent and private alike, is one neutral page, so an embed cannot be used to confirm a slug exists.
3. **It shows the current version** unless the address pins one, so an embed follows the document as it is revised, within the five-minute cache window.
4. **An embedded read is a read.** The page runs the same reading clock as the viewer, so it counts into `stats.views` and `stats.totalMs` like any other session, and `stats.embeds` says how many of those came through an embed. A session starts only once the embed has been on screen for two seconds, inside the host page's viewport as well as a visible tab, so an embed nobody scrolled to is not a view.
5. **Analytics asks in the embed itself.** A browser keeps an embedded page's storage apart for each site that frames it, so a visitor's answer on Bikeshed is not their answer there. The embed shows its own one-line consent bar, and the measurement script is fetched only after Allow, as everywhere else (SPEC §15). It sends the route pattern and enums, never a document id.
6. **The raw `/content` address stays frameable and stays uncounted.** Taking it away would break embeds that already exist, for nothing a supported address does not already offer.

## Consequences

- A host page decides how the document is cropped, sized and surrounded, and can lay anything over it. Bikeshed cannot prevent that, and an embed never claims more than "this is the document".
- A host page can inflate a public document's view count by loading it many times. So can anybody with a browser and the public link; the cost defence is still CDN caching, and App Check is still the named hook.
- Google Analytics will undercount embedded reads, because most people ignore a consent bar inside a widget. Bikeshed's own view statistics count every read.
- An embedded deck is one long page: slide navigation is the viewer's, and the viewer cannot be framed. A document's own script never runs in an embed, trusted or not, because the run variant may only be framed by this origin.
- Comments are not shown. The embed links to the document, where they are.
- Whether Hosting applies the frame headers to `/embed/**` as intended can only be seen on a real deployment: its glob handling differs from the emulator's.

## What would change this

- Authors asking to stop one document being embedded. Then a setting per document, which the embed page checks.
- A host page needing the embed to size itself to the document. Then a height message from the embed page to its parent, with the parent's origin left unchecked because it carries nothing but a number.
- Evidence of framing pages misleading readers about what a document says, at a scale that matters. Then the embed shows the document's title and address in its own chrome, outside the frame.
- Browsers ending framing for cross-site pages without user consent. Then the embed becomes a link card.
