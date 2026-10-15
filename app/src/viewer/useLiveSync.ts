// SPDX-License-Identifier: Apache-2.0
// Noticing what somebody else just did (SPEC §6b, §16).

import { useEffect, useRef, useState } from "react";
import type { DocMeta } from "../types";

/**
 * The one-second text, two-hundred-millisecond pointer split.
 *
 * An observer sees the draft refresh on each of the editor's autosaves — the
 * existing debounce, not a new channel — while the peer's caret updates five
 * times a second. Editors merge through the shared CRDT; idle readers of the
 * draft refresh from autosaves. A live co-editor's save is confirmation of the
 * shared work, not a competing copy to load or discard.
 *
 * Nothing here diffs or patches. It refreshes the src of a frame the viewer
 * already knows how to reload without losing the reader's place — and only a
 * frame that shows the draft, and not while the reader is writing a
 * suggestion: a reload throws the open form and the selection away.
 */
export function useLiveSync(options: {
  meta: DocMeta | null;
  /** The version the frame is showing — `currentVersion` as the viewer resolved it. */
  shownVersion: string;
  emailLower: string;
  /** True when this reader is the one typing. */
  isEditing: boolean;
  /** The frame shows the draft. A published version does not change when the draft is saved. */
  showsDraft: boolean;
  /** Editors whose changes already merge through this reader's live connection. */
  liveEditorEmails?: readonly string[];
  /** The reader is writing something a reload would throw away; catch up once they finish. */
  hold?: boolean;
  onPeerSavedDraft: () => void;
}) {
  const { meta, shownVersion, emailLower, isEditing, showsDraft, liveEditorEmails = [], hold = false, onPeerSavedDraft } = options;

  const lastDraftAt = useRef<number>(0);
  const owedReload = useRef(false);
  const lastVersion = useRef<string | null>(null);
  const [conflict, setConflict] = useState<{ byEmail: string } | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!meta) return;

    const draft = meta.draft ?? null;
    const draftAt = draft?.updatedAt?.toMillis?.() ?? 0;
    const byPeer = draft != null && draft.updatedByEmail !== emailLower;

    if (draftAt > lastDraftAt.current) {
      // The first save seen is the one the frame was just loaded with.
      const first = lastDraftAt.current === 0;
      lastDraftAt.current = draftAt;
      if (byPeer) {
        if (isEditing && !liveEditorEmails.includes(draft.updatedByEmail)) {
          // Last-writer-wins, never auto-clobbered: the choice is offered, and
          // silence keeps YOUR work rather than theirs.
          setConflict({ byEmail: draft.updatedByEmail });
        } else if (showsDraft && !first) {
          if (hold) owedReload.current = true;
          else onPeerSavedDraft();
        }
      }
    }

    if (lastVersion.current && meta.currentVersion !== lastVersion.current) {
      // A new version is not a conflict for an idle reader — it is just newer.
      setNewVersion(meta.currentVersion);
    }
    lastVersion.current = meta.currentVersion;
  }, [meta, emailLower, isEditing, showsDraft, liveEditorEmails, hold, onPeerSavedDraft]);

  // The reload a reader was spared while writing, made once they are done.
  useEffect(() => {
    if (hold || !owedReload.current) return;
    owedReload.current = false;
    if (showsDraft && !isEditing) onPeerSavedDraft();
  }, [hold, showsDraft, isEditing, onPeerSavedDraft]);

  return {
    conflict: conflict && !liveEditorEmails.includes(conflict.byEmail) ? conflict : null,
    dismissConflict: () => setConflict(null),
    /**
     * News only to a reader who is not looking at it. With no version pinned
     * in the URL the viewer follows `currentVersion` in the same render the
     * snapshot lands — the reader's own commit, or a peer's publish — so the
     * banner would offer "Open v4 / Stay here" over a frame already on v4. A
     * reader pinned to an older version is the one it is for, and once they
     * open the new one this clears on its own.
     */
    newVersion: newVersion !== null && newVersion !== shownVersion && newVersion === meta?.currentVersion ? newVersion : null,
    dismissNewVersion: () => setNewVersion(null),
  };
}
