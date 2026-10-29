// SPDX-License-Identifier: Apache-2.0
// The two trust scopes, and who bears the risk of each (SPEC §6c).

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { mayTrustForEveryone, setTrusted } from "../trust";
import { logEvent } from "../analytics";

/**
 * This dialog appears ONLY when it would change something: the document is
 * still sandboxed for this reader AND its DOM actually contains a script. A
 * prompt that never matters is a prompt people learn to click through, and then
 * the one that does matter gets clicked through too.
 *
 * The two scopes are presented in the order of increasing consequence, and the
 * global one is visually marked as the consequential choice rather than being
 * the default.
 */
export function TrustDialog({
  docId,
  isOwner,
  personallyTrusted,
  onClose,
  onPersonalTrust,
}: {
  docId: string;
  isOwner: boolean;
  personallyTrusted: boolean;
  onClose: () => void;
  onPersonalTrust: (value: boolean) => Promise<void>;
}) {
  const toast = useToast();
  // Which grant is in flight, so the button that was pressed is the one that spins.
  const [busy, setBusy] = useState<"global" | "personal" | null>(null);
  // Owning a document no longer lets you run its code for everyone: only a
  // deployment's superadmins may (ADR 0021). The server says which this is;
  // until it has, and if it cannot, the choice is not offered.
  const [forEveryone, setForEveryone] = useState(false);
  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    mayTrustForEveryone(docId).then(
      (may) => live && setForEveryone(may),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [docId, isOwner]);

  const run = async (fn: () => Promise<unknown>, scope: "global" | "personal") => {
    setBusy(scope);
    try {
      await fn();
      logEvent({ name: "trust_grant", params: { scope } });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="This document wants to run its own code"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Keep it sandboxed
          </button>
        </>
      }
    >
      <p>
        It contains scripts, which are currently blocked. Parts of it may look
        empty until they run — a chart, a reveal, an interactive diagram.
      </p>

      <div className="trust-scopes">
        <div className="trust-scope" data-scope="personal">
          <div className="trust-scope-title">Run it in my browser</div>
          <p className="trust-scope-note">
            {/* Self-regarding, which is exactly why any reader may do it: the
                only session exposed to this document's code is their own. */}
            Affects only you, on this account. Nobody else's view changes.
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            aria-busy={busy === "personal"}
            onClick={() => void run(() => onPersonalTrust(!personallyTrusted), "personal")}
          >
            {personallyTrusted ? "Sandbox it again for me" : "Run it for me"}
          </button>
        </div>

        {forEveryone ? (
          <div className="trust-scope" data-scope="global">
            <div className="trust-scope-title">Run it for everyone</div>
            <p className="trust-scope-note">
              {/* A decision made on other people's behalf, so it is a
                  superadmin's, on their own document. A trusted document's
                  code runs same-origin for every reader. */}
              This document's code will run for every reader. Only do this if you
              know where it came from.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              aria-busy={busy === "global"}
              onClick={() => void run(() => setTrusted(docId, true), "global")}
            >
              Trust it for everyone
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
