// SPDX-License-Identifier: Apache-2.0
// Capture and compare the exact saved publication state when review refuses a commit (SPEC §6a, §19, §22).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { draftStoragePrefix, listObjects, readCollection, readDoc, readObject } from "./admin.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

/** Only the complete documented review refusal is a safe serialization result. */
export function isPublicationReviewRefusal(answer) {
  if (answer?.status !== 200 || answer.isError !== true || typeof answer.text !== "string") return false;
  if (answer.text === "Resolve all comments before publishing a new version.") return true;
  const match = /^([1-9]\d*) suggested edits? /.exec(answer.text);
  if (!match) return false;
  const singular = match[1] === "1";
  const expected = `${match[1]} suggested ${singular ? "edit is" : "edits are"} waiting for a decision. Only the owner or an approver can accept or reject ${singular ? "it" : "them"}, and no new version can be published until then. ${singular ? "If it is yours, you may withdraw it." : "Any that are yours you may withdraw."}`;
  return answer.text === expected;
}

/** Direct object bytes, never metadata alone or the current content proxy. */
async function inventory(target, prefix) {
  return Promise.all((await listObjects(target, `${prefix}/`)).map(async key => {
    const bytes = await readObject(target, key);
    assert.ok(bytes, `C14 publication inventory: listed object ${key} can be read`);
    return { key, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
}

/** Version metadata and draft metadata choose their own immutable object paths. */
export async function publicationSnapshot(target, docId) {
  const meta = await readDoc(target, `docs/${docId}`);
  assert.ok(meta, "C14 publication inventory: the document exists");
  const records = (await readCollection(target, `docs/${docId}/versions`)).sort((a, b) => a.id.localeCompare(b.id));
  const versions = await Promise.all(records.map(async ({ id, data }) => {
    const prefix = draftStoragePrefix(docId, { storagePrefix: data.storagePrefix ?? `docs/${docId}/${id}` });
    return { id, metadata: plain(data), objects: await inventory(target, prefix) };
  }));
  return {
    currentVersion: meta.currentVersion,
    liveEpoch: Object.hasOwn(meta, "liveEpoch") ? { present: true, value: meta.liveEpoch } : { present: false },
    draft: meta.draft ? plain(meta.draft) : null,
    versions,
    draftObjects: meta.draft ? await inventory(target, draftStoragePrefix(docId, meta.draft)) : [],
  };
}

/** A baseline must contain actual version and saved-draft bytes; empty lists prove nothing. */
export function assertPublicationBaseline(snapshot) {
  assert.equal(snapshot.currentVersion, "v1", "C14 publication baseline starts on v1");
  assert.deepEqual(snapshot.versions.map(v => v.id), ["v1"], "C14 publication baseline has exactly v1");
  assert.ok(snapshot.draft?.entry, "C14 publication baseline has a saved draft entry");
  for (const [label, entry, objects] of [
    ["version", snapshot.versions[0]?.metadata.entry, snapshot.versions[0]?.objects],
    ["draft", snapshot.draft.entry, snapshot.draftObjects],
  ]) {
    assert.ok(entry && objects?.some(o => o.key.endsWith(`/${entry}`)), `C14 publication baseline has the actual ${label} entry bytes`);
    assert.ok(objects.every(o => Number.isSafeInteger(o.size) && o.size >= 0 && /^[a-f0-9]{64}$/.test(o.sha256)), `C14 publication baseline has complete ${label} byte digests`);
  }
}

/** Refusing review never consumes or mutates a saved draft or existing version. */
export function assertPublicationPreserved(before, after) {
  assert.equal(after.currentVersion, before.currentVersion, "C14 refusal preserves the current version");
  assert.deepEqual(after.liveEpoch, before.liveEpoch, "C14 refusal preserves the live editing epoch");
  assert.deepEqual(after.draft, before.draft, "C14 refusal preserves exact draft metadata");
  assert.deepEqual(after.draftObjects, before.draftObjects, "C14 refusal preserves exact draft object bytes and paths");
  assert.deepEqual(after.versions.map(({ id, metadata }) => ({ id, metadata })), before.versions.map(({ id, metadata }) => ({ id, metadata })), "C14 refusal preserves every version and its exact metadata");
  assert.deepEqual(after.versions.map(({ id, objects }) => ({ id, objects })), before.versions.map(({ id, objects }) => ({ id, objects })), "C14 refusal preserves exact version object bytes and paths");
}
