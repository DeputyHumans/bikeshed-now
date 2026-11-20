# 0039 — The viewer has an explorer, above the keyed viewer and remembered on the account

**Status** Accepted · **Spec** §4, §7, §13 · **Builds on** [0027](0027-a-reader-lists-their-own-reading.md) (Recent)

## Context

Moving from one document to another meant going back to the workspace and finding the next one there, even when somebody reads three documents side by side for a review. People asked for the list of their documents beside the one they are reading, closed unless they open it, and remembered once they do.

Two facts about the viewer shaped where it can go. `ViewerRoute` remounts `DocViewer` for every document, keyed by its id and version, behind a full-page loading state, so anything inside `DocViewer` is unmounted by the very switch it exists for. And the editor drops what it has not saved yet when it unmounts: only Stop editing saves first.

## Decision

1. **A toggle comes first in the document's toolbar,** before the mark and the title, at every width, for a signed-in account that is reading. On a phone it goes in the first row, so the second row's slot table is unchanged.
2. **The explorer lives in `ExplorerShell`, around the keyed viewer** (`viewer/explorer.tsx`). It holds whether it is open, its open folders and its filter, and the workspace's own queries (`listMyDocs`, `listMyFolders`), subscribed from the first time it opens until the reader leaves the viewer. The toolbar reads it through a context, and the viewer tells it when to step aside.
3. **It lists what the workspace query returns:** Recent and Shared with me, ten at a time, then every folder with its documents and the documents in no folder. A document filed in a folder its reader cannot open is listed at the top level rather than nowhere. A filter by title searches every document, client-side, because there is no search index. Your reads are fetched again for each document opened, as Recent's are on each visit.
4. **Open or closed is kept on the account,** `users/{uid}.explorerOpen`, so it follows the reader to every device. The view choices are kept per browser; this one is the exception, because it was asked for that way.
5. **Above 1100 px it is a 260 px column,** a grid track that exists only while it is open, with the viewer pinned to the last track. **At 1100 px and below it is a drawer** over the document and its bars, because a column there would leave too little width for the document once the comments panel and the slide rail are open. The drawer starts closed every time and never writes the account. It closes on Escape, on the scrim and on navigation, and it gives focus back to the toggle.
6. **It steps aside while the reader edits,** from the moment they ask to. Following one of its links would unmount the editor and lose the last second of typing, and the editor's bar has no control to bring it back, which is what the slide rail already does. Presenting and printing hide it with the rest of the chrome.

## Consequences

- Switching documents from the explorer keeps its place, its open folders and its filter, and costs no new subscription.
- One more `users/{uid}` field the client may write, added to the create allowlist. A write happens only when the toggle is pressed above 1100 px.
- On a cold load with the explorer remembered open, the column appears when the account record arrives, which can be after the document has started to draw.
- The workspace and the explorer each subscribe to the same two queries. The SDK shares one listener per identical query, so a reader who goes back to the workspace pays nothing extra.
- A document readable only through its `?k=` link is not listed, as it is not in the workspace.
- The editor has no explorer. Leaving an edit to switch documents is two steps: Stop editing, then the toggle.

## What would change this

- People keeping the drawer open while they read on tablets. Then the column comes down to the 860 px tier, and the comments panel narrows to make room.
- Workspaces too large to draw a folder's documents at once. Then the tree draws them a batch at a time, as Recent and Shared with me already do.
- A way to leave the editor that saves first, wherever the reader goes. Then the explorer can stay while editing.
