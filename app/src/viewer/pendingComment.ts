// SPDX-License-Identifier: Apache-2.0
// A comment started before signing in, carried across the sign-in page (SPEC §3).

import type { Anchor } from "../types";

/**
 * "Sign in to comment. Your selection is kept." Signing in leaves this page, which
 * takes the frame and its selection with it, so what is kept has to be the anchor,
 * measured while the selection is still there.
 *
 * In this tab's session storage, never the URL: an anchor quotes the document, and
 * a URL reaches logs and the Referer (SPEC §15). In memory as well, because storage
 * can refuse, and a password sign-in never reloads the page.
 *
 * It goes stale. Somebody who gave up on signing in and came back later did not ask
 * for a thread to appear on what they highlighted an hour ago.
 */
export interface PendingComment {
  docId: string;
  version: string;
  anchor: Anchor;
}

const STORAGE_KEY = "bikeshed.pendingComment";
const LIVES_MS = 30 * 60 * 1000;

type Saved = PendingComment & { at: number };
let memory: Saved | null = null;

export function savePendingComment(pending: PendingComment, now: number = Date.now()): void {
  memory = { ...pending, at: now };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* the in-memory copy still covers a sign-in that does not reload the page */
  }
}

/** The comment waiting on this document, if any. Reads only, so a render can call it. */
export function readPendingComment(docId: string, now: number = Date.now()): PendingComment | null {
  let saved: Saved | null = memory;
  if (!saved) {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      saved = raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      return null;
    }
  }
  if (!saved || saved.docId !== docId || !saved.anchor || now - saved.at > LIVES_MS) return null;
  return { docId: saved.docId, version: saved.version, anchor: saved.anchor };
}

export function clearPendingComment(): void {
  memory = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing was stored, then */
  }
}
