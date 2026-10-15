// SPDX-License-Identifier: Apache-2.0
// The exact shared editing history represented by a saved HTML snapshot (SPEC §6b, §16).

export type CausalStamp = {
  generation: string;
  vector: Record<string, number>;
  /** Deleted item ranges as [clock, length], because deletions do not advance Yjs state vectors. */
  deletes: Record<string, Array<[number, number]>>;
};

/** True when every deletion in wanted is covered, including adjacent ranges. */
function covers(have: Array<[number, number]>, wanted: Array<[number, number]>): boolean {
  let index = 0;
  for (const [start, length] of wanted) {
    let at = start;
    const end = start + length;
    while (index < have.length && have[index][0] + have[index][1] <= at) index += 1;
    while (at < end) {
      const range = have[index];
      if (!range || range[0] > at) return false;
      at = Math.max(at, range[0] + range[1]);
      if (at < end) index += 1;
    }
  }
  return true;
}

function dominates(a: CausalStamp, b: CausalStamp): boolean {
  return Object.entries(b.vector).every(([id, count]) => (a.vector[id] ?? 0) >= count)
    && Object.entries(b.deletes).every(([id, ranges]) => covers(a.deletes[id] ?? [], ranges));
}

/** Same ordering as the server's draft guard; clocks alone cannot order deletion-only edits. */
export function causalOrder(candidate: CausalStamp, current: CausalStamp): "ahead" | "same" | "behind" | "concurrent" | "generation" {
  if (candidate.generation !== current.generation) return "generation";
  const forward = dominates(candidate, current);
  const backward = dominates(current, candidate);
  return forward ? (backward ? "same" : "ahead") : (backward ? "behind" : "concurrent");
}
