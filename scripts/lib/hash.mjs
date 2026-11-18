// SPDX-License-Identifier: Apache-2.0
// Deterministic content hash over a bundle, by bytes (v1) or by file list (v2) (SPEC §9.1).
//
// Copyright 2026 Bikeshed contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// The FULL notice is here, rather than the one-line identifier the rest of this
// codebase uses, because this file is a normative wire format that somebody may
// reimplement from scratch in another language — and when it is copied out on
// its own, the LICENSE at the repository root does not travel with it.

/**
 * The ESM half of a two-runtime pair; `functions/src/lib/hash.ts` is the
 * CommonJS half. They MUST produce a byte-identical contentHash for the same
 * (relpath, bytes) set, or a document published from the CLI and the same
 * document committed in the app stop deduplicating and idempotency dies
 * silently — no error, just a v2 that should have been a no-op.
 *
 * Both are asserted against a SHARED GOLDEN FIXTURE, never against each other:
 * a port-vs-port comparison drifts together, a fixture does not.
 *
 * Two framings, both frozen in SPEC §9.1. Files are sorted ascending by POSIX
 * relative path, compared as UTF-16 code units (JavaScript's `<`), in both.
 *
 *   v1, over the bytes:
 *     per file: UInt32BE(relpath utf8 length) || UInt32BE(data length)
 *               || utf8(relpath) || data
 *
 *   v2, over the file list:
 *     "bikeshed-bundle-v2" || 0x00, then
 *     per file: UInt32BE(relpath utf8 length) || UInt32BE(data length)
 *               || utf8(relpath) || SHA-256(data), 32 raw bytes
 *
 * The length prefix is what makes each framing injective. Plain concatenation
 * collides: a file "a b" containing "c" and a file "a" containing " bc" produce
 * the same byte stream. The fixed-width digest keeps v2 injective the same way,
 * and its leading tag keeps a v2 hash from ever being read as a v1 hash.
 *
 * New versions are hashed with v2, from the file list they record; versions
 * minted before it keep their v1 hash (SPEC §4).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Recursively list a bundle directory, sorted by POSIX relpath. */
export function listBundleFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`bundle dir not found or not a directory: ${dir}`);
  }
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out
    .map((abs) => ({ abs, rel: relative(dir, abs).split(sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The order both framings hash in: UTF-16 code units, which is JavaScript's `<`. */
export function byPath(a, b) {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/** v1: hash a set of in-memory files, over every byte. */
export function hashBundleFiles(files) {
  const sorted = [...files].sort(byPath);
  const h = createHash("sha256");
  let bytes = 0;
  for (const f of sorted) {
    bytes += f.data.length;
    const relBuf = Buffer.from(f.rel, "utf8");
    const frame = Buffer.allocUnsafe(8);
    frame.writeUInt32BE(relBuf.length, 0);
    frame.writeUInt32BE(f.data.length, 4);
    h.update(frame);
    h.update(relBuf);
    h.update(f.data);
  }
  return { contentHash: h.digest("hex"), fileCount: sorted.length, bytes };
}

/** Hash a bundle directory on disk. */
export function hashBundle(dir) {
  const entries = listBundleFiles(dir);
  if (entries.length === 0) throw new Error(`bundle dir is empty: ${dir}`);
  const files = entries.map((f) => ({ rel: f.rel, data: readFileSync(f.abs) }));
  return { ...hashBundleFiles(files), files: entries };
}

const V2_TAG = Buffer.from("bikeshed-bundle-v2\0", "utf8");
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** SHA-256 of one file's bytes, lowercase hex, as a version lists it. */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** v2: hash a file list of `{rel, size, sha256}`, without the bytes. */
export function hashBundleListing(files) {
  const sorted = [...files].sort(byPath);
  const h = createHash("sha256");
  h.update(V2_TAG);
  let bytes = 0;
  for (const f of sorted) {
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > 0xffffffff) throw new Error(`hash: bad size for ${f.rel}`);
    if (!SHA256_HEX.test(f.sha256)) throw new Error(`hash: bad digest for ${f.rel}`);
    bytes += f.size;
    const relBuf = Buffer.from(f.rel, "utf8");
    const frame = Buffer.allocUnsafe(8);
    frame.writeUInt32BE(relBuf.length, 0);
    frame.writeUInt32BE(f.size, 4);
    h.update(frame);
    h.update(relBuf);
    h.update(Buffer.from(f.sha256, "hex"));
  }
  return { contentHash: h.digest("hex"), fileCount: sorted.length, bytes };
}

/** The file list of in-memory files, for `hashBundleListing`. */
export function listingOf(files) {
  return files.map((f) => ({ rel: f.rel, size: f.data.length, sha256: sha256Hex(f.data) }));
}
