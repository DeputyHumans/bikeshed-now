// SPDX-License-Identifier: Apache-2.0
// When a document stops being readable, said as a chip (SPEC §17).

import { Icon } from "./Icon";
import { useToast } from "./Toast";
import {
  expiringSoon,
  expiryExplanation,
  expiryLabel,
  isExpired,
  sharingExplanation,
  sharingLabel,
  throughFolderExplanation,
} from "../expiry";
import type { DocMeta } from "../types";

/**
 * One chip for the workspace card and the viewer's toolbar.
 *
 * It escalates rather than shouting from the start: a date eleven months out
 * is information, the last week is a warning, and past it is a state. Each
 * step is carried by the WORDING as well as the attribute, so colour is never
 * the only signal.
 *
 * It is a button because the sentence behind it has to be reachable without a
 * hover — tooltips do not exist on touch. The owner is handed the place the
 * date is changed; everybody else is told what the state means, which for a
 * reader looking at an empty frame is that nothing was deleted and who can
 * restore it.
 */
export function ExpiryChip({
  expiresAt,
  onOpen,
  of = "document",
}: {
  expiresAt: DocMeta["expiresAt"] | number | null;
  /** The owner's tap. Only an owner is handed the dialog, so this also decides the wording. */
  onOpen?: () => void;
  /**
   * Whose date it is. A folder's date ends its link and nothing else, so it
   * says "sharing ends", never "expires"; a reader who came through a folder's
   * link is told when THEIR link stops (SPEC §17 "A folder's reach").
   */
  of?: "document" | "folder" | "folder-link";
}) {
  const toast = useToast();
  const label = of === "document" ? expiryLabel(expiresAt) : sharingLabel(expiresAt);
  if (!label) return null;
  const explanation = (
    of === "folder"
      ? sharingExplanation(expiresAt, onOpen !== undefined)
      : of === "folder-link"
        ? throughFolderExplanation(expiresAt)
        : expiryExplanation(expiresAt, onOpen !== undefined)
  ) as string;

  return (
    <button
      type="button"
      className="chip expiry-chip"
      data-expired={isExpired(expiresAt) ? "" : undefined}
      data-soon={expiringSoon(expiresAt) ? "" : undefined}
      aria-label={label}
      title={explanation}
      onClick={onOpen ?? (() => toast.show(explanation))}
    >
      <Icon name="clock" size={12} />
      {/* Hidden on the narrowest screens; the accessible name above is not. */}
      <span className="chip-label">{label}</span>
    </button>
  );
}
