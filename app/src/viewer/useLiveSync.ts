// SPDX-License-Identifier: Apache-2.0
// Noticing what somebody else just did (SPEC §6b, §16).

import { useEffect, useRef, useState } from "react";
import type { DocMeta } from "../types";

/**
 * The one-second text, two-hundred-millisecond pointer split.
 *
 * An observer sees the draft refresh on each of the editor's autosaves — the
 * existing debounce, not a new channel — while the peer's caret updates five
 * times a second. That split is precisely what avoids needing a CRDT: the
 * POINTER is what the eye tracks, so it has to feel live; the TEXT arriving a
 * second later reads as natural, because that is roughly the cadence at which a
 * person finishes a sentence.
 *
 * Nothing here diffs or patches. It refreshes the src of a frame the viewer
 * already knows how to reload without losing the reader's place.
 */
export function useLiveSync(options: {
  meta: DocMeta | null;
  emailLower: string;
  /** True when this reader is the one typing. */
  isEditing: boolean;
  onPeerSavedDraft: () => void;
}) {
  const { meta, emailLower, isEditing, onPeerSavedDraft } = options;

  const lastDraftAt = useRef<number>(0);
  const lastVersion = useRef<string | null>(null);
  const [conflict, setConflict] = useState<{ byEmail: string } | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!meta) return;

    const draft = meta.draft ?? null;
    const draftAt = draft?.updatedAt?.toMillis?.() ?? 0;
    const byPeer = draft != null && draft.updatedByEmail !== emailLower;

    if (draftAt > lastDraftAt.current) {
      lastDraftAt.current = draftAt;
      if (byPeer) {
        if (isEditing) {
          // Last-writer-wins, never auto-clobbered: the choice is offered, and
          // silence keeps YOUR work rather than theirs.
          setConflict({ byEmail: draft.updatedByEmail });
        } else {
          onPeerSavedDraft();
        }
      }
    }

    if (lastVersion.current && meta.currentVersion !== lastVersion.current) {
      // A new version is not a conflict for an idle reader — it is just newer.
      setNewVersion(meta.currentVersion);
    }
    lastVersion.current = meta.currentVersion;
  }, [meta, emailLower, isEditing, onPeerSavedDraft]);

  return {
    conflict,
    dismissConflict: () => setConflict(null),
    newVersion,
    dismissNewVersion: () => setNewVersion(null),
  };
}
