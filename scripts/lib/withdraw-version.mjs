// SPDX-License-Identifier: Apache-2.0
// Guarded version repointing and exact object ownership for operator withdrawal (SPEC §9, §17).

import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { FieldValue } from './firebase.mjs';
import { freshReceiptId, readReceipt, recordReceipt, clearReceipt } from './transaction-receipts.mjs';

export function withdrawalPrefix(docId, versionId, record) {
  if (!/^[a-zA-Z0-9_-]+$/.test(docId) || !/^(v[0-9]+|draft)$/.test(versionId)) throw new Error('invalid withdrawal prefix');
  const prefix = record?.storagePrefix ?? `docs/${docId}/${versionId}`;
  const legacy = `docs/${docId}/${versionId}`;
  const bundle = `docs/${docId}/bundles/`;
  if (typeof prefix !== 'string' || (prefix !== legacy && !(prefix.startsWith(bundle) && /^[a-zA-Z0-9_-]+$/.test(prefix.slice(bundle.length)))) ) {
    throw new Error('invalid withdrawal storage prefix');
  }
  return `${prefix}/`;
}

export async function repointWithdrawal(db, docRef, plan, deleteField = () => FieldValue.delete()) {
  const liveEpoch = randomUUID();
  const receipt = freshReceiptId();
  const result = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) throw new Error('the document disappeared mid-run');
    const data = fresh.data();
    // A later publication may replace the head and epoch before native retry.
    // The bounded operation receipt still proves this retirement completed.
    const committed = readReceipt(fresh, receipt);
    if (committed.found) return committed.result;
    const retiredEpoch = data.liveEpoch ?? 'initial';
    if (typeof retiredEpoch !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(retiredEpoch)) throw new Error('invalid live editing epoch');
    if (data.currentVersion !== plan.currentVersion) throw new Error('currentVersion changed mid-run; aborted without deleting anything');
    if (!isDeepStrictEqual(data.draft ?? null, plan.draft ?? null)) throw new Error('draft changed mid-run; aborted without deleting anything');
    const doomed = await tx.get(docRef.collection('versions').doc(plan.doomed));
    const repoint = await tx.get(docRef.collection('versions').doc(plan.repoint));
    if (!doomed.exists || !repoint.exists) throw new Error('a version disappeared mid-run; aborted without deleting anything');
    const prefix = withdrawalPrefix(docRef.id, plan.doomed, doomed.data());
    if (prefix !== withdrawalPrefix(docRef.id, plan.doomed, plan.version)) throw new Error('version bytes changed mid-run; aborted without deleting anything');
    const draftPrefix = plan.draft ? withdrawalPrefix(docRef.id, 'draft', plan.draft) : null;
    const versions = await tx.get(docRef.collection('versions'));
    for (const version of versions.docs) {
      if (version.id === plan.doomed) continue;
      const retained = withdrawalPrefix(docRef.id, version.id, version.data());
      if (retained === prefix || retained === draftPrefix) throw new Error('withdrawal bytes are still referenced by another version');
    }
    const publicRef = db.collection('public').doc(docRef.id);
    const projection = await tx.get(publicRef);
    if (data.visibility === 'public' && !projection.exists) throw new Error('public projection is missing; repair it before withdrawing');
    const version = repoint.data();
    const update = { currentVersion: plan.repoint, liveEpoch, updatedAt: version.publishedAt ?? null };
    if (plan.draft) update.draft = deleteField();
    if (data.thumb?.versionId === plan.doomed) update.thumb = deleteField();
    if (!plan.keepStats) {
      update['stats.commits'] = Math.max(0, Number(data.stats?.commits ?? 0) - 1);
      if (update['stats.commits'] === 0) {
        update['stats.lastEditedAt'] = deleteField();
        update['stats.lastEditedByEmail'] = deleteField();
      }
    }
    const result = { retiredEpoch, draftPrefix };
    recordReceipt(tx, docRef, fresh, receipt, result);
    tx.update(docRef, update);
    if (data.visibility === 'public') {
      tx.update(publicRef, {
        currentVersion: plan.repoint, liveEpoch, entry: version.entry ?? 'index.html', format: version.format === 'markdown' ? 'markdown' : 'html',
        sourceEntry: typeof version.sourceEntry === 'string' ? version.sourceEntry : null,
        fileCount: Number.isSafeInteger(version.fileCount) && version.fileCount > 0 ? version.fileCount : 1,
        publishedAt: version.publishedAt ?? null,
      });
    } else if (projection.exists) tx.delete(publicRef);
    return result;
  });
  await clearReceipt(docRef, receipt);
  return result;
}
