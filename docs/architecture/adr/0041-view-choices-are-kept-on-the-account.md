# 0041 — View choices are kept on the account, and copied into the browser

**Status** Accepted · **Spec** §13 · **Amends** [0039](0039-the-viewer-has-an-explorer.md) (decision 4: the view choices are no longer kept per browser)

## Context

The workspace kept its sort, each kind of page's layout and Recent's filters in the browser's own storage, and only the explorer's open or closed on the account (ADR 0039). So a layout chosen on a laptop was not there on the desktop, and the privacy page had to promise those choices "never leave" the browser. Then the explorer's column became something a reader drags to a width, which is the same kind of choice, and people asked for all of them to follow the account the way open or closed already did.

Two things were already true. Every signed-in page listens to `users/{uid}` (`useAccountPreferences`), and the SDK shares one listener per document, so reading a choice from the record costs nothing more. And ADR 0039 had found that following the record live is wrong: one press flipped the explorer in every tab of the account at once.

## Decision

1. **The account keeps every view choice:** `users/{uid}.view` holds `sort`, `layout.{folders, recent, shared}`, `recentFilters` and `explorerWidth`. `explorerOpen` stays beside it, where ADR 0039 put it, so records and clients from before this keep working. The rules let the client create the field, as they let it write `explorerOpen`.
2. **The browser keeps a copy,** one entry per account (`bshd-view:<uid>`), so a page draws right on its first frame and two accounts on one browser never share one. It is a cache, never the record: the account's answer replaces it.
3. **A tab takes the account's choices once,** from that listener's first answer, then closes its own listener and keeps its choices until it is reloaded. A choice made before the account answered stands. A change is written to the copy and to the account at once, and a write the account refuses is put back in both.
4. **What a browser kept before this moves up once.** Where the account has no value, the browser's old one is written to it; where it has one, the account's wins. The old keys are then removed.
5. **Each value is checked where it is used,** so one an older or newer client wrote reads as the default rather than breaking a page.

## Consequences

- A layout, a sort, a filter or the explorer's width chosen on one device is there on the next page load on every other.
- A cold load with the explorer left open draws the column on its first frame from the copy. ADR 0039's column that appeared when the account record arrived now does so only on a browser with no copy yet.
- On a page load after another device changed a choice, the copy draws the old one until the account answers, a moment later, and then the page changes once.
- One more `users/{uid}` field the client may create. No new read: the record was already listened to.
- Signed out, nothing is kept anywhere, and a choice lasts as long as the page. Every page with view choices is signed-in only today.
- The privacy page says the choices are kept with the account and copied into this browser.

## What would change this

- Somebody who wants one layout on a phone and another on a desktop. Then a choice is kept per kind of device, still on the account.
- Choices that change many times a second, such as a drag written as it moves. Then they are written when they settle, as the explorer's width already is, or kept in the browser alone.
- A reader asking for open tabs to follow each other. Then the tab keeps its listener, and ADR 0039's flipping is weighed again.
