// SPDX-License-Identifier: Apache-2.0
// Delete forever: ask for a code by email, then spend it on exactly this (SPEC §4).

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { confirmPurge, purgeSentence, requestPurgeCode, type PurgeSummary, type PurgeTarget } from "../purge";

/** How long before another code may be asked for; the server holds the same gap. */
const RESEND_GAP_MS = 60_000;

/**
 * Two steps, because the second one cannot be undone. The first says what
 * is about to go and sends the code; only then does the dialog know exactly
 * what the server will delete, which it says again beside the code field.
 * Nothing is deleted until the code is entered, and closing the dialog at
 * any point leaves everything where it was.
 */
export function PurgeDialog({
  target,
  what,
  onClose,
  onDone,
}: {
  target: PurgeTarget;
  /** What the first step names, before the server has counted: "“Plan”", "everything in your Trash". */
  what: string;
  onClose: () => void;
  onDone: (gone: { documents: number; folders: number }) => void;
}) {
  const [sent, setSent] = useState<{ sentTo: string; minutes: number; summary: PurgeSummary; at: number } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"code" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const wait = sent ? Math.max(0, Math.ceil((sent.at + RESEND_GAP_MS - now) / 1000)) : 0;

  // Ticks only while there is a wait to count down.
  useEffect(() => {
    if (wait === 0) return;
    const tick = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(tick);
  }, [wait]);

  const ask = async () => {
    setBusy("code");
    setError(null);
    try {
      const r = await requestPurgeCode(target);
      setSent({ sentTo: r.sentTo, minutes: r.expiresInMinutes, summary: r.summary, at: Date.now() });
      setNow(Date.now());
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    setBusy("confirm");
    setError(null);
    try {
      onDone(await confirmPurge(target, code));
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Delete forever?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Keep it
          </button>
          {sent ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null || code.length !== 6}
              aria-busy={busy === "confirm"}
              onClick={() => void confirm()}
            >
              Delete forever
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy !== null} aria-busy={busy === "code"} onClick={() => void ask()}>
              Email me a code
            </button>
          )}
        </>
      }
    >
      {sent ? (
        <>
          <p>{purgeSentence(sent.summary)} This can't be undone.</p>
          <div className="field">
            <label className="field-label" htmlFor="purge-code">
              Enter the six-digit code we sent to {sent.sentTo}. It expires in {sent.minutes} minutes.
            </label>
            <input
              id="purge-code"
              className="input verify-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null || wait > 0} aria-busy={busy === "code"} onClick={() => void ask()}>
            {wait > 0 ? `Send another code in ${wait} s` : "Send another code"}
          </button>
        </>
      ) : (
        <p>
          {what} will be deleted for good, with every version and comment, and can't be brought back. To make sure it's you, we'll email a code to your address first.
        </p>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
