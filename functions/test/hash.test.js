// SPDX-License-Identifier: Apache-2.0
// The content hash is a wire format shared by two runtimes (SPEC §9.1).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { hashBundleFiles, hashBundleListing, sha256Hex } = require("../lib/lib/hash.js");

const VECTORS = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "hash-vectors.json"), "utf8"),
);
// v2's expected hashes were computed by an implementation outside this
// repository's code, so neither runtime is checked against the other.
const VECTORS_V2 = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "hash-vectors-v2.json"), "utf8"),
);

function materialize(vector) {
  return vector.files.map((f) => ({ rel: f.rel, data: Buffer.from(f.utf8, "utf8") }));
}

test("CommonJS implementation matches every golden vector", () => {
  for (const vector of VECTORS) {
    const got = hashBundleFiles(materialize(vector));
    assert.equal(got.contentHash, vector.contentHash, vector.name);
    assert.equal(got.fileCount, vector.fileCount, `${vector.name}: fileCount`);
    assert.equal(got.bytes, vector.bytes, `${vector.name}: bytes`);
  }
});

test("ESM implementation matches every golden vector", async () => {
  // Dynamic import of the ESM twin from the CommonJS suite. Both are compared
  // to the FIXTURE, never to each other: two ports compared to one another
  // drift together and the test keeps passing.
  const esm = await import("../../scripts/lib/hash.mjs");
  for (const vector of VECTORS) {
    const got = esm.hashBundleFiles(materialize(vector));
    assert.equal(got.contentHash, vector.contentHash, vector.name);
  }
});

function listed(vector, digest) {
  return vector.files.map((f) => {
    const data = Buffer.from(f.utf8, "utf8");
    return { rel: f.rel, size: data.length, sha256: digest(data) };
  });
}

test("v2: CommonJS implementation matches every golden vector", () => {
  for (const vector of VECTORS_V2) {
    const got = hashBundleListing(listed(vector, sha256Hex));
    assert.equal(got.contentHash, vector.contentHash, vector.name);
    assert.equal(got.fileCount, vector.fileCount, `${vector.name}: fileCount`);
    assert.equal(got.bytes, vector.bytes, `${vector.name}: bytes`);
  }
});

test("v2: ESM implementation matches every golden vector", async () => {
  const esm = await import("../../scripts/lib/hash.mjs");
  for (const vector of VECTORS_V2) {
    const got = esm.hashBundleListing(listed(vector, esm.sha256Hex));
    assert.equal(got.contentHash, vector.contentHash, vector.name);
    assert.equal(got.bytes, vector.bytes, `${vector.name}: bytes`);
  }
});

test("v2 never equals v1 for the same files, and both cover the same vectors", () => {
  assert.deepEqual(VECTORS_V2.map((v) => v.name), VECTORS.map((v) => v.name));
  for (const [i, vector] of VECTORS_V2.entries()) assert.notEqual(vector.contentHash, VECTORS[i].contentHash, vector.name);
});

test("v2 refuses a malformed digest or size rather than hashing it", () => {
  assert.throws(() => hashBundleListing([{ rel: "a", size: 1, sha256: "AB" }]), /bad digest/);
  assert.throws(() => hashBundleListing([{ rel: "a", size: -1, sha256: "0".repeat(64) }]), /bad size/);
});

test("input order does not affect the digest", () => {
  const files = [
    { rel: "b.css", data: Buffer.from("body{}") },
    { rel: "a.html", data: Buffer.from("<p>a</p>") },
  ];
  const forward = hashBundleFiles(files).contentHash;
  const reversed = hashBundleFiles([...files].reverse()).contentHash;
  assert.equal(forward, reversed);
});

test("hashing does not mutate its input", () => {
  const files = [
    { rel: "b.css", data: Buffer.from("body{}") },
    { rel: "a.html", data: Buffer.from("<p>a</p>") },
  ];
  hashBundleFiles(files);
  assert.deepEqual(
    files.map((f) => f.rel),
    ["b.css", "a.html"],
  );
});

test("the framing is injective across an ambiguous split", () => {
  // Without the length prefix, ("a b", "c") and ("a", " bc") concatenate to the
  // same bytes. This is the specific collision the framing exists to prevent.
  const one = hashBundleFiles([{ rel: "a b", data: Buffer.from("c") }]).contentHash;
  const two = hashBundleFiles([{ rel: "a", data: Buffer.from(" bc") }]).contentHash;
  assert.notEqual(one, two);
});

test("an empty bundle hashes without throwing", () => {
  const got = hashBundleFiles([]);
  assert.equal(got.fileCount, 0);
  assert.equal(got.bytes, 0);
  assert.match(got.contentHash, /^[0-9a-f]{64}$/);
});
