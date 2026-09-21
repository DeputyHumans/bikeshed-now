// SPDX-License-Identifier: Apache-2.0
// The tab follows the document even where the server shell cannot (SPEC §17).

import { useEffect } from "react";

/**
 * The server injects `<title>` into `/d/**` (`functions/src/lib/shell.ts`),
 * but only for documents readable without an account, and only on the FIRST
 * load: SPA navigation between documents never re-requests the shell, and a
 * member of a private document gets the generic one regardless. The tab has
 * to follow the document from inside the app, for every reader, on every
 * navigation.
 *
 * Restoring "Bikeshed" on cleanup matters for the SAME reason the server
 * fallback exists: leaving the previous document's title behind would carry
 * it into whatever screen comes next — the workspace, another document mid
 * load — same shape of leak the server-side default closes on the way in.
 *
 * `title` is `""` for the whole `useDocument()` loading window and for every
 * not-found/denied document (it never resolves) — falling back to "Bikeshed"
 * for an empty title, rather than writing it verbatim, is what keeps the tab
 * from going blank on every open and staying blank forever on one the reader
 * cannot see. The same fallback also clears a *previous* document's title
 * left over from before a same-component navigation, instead of leaving it
 * showing through the next one's loading window.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title || "Bikeshed";
    return () => {
      document.title = "Bikeshed";
    };
  }, [title]);
}
