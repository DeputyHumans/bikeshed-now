# 0021 — A document's script runs only with its reader's consent

**Status** Accepted · Amended in 0.32.0 (the lock names harmless types; trust is for the current version and never carries; only the browser's session lifts the sandbox) · **Spec** §2, §6c · **Amends** [0002](0002-two-scope-trust.md)

## Context

[0001](0001-same-origin-iframe.md) serves documents from the app's own origin, and [0002](0002-two-scope-trust.md) keeps their scripts off with the frame's `sandbox` attribute until somebody vouches. Two holes were found in that, on 2026-10-29:

- **The sandbox belonged to the frame, not to the bytes.** The same `/content/…` address opened any other way (pasted into a tab, a popup, an `<object>`) was a page on this origin with its scripts running, able to act as whoever opened it. Production served it with no CSP and no frame rule.
- **Global trust was any owner's.** "Trust it for everyone" was gated on owning the document, and its effect is that the owner's script runs as each reader. Any account could publish a page, trust it, share it and act as its readers. An absent flag also counted as trusted.

## Decision

- **Every response that could be a scripted document is locked.** `/content` and `/draft` responses carry `Content-Security-Policy: sandbox allow-same-origin`, whatever the document's trust, unless their type is on a short list of types a browser never renders as a scripted document (pictures, sound, video, fonts, CSS, JavaScript, JSON, text, PDF). Inside the app this is what the frame already does. *Amended in 0.32.0:* the rule first named the scriptable types (HTML, XHTML, SVG, XML), and WebKit renders `.atom` and `.rss` as XML too, so their XHTML-namespaced script ran unlocked in Safari and every browser on iOS. Naming the harmless types instead fails closed.
- **One way to run a document's script: the run variant.** A path segment, `/content/[~key/]!run/{docId}/{versionId}/…`, asks; the server unlocks it only when the document is globally trusted or the caller's own `docs/{docId}/trust/{uid}` exists. It is always `private, no-store` for a scriptable type and always `frame-ancestors 'self'`. The session cookie is `SameSite=Strict`, so a page elsewhere framing it has no caller.
- **Global trust is a superadmin's.** `POST /trust {trusted: true}` takes an owner who is listed in `BIKESHED_SUPERADMINS`, deployment configuration that is never committed. Restoring the sandbox stays any owner's. Only `trusted === true` is trust; absent fails closed. Personal trust is unchanged.
- **Drafts never run**, and no content path serves a service worker's script.
- `scripts/reconcile-trust.mjs` brings existing flags into line once.

## Consequences

- An owner who is not a superadmin can no longer make their document's scripts run for others; each reader decides for themselves, once.
- Documents that relied on an absent flag stop running their scripts until a superadmin who owns them, or each reader, says otherwise.
- A trusted document's page is never cached, so every open of it reaches the function. Its scripts and images are still cached as before.
- An editor no longer sees a draft's scripts run.
- When a document's own trust changes, a cached copy of its plain address can answer with the old header for up to five minutes, like any other content change. The run variant is never cached, so this cannot unlock anything.

## What would change this

Serving documents from an origin of their own would make the lock redundant, but would cost the same-origin frame that [0001](0001-same-origin-iframe.md) rests on. A verified publisher identity, as 0002 anticipates, could replace the superadmin list as the source of global trust.
