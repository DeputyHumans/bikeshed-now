// SPDX-License-Identifier: Apache-2.0
// Resolving a document for whoever is asking (SPEC §4, §17).

import { useEffect, useState } from "react";
import { getPublicDoc, getVersion, listVersions, watchDoc } from "../firestore";
import type { DocMeta, DocVersion, PublicDoc, SourceFormat } from "../types";

/**
 * A reader arrives by one of three routes, and the viewer should not care which.
 *
 *   A MEMBER reads `docs/{docId}` and gets everything.
 *   A SIGNED-IN NON-MEMBER on a public document cannot read that record at all —
 *     it carries the member list and the reading statistics, and Firestore
 *     rules cannot project fields — so they get the `public/{docId}` mirror.
 *   AN ANONYMOUS READER gets the same mirror.
 *
 * This hook tries the full record first and falls back, so every consumer gets
 * one shape with the fields it is allowed to have and `null` for the rest. The
 * fallback is not an error path: for most readers of a public document it is
 * the normal one.
 */

export interface ResolvedDocument {
  loading: boolean;
  /** The full record, when this reader is a member. */
  meta: DocMeta | null;
  /** The world-readable projection, when they are not. */
  publicDoc: PublicDoc | null;
  /** Present when the document exists but this reader may not see it. */
  notFound: boolean;

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
  title: "",
  currentVersion: "",
  entry: "index.html",
  format: "html",
  trusted: undefined,
  publicEdit: false,
  versions: [],
  version: null,
};

export function useDocument(docId: string, versionId?: string): ResolvedDocument {
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [publicDoc, setPublicDoc] = useState<PublicDoc | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [version, setVersion] = useState<DocVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    let cancelled = false;

    const unsubscribe = watchDoc(
      docId,
      (next) => {
        if (cancelled) return;
        if (next) {
          setMeta(next);
          setPublicDoc(null);
          setLoading(false);
        }
      },
      () => {
        // A denied read is the expected case for a non-member on a public
        // document, so it falls back rather than surfacing.
        if (cancelled) return;
        void getPublicDoc(docId)
          .then((projection) => {
            if (cancelled) return;
            setPublicDoc(projection);
            setNotFound(projection == null);
            setLoading(false);
          })
          .catch(() => {
            if (cancelled) return;
            setNotFound(true);
            setLoading(false);
          });
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [docId]);

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
    return { ...EMPTY, loading, notFound };
  }

  return {
    loading,
    meta,
    publicDoc,
    notFound,
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
