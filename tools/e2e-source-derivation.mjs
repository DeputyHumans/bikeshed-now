// SPDX-License-Identifier: Apache-2.0
// Verify explicitly reviewed harness-only source derivatives while preserving each proof's actual full-tree fingerprint (SPEC §12).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const need = (ok, why) => { if (!ok) throw new Error(`source derivation: ${why}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
// These exact bytes were reviewed as diagnostics-only changes; no application, dependency,
// scenario, trial, assertion, timeout, JVM limit or runtime derivation change is permitted.
export const FIRESTORE_MAINTENANCE_DELTA = Object.freeze([
  ['CHANGELOG.md', 'fd92b5f1165cc6a711a89cca7efe786c486a1e5307f631ad716082dbef45aa30', 'e72af4b438db72f3d25d72d8a78a88e12aaa45388f7cda507ee4f0606bd6c900'],
  ['e2e/README.md', 'c184e923060eef36ae62d776937bd3926401165d7f4a5fad1601d1337a3972f3', 'b9508a95c9cf55e3707eee735dd306bbf8462bfad3b0854bc9b0b2c96469205b'],
  ['e2e/lib/firestore-coverage.mjs', null, '972231335d6979e397e36631f618311efcecc06e008bdbbe2aa5f78bda68e9c2'],
  ['e2e/lib/test.mjs', '1cfdaf855d8c276280fad8de150aa3700f991f8a13cc6558128dbe6113a93e86', 'cc18bcce9e00d5bee16ff303bbd6dec584d9c028920c610aadf2e9fff352eb02'],
  ['e2e/selftest/firestore-coverage.test.mjs', null, 'ac32f6ee99685089636acb4a973f1f04323610636fda1d83021a8d35669a054a'],
].map(Object.freeze));

// Exact idle transport cleanup overlay; v1 remains valid for its earlier proofs.
export const FIRESTORE_CHANNEL_KIND = 'firestore-idle-channel-cleanup-v2';
export const CONTROLLED_READER_CHANNEL_KIND = 'firestore-idle-channel-controlled-reader-rounds-v2';
export const FIRESTORE_CHANNEL_DELTA = Object.freeze([
  [
    "CHANGELOG.md",
    "fd92b5f1165cc6a711a89cca7efe786c486a1e5307f631ad716082dbef45aa30",
    "d5035ab864c695bddf0feeed5f0f9e9447a3f64504aa32de5bdce2f3664bea53"
  ],
  [
    "e2e/README.md",
    "c184e923060eef36ae62d776937bd3926401165d7f4a5fad1601d1337a3972f3",
    "028c9a3fa6666190de7e1a0a8e1031706f148561d2b24d6b056221fdfa4cbc2c"
  ],
  [
    "e2e/lib/browser.mjs",
    "5fd3b5caddda983aa45a9780b7ce18ccccd1b70e820f8af107e3ec308286049a",
    "df5357b5c764d34b383d93d0983ab290f245f4d29ada0a61cfea7ead679a2af9"
  ],
  [
    "e2e/lib/firestore-channels.mjs",
    null,
    "964e7199c66070c8b8a8f6e47a15f4a1340320e8c02ad2513ea85b8c3d5aab88"
  ],
  [
    "e2e/lib/firestore-coverage.mjs",
    null,
    "cb99e5d63baf067cb8f58499cb21ed1046b85158e316d370b12770d8f38018aa"
  ],
  [
    "e2e/lib/test.mjs",
    "1cfdaf855d8c276280fad8de150aa3700f991f8a13cc6558128dbe6113a93e86",
    "cc18bcce9e00d5bee16ff303bbd6dec584d9c028920c610aadf2e9fff352eb02"
  ],
  [
    "e2e/selftest/firestore-channels.test.mjs",
    null,
    "80751f9f7f667cc742b8889286ec6c11163f23f67d7055e33875cae6dd39139a"
  ],
  [
    "e2e/selftest/firestore-coverage.test.mjs",
    null,
    "ac32f6ee99685089636acb4a973f1f04323610636fda1d83021a8d35669a054a"
  ]
].map(Object.freeze));

// Exact v3 idle barrier repair; previous v1/v2 proofs retain their actual profiles.
export const FIRESTORE_BARRIER_KIND = 'firestore-idle-removal-barrier-v3';
export const CONTROLLED_READER_BARRIER_KIND = 'firestore-idle-barrier-controlled-reader-rounds-v3';
const barrierDigests = Object.freeze({
  "CHANGELOG.md": "bdd18ffe7851bb8a9fb3d2c864bf5c633919ea2bb5a6edff30e850eb0790c84e",
  "e2e/README.md": "b27433d28494aea08816ecc0aaf3f686dd6dd920282bda264c91c7a093fcf5d6",
  "e2e/lib/firestore-channels.mjs": "7ed80892bd85b1d5e183583147d5eadd47c152d98740598ba61f8b2e990ac310",
  "e2e/selftest/firestore-channels.test.mjs": "80beead1e3eb136ee887c87072e03181c8c0ded85284906b70ea4d597e67e61b"
});
export const FIRESTORE_BARRIER_DELTA = Object.freeze(FIRESTORE_CHANNEL_DELTA.map(([path, before, after]) => Object.freeze([path, before, barrierDigests[path] ?? after])));

// Exact C7 admission recovery: explicit reload before typing, with every
// existing oracle and participant/trial declaration retained.
export const DRAFT_ADMISSION_KIND = 'firestore-idle-barrier-draft-admission-v4';
const admissionDigests = Object.freeze({
  'CHANGELOG.md': '89a29c407147b45f1b7552f7bbe69b9ee73b397dd9d2abcd7bce90ad3881d4b4',
  'e2e/README.md': '383f2204fa9e51b8f750e82b8d751430b9785cc7c9f0b56fccbdb6f6e634c9ef',
});
export const DRAFT_ADMISSION_DELTA = Object.freeze([
  ...FIRESTORE_BARRIER_DELTA.map(([path, before, after]) => [path, before, admissionDigests[path] ?? after]),
  ['e2e/specs/concurrency/c05-structure.spec.mjs', 'ff829eadf25a3c16685bd8e1f9cc1fc3ea8b9445009b60f1b29b3efdbeec7287', '8d5a5a248c0a8b06bea2349182eca2ca31af82b93da61efaa3796e32fb57f293'],
  ['e2e/lib/draft-admission.mjs', null, '8948986714fc5dba7a0fb6acc642992c3baef75e60b40b561d188e672630bf4c'],
  ['e2e/selftest/draft-admission.test.mjs', null, 'bb24c5510f0bceaded1c3b65dba4e1d45f4cf2c195f983b3d72ab7597f4a5945'],
].map(Object.freeze));

export const DONE_RETRY_KIND = 'firestore-idle-barrier-done-retry-v5';
export const DONE_RETRY_DELTA = Object.freeze([...DRAFT_ADMISSION_DELTA, Object.freeze(["e2e/specs/concurrency/c06-leave-commit.spec.mjs", "27d791d9acee18b19765e2aa321c7e189523f0bdef630aca94fe2e986d5f8e8c", "88c42b1e006278732119281dcb00f4cd7e861bc4fb9f131c95b3012da5fba96e"])]);

// Passive bounded inspector retention only; prior proofs keep their original source profiles.
export const DURABLE_RESPONSE_KIND = 'firestore-durable-response-v6';
export const CONTROLLED_READER_RESPONSE_KIND = 'firestore-durable-response-controlled-reader-v4';
const durableDigests = Object.freeze({
  'e2e/lib/browser.mjs': 'bcbb1432a9613352a513abdb2264618021461a2d100f35e31bab04b0f30b8527',
  'e2e/lib/firestore-channels.mjs': '9115325d915e9d9cd7e8f79ef9ff373df89e5d418363c67820ff4d02af6d55a8',
});
const durableDelta = base => Object.freeze([
  ...base.map(([path, before, after]) => Object.freeze([path, before, durableDigests[path] ?? after])),
  Object.freeze(['e2e/selftest/firestore-response-retention.test.mjs', null, 'c321a8761dfef95ee6fd857efbd9d81f871c0a45e7c03a5f1fd2fa4a7cf96518']),
]);
export const DURABLE_RESPONSE_DELTA = durableDelta(DONE_RETRY_DELTA);
export const CONTROLLED_READER_RESPONSE_DELTA = durableDelta(FIRESTORE_BARRIER_DELTA);


// Exact C8 transport dispatch repair: all gate, trial and product oracles remain unchanged.
export const MINT_DISPATCH_KIND = 'firestore-durable-response-mint-dispatch-v7';
export const MINT_DISPATCH_DELTA = Object.freeze([...DURABLE_RESPONSE_DELTA,
  Object.freeze(['e2e/specs/concurrency/c08-mint-races.spec.mjs', '885590c2d9dfccd16685352fe261d0e9bfa911e505a7dad86452c862590e35a4', 'a5b7e3d11faa41dcffd0ec08fcbd29c83dbf5c426744a405e0e61d7e8a6b6251']),
  Object.freeze(['e2e/selftest/mint-race-dispatch.test.mjs', null, '93db7845434e380d9469f248e618bec009fa2f418addeeb4bfd0e4ab4a9ab67e']),
]);

// Reviewed scheduling overlay only: simultaneous token rounds share the original quiet
// interval. Actor count, tokens, trials, delays, holds and all assertions are unchanged.
export const CONTROLLED_READER_DELTA = Object.freeze([
  'e2e/specs/concurrency/c18-scale-ui.spec.mjs',
  '4922783cb3ec08737cf1e867d859a4eb4f234423ba895756b9d73e724ea291b6',
  '2068bb5a69c1af78ac408b2538cf21901a9322e85973076a32b543c0138ec157',
]);
export const CONTROLLED_READER_KIND = 'firestore-recycle-controlled-reader-rounds-v1';

export function manifestFingerprint(manifest) {
  need(Array.isArray(manifest?.files) && manifest.files.length > 0, 'complete file inventory required');
  const paths = manifest.files.map(row => row.path);
  need(paths.every(path => typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(x => ['', '.', '..'].includes(x))), 'noncanonical source path');
  assert.deepEqual(paths, [...new Set(paths)].sort(), 'source derivation: source inventory must be unique and sorted');
  need(manifest.files.every(row => HASH.test(row.sha256) || /^link:.+/.test(row.sha256)), 'invalid source digest');
  const digest = hash(manifest.files.map(row => `${row.path}\0${row.sha256}\n`).join(''));
  need(manifest.snapshot?.fingerprint === digest && manifest.snapshot.files === manifest.files.length, 'manifest fingerprint or file count differs');
  return digest;
}

export function verifySourceDerivation(acceptance, actual, baseline, candidate, kind) {
  need(['firestore-diagnostic-recycle-v1', CONTROLLED_READER_KIND, FIRESTORE_CHANNEL_KIND, CONTROLLED_READER_CHANNEL_KIND, FIRESTORE_BARRIER_KIND, CONTROLLED_READER_BARRIER_KIND, DRAFT_ADMISSION_KIND, DONE_RETRY_KIND, DURABLE_RESPONSE_KIND, CONTROLLED_READER_RESPONSE_KIND, MINT_DISPATCH_KIND].includes(kind), 'unreviewed derivative kind');
  manifestFingerprint(baseline); manifestFingerprint(candidate);
  for (const field of ['revision', 'version', 'fingerprint']) {
    need(baseline.snapshot[field] === acceptance[field], `baseline ${field} differs`);
    need(candidate.snapshot[field] === actual[field], `candidate ${field} differs`);
  }
  for (const field of ['revision', 'version']) need(actual[field] === acceptance[field], `derivative ${field} differs`);
  const before = new Map(baseline.files.map(row => [row.path, row.sha256]));
  const after = new Map(candidate.files.map(row => [row.path, row.sha256]));
  const delta = [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path) !== after.get(path)).map(path => [path, before.get(path) ?? null, after.get(path) ?? null]);
  const controlled = [CONTROLLED_READER_KIND, CONTROLLED_READER_CHANNEL_KIND, CONTROLLED_READER_BARRIER_KIND, CONTROLLED_READER_RESPONSE_KIND].includes(kind);
  const maintenance = kind === MINT_DISPATCH_KIND ? MINT_DISPATCH_DELTA : kind === DURABLE_RESPONSE_KIND ? DURABLE_RESPONSE_DELTA : kind === CONTROLLED_READER_RESPONSE_KIND ? CONTROLLED_READER_RESPONSE_DELTA : kind === DONE_RETRY_KIND ? DONE_RETRY_DELTA : kind === DRAFT_ADMISSION_KIND ? DRAFT_ADMISSION_DELTA : [FIRESTORE_BARRIER_KIND, CONTROLLED_READER_BARRIER_KIND].includes(kind) ? FIRESTORE_BARRIER_DELTA : [FIRESTORE_CHANNEL_KIND, CONTROLLED_READER_CHANNEL_KIND].includes(kind) ? FIRESTORE_CHANNEL_DELTA : FIRESTORE_MAINTENANCE_DELTA;
  const expected = [...maintenance, ...(controlled ? [CONTROLLED_READER_DELTA] : [])].sort(([a], [b]) => a < b ? -1 : 1);
  assert.deepEqual(delta, expected, 'source derivation: bytes differ beyond the reviewed diagnostics-only delta or named controlled schedule');
  return { kind, controlled, source: actual, changes: delta };
}

function readBound(root, reference) {
  root = realpathSync(root);
  need(reference && HASH.test(reference.sha256) && typeof reference.artifact === 'string', 'manifest reference missing');
  const path = resolve(root, reference.artifact);
  need(reference.artifact.startsWith('e2e/.out/') && relative(root, path) === reference.artifact && !isAbsolute(reference.artifact), 'manifest must be contained evidence');
  need(lstatSync(path).isFile() && realpathSync(path) === path, 'manifest must be a regular contained file');
  const bytes = readFileSync(path);
  need(hash(bytes) === reference.sha256, 'manifest artifact digest differs');
  return JSON.parse(bytes);
}

/** Equality remains the default. A derivative never rewrites or inherits a baseline fingerprint. */
export function assertAcceptedSource(campaign, actual, { root } = {}) {
  const acceptance = campaign.acceptance;
  for (const field of ['revision', 'version']) need(actual?.[field] === acceptance[field], `${field} differs`);
  if (!acceptance.fingerprint || actual.fingerprint === acceptance.fingerprint) return null;
  const entries = (acceptance.sourceDerivations ?? []).filter(row => row.fingerprint === actual.fingerprint);
  need(entries.length === 1, 'source fingerprint differs and has no unique reviewed derivative');
  const entry = entries[0];
  return verifySourceDerivation(acceptance, actual, readBound(root, entry.baseline), readBound(root, entry.candidate), entry.kind);
}

export function stackSource(stack) {
  return { revision: stack.fingerprint?.baseSha, version: stack.expectVersion, fingerprint: stack.fingerprint?.sha256 };
}

/** The actual source's pinned file hashes; legacy campaigns retain strict local equality. */
export function acceptedSourceFiles(campaign, actual, { root } = {}) {
  const profile = assertAcceptedSource(campaign, actual, { root });
  const entries = campaign.acceptance.sourceDerivations ?? [];
  const entry = profile ? entries.find(row => row.fingerprint === actual.fingerprint) : entries[0];
  if (!entry) return null;
  const manifest = readBound(root, profile ? entry.candidate : entry.baseline);
  manifestFingerprint(manifest);
  for (const field of ['revision', 'version', 'fingerprint']) need(manifest.snapshot[field] === actual[field], `source inventory ${field} differs`);
  return new Map(manifest.files.map(row => [row.path, row.sha256]));
}

/** A changed executable spec needs an exact reviewed, non-controlled source delta. */
export function reviewedSpecChange(campaign, path, before, after, { root } = {}) {
  return (campaign.acceptance.sourceDerivations ?? []).some(entry => {
    const profile = assertAcceptedSource(campaign, { ...campaign.acceptance, fingerprint: entry.fingerprint }, { root });
    return profile && !profile.controlled && profile.changes.some(([file, oldHash, newHash]) =>
      file === path && (oldHash === before && newHash === after || oldHash === after && newHash === before));
  });
}
