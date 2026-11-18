// SPDX-License-Identifier: Apache-2.0
// A version's files stored once per document, for the operator scripts (SPEC §4, ADR 0036).

/**
 * The ESM side of `functions/src/lib/storage.ts`: what a stored-layout record
 * lists and where each file's bytes are. A version minted before files were
 * stored once has a prefix instead, and none of this applies to it.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DOC_ID = /^[a-zA-Z0-9_-]+$/;

/** The one object holding these bytes for this document. */
export function blobKey(docId, sha256) {
  if (!DOC_ID.test(docId) || !SHA256_HEX.test(sha256)) throw new Error("invalid stored file");
  return `docs/${docId}/blobs/${sha256}`;
}

/** True for a version whose files are stored once per document. */
export function isStoredLayout(record) {
  return record?.layout === "blobs";
}

/**
 * The files a stored-layout record lists: `{rel, sha256, size, key}`. Throws on
 * a malformed record, since the scripts act on what this returns.
 */
export function storedEntries(docId, record) {
  const { files, hashes, sizes } = record ?? {};
  if (!Array.isArray(files) || !Array.isArray(hashes) || !Array.isArray(sizes) ||
      files.length !== hashes.length || files.length !== sizes.length) {
    throw new Error(`malformed file list on a version of ${docId}`);
  }
  return files.map((rel, i) => {
    if (typeof rel !== "string" || !SHA256_HEX.test(hashes[i]) || !Number.isSafeInteger(sizes[i])) {
      throw new Error(`malformed file list on a version of ${docId}`);
    }
    return { rel, sha256: hashes[i], size: sizes[i], key: blobKey(docId, hashes[i]) };
  });
}

/**
 * The stored files only `doomed` names: what withdrawing it may delete. Every
 * other version keeps whatever it names, so a file two versions share stays.
 */
export function onlyNamedBy(docId, doomed, others) {
  if (!isStoredLayout(doomed)) return { deletes: [], keeps: [] };
  const usedBy = new Map();
  for (const { id, record } of others) {
    if (!isStoredLayout(record)) continue;
    for (const f of storedEntries(docId, record)) {
      if (!usedBy.has(f.sha256)) usedBy.set(f.sha256, new Set());
      usedBy.get(f.sha256).add(id);
    }
  }
  const deletes = new Map();
  const keeps = new Map();
  for (const f of storedEntries(docId, doomed)) {
    const users = usedBy.get(f.sha256);
    const into = users ? keeps : deletes;
    if (!into.has(f.sha256)) into.set(f.sha256, { sha256: f.sha256, key: f.key, size: f.size, paths: [], ...(users ? { usedBy: [...users].sort() } : {}) });
    into.get(f.sha256).paths.push(f.rel);
  }
  return { deletes: [...deletes.values()], keeps: [...keeps.values()] };
}

/** How long a withdrawal's mark holds back a publish that would reuse a file it is deleting. */
export const WITHDRAWING_HOLD_MS = 60 * 60 * 1000;
