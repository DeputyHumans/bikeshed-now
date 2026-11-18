// SPDX-License-Identifier: Apache-2.0
// Reading a version's bytes in tests, through the resolver every reader uses (SPEC §4).

const { versionObjectKey } = require("../lib/lib/storage.js");
const { hashBundleListing, sha256Hex } = require("../lib/lib/hash.js");

/** The bytes a version holds at `rel`, in whichever layout it was stored, or undefined. */
function versionBytes(objects, docId, versionId, record, rel) {
  const key = versionObjectKey(docId, versionId, record ?? {}, rel);
  return key ? objects.get(key) : undefined;
}

/** The v2 content hash of in-memory files `{rel, data}` (SPEC §9.1). */
function listedHash(files) {
  return hashBundleListing(files.map((f) => ({ rel: f.rel, size: f.data.length, sha256: sha256Hex(f.data) }))).contentHash;
}

module.exports = { versionBytes, listedHash };
