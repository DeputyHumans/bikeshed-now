// SPDX-License-Identifier: Apache-2.0
// Deterministic content hash over a bundle directory (SPEC §9.1).

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
 * Framing, frozen in SPEC §9.1:
 *   files sorted ascending by POSIX relative path
 *   per file: UInt32BE(relpath utf8 length) || UInt32BE(data length)
 *             || utf8(relpath) || data
 *
 * The length prefix is what makes the framing injective. Plain concatenation
 * collides: a file "a b" containing "c" and a file "a" containing " bc" produce
 * the same byte stream.
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

/** Hash a set of in-memory files. The normative implementation. */
export function hashBundleFiles(files) {
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

/** Hash a bundle directory on disk. */
export function hashBundle(dir) {
  const entries = listBundleFiles(dir);
  if (entries.length === 0) throw new Error(`bundle dir is empty: ${dir}`);
  const files = entries.map((f) => ({ rel: f.rel, data: readFileSync(f.abs) }));
  return { ...hashBundleFiles(files), files: entries };
}
