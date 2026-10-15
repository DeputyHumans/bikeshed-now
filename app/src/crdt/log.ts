// SPDX-License-Identifier: Apache-2.0
// Shared document state as an append-only update log (SPEC §6b, §16).

import * as Y from "yjs";

/**
 * Why a log of updates rather than a shared snapshot
 * --------------------------------------------------
 * A CRDT update is commutative, idempotent and order-independent. That is the
 * whole point of one, and it means the transport can be the dumbest thing that
 * works: append a blob, read every blob, apply them in whatever order they
 * arrive. No locking, no last-writer-wins, no server that has to understand the
 * document — which is exactly why this rides on the Realtime Database node the
 * presence system already uses instead of needing a WebSocket service.
 *
 * The log is NOT the durable artifact. The draft and the published versions
 * are, in Firestore and Storage, exactly as before. This carries live
 * collaboration and nothing else, so it can be trimmed aggressively and lost
 * entirely without losing a document — whoever opens the editor next seeds a
 * fresh one from the saved bytes.
 *
 * Transport is injected rather than imported so the merge behaviour can be
 * tested without a network, a Firebase app, or an emulator. The RTDB binding is
 * twenty lines in `rtdb.ts`; everything difficult is here.
 */

/** What the provider needs from a transport. Deliberately tiny. */
export interface UpdateLog {
  /** Calls back for every entry already present and every one appended after. */
  subscribe(onEntry: (key: string, payload: string) => void): () => void;
  append(payload: string): Promise<string | null>;
  remove(keys: readonly string[]): Promise<void>;
  /** Atomically retain one initial update; return the winner to every joiner. */
  initialize(payload: string): Promise<string>;
  /** Resolves once all entries that existed at join time have been delivered. */
  ready(): Promise<void>;
}

/**
 * Base64 for a byte array, without a dependency.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a large update blows the
 * argument limit and throws — a document only has to be a few hundred kilobytes
 * for that to be a real crash rather than a theoretical one.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Past this many entries the log is replaced by one merged update.
 *
 * Every keystroke is an entry, so an editing session reaches this in seconds.
 * The number only decides how often compaction runs; correctness does not
 * depend on it, because an uncompacted log and a compacted one describe the
 * same document.
 */
export const COMPACT_AFTER = 64;
export const SEED_KEY = "_seed";

export interface Connection {
  initialize(seed: Uint8Array): Promise<void>;
  destroy(): void;
  /** Entry keys currently believed to be in the log. Exposed for tests. */
  size(): number;
  snapshot(): Record<string, string>;
}

/**
 * Join `doc` to a log. Every peer on the same log converges.
 *
 * `origin` is what keeps this from echoing: an update applied FROM the log is
 * tagged, and the local-update handler ignores anything carrying that tag.
 * Without it every remote update is immediately re-appended by every peer that
 * receives it, and the log grows without bound while the document does nothing.
 */
export function connect(doc: Y.Doc, log: UpdateLog, beforeRemote: () => void = () => {}): Connection {
  const REMOTE = Symbol("remote");
  const seen = new Set<string>();
  const payloads = new Map<string, string>();
  let destroyed = false;
  let compacting = false;

  const unsubscribe = log.subscribe((key, payload) => {
    if (destroyed || seen.has(key)) return;
    seen.add(key);
    try {
      // Preserve DOM edits whose MutationObserver has not delivered yet.
      beforeRemote();
      Y.applyUpdate(doc, fromBase64(payload), REMOTE);
      payloads.set(key, payload);
    } catch {
      // A malformed entry is one peer's problem, not everybody's. Applying the
      // rest still converges every client that can read them.
    }
  });

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (destroyed || origin === REMOTE) return;
    void log.append(toBase64(update)).then((key) => {
      if (key) { seen.add(key); payloads.set(key, toBase64(update)); }
      void compact();
    });
  };
  doc.on("update", onUpdate);

  /**
   * Replace a run of entries with one that means the same thing.
   *
   * The merged entry is written BEFORE the consumed ones are removed, so a
   * failure between the two leaves a redundant log rather than a truncated one.
   * Applying an update twice is a no-op, which is what makes that ordering safe
   * and what makes two peers compacting at once harmless.
   */
  async function compact(): Promise<void> {
    if (compacting || destroyed || seen.size < COMPACT_AFTER) return;
    compacting = true;
    const consumed = [...seen].filter((key) => key !== SEED_KEY);
    try {
      const payload = toBase64(Y.encodeStateAsUpdate(doc));
      const merged = await log.append(payload);
      if (merged) { seen.add(merged); payloads.set(merged, payload); }
      await log.remove(consumed);
      for (const key of consumed) { seen.delete(key); payloads.delete(key); }
    } catch {
      /* the log stays longer than it needs to; nothing is lost */
    } finally {
      compacting = false;
    }
  }

  return {
    async initialize(seed) {
      const elected = await log.initialize(toBase64(seed));
      if (!destroyed) {
        Y.applyUpdate(doc, fromBase64(elected), REMOTE);
        seen.add(SEED_KEY); payloads.set(SEED_KEY, elected);
      }
    },
    destroy() {
      destroyed = true;
      doc.off("update", onUpdate);
      unsubscribe();
    },
    size: () => seen.size,
    snapshot: () => Object.fromEntries(payloads),
  };
}
