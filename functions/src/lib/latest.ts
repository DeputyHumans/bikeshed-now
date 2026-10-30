// SPDX-License-Identifier: Apache-2.0
// The current version, summarized on its document: when, by whom, through what, how it arrived and how long it is (SPEC §4, §17).

import * as admin from "firebase-admin";
import type { Timestamp } from "firebase-admin/firestore";
import { bucketName } from "../config";
import { countWords } from "./head";
import { safeRelPath } from "./http";
import { originOf } from "./versions";
import { syncPublicProjection } from "./publicdoc";
import { versionStoragePrefix } from "./storage";

type Db = admin.firestore.Firestore;
type Data = Record<string, unknown>;

/**
 * Why a summary, and why written here
 * -----------------------------------
 * A workspace card says when a document was last updated, by whom, through
 * what and how long it takes to read, and a card cannot read the version it
 * describes: the list is one query over documents. `updatedAt` is no answer,
 * because renaming, re-sharing, trust and every folder recompute move it too.
 *
 * So the document carries `latest`, a summary of its current version, and the
 * version-write trigger keeps it: every way a version is made (the browser,
 * the CLI, an agent, a fork, the operator scripts) writes a version record, so
 * one place sees them all, and a withdrawal, which deletes one, moves the
 * summary back to whatever is current. It is written only while that version
 * is current, read inside the transaction, so it can lag a publish by a moment
 * but never names a version that is not the head.
 *
 * The word count needs the version's bytes, which only Storage has; it is
 * counted once, here, and kept on the version too, for the Details sheet of a
 * version that is no longer current.
 */
export interface Latest {
  version: string;
  at: Timestamp | null;
  byEmail: string | null;
  channel: string;
  via?: string;
  origin: "upload" | "edit" | "fork" | null;
  words?: number;
}

/** The summary of one version, as its record says. */
export function latestOf(versionId: string, v: Data): Latest {
  const by = v.publishedBy as { channel?: unknown; via?: unknown } | undefined;
  return {
    version: versionId,
    at: (v.publishedAt as Timestamp | undefined) ?? null,
    byEmail: typeof v.publishedByEmail === "string" ? v.publishedByEmail : null,
    channel: typeof by?.channel === "string" ? by.channel : "web",
    ...(typeof by?.via === "string" && by.via ? { via: by.via } : {}),
    origin: originOf(v),
    ...(typeof v.words === "number" ? { words: v.words } : {}),
  };
}

function sameLatest(a: unknown, b: Latest): boolean {
  if (!a || typeof a !== "object") return false;
  const x = a as Partial<Latest>;
  const millis = (t: unknown) => (t && typeof (t as Timestamp).toMillis === "function" ? (t as Timestamp).toMillis() : null);
  return (
    x.version === b.version &&
    millis(x.at) === millis(b.at) &&
    (x.byEmail ?? null) === b.byEmail &&
    x.channel === b.channel &&
    (x.via ?? undefined) === b.via &&
    (x.origin ?? null) === b.origin &&
    (x.words ?? undefined) === b.words
  );
}

/** The version's entry, read from Storage and counted; null when it cannot be read. */
async function countEntryWords(docId: string, versionId: string, v: Data): Promise<number | null> {
  const entry = typeof v.entry === "string" ? safeRelPath(v.entry) : null;
  if (!entry) return null;
  const file = admin.storage().bucket(bucketName()).file(`${versionStoragePrefix(docId, versionId, v)}/${entry}`);
  try {
    const [bytes] = await file.download();
    return countWords(bytes.toString("utf8"));
  } catch (err) {
    if ((err as { code?: unknown }).code === 404) return null;
    throw err;
  }
}

/**
 * Count a version written without its words, and bring its document's summary
 * to the version that is current now. Idempotent: a redelivered or repeated
 * call finds the words and the summary already in place and writes nothing.
 */
export async function refreshLatest(db: Db, docId: string, versionId: string, after: Data | undefined): Promise<void> {
  const docRef = db.collection("docs").doc(docId);
  let version = after;
  if (version && typeof version.words !== "number") {
    const words = await countEntryWords(docId, versionId, version);
    if (words !== null) {
      try {
        await docRef.collection("versions").doc(versionId).update({ words });
        version = { ...version, words };
      } catch (err) {
        // Withdrawn while it was being counted: nothing to summarize.
        if ((err as { code?: unknown }).code === 5) return;
        throw err;
      }
    }
  }

  const changed = await db.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    const data = doc.data();
    const current = data?.currentVersion;
    if (!data || typeof current !== "string" || !current) return false;
    const record = current === versionId && version ? version : (await tx.get(docRef.collection("versions").doc(current))).data();
    if (!record) return false;
    const next = latestOf(current, record);
    if (sameLatest(data.latest, next)) return false;
    tx.update(docRef, { latest: next });
    return true;
  });
  // The public mirror says when it was last updated and how long it is.
  if (changed) await syncPublicProjection(db, docId);
}
