// SPDX-License-Identifier: Apache-2.0
// Effective trust, and when to even mention it (SPEC §6c).

import { useEffect, useState } from "react";
import { setPersonalTrust, watchPersonalTrust } from "../trust";
import { isEffectivelyTrusted } from "./frameMode";

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
  const [personallyTrusted, setPersonallyTrusted] = useState(false);
  const [hasScripts, setHasScripts] = useState(false);

  useEffect(() => {
    if (!uid) return;
    return watchPersonalTrust(docId, uid, setPersonallyTrusted);
  }, [docId, uid]);

  useEffect(() => {
    if (!doc) return;
    setHasScripts(doc.querySelector("script") != null);
  }, [doc, epoch]);

  const trusted = isEffectivelyTrusted(docTrusted, personallyTrusted);

  return {
    trusted,
    personallyTrusted,
    /** Changes identity when trust flips, so the frame remounts and reparses. */
    trustToken: trusted ? "trusted" : "sandboxed",
    /** Whether to offer the choice at all. */
    shouldOffer: !trusted && hasScripts,
    async grantPersonal(value: boolean) {
      if (!uid) return;
      await setPersonalTrust(docId, uid, emailLower, value);
    },
  };
}
