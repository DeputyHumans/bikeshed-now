// SPDX-License-Identifier: Apache-2.0
// Effective trust, and when to even mention it (SPEC §6c).

import { useEffect, useState } from "react";
import { setPersonalTrust, watchPersonalTrust } from "../trust";
import { isEffectivelyTrusted } from "./frameMode";

/**
 * How long a reading frame's first load waits for this reader's personal grant
 * before it loads sandboxed anyway.
 *
 * The answer is a Firestore listener, and a network that blocks Firestore's
 * channel while plain HTTP works would otherwise never open the document at
 * all. Past this, the viewer behaves as it did before it waited: sandboxed
 * first, remounted when the answer lands.
 */
export const PERSONAL_TRUST_WAIT_MS = 1500;

/**
 * Trust is surfaced ONLY when it would change something: the document is still
 * sandboxed for THIS reader AND its loaded DOM actually contains a script tag.
 *
 * The sandbox blocks execution but leaves the tags parseable, so "does this
 * document have scripts" is answerable from the rendered DOM. Without that
 * second condition, every static upload would prompt for a decision that
 * changes nothing — and a prompt that never matters is a prompt people learn to
 * click through.
 */
export function useDocTrust(options: {
  docId: string;
  uid: string | null;
  doc: Document | null;
  epoch: number;
  docTrusted: boolean | undefined;
  emailLower: string;
}) {
  const { docId, uid, doc, epoch, docTrusted, emailLower } = options;
  // Keyed by whom it was read for. An answer about one account says nothing
  // about the next one, or about nobody: unkeyed, a grant outlived the sign-out
  // of the account that made it, and the frame stayed unsandboxed.
  const asking = uid ? `${docId}/${uid}` : null;
  const [answer, setAnswer] = useState<{ for: string; trusted: boolean } | null>(null);
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  const [hasScripts, setHasScripts] = useState(false);

  useEffect(() => {
    if (!uid) return;
    const key = `${docId}/${uid}`;
    const timer = setTimeout(() => setGaveUpOn(key), PERSONAL_TRUST_WAIT_MS);
    const stop = watchPersonalTrust(docId, uid, (trusted) => {
      clearTimeout(timer);
      setAnswer({ for: key, trusted });
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [docId, uid]);

  useEffect(() => {
    if (!doc) return;
    setHasScripts(doc.querySelector("script") != null);
  }, [doc, epoch]);

  const answered = asking !== null && answer?.for === asking;
  const gaveUp = asking !== null && gaveUpOn === asking;
  const personallyTrusted = answered && answer.trusted;
  const trusted = isEffectivelyTrusted(docTrusted, personallyTrusted);

  /**
   * Whether the sandbox decision is final enough to load a document under.
   *
   * The sandbox is read at parse time, so a frame that loads before this
   * reader's grant is known loads sandboxed and has to load all over again
   * when the grant lands. Only an untrusted document read by a known account
   * can still change, and it waits for that account's answer or the cap. It
   * never waits on auth: a link opens before sign-in has decided (SPEC §17).
   */
  const settled = docTrusted === true || asking === null || answered || gaveUp;

  return {
    trusted,
    personallyTrusted,
    settled,
    /** Changes identity when trust flips, so the frame remounts and reparses. */
    trustToken: trusted ? "trusted" : "sandboxed",
    /**
     * Whether to offer the choice at all. Not before this reader's own answer
     * is in, or a reader who already decided is asked again.
     */
    shouldOffer: settled && !trusted && hasScripts,
    async grantPersonal(value: boolean) {
      if (!uid) return;
      await setPersonalTrust(docId, uid, emailLower, value);
    },
  };
}
