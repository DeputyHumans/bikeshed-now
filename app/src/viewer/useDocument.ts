// SPDX-License-Identifier: Apache-2.0
// Resolving a document for whoever is asking (SPEC §4, §17).

import { useEffect, useState } from "react";
import { getPublicDoc, getVersion, listVersions, watchDoc } from "../firestore";
import { unlockDoc } from "../visibility";
import type { DocMeta, DocVersion, PublicDoc, SourceFormat } from "../types";

/**
 * A reader arrives by one of four routes, and the viewer should not care which.
 *
 *   A MEMBER reads `docs/{docId}` and gets everything.
 *   ANYONE ELSE cannot read that record at all — it carries the member list and
 *     the reading statistics, and Firestore rules cannot project fields — so:
 *   on a PUBLIC document they get the `public/{docId}` mirror;
 *   on an UNLISTED one, holding its key, they get the same shape from
 *     POST /unlock, which checks the key and, for an account, records a grant;
 *   and a signed-in reader who opened the link before gets it from /unlock
 *     without the key, on the strength of that grant.
 *
 * Anyone else is told nothing. Without the key an unlisted document is
 * indistinguishable from an id that does not exist (SPEC §17).
 *
 * This hook tries the full record first and falls back — a key holder asks for
 * both at once — so every consumer gets one shape with the fields it is allowed
 * to have and `null` for the rest. The fallback is not an error path: for most
 * readers of a shared document it is the normal one.
 */

/** Who is asking, besides whoever the Firestore SDK is signed in as. */
export interface ReaderAccess {
  /** The unlisted key from the URL's `?k=`, or "" when there is none. */
  k: string;
  /** The signed-in account, or null for an anonymous reader. */
  uid: string | null;
  /** False until auth has decided who is asking. Before, only a key is presented. */
  settled: boolean;
}

const ANYONE: ReaderAccess = { k: "", uid: null, settled: true };

/** The render fields for someone who may not read the full record, or null. */
async function resolveReader(
  docId: string,
  k: string,
  signedIn: boolean,
): Promise<PublicDoc | null> {
  // The key only opens anything at the one endpoint that checks it.
  if (k) return unlockDoc(docId, k);
  const projection = await getPublicDoc(docId);
  if (projection) return projection;
  // No key and no public mirror. A signed-in reader may still hold a grant
  // from opening the link before — a reply notification links without the
  // key. An anonymous one cannot, so they never ask.
  return signedIn ? unlockDoc(docId, null) : null;
}

export interface ResolvedDocument {
  loading: boolean;
  /** The full record, when this reader is a member. */
  meta: DocMeta | null;
  /** The world-readable projection, when they are not. */
  publicDoc: PublicDoc | null;
  /** Present when the document exists but this reader may not see it. */
  notFound: boolean;
  /**
   * The identity the current answer was worked out for: a uid, "" for an
   * anonymous reader, null before the first answer. A reader who signs in on
   * the page is resolved again — which is what mints their link grant — and
   * anything that writes as them waits until this is their uid.
   */
  resolvedFor: string | null;

  title: string;
  currentVersion: string;
  entry: string;
  format: SourceFormat;
  trusted: boolean | undefined;
  publicEdit: boolean;

  versions: DocVersion[];
  version: DocVersion | null;
}

const EMPTY: ResolvedDocument = {
  loading: true,
  meta: null,
  publicDoc: null,
  notFound: false,
  resolvedFor: null,
  title: "",
  currentVersion: "",
  entry: "index.html",
  format: "html",
  trusted: undefined,
  publicEdit: false,
  versions: [],
  version: null,
};

export function useDocument(
  docId: string,
  versionId?: string,
  access: ReaderAccess = ANYONE,
): ResolvedDocument {
  const { k, uid, settled } = access;
  const who = uid ?? "";
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [publicDoc, setPublicDoc] = useState<PublicDoc | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [version, setVersion] = useState<DocVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Whose read of the full record was refused. The fallback runs for that
  // identity, and again when somebody else asks — the same reader, signed in.
  const [deniedFor, setDeniedFor] = useState<string | null>(null);
  // Whom the member record was delivered for. Nothing the fallback answers
  // afterwards for the same reader may replace it.
  const [memberFor, setMemberFor] = useState<string | null>(null);
  // Whose fallback came back empty. Final only together with `deniedFor`.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);

  // `loading` is only ever cleared, never set again. A reader who signs in on
  // the page is resolved a second time, and a spinner then would unmount the
  // frame and lose the selection they signed in to comment on.
  useEffect(() => {
    if (!settled) return;
    let cancelled = false;

    const unsubscribe = watchDoc(
      docId,
      (next) => {
        if (cancelled) return;
        if (next) {
          setMeta(next);
          setPublicDoc(null);
          setNotFound(false);
          setLoading(false);
          setResolvedFor(who);
          setMemberFor(who);
        }
      },
      () => {
        // A denied read is the expected case for anyone but a member, so it
        // falls back rather than surfacing.
        if (!cancelled) setDeniedFor(who);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [docId, who, settled]);

  /**
   * A key holder asks /unlock at once: before auth has decided, and without
   * waiting for Firestore to refuse the member record. The key is checked
   * there and nowhere else, so neither is needed to read what it opens — and
   * on a phone neither answers before Google's sign-in script has loaded,
   * because Firebase Auth sets up its popup helper ahead of reporting anyone
   * on every mobile browser and Safari. While that script stalled, a key
   * holder sat on "Opening the document" indefinitely, and desktop Chrome,
   * which skips the step, opened the same link at once.
   *
   * Until auth decides, `who` is "", the anonymous reader. The request still
   * carries the session cookie, so a returning account is recognised; if auth
   * then decides on an account, `who` changes and this asks again as them.
   */
  const askUnlock = memberFor !== who && (k !== "" || (settled && deniedFor === who));

  useEffect(() => {
    if (!askUnlock) return;
    let cancelled = false;
    void resolveReader(docId, k, uid !== null)
      .catch(() => null)
      .then((projection) => {
        if (cancelled) return;
        if (!projection) {
          setRefusedFor(who);
          return;
        }
        setPublicDoc(projection);
        setNotFound(false);
        setLoading(false);
        setResolvedFor(who);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, k, uid, who, askUnlock]);

  // Refused means "not here" only once the member read is refused as well. A
  // key /unlock turns down may be a stale one in a member's link, and the
  // member reads the document from Firestore regardless.
  useEffect(() => {
    if (refusedFor !== who || deniedFor !== who) return;
    setPublicDoc(null);
    setNotFound(true);
    setLoading(false);
    setResolvedFor(who);
  }, [refusedFor, deniedFor, who]);

  // Version records are readable by anyone who may read the document's
  // feedback, so this simply fails quietly for an anonymous reader — who does
  // not need it, because the projection already names the current version.
  useEffect(() => {
    if (!meta) return;
    void listVersions(docId).then(setVersions).catch(() => setVersions([]));
  }, [docId, meta?.currentVersion]);

  const resolvedVersionId =
    versionId || meta?.currentVersion || publicDoc?.currentVersion || "";

  useEffect(() => {
    if (!resolvedVersionId) return;
    const known = versions.find((v) => v.versionId === resolvedVersionId);
    if (known) {
      setVersion(known);
      return;
    }
    void getVersion(docId, resolvedVersionId)
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [docId, resolvedVersionId, versions]);

  if (!meta && !publicDoc) {
    return { ...EMPTY, loading, notFound, resolvedFor };
  }

  return {
    loading,
    meta,
    publicDoc,
    notFound,
    resolvedFor,
    title: meta?.title ?? publicDoc?.title ?? "Untitled",
    currentVersion: resolvedVersionId,
    entry: version?.entry ?? publicDoc?.entry ?? "index.html",
    format: version?.format ?? publicDoc?.format ?? "html",
    trusted: meta?.trusted ?? publicDoc?.trusted,
    publicEdit: meta?.publicEdit ?? publicDoc?.publicEdit ?? false,
    versions,
    version,
  };
}
