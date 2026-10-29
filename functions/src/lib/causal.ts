// SPDX-License-Identifier: Apache-2.0
// Compare shared draft histories without allowing an older snapshot to replace a merged one (SPEC §6b, §16).

export type CausalStamp = {
  generation: string;
  vector: Record<string, number>;
  deletes: Record<string, Array<[number, number]>>;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const clock = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const client = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));

/** Bounded JSON only; malformed histories never enter a document record. */
export function parseCausalStamp(value: unknown): CausalStamp | null {
  if (!record(value) || Object.keys(value).sort().join() !== "deletes,generation,vector") return null;
  if (typeof value.generation !== "string" || !/^[a-f0-9]{64}$/.test(value.generation)) return null;
  if (!record(value.vector) || !record(value.deletes)) return null;
  const vectorEntries = Object.entries(value.vector);
  const deleteEntries = Object.entries(value.deletes);
  if (vectorEntries.length > 4096 || deleteEntries.length > 4096) return null;
  if (vectorEntries.some(([id, count]) => !client(id) || !clock(count))) return null;
  let ranges = 0;
  for (const [id, intervals] of deleteEntries) {
    if (!client(id) || !Array.isArray(intervals)) return null;
    let end = -1;
    for (const interval of intervals) {
      if (++ranges > 16384 || !Array.isArray(interval) || interval.length !== 2) return null;
      const [at, length] = interval;
      if (!clock(at) || !clock(length) || length === 0 || !clock(at + length) || at < end) return null;
      if (!clock(value.vector[id]) || at + length > value.vector[id]) return null;
      end = at + length;
    }
  }
  return value as CausalStamp;
}

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

/** Ordering is causal, never request arrival order or a client's wall clock. */
export function causalOrder(candidate: CausalStamp, current: CausalStamp): "ahead" | "same" | "behind" | "concurrent" | "generation" {
  if (candidate.generation !== current.generation) return "generation";
  const forward = dominates(candidate, current);
  const backward = dominates(current, candidate);
  return forward ? (backward ? "same" : "ahead") : (backward ? "behind" : "concurrent");
}

/** Firestore rejects nested arrays; keep the bounded deletion intervals as JSON. */
export function storedCausalStamp(stamp: CausalStamp): { generation: string; vector: Record<string, number>; deletesJson: string } {
  return { generation: stamp.generation, vector: stamp.vector, deletesJson: JSON.stringify(stamp.deletes) };
}

export function readStoredCausalStamp(value: unknown): CausalStamp | null {
  if (!record(value) || typeof value.deletesJson !== "string") return null;
  try { return parseCausalStamp({ generation: value.generation, vector: value.vector, deletes: JSON.parse(value.deletesJson) }); }
  catch { return null; }
}
