// SPDX-License-Identifier: Apache-2.0
// Atomic operator sharing and version records, with current membership dependencies (SPEC §9, §13, §18).

import { randomUUID } from 'node:crypto';
import mime from 'mime';
import { GRANT_LIST, computeMembership, grantLists, grantsOf, loadFolderMembership, loadTeamIndex } from './membership.mjs';

/** Adapt the existing read-only membership loaders to this transaction. */
function reader(db, tx) {
  return { collection: (name) => ({ doc: (id) => ({ get: () => tx.get(db.collection(name).doc(id)) }) }) };
}

async function effective(db, tx, current, grants, ownerEmail) {
  const reads = reader(db, tx);
  const parent = await loadFolderMembership(reads, current.folderId ?? null);
  const teams = await loadTeamIndex(reads, ...grantLists(grants));
  return computeMembership(ownerEmail, grants, parent, teams);
}

/** Apply one CLI delta to the current record; a read-only --list writes nothing. */
export async function persistOperatorAccess(db, docRef, { add, remove, role }, timestamp) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error(`document not found: ${docRef.path}`);
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
    if (add.length || remove.length) tx.set(docRef, { ...grants, ...membership, updatedAt: timestamp }, { merge: true });
    return { ownerEmail, folderId: current.folderId ?? null, grants, membership };
  });
}

/** Select a version only after upload; losing attempts never modify another version. */
export async function commitOperatorVersion(db, docRef, input, timestamp) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const versions = await tx.get(docRef.collection('versions'));
    const duplicate = versions.docs.find((version) => version.data().contentHash === input.version.contentHash);
    if (duplicate) return { duplicate: true, versionId: duplicate.id };
    const current = snap.data() || {};
    if (snap.exists !== input.existed || (current.currentVersion ?? null) !== input.baseVersion) {
      throw new Error('document advanced while uploading; rerun against its current version');
    }
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
    tx.set(docRef, {
      docId: docRef.id, title: input.title, slug: input.slug,
      ...(snap.exists ? {} : { ownerUid: null, ownerEmail: input.ownerEmail, createdAt: timestamp, visibility: 'private', publicEdit: false, folderId: null }),
      ...grants, ...membership, currentVersion: versionId, trusted: true, updatedAt: timestamp,
    }, { merge: true });
    tx.create(docRef.collection('versions').doc(versionId), {
      ...input.version, versionId, label: input.label ?? versionId,
      parentVersion: current.currentVersion ?? null, publishedAt: timestamp,
    });
    return { duplicate: false, versionId, membership, existed: snap.exists };
  });
}

/** Each upload owns immutable objects before its metadata transaction competes. */
export async function uploadOperatorBundle(bucket, docId, files) {
  const storagePrefix = `docs/${docId}/bundles/${randomUUID()}`;
  for (const file of files) {
    await bucket.file(`${storagePrefix}/${file.rel}`).save(file.data, {
      contentType: mime.getType(file.rel) || 'application/octet-stream',
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  }
  return storagePrefix;
}
