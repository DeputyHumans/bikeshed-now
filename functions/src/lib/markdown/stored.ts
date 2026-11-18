// SPDX-License-Identifier: Apache-2.0
// A version's Markdown reading, made once for its bytes and kept beside the version (SPEC §19, ADR 0033).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { safeSegment } from "../http";
import { budgetedReading, oneAtATime } from "./budget";
import { type LeftOut, type Reading, type ReadingContext } from "./reading";

/**
 * Why this exists
 * ---------------
 * A reading is made from the version's entry (ADR 0030), and a large page
 * costs seconds of one CPU and most of a small instance's memory to make.
 * `get_document` pages a long reading 200,000 characters at a time, so making
 * it on every request made one read of a 2 MB page convert the whole page
 * four times. A version's bytes never change, so its reading is made once and
 * kept, like a thumbnail.
 *
 * What a kept reading belongs to
 * ------------------------------
 * The bytes, not the version's name. A withdrawn head's name is minted again
 * by the next publish (`v${maxN + 1}`), with other bytes, so the object's name
 * hashes the version's `contentHash` (SPEC §9) and its storage prefix with
 * everything else that decides the body: the rules that made it, the origin
 * its addresses start with, the entry, and the key that opened it, because a
 * keyed reading carries the key in its addresses. Change any of them and the
 * old object is simply never read again; the document's purge removes it.
 *
 * Only the body and its counts are kept. The front matter names the title,
 * which a rename changes, and the reader address, which depends on how it was
 * asked for, so it is composed on every request.
 */

/** What a kept reading needs of the bucket: one read, and one write that never replaces anything. */
export interface ReadingStore {
  file(name: string): {
    download(): Promise<[Buffer]>;
    save(data: string, options: { contentType: string; resumable: false; preconditionOpts: { ifGenerationMatch: 0 } }): Promise<unknown>;
  };
}

/** The fields of a version record a kept reading is named by. */
export interface VersionBytes {
  contentHash?: unknown;
}

/**
 * Every file a reading is made by: `reading.ts` as compiled, the budget and
 * the worker it runs in (a changed ladder decides which part of a page is
 * read), turndown, and the parser turndown brings. Empty when one cannot be
 * found.
 */
function ruleFiles(): string[] {
  try {
    const turndown = require.resolve("turndown");
    return [
      require.resolve("./reading"),
      require.resolve("./budget"),
      require.resolve("./worker"),
      turndown,
      createRequire(turndown).resolve("@mixmark-io/domino"),
    ];
  } catch {
    return [];
  }
}

export const RULE_FILES: readonly string[] = ruleFiles();

/**
 * A fingerprint of `RULE_FILES`. Null when any of them cannot be read, and
 * then nothing is kept: a reading made fresh is always right, a kept one only
 * while the rules are the ones that made it.
 */
function rulesFingerprint(): string | null {
  if (RULE_FILES.length === 0) return null;
  try {
    const hash = createHash("sha256");
    for (const file of RULE_FILES) {
      hash.update(file.slice(file.lastIndexOf("/") + 1));
      hash.update(readFileSync(file));
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export const RULES = rulesFingerprint();

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Everything kept for one version's readings. Outside the version's own prefix, for the reason thumbnails are. */
export function readingsPrefix(docId: string, versionId: string): string {
  return `docs/${docId}/readings/${versionId}/`;
}

/**
 * The object a version's reading is kept in, or null when it must not be kept:
 * a version recorded without its content hash, or rules that cannot be named.
 */
export function readingObject(place: ReadingContext, version: VersionBytes, storagePrefix: string): string | null {
  const contentHash = typeof version.contentHash === "string" && CONTENT_HASH.test(version.contentHash) ? version.contentHash : null;
  if (!contentHash || !RULES || !safeSegment(place.docId) || !safeSegment(place.versionId)) return null;
  const name = createHash("sha256")
    .update(JSON.stringify([RULES, contentHash, storagePrefix, place.entry, place.origin, place.k ?? ""]))
    .digest("hex");
  return `${readingsPrefix(place.docId, place.versionId)}${name}.json`;
}

const LEFT_OUT_KEYS: (keyof LeftOut)[] = ["scripts", "stylesheets", "figures", "embeds", "inlineImages", "hidden", "formControls"];

/** A kept reading as stored, or null for anything else: then it is made again. */
export function parseKept(text: string): Reading | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = value as Partial<Record<keyof Reading, unknown>> | null;
  if (!v || typeof v.body !== "string" || typeof v.cut !== "boolean") return null;
  if (!Array.isArray(v.warnings) || !v.warnings.every((w) => typeof w === "string")) return null;
  const counts = v.leftOut as Record<string, unknown> | null;
  if (!counts || typeof counts !== "object") return null;
  const leftOut = {} as LeftOut;
  for (const key of LEFT_OUT_KEYS) {
    const n = counts[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    leftOut[key] = n;
  }
  return { body: v.body, leftOut, warnings: v.warnings as string[], cut: v.cut };
}

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown })?.code ?? (err as Error)?.name;
}

/** The kept reading at `name`, or null for none, or for one that does not parse: then it is made again. */
async function keptReading(store: ReadingStore, name: string): Promise<Reading | null> {
  try {
    const [bytes] = await store.file(name).download();
    return parseKept(bytes.toString("utf8"));
  } catch (err) {
    if (codeOf(err) !== 404) console.warn("reading: kept copy unreadable", codeOf(err));
    return null;
  }
}

/**
 * A version's reading: the kept one when there is one, else made from the
 * source and kept for next time. Call it only after the read gate has said
 * yes; what it keeps is the document's content.
 *
 * A miss waits its turn for the instance's one conversion (`oneAtATime`), then
 * looks again, so readers who queued behind the reading of the same version
 * are served what it kept rather than converting it again. The reading is
 * made within a budget (`budgetedReading`) and kept whatever it came to,
 * including a shortened one, so a page that costs its budget costs it once.
 *
 * The write is awaited, because Cloud Run takes the CPU away once the response
 * is sent. A write that fails, or loses the race to another reader's identical
 * one, costs only the next request a conversion, so it never fails this one.
 * Logs carry a code, never the object's name, which holds the document id.
 */
export async function storedReading(input: {
  store: ReadingStore;
  place: ReadingContext;
  version: VersionBytes;
  storagePrefix: string;
  source: () => Promise<string>;
}): Promise<Reading> {
  const name = readingObject(input.place, input.version, input.storagePrefix);
  const kept = name ? await keptReading(input.store, name) : null;
  if (kept) return kept;
  return oneAtATime(async () => {
    const again = name ? await keptReading(input.store, name) : null;
    if (again) return again;
    const reading = await budgetedReading(await input.source(), input.place);
    if (name) {
      try {
        await input.store.file(name).save(
          JSON.stringify({ body: reading.body, leftOut: reading.leftOut, warnings: reading.warnings, cut: reading.cut }),
          { contentType: "application/json", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } },
        );
      } catch (err) {
        if (codeOf(err) !== 412) console.warn("reading: not kept", codeOf(err));
      }
    }
    return reading;
  });
}
