// SPDX-License-Identifier: Apache-2.0
// That a document is a fork, or has been forked, said as a chip (SPEC §21).

import { Icon } from "./Icon";
import type { Lineage } from "../forks";

/**
 * Beside the version chip, like the expiry: a fact about this document, not an
 * action. One chip for both directions, because a fork can itself be forked,
 * and both open the same panel.
 *
 * The sentence is the accessible name AND the tooltip, so nothing here depends
 * on seeing the dot: "the original has changed" is said in words to anyone who
 * cannot.
 */
export function ForkChip({
  forked,
  forkCount,
  lineage,
  onOpen,
}: {
  forked: boolean;
  /** Forks made from this document. Passed only to its owner. */
  forkCount: number;
  lineage: Lineage | null;
  onOpen: () => void;
}) {
  if (!forked && forkCount <= 0) return null;
  const parent = lineage?.ancestors[0];
  const changed = forked && parent?.changed === true;

  const sentences: string[] = [];
  if (forked) {
    sentences.push(parent ? `Forked from ${parent.title}` : "Forked from another document");
  }
  if (changed) sentences.push("The original has changed since");
  if (forkCount > 0) sentences.push(`Forked ${forkCount === 1 ? "once" : `${forkCount} times`}`);
  const sentence = sentences.join(". ");

  const words = [forked ? "Fork" : null, forkCount > 0 ? String(forkCount) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      className="chip fork-chip"
      data-changed={changed ? "" : undefined}
      aria-label={sentence}
      title={sentence}
      onClick={onOpen}
    >
      <Icon name="fork" size={12} />
      <span className="chip-label">{words}</span>
    </button>
  );
}
