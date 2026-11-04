// SPDX-License-Identifier: Apache-2.0
// A busy indicator that says what it is waiting for.

import { useEffect, useState } from "react";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label} />
  );
}

/** How long one stage of a wait runs before the page admits it is slow. */
export const SLOW_MS = 4_000;
/** How long before it offers to start that stage again. */
export const STUCK_MS = 20_000;

/**
 * A full-panel waiting state. `label` is announced, not just drawn.
 *
 * With `onRetry`, each stage — each label — keeps its own clock: past
 * `SLOW_MS` the wait says it is slow, past `STUCK_MS` it offers Try again.
 * Without it nothing changes, however long the wait.
 */
export function Loading({ label = "Loading", onRetry }: { label?: string; onRetry?: () => void }) {
  const retryable = onRetry !== undefined;
  const [attempt, setAttempt] = useState(0);
  // Keyed by stage, so a new label starts at zero without a render to reset it.
  const stage = `${attempt} ${label}`;
  const [waited, setWaited] = useState<{ for: string; level: 1 | 2 } | null>(null);
  const level = waited?.for === stage ? waited.level : 0;

  useEffect(() => {
    if (!retryable) return;
    const slow = setTimeout(() => setWaited({ for: stage, level: 1 }), SLOW_MS);
    const stuck = setTimeout(() => setWaited({ for: stage, level: 2 }), STUCK_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, [stage, retryable]);

  return (
    <div className="empty-state">
      <Spinner label={label} />
      <p style={{ marginTop: "var(--s-2)" }}>{label}…</p>
      {retryable ? (
        <div aria-live="polite">
          {level >= 1 ? <p>This is taking longer than it should.</p> : null}
          {level >= 2 ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAttempt((n) => n + 1);
                onRetry();
              }}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Card skeletons.
 *
 * A layout-shaped placeholder rather than a spinner, so the page does not jump
 * when the real cards arrive — the jump is what makes a fast load feel slow.
 */
/** The list's stand-in, row for row, so the layout does not jump when the rows land. */
export function RowSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="doc-table" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="doc-row doc-row-skeleton">
          <div className="skeleton doc-row-thumb" />
          <div className="skeleton" style={{ height: 14, width: "55%" }} />
        </div>
      ))}
    </div>
  );
}

export function CardSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="doc-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="doc-card">
          <div className="skeleton doc-card-thumb-skeleton" />
          <div className="skeleton" style={{ height: 18, width: "70%" }} />
          <div className="skeleton" style={{ height: 12, width: "45%" }} />
          <div className="skeleton" style={{ height: 12, width: "60%", marginTop: "auto" }} />
        </div>
      ))}
    </div>
  );
}
