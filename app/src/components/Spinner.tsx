// SPDX-License-Identifier: Apache-2.0
// A busy indicator that says what it is waiting for.

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label} />
  );
}

/** A full-panel waiting state. `label` is announced, not just drawn. */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="empty-state">
      <Spinner label={label} />
      <p style={{ marginTop: "var(--s-2)" }}>{label}…</p>
    </div>
  );
}

/**
 * Card skeletons.
 *
 * A layout-shaped placeholder rather than a spinner, so the page does not jump
 * when the real cards arrive — the jump is what makes a fast load feel slow.
 */
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
