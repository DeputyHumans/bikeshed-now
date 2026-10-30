// SPDX-License-Identifier: Apache-2.0
// What acted, beside an action that was not a person in the browser, in the words the server stored (SPEC §17, ADR 0023).

/**
 * Server-derived, so stated as fact. Nothing for a person in the browser: the
 * caller passes `viaOf(actor)` (provenance.ts), which is null for them.
 */
export function ViaBadge({ via, title }: { via: string | null; title: string }) {
  if (!via) return null;
  return (
    <span className="badge-automated" title={title}>
      via {via}
    </span>
  );
}
