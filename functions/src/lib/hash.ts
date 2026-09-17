// SPDX-License-Identifier: Apache-2.0
// Deterministic content hash over a set of in-memory bundle files (SPEC §9.1).
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
 * This is the CommonJS half of a two-runtime pair; `scripts/lib/hash.mjs` is the
 * ESM half. They exist separately because Cloud Functions is CommonJS and the
 * operator scripts are ESM, and neither can import the other.
 *
 * They MUST produce a byte-identical `contentHash` for the same (relpath, bytes)
 * set. If they drift, a document published from the CLI and the same document
 * committed in the app stop deduplicating, and idempotency dies silently — no
 * error, just a v2 that should have been a no-op.
 *
 * Both are asserted against a SHARED GOLDEN FIXTURE
 * (`functions/test/fixtures/hash-vectors.json`), never against each other. A
 * port-vs-port comparison drifts together; a fixture does not.
 *
 * Framing, frozen in SPEC §9.1:
 *   files sorted ascending by POSIX relative path
 *   per file: UInt32BE(relpath utf8 length) || UInt32BE(data length)
 *             || utf8(relpath) || data
 *
 * The length prefix is what makes the framing injective. Plain concatenation
 * collides: a file named "a b" with content "c" and a file named "a" with
 * content " bc" produce the same byte stream.
 */

import { createHash } from "crypto";

export interface BundleFile {
  /** POSIX-style path relative to the bundle root. */
  rel: string;
  data: Buffer;
}

export interface BundleHash {
  contentHash: string;
  fileCount: number;
  bytes: number;
}

export function hashBundleFiles(files: BundleFile[]): BundleHash {
  const sorted = [...files].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );
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
