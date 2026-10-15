// SPDX-License-Identifier: Apache-2.0
// The exact shared editing history represented by a saved HTML snapshot (SPEC §6b, §16).

export type CausalStamp = {
  generation: string;
  vector: Record<string, number>;
  /** Deleted item ranges as [clock, length], because deletions do not advance Yjs state vectors. */
  deletes: Record<string, Array<[number, number]>>;
};
