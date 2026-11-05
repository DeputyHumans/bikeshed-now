// SPDX-License-Identifier: Apache-2.0
// That something other than a person in the browser acted, as one word, with what acted behind it (SPEC §17, ADR 0023).

import { Icon } from "./Icon";
import { useToast } from "./Toast";

/**
 * Server-derived, so stated as fact. Nothing for a person in the browser: the
 * caller passes `viaOf(actor)` (provenance.ts), which is null for them.
 *
 * The page says `agent`; `title` is the caller's sentence with the words the
 * server stored. It is a button because those words have to be reachable
 * without a hover: tooltips do not exist on touch. It stops the click because
 * it sits inside things that take one, and a comment's thread is one of them.
 */
export function ViaBadge({ via, title }: { via: string | null; title: string }) {
  const toast = useToast();
  if (!via) return null;
  return (
    <button
      type="button"
      className="chip badge-automated"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        toast.show(title);
      }}
    >
      <Icon name="agent" size={12} />
      agent
    </button>
  );
}
