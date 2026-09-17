// SPDX-License-Identifier: Apache-2.0
// The single-holder edit lock, and the handoff around it (SPEC §16).

import { useCallback, useEffect, useState } from "react";
import {
  LOCK_IDLE_MS,
  LOCK_WARN_MS,
  claimLock,
  clearEditRequest,
  releaseLock,
  requestEdit,
  touchLock,
  watchEditRequests,
  watchLock,
  type EditLock,
  type EditRequest,
} from "../presence";

/**
 * What makes "no CRDT" honest.
 *
 * The lock is SOFT: a peer who does not hold it is not blocked from the
 * document, they enter OBSERVE mode — watching the draft refresh, seeing the
 * holder's caret live, still able to highlight and comment. Review does not
 * stop because somebody is typing.
 *
 * The stale-base 409 and the conflict banner remain as the backstop for what a
 * lock cannot cover: a tab that never disconnected cleanly, and a version
 * published from somewhere else entirely.
 */
export function useEditLock(options: {
  docId: string;
  uid: string | null;
  emailLower: string;
  /** True while this reader wants to be editing. */
  wantsEdit: boolean;
}) {
  const { docId, uid, emailLower, wantsEdit } = options;

  const [lock, setLock] = useState<EditLock | null>(null);
  const [requests, setRequests] = useState<EditRequest[]>([]);
  const [asked, setAsked] = useState(false);
  const [idleWarning, setIdleWarning] = useState(false);

  useEffect(() => watchLock(docId, setLock), [docId]);
  useEffect(() => watchEditRequests(docId, setRequests), [docId]);

  const held = Boolean(lock && uid && lock.uid === uid);
  const heldByOther = Boolean(lock && uid && lock.uid !== uid);

  // Claim on entering edit mode, release on leaving. onDisconnect covers the
  // tab that never leaves.
  useEffect(() => {
    if (!uid) return;
    if (!wantsEdit) {
      if (held) void releaseLock(docId, uid);
      return;
    }
    void claimLock(docId, uid, emailLower);
    return () => {
      void releaseLock(docId, uid);
    };
  }, [wantsEdit, docId, uid, emailLower]);

  /**
   * Idle release, warned at four minutes and taken at five.
   *
   * Somebody who opened the editor and walked away should not hold the document
   * indefinitely — but they should be TOLD before it is taken, because losing
   * the lock silently mid-thought is how people stop trusting the feature.
   */
  useEffect(() => {
    if (!held || !uid) return;
    const warn = setTimeout(() => setIdleWarning(true), LOCK_WARN_MS);
    const release = setTimeout(() => {
      void releaseLock(docId, uid);
      setIdleWarning(false);
    }, LOCK_IDLE_MS);
    return () => {
      clearTimeout(warn);
      clearTimeout(release);
    };
  }, [held, docId, uid, lock?.since]);

  /** Any activity re-stamps the lock and dismisses the warning. */
  const keepAlive = useCallback(() => {
    if (!held || !uid) return;
    setIdleWarning(false);
    void touchLock(docId, uid, emailLower);
  }, [held, docId, uid, emailLower]);

  /**
   * Ask the holder to hand over. Asked ONCE.
   *
   * If they ignore it, the asker is told once and never again — no repeat
   * prompts, no queue, no escalation. The request node is keyed by the asker,
   * so asking twice overwrites rather than accumulating.
   */
  const askToEdit = useCallback(async () => {
    if (!uid || asked) return;
    setAsked(true);
    await requestEdit(docId, uid, emailLower);
  }, [docId, uid, emailLower, asked]);

  /** The holder hands over: release, and clear the request that prompted it. */
  const handOff = useCallback(
    async (toUid: string) => {
      if (!uid) return;
      await clearEditRequest(docId, toUid);
      await releaseLock(docId, uid);
    },
    [docId, uid],
  );

  const dismissRequest = useCallback(
    (fromUid: string) => void clearEditRequest(docId, fromUid),
    [docId],
  );

  return {
    lock,
    held,
    /** True when somebody else is editing: this reader observes. */
    observing: wantsEdit && heldByOther,
    idleWarning,
    keepAlive,
    /** Requests addressed to the current holder. */
    requests: held ? requests.filter((r) => r.uid !== uid) : [],
    asked,
    askToEdit,
    handOff,
    dismissRequest,
  };
}
