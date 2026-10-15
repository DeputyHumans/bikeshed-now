// SPDX-License-Identifier: Apache-2.0
// Shared document state as an append-only update log (SPEC §6b, §16).

import * as Y from "yjs";
import type { CausalStamp } from "./causal";

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
 * collaboration and nothing else. Compaction preserves the elected seed; a
 * successful publication retires its epoch so the next session can seed from
 * the saved bytes. Unexpected loss within a stamped epoch fails closed instead
 * of inventing a new identity over still-active peers.
 *
 * Transport is injected rather than imported so the merge behaviour can be
 * tested without a network, a Firebase app, or an emulator. The RTDB binding is
 * twenty lines in `rtdb.ts`; everything difficult is here.
 */

/** What the provider needs from a transport. Deliberately tiny. */
export interface UpdateLog {
  /** Calls back for every entry already present and every one appended after. */
  subscribe(onEntry: (key: string, payload: string) => void, onError?: (error: Error) => void): () => void;
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
  initialize(seed?: Uint8Array): Promise<void>;
  causalStamp(): CausalStamp;
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
export function connect(doc: Y.Doc, log: UpdateLog, beforeRemote: () => void = () => {}, onDelivery: (available: boolean) => void = () => {}): Connection {
  const REMOTE = Symbol("remote");
  const seen = new Set<string>();
  const payloads = new Map<string, string>();
  let destroyed = false;
  let compacting = false;
  let generation: string | null = null;
  let pending: Uint8Array | null = null;
  let sending = false;
  let readFailed = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

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
  }, () => { readFailed = true; if (!destroyed) onDelivery(false); });

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (destroyed || origin === REMOTE) return;
    pending = pending ? Y.mergeUpdates([pending, update]) : update;
    void drain();
  };

  async function drain(): Promise<void> {
    if (destroyed || sending || retry || !pending) return;
    sending = true;
    try {
      while (pending && !destroyed) {
        const update = pending;
        pending = null;
        const payload = toBase64(update);
        try {
          const key = await log.append(payload);
          if (!key) throw new Error("The shared update was not acknowledged");
          if (destroyed) return;
          seen.add(key); payloads.set(key, payload);
          failures = 0;
          void compact();
        } catch {
          if (destroyed) return;
          // Keep both the refused bytes and changes made while they were in
          // flight. Later Yjs deltas may depend on those earlier item ids.
          pending = pending ? Y.mergeUpdates([update, pending]) : update;
          onDelivery(false);
          retry = setTimeout(() => { retry = null; void drain(); }, Math.min(2_000, 200 * 2 ** Math.min(failures++, 4)));
          return;
        }
      }
      if (!destroyed && !readFailed) onDelivery(true);
    } finally { sending = false; }
  }
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
      if (!merged) return;
      seen.add(merged); payloads.set(merged, payload);
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
      let elected = payloads.get(SEED_KEY);
      if (!elected) {
        if (payloads.size > 0) throw new Error("The shared document seed is missing");
        if (!seed) throw new Error("The shared document needs an initial seed");
        elected = await log.initialize(toBase64(seed));
      }
      const bytes = fromBase64(elected);
      const hash = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
      if (!destroyed) {
        Y.applyUpdate(doc, fromBase64(elected), REMOTE);
        seen.add(SEED_KEY); payloads.set(SEED_KEY, elected);
        generation = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
    },
    causalStamp() {
      if (!generation) throw new Error("The shared document seed is not ready");
      const deletes = Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds.clients;
      return {
        generation,
        vector: Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc))),
        deletes: Object.fromEntries([...deletes].map(([client, ranges]) =>
          [client, ranges.map(({ clock, len }) => [clock, len] as [number, number])])),
      };
    },
    destroy() {
      destroyed = true;
      if (retry) clearTimeout(retry);
      pending = null;
      doc.off("update", onUpdate);
      unsubscribe();
    },
    size: () => seen.size,
    snapshot: () => Object.fromEntries(payloads),
  };
}
