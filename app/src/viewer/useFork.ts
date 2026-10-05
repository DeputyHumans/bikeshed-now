// SPDX-License-Identifier: Apache-2.0
// Forking from the viewer, and where the document came from (SPEC §21).

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "../components/Toast";
import { forkDoc, getLineage, type Lineage } from "../forks";

/** The query parameter that carries "fork this" across a sign-in. */
export const FORK_INTENT = "fork";

/**
 * One click forks and opens the fork. There is nothing to ask first: renaming
 * and filing it are what the workspace menus are for.
 *
 * A signed-out reader is sent to sign in with the intent IN THE URL, and the
 * viewer finishes it when they come back. The URL, not component state,
 * because signing in leaves this page: state would be gone, and the reader
 * would land in the workspace wondering where their fork went. It runs once,
 * and only after the document has been resolved AS this account — on an
 * unlisted document, that is what records the link grant the server checks.
 * The parameter is removed before the request goes, so a reload cannot fork
 * twice.
 */
export function useFork(
  docId: string,
  opts: {
    /** The version on screen, when it is not the current one. */
    versionId?: string;
    linkKey: string;
    uid: string | null;
    resolvedFor: string | null;
  },
): { fork: () => void; forking: boolean } {
  const { versionId, linkKey, uid, resolvedFor } = opts;
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [forking, setForking] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setForking(true);
    toast
      .during(
        "Forking…",
        forkDoc(docId, {
          ...(versionId ? { versionId } : {}),
          ...(linkKey ? { linkKey } : {}),
        }),
      )
      .then((made) => navigate(`/d/${made.docId}`))
      .catch((e: Error) => toast.error(e.message))
      .finally(() => {
        inFlight.current = false;
        setForking(false);
      });
  }, [docId, versionId, linkKey, navigate, toast]);

  const fork = useCallback(() => {
    if (uid) {
      run();
      return;
    }
    const back = new URLSearchParams();
    if (linkKey) back.set("k", linkKey);
    back.set(FORK_INTENT, "1");
    const path = `/d/${docId}${versionId ? `/${versionId}` : ""}?${back.toString()}`;
    navigate(`/signup?next=${encodeURIComponent(path)}`);
  }, [uid, run, docId, versionId, linkKey, navigate]);

  const intent = params.get(FORK_INTENT) === "1";
  useEffect(() => {
    if (!intent || !uid || resolvedFor !== uid) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(FORK_INTENT);
        return next;
      },
      { replace: true },
    );
    run();
  }, [intent, uid, resolvedFor, setParams, run]);

  return { fork, forking };
}

/**
 * Where this document came from, as far as this reader may see, and — for its
 * owner — its forks.
 *
 * Asked for on its own only for a fork (`auto`), so a document that is not one
 * costs no extra request. `refresh` asks regardless, for the panel, which is
 * where an owner's inventory is wanted and the only place it is shown.
 */
export function useLineage(
  docId: string,
  opts: {
    linkKey: string;
    /**
     * Signed in AND resolved as that account. Lineage is per caller, and on an
     * unlisted document the account's link grant is what the server checks.
     */
    ready: boolean;
    auto: boolean;
  },
): { lineage: Lineage | null; failed: boolean; refresh: () => void } {
  const { linkKey, ready, auto } = opts;
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [failed, setFailed] = useState(false);
  // A late answer for a document the reader has already left must not land.
  const latest = useRef(0);

  const refresh = useCallback(() => {
    if (!ready) return;
    const ask = ++latest.current;
    setFailed(false);
    getLineage(docId, linkKey || undefined).then(
      (answer) => {
        if (ask === latest.current) setLineage(answer);
      },
      () => {
        if (ask === latest.current) setFailed(true);
      },
    );
  }, [docId, linkKey, ready]);

  useEffect(() => {
    setLineage(null);
    if (auto) refresh();
  }, [auto, refresh]);

  return { lineage, failed, refresh };
}
