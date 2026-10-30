// SPDX-License-Identifier: Apache-2.0
// What a person sees when something goes to the Trash or comes back, said once for every page (SPEC §4).

import { restoreItem, trashItem, type OrganizeKind } from "./folders";
import type { useToast } from "./components/Toast";

type Toast = ReturnType<typeof useToast>;

/** Bring an item back, saying so, or why not. */
export function restoreFromTrash(toast: Toast, kind: OrganizeKind, id: string, title: string): Promise<void> {
  return toast
    .during("Restoring…", restoreItem(kind, id))
    .then(() => toast.show(`“${title}” is back where it was, with its sharing.`))
    .catch((e: Error) => toast.error(e.message));
}

/**
 * Move an item to the Trash, with an Undo for as long as the toast stays:
 * the Trash itself is the safety net, so nothing but a folder asks first.
 */
export function moveToTrash(toast: Toast, kind: OrganizeKind, id: string, title: string): Promise<void> {
  return toast
    .during("Moving to the Trash…", trashItem(kind, id))
    .then(() => toast.show(`“${title}” is in the Trash.`, { label: "Undo", onSelect: () => void restoreFromTrash(toast, kind, id, title) }))
    .catch((e: Error) => toast.error(e.message));
}
