// SPDX-License-Identifier: Apache-2.0
// Share immutable artifact bytes within one campaign verification while preserving per-proof checks (SPEC §12).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const caseKey = row => JSON.stringify([row.id, row.n ?? null, row.trial ?? 1]);

/** One operation only: never retain this cache between import/check commands. */
export class EvidenceArtifacts {
  #files = new Map();
  #cases = new WeakMap();
  #read;

  constructor({ read = readFileSync } = {}) { this.#read = read; }

  #capture(path) {
    const absolute = resolve(path), bytes = this.#read(absolute), sha256 = hash(bytes);
    let entry = this.#files.get(absolute);
    if (entry && entry.sha256 !== sha256) throw new Error(`evidence changed during verification: ${absolute}`);
    if (!entry) { entry = { sha256 }; this.#files.set(absolute, entry); }
    return { entry, bytes };
  }

  json(path) {
    const entry = this.#files.get(resolve(path));
    if (entry && Object.hasOwn(entry, "json")) return entry.json;
    const captured = this.#capture(path);
    captured.entry.json = JSON.parse(captured.bytes.toString("utf8"));
    return captured.entry.json;
  }

  text(path) {
    const entry = this.#files.get(resolve(path));
    if (entry && Object.hasOwn(entry, "text")) return entry.text;
    const captured = this.#capture(path);
    captured.entry.text = captured.bytes.toString("utf8");
    return captured.entry.text;
  }

  digest(path) {
    return this.#files.get(resolve(path))?.sha256 ?? this.#capture(path).entry.sha256;
  }

  /** Keep duplicate identities visible: an index must not turn two rows into one. */
  cases(report, identity) {
    let index = this.#cases.get(report);
    if (!index) {
      index = new Map();
      for (const row of Array.isArray(report.cases) ? report.cases : []) {
        const key = caseKey(row), matches = index.get(key) ?? [];
        matches.push(row); index.set(key, matches);
      }
      this.#cases.set(report, index);
    }
    return index.get(caseKey(identity)) ?? [];
  }

  /** Rehash each distinct path, once, before any result can be accepted. */
  assertUnchanged() {
    for (const [path, entry] of this.#files) {
      if (hash(this.#read(path)) !== entry.sha256) throw new Error(`evidence changed during verification: ${path}`);
    }
  }
}
