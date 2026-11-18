// SPDX-License-Identifier: Apache-2.0
// Atomic operator sharing and version records, with current membership dependencies (SPEC §9, §13, §18).

import { randomUUID } from 'node:crypto';
import mime from 'mime';
import { GRANT_LIST, computeMembership, grantLists, grantsOf, isTrashed, loadFolderMembership, loadTeamIndex } from './membership.mjs';
import { FieldValue, getRtdb } from './firebase.mjs';
import { syncPresenceAccess } from './presence.mjs';
import { withdrawalPrefix } from './withdraw-version.mjs';
import { sha256Hex } from './hash.mjs';
import { blobKey } from './stored.mjs';
import { freshReceiptId, readReceipt, recordReceipt, clearReceipt } from './transaction-receipts.mjs';

/** Adapt the existing read-only membership loaders to this transaction. */
function reader(db, tx) {
  return { collection: (name) => ({ doc: (id) => ({ get: () => tx.get(db.collection(name).doc(id)) }) }) };
}

async function effective(db, tx, current, grants, ownerEmail) {
  const reads = reader(db, tx);
  const parent = await loadFolderMembership(reads, current.folderId ?? null);
  const teams = await loadTeamIndex(reads, ...grantLists(grants));
  // A trashed document stays its owner's alone whatever an operator grants:
  // the grants are stored for Restore and count for nothing until then.
  return computeMembership(ownerEmail, grants, parent, teams, isTrashed(current));
}

/** Apply one CLI delta to the current record; a read-only --list writes nothing. */
export async function persistOperatorAccess(db, docRef, { add, remove, role }, timestamp) {
  const receipt = add.length || remove.length ? freshReceiptId() : null;
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error(`document not found: ${docRef.path}`);
    const committed = receipt ? readReceipt(snap, receipt) : null;
    if (committed?.found) return committed.result;
    const current = snap.data() || {};
    const ownerEmail = String(current.ownerEmail || '').toLowerCase();
    const sets = new Map(Object.entries(grantsOf(current)).map(([list, principals]) => [list, new Set(principals)]));
    const drop = (principal) => { for (const set of sets.values()) set.delete(principal); };
    for (const principal of remove) if (principal !== ownerEmail) drop(principal);
    for (const principal of add) {
      if (principal === ownerEmail) continue;
      drop(principal);
      sets.get(GRANT_LIST[role]).add(principal);
    }
    const grants = Object.fromEntries([...sets].map(([list, principals]) => [list, [...principals].sort()]));
    const membership = await effective(db, tx, current, grants, ownerEmail);
    const result = { ownerEmail, folderId: current.folderId ?? null, grants, membership };
    if (receipt) {
      recordReceipt(tx, docRef, snap, receipt, result);
      tx.set(docRef, { ...grants, ...membership, updatedAt: timestamp }, { merge: true });
    }
    return result;
  });
  if (receipt) await clearReceipt(docRef, receipt);
  return result;
}

/** Select a version only after upload; losing attempts never modify another version. */
export async function commitOperatorVersion(db, docRef, input, timestamp, deleteField = () => FieldValue.delete()) {
  let attempted;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const versions = await tx.get(docRef.collection('versions'));
    // A retried callback can observe our already-committed upload. Preserve
    // its retirement receipt instead of calling it a duplicate and skipping
    // the mirror, old log and captured-draft cleanup still owed by this run.
    if (attempted && versions.docs.some((version) => version.id === attempted.versionId && version.data().attempt === input.version.attempt)) return attempted;
    // The head's hash is compared in the framing it was minted with: v2 over the
    // file list, or v1 over the bytes, which the operator has on disk (SPEC §9.1).
    const duplicate = versions.docs.find((version) => version.id === snap.data()?.currentVersion &&
      version.data().contentHash === (version.data().hashVersion === 2 ? input.version.contentHash : input.bytesHash));
    if (duplicate) return { duplicate: true, versionId: duplicate.id };
    const current = snap.data() || {};
    if (snap.exists !== input.existed || (current.currentVersion ?? null) !== input.baseVersion) {
      throw new Error('document advanced while uploading; rerun against its current version');
    }
    const mark = current.withdrawing;
    if (mark && Array.isArray(mark.hashes) && typeof mark.until === 'number' && mark.until > Date.now() &&
        input.version.hashes.some((hash) => mark.hashes.includes(hash))) {
      throw new Error('a version of this document is being withdrawn and one of these files is being deleted; rerun in a minute');
    }
    const retiredEpoch = current.liveEpoch ?? 'initial';
    if (typeof retiredEpoch !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(retiredEpoch)) throw new Error('invalid live editing epoch');
    const draftPrefix = current.draft ? withdrawalPrefix(docRef.id, 'draft', current.draft) : null;
    if (draftPrefix && versions.docs.some((version) => withdrawalPrefix(docRef.id, version.id, version.data()) === draftPrefix)) {
      throw new Error('draft bytes are still referenced by a version');
    }
    const publicRef = db.collection('public').doc(docRef.id);
    const projection = await tx.get(publicRef);
    if (current.visibility === 'public' && !projection.exists) throw new Error('public projection is missing; repair it before publishing');
    let maxN = 0;
    for (const version of versions.docs) {
      const match = /^v(\d+)$/.exec(version.id);
      if (match) maxN = Math.max(maxN, Number(match[1]));
    }
    const versionId = `v${maxN + 1}`;
    const ownerEmail = current.ownerEmail ?? input.ownerEmail;
    const grants = {
      ...grantsOf(current),
      viewers: [...new Set([...(current.viewers ?? []), ...input.viewers])].sort(),
      editors: [...new Set([...(current.editors ?? []), ...input.editors])].sort(),
    };
    const membership = await effective(db, tx, current, grants, ownerEmail);
    const liveEpoch = randomUUID();
    tx.set(docRef, {
      docId: docRef.id, title: input.title, slug: input.slug,
      ...(snap.exists ? {} : { ownerUid: null, ownerEmail: input.ownerEmail, createdAt: timestamp, visibility: 'private', publicEdit: false, folderId: null }),
      ...grants, ...membership, currentVersion: versionId, liveEpoch, draft: deleteField(), trusted: true, updatedAt: timestamp,
      // Counted as every other publish counts, so withdraw-version's
      // decrement has something to take back.
      stats: { commits: FieldValue.increment(1) },
    }, { merge: true });
    tx.create(docRef.collection('versions').doc(versionId), {
      ...input.version, versionId, label: input.label ?? versionId,
      parentVersion: current.currentVersion ?? null, publishedAt: timestamp,
    });
    if (current.visibility === 'public') {
      tx.update(publicRef, {
        title: input.title, slug: input.slug, trusted: true, currentVersion: versionId, liveEpoch,
        entry: input.version.entry ?? 'index.html', format: input.version.format === 'markdown' ? 'markdown' : 'html',
        sourceEntry: typeof input.version.sourceEntry === 'string' ? input.version.sourceEntry : null,
        fileCount: Number.isSafeInteger(input.version.fileCount) && input.version.fileCount > 0 ? input.version.fileCount : 1,
        publishedAt: timestamp,
      });
    } else if (projection.exists) tx.delete(publicRef);
    attempted = { duplicate: false, versionId, membership, existed: snap.exists, retiredEpoch, draftPrefix };
    return attempted;
  });
}

/** Fence old clients before removing only the log and draft captured by a committed replacement. */
export async function finishOperatorReplacement(docId, result, { bucket, project, mirror = syncPresenceAccess, database = () => getRtdb(project) }) {
  if (result.duplicate) return;
  const { retiredEpoch, draftPrefix } = result;
  if (typeof retiredEpoch !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(retiredEpoch)) throw new Error('invalid retired live editing epoch');
  await mirror(docId, result.membership?.members ?? [], result.membership?.editorMembers ?? [], project);
  const rtdb = database();
  if (rtdb) {
    await rtdb.ref(`status/${docId}/y/${retiredEpoch}`).remove();
    if (retiredEpoch === 'initial') {
      const root = rtdb.ref(`status/${docId}/y`);
      const legacy = (await root.once('value')).val();
      const removed = Object.fromEntries(Object.entries(legacy ?? {}).filter(([, value]) => typeof value === 'string').map(([key]) => [key, null]));
      if (Object.keys(removed).length) await root.update(removed);
    }
  }
  if (draftPrefix) await bucket.deleteFiles({ prefix: draftPrefix, force: true });
}

/**
 * Store each file's bytes once for the document, before the metadata
 * transaction competes (SPEC §4). Create-only: a 412 means those bytes are
 * already stored, which is the point. Nothing here is ever deleted on a
 * refusal, since another version may name the same file.
 */
export async function storeOperatorFiles(bucket, docId, files) {
  const done = new Set();
  let written = 0;
  for (const file of files) {
    const sha256 = sha256Hex(file.data);
    if (done.has(sha256)) continue;
    done.add(sha256);
    try {
      await bucket.file(blobKey(docId, sha256)).save(file.data, {
        contentType: mime.getType(file.rel) || 'application/octet-stream',
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      written += 1;
    } catch (error) {
      if (error?.code !== 412) throw error;
    }
  }
  return written;
}
