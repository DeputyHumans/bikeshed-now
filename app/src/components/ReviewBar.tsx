// SPDX-License-Identifier: Apache-2.0
// The review pass's controls, under the editing toolbar (SPEC §22).

import { useState } from "react";
import type { Annotation } from "../types";

/**
 * Two states. Idle, it says how many suggestions are waiting — which is also
 * why "Save as new version" is greyed out — and offers an approver the way
 * in. Reviewing, it walks the pending suggestions one at a time: what each
 * would change, who suggested it, and Accept, Reject, Previous, Next.
 *
 * Every control is a button in reading order, so the pass is keyboard
 * operable without any shortcut to learn.
 */
export function ReviewBar({
  pending,
  canDecide,
  reviewing,
  currentId,
  stale,
  ready,
  busy,
  onStart,
  onGo,
  onAccept,
  onReject,
  onDone,
}: {
  pending: Annotation[];
  canDecide: boolean;
  reviewing: boolean;
  currentId: string | null;
  stale: Set<string>;
  /** The editing session will carry an edit to everyone; until then, no Accept. */
  ready: boolean;
  busy: boolean;
  onStart: () => void;
  onGo: (annId: string) => void;
  onAccept: (a: Annotation) => void;
  onReject: (a: Annotation, reason: string) => void;
  onDone: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const n = pending.length;
  if (n === 0) return null;

  const waiting = `${n === 1 ? "1 suggested edit is" : `${n} suggested edits are`} waiting.`;
  if (!reviewing || !canDecide) {
    return (
      <div className="review-bar" role="region" aria-label="Suggested edits">
        <span>
          {waiting}{" "}
          {canDecide
            ? `Accept or reject ${n === 1 ? "it" : "each one"} before you publish a new version.`
            : `Only the owner or an approver can accept or reject ${n === 1 ? "it" : "them"}.`}
        </span>
        {canDecide ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={onStart}>
            Review {n === 1 ? "it" : "them"}
          </button>
        ) : null}
      </div>
    );
  }

  const index = Math.max(0, pending.findIndex((a) => a.annId === currentId));
  const current = pending[index];
  const s = current.suggestion!;
  const isStale = stale.has(current.annId);
  const go = (i: number) => {
    setRejecting(false);
    setReason("");
    onGo(pending[(i + n) % n].annId);
  };
  const reject = () => {
    onReject(current, reason.trim());
    setRejecting(false);
    setReason("");
  };

  return (
    <div className="review-bar is-reviewing" role="region" aria-label="Review suggested edits">
      <span className="review-count">
        {index + 1} of {n}
      </span>
      <p className="review-change" aria-live="polite">
        <span className="visually-hidden">{current.authorEmail} suggests: </span>
        <span className="review-by" aria-hidden="true">
          {current.authorEmail}:
        </span>{" "}
        <span className="visually-hidden">{s.replacement === "" ? "delete " : "replace "}</span>
        <del>{current.anchor.exact}</del>
        {s.replacement === "" ? null : (
          <>
            <span className="visually-hidden"> with </span>
            <span aria-hidden="true"> → </span>
            <ins>{s.replacement}</ins>
          </>
        )}
        {isStale ? (
          <span className="review-stale"> The text has changed since this was suggested, so it can’t be applied.</span>
        ) : null}
      </p>
      <div className="review-actions">
        {rejecting ? (
          <>
            <input
              className="input"
              aria-label="Why reject it? (optional)"
              placeholder="Why? (optional)"
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  reject();
                } else if (e.key === "Escape") {
                  setRejecting(false);
                }
              }}
            />
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={reject}>
              Reject
            </button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || isStale || !ready}
              title={!ready ? "Joining the live document…" : undefined}
              aria-busy={busy}
              onClick={() => onAccept(current)}
            >
              Accept
            </button>
            <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => setRejecting(true)}>
              Reject…
            </button>
            <button type="button" className="btn btn-sm btn-quiet" disabled={busy || n < 2} onClick={() => go(index - 1)}>
              Previous
            </button>
            <button type="button" className="btn btn-sm btn-quiet" disabled={busy || n < 2} onClick={() => go(index + 1)}>
              Next
            </button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={onDone}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
