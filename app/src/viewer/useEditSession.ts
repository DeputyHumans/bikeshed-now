// SPDX-License-Identifier: Apache-2.0
// Capture the version and live-log epoch an editor actually opened (SPEC §6a, §6b).

import { useCallback, useEffect, useState } from "react";

export function useEditSession(docId: string, baseVersion: string, liveEpoch: string) {
  const [origin, setOrigin] = useState<{ docId: string; baseVersion: string; liveEpoch: string } | null>(null);
  useEffect(() => { setOrigin(null); }, [docId]);
  const setEditing = useCallback((editing: boolean) => {
    setOrigin(editing ? { docId, baseVersion, liveEpoch } : null);
  }, [docId, baseVersion, liveEpoch]);
  return { origin: origin?.docId === docId ? origin : null, setEditing };
}
