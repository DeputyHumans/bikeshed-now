// SPDX-License-Identifier: Apache-2.0
// Renaming a document: its title and slug, never its address (SPEC §4).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { slugify } from "./folders";
import { syncPublicProjection } from "./publicdoc";

/** The longest title a document may be given. */
export const TITLE_LIMIT = 200;

/**
 * Give a document a new title, for a caller already allowed to edit it.
 *
 * The title is the workspace's name for the document: the list, the tab, the
 * public projection. Its address is its docId, which a rename never touches,
 * so every link already sent keeps working. An HTML document's own `<title>`
 * is part of its bytes and is not rewritten; link previews still prefer it
 * (SPEC §17).
 */
export async function renameDocument(
  db: admin.firestore.Firestore,
  ref: admin.firestore.DocumentReference,
  raw: unknown,
): Promise<{ title: string } | { error: string }> {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title || title.length > TITLE_LIMIT) {
    return { error: `title is required (up to ${TITLE_LIMIT} characters)` };
  }
  await ref.set(
    { title, slug: slugify(title), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  // A public document's title is also in its world-readable projection.
  await syncPublicProjection(db, ref.id);
  return { title };
}
