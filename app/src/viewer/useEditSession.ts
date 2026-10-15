// SPDX-License-Identifier: Apache-2.0
// Open a version and draft revision that the editor frame will validate before loading (SPEC §6a, §6b).

import { useCallback, useEffect, useRef, useState } from "react";
import { openDraftSession, type DraftSession } from "../edit";

export function useEditSession(docId: string, baseVersion: string) {
  const [origin, setOrigin] = useState<(DraftSession & { docId: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { request.current += 1; setOrigin(null); setError(null); return () => { request.current += 1; }; }, [docId]);
  const setEditing = useCallback(async (editing: boolean, options: { reload?: boolean } = {}) => {
    // Review can enter an editor that already owns unsaved DOM. Only an
    // explicit Reload may discard that snapshot and ask for different bytes.
    if (editing && origin?.docId === docId && !options.reload) return;
    const current = ++request.current;
    setOrigin(null);
    setError(null);
    if (!editing) return;
    try {
      const snapshot = await openDraftSession(docId, baseVersion);
      if (request.current === current) setOrigin({ docId, ...snapshot });
    } catch (e) {
      if (request.current === current) setError((e as Error).message);
    }
  }, [docId, baseVersion, origin]);
  const reloadEditing = useCallback(() => setEditing(true, { reload: true }), [setEditing]);
  return { reloadEditing, origin: origin?.docId === docId ? origin : null, error, setEditing };
}
