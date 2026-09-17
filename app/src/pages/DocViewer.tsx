// SPDX-License-Identifier: Apache-2.0
// The document viewer: composition only (SPEC §6, §6a, §6c, §16, §17).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth";
import { logEvent } from "../analytics";
import { createAnnotation, listAnnotations, listMyTeams } from "../firestore";
import { describeAnchorFromSelection } from "../annotation/anchor";
import { Sidebar } from "../annotation/Sidebar";
import { commitVersion, UnresolvedCommentsError, StaleVersionError } from "../edit";
import { downloadEntry, downloadSource, downloadZip } from "../export/html";
import { printDoc } from "../export/pdf";
import { MARKING_OFF } from "../export/labels";
import { useIsSingleColumn } from "../hooks/useMediaQuery";

import { useDocument } from "../viewer/useDocument";
import { useDocFrame } from "../viewer/useDocFrame";
import { useAnnotationLayer } from "../viewer/useAnnotationLayer";
import { useInlineEditor } from "../viewer/useInlineEditor";
import { useDocTrust } from "../viewer/useDocTrust";
import { useReadingSession } from "../viewer/useReadingSession";
import { usePeerPresence } from "../viewer/usePeerPresence";
import { useEditLock } from "../viewer/useEditLock";
import { useLiveSync } from "../viewer/useLiveSync";
import type { FrameMode } from "../viewer/frameMode";

import { EditToolbar } from "../wysiwyg/EditToolbar";
import { ViewerToolbar } from "../components/ViewerToolbar";
import { ViewerBanners } from "../components/ViewerBanners";
import { SelectionFab } from "../components/SelectionFab";
import { SlidePanel } from "../components/SlidePanel";
import { SharePanel } from "../components/SharePanel";
import { VisibilityDialog } from "../components/VisibilityDialog";
import { TrustDialog } from "../components/TrustDialog";
import { MarkingDialog } from "../components/MarkingDialog";
import { StatsPanel } from "../components/StatsPanel";
import { ImageExportDialog } from "../components/ImageExportDialog";
import { Loading } from "../components/Spinner";
import { useToast } from "../components/Toast";
import type { MenuEntry } from "../components/Menu";
import type { Annotation, TeamMeta } from "../types";

/**
 * This file is COMPOSITION. Every decision lives in a hook in `viewer/`, and
 * what remains here is which hooks exist and what they are wired to.
 *
 * The declaration order below is load-bearing, not stylistic:
 * `useAnnotationLayer` MUST come before `useInlineEditor`. Within one
 * component, effect cleanups run in declaration order before any setup — so the
 * annotation layer's cleanup, which strips every highlight, has already run by
 * the time the editor attaches. That is leg 2 of the four defences that keep
 * decoration out of published bytes; legs 1, 3 and 4 are in the hooks and the
 * serializer.
 */

type Dialog =
  | null
  | "share"
  | "visibility"
  | "trust"
  | "marking"
  | "stats"
  | "image";

export function DocViewer() {
  const { docId = "", versionId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, emailLower, gate } = useAuth();
  const singleColumn = useIsSingleColumn();

  const doc = useDocument(docId, versionId);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [teams, setTeams] = useState<TeamMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [wantsEdit, setWantsEdit] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [pane, setPane] = useState<"doc" | "comments">("doc");
  const [presenting, setPresenting] = useState(false);
  const [pendingComment, setPendingComment] = useState(false);

  const signedIn = gate === "ready" && Boolean(user);
  const isOwner = doc.meta?.ownerEmail === emailLower;
  const isDocEditor = Boolean(
    doc.meta &&
      (isOwner ||
        doc.meta.editors?.includes(emailLower) ||
        doc.meta.editorMembers?.includes(emailLower)),
  );
  // Open editing widens WHO, never to anyone: a signed-in account is still
  // required, on every document, whatever its owner chose.
  const canEdit = isDocEditor || (signedIn && doc.publicEdit);

  const lock = useEditLock({ docId, uid: user?.uid ?? null, emailLower, wantsEdit });

  const trust = useDocTrust({
    docId,
    uid: user?.uid ?? null,
    doc: null,
    epoch: 0,
    docTrusted: doc.trusted,
    emailLower,
  });

  const mode: FrameMode = useMemo(
    () =>
      wantsEdit && !lock.observing
        ? { kind: "editing", baseVersion: doc.currentVersion }
        : {
            kind: "reading",
            versionId: doc.currentVersion,
            draft: Boolean(doc.meta?.draft) && canEdit,
            sandboxed: !trust.trusted,
          },
    [wantsEdit, lock.observing, doc.currentVersion, doc.meta?.draft, canEdit, trust.trusted],
  );

  const frame = useDocFrame({
    mode,
    docId,
    entry: doc.entry,
    trustToken: trust.trustToken,
    linkToken: params.get("k") ?? undefined,
  });

  // Re-derived against the live document, so the trust prompt can ask "does it
  // actually contain scripts" rather than guessing.
  const liveTrust = useDocTrust({
    docId,
    uid: user?.uid ?? null,
    doc: frame.doc,
    epoch: frame.epoch,
    docTrusted: doc.trusted,
    emailLower,
  });

  // DECLARATION ORDER MATTERS. See the note at the top of this file.
  const annotationLayer = useAnnotationLayer({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    annotations,
    selectedId,
    onSelect: setSelectedId,
  });

  const editor = useInlineEditor({
    mode,
    doc: frame.doc,
    epoch: frame.epoch,
    docId,
    authoredAssets: frame.authoredAssets,
    observing: lock.observing,
    onStale: () => toast.error("Somebody published a newer version. Reload to continue."),
  });

  const presence = usePeerPresence({
    docId,
    uid: user?.uid ?? null,
    emailLower,
    displayName: user?.displayName || emailLower,
    doc: frame.doc,
    epoch: frame.epoch,
    mode: mode.kind === "editing" ? "edit" : "view",
    enabled: signedIn,
  });

  const live = useLiveSync({
    meta: doc.meta,
    emailLower,
    isEditing: mode.kind === "editing",
    onPeerSavedDraft: frame.reload,
  });

  useReadingSession({
    docId,
    versionId: doc.currentVersion || null,
    doc: frame.doc,
    epoch: frame.epoch,
    enabled: mode.kind === "reading" && !mode.draft,
  });

  useEffect(() => {
    if (!doc.currentVersion) return;
    return listAnnotations(docId, doc.currentVersion, setAnnotations, () => setAnnotations([]));
  }, [docId, doc.currentVersion]);

  useEffect(() => {
    if (!signedIn) return;
    return listMyTeams(emailLower, setTeams, () => setTeams([]));
  }, [signedIn, emailLower]);

  useEffect(() => {
    if (doc.format && frame.epoch > 0) {
      logEvent({
        name: "doc_open",
        params: { format: doc.format, sandboxed: !trust.trusted },
      });
    }
  }, [doc.format, frame.epoch > 0]);

  /** Turn the current selection into a thread. */
  const startComment = useCallback(async () => {
    if (!frame.doc) return;
    if (!user) {
      // The selection survives the prompt, and the comment posts afterwards.
      // Losing it here is where this feature dies.
      setPendingComment(true);
      setCommentsOpen(true);
      setPane("comments");
      return;
    }
    const anchor = describeAnchorFromSelection(frame.doc);
    if (!anchor) return;
    try {
      const annId = await createAnnotation(
        docId,
        doc.currentVersion,
        anchor,
        user.uid,
        emailLower,
      );
      logEvent({ name: "annotation_create", params: {} });
      setSelectedId(annId);
      setCommentsOpen(true);
      setPane("comments");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [frame.doc, user, docId, doc.currentVersion, emailLower, toast]);

  /**
   * Finish a comment the reader started before signing in.
   *
   * The selection is still live in the document, because signing in never
   * unmounted the frame — so this is one call rather than "please highlight it
   * again", which is the version of this feature nobody uses twice.
   */
  useEffect(() => {
    if (!pendingComment || !signedIn) return;
    setPendingComment(false);
    void startComment();
  }, [pendingComment, signedIn, startComment]);

  const commit = useCallback(async () => {
    if (editor.saveFailed()) {
      // Publishing now would promote the PREVIOUS draft bytes while reporting
      // success, which is the worst available outcome.
      toast.error("The last save did not go through. Fix that before publishing.");
      return;
    }
    await editor.flushNow();
    try {
      const result = await commitVersion(docId, doc.currentVersion);
      logEvent({ name: "version_commit", params: { format: doc.format } });
      setWantsEdit(false);
      toast.show(
        result.deduped
          ? "No changes to publish — the content is identical."
          : `Published ${result.versionId}.`,
      );
      navigate(`/d/${docId}`);
    } catch (e) {
      if (e instanceof UnresolvedCommentsError) toast.error(e.message);
      else if (e instanceof StaleVersionError) toast.error(e.message);
      else toast.error((e as Error).message);
    }
  }, [editor, docId, doc.currentVersion, doc.format, navigate, toast]);

  const menuEntries: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = [
      { id: "h-export", label: "Download", heading: true },
      {
        id: "html",
        label: doc.format === "markdown" ? "Download the rendered HTML" : "Download the HTML",
        onSelect: () => {
          void downloadEntry(docId, doc.currentVersion, doc.entry, doc.title);
          logEvent({ name: "export", params: { kind: "html" } });
        },
      },
    ];
    if (doc.version?.sourceEntry) {
      entries.push({
        id: "source",
        label: "Download the Markdown source",
        onSelect: () => {
          void downloadSource(docId, doc.currentVersion, doc.version!.sourceEntry!, doc.title);
          logEvent({ name: "export", params: { kind: "html" } });
        },
      });
    }
    if ((doc.version?.fileCount ?? 1) > 1) {
      entries.push({
        id: "zip",
        label: "Download everything as a .zip",
        onSelect: () => {
          downloadZip(docId, doc.currentVersion);
          logEvent({ name: "export", params: { kind: "zip" } });
        },
      });
    }
    entries.push(
      {
        id: "pdf",
        label: "Print or save as PDF",
        onSelect: () => {
          if (!frame.doc) return;
          void printDoc(frame.doc, {
            baseHref: `/content/${docId}/${doc.currentVersion}/`,
            marking: doc.meta?.marking ?? MARKING_OFF,
            title: doc.title,
            version: doc.currentVersion,
            user: emailLower,
          });
          logEvent({ name: "export", params: { kind: "pdf" } });
        },
      },
      { id: "image", label: "Export an image…", onSelect: () => setDialog("image") },
      { id: "sep1", separator: true },
    );

    if (doc.meta) {
      entries.push({ id: "h-doc", label: "This document", heading: true });
      entries.push({ id: "stats", label: "Activity", onSelect: () => setDialog("stats") });
      if (isOwner) {
        entries.push(
          { id: "share", label: "Share…", onSelect: () => setDialog("share") },
          { id: "visibility", label: "Who can see it…", onSelect: () => setDialog("visibility") },
          { id: "marking", label: "Marking on exports…", onSelect: () => setDialog("marking") },
        );
      }
    }

    if (doc.versions.length > 1) {
      entries.push({ id: "sep2", separator: true });
      entries.push({ id: "h-versions", label: "Versions", heading: true });
      for (const v of [...doc.versions].reverse().slice(0, 8)) {
        entries.push({
          id: v.versionId,
          label:
            v.versionId === doc.meta?.currentVersion
              ? `${v.versionId} — current`
              : v.versionId,
          disabled: v.versionId === doc.currentVersion,
          onSelect: () => navigate(`/d/${docId}/${v.versionId}`),
        });
      }
    }
    return entries;
  }, [doc, docId, frame.doc, isOwner, emailLower, navigate]);

  if (doc.loading) return <Loading label="Opening the document" />;
  if (doc.notFound) {
    return (
      <div className="empty-state">
        <h1>Not here</h1>
        <p>
          {/* Deliberately indistinguishable from "you may not read this": with
              no domain gate, a difference between the two would let anyone walk
              the slug space. */}
          This document does not exist, or you do not have access to it.
        </p>
      </div>
    );
  }

  const editingNow = mode.kind === "editing";
  const lockColor = presence.peers.find((p) => p.uid === lock.lock?.uid)?.color;

  return (
    <div className={presenting ? "viewer is-presenting" : "viewer"} data-pane={pane}>
      {editingNow ? (
        <EditToolbar
          format={doc.format}
          doc={frame.doc}
          saveState={editor.saveState}
          saveError={editor.saveError}
          observing={lock.observing}
          onCommit={() => void commit()}
          commitDisabled={annotations.some((a) => !a.resolved)}
          commitDisabledReason={
            annotations.some((a) => !a.resolved)
              ? "Resolve every comment first. Annotations belong to a version, so publishing would leave them behind."
              : undefined
          }
        />
      ) : (
        <ViewerToolbar
          title={doc.title}
          versionLabel={doc.currentVersion}
          peers={presence.peers}
          following={presence.following}
          onToggleFollow={presence.toggleFollow}
          commentsOpen={commentsOpen}
          onToggleComments={() => setCommentsOpen((v) => !v)}
          canEdit={canEdit}
          editing={editingNow}
          onToggleEdit={() => setWantsEdit((v) => !v)}
          offerTrust={liveTrust.shouldOffer}
          onOpenTrust={() => setDialog("trust")}
          onPresent={() => {
            setPresenting(true);
            void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
          menuEntries={menuEntries}
          pane={pane}
          onPane={setPane}
          singleColumn={singleColumn}
        />
      )}

      <ViewerBanners
        newVersion={live.newVersion}
        onOpenNewVersion={() => navigate(`/d/${docId}`)}
        onDismissNewVersion={live.dismissNewVersion}
        conflict={live.conflict}
        onTakeTheirs={() => {
          live.dismissConflict();
          frame.reload();
        }}
        onKeepMine={live.dismissConflict}
        lock={lock.lock}
        observing={lock.observing}
        asked={lock.asked}
        onAskToEdit={() => void lock.askToEdit()}
        idleWarning={lock.idleWarning}
        onStayEditing={lock.keepAlive}
        requests={lock.requests}
        onHandOff={(uid) => void lock.handOff(uid)}
        onDismissRequest={lock.dismissRequest}
        orphanedCount={annotationLayer.orphaned.length}
        offerTrust={liveTrust.shouldOffer}
        onOpenTrust={() => setDialog("trust")}
        peerColor={lockColor}
      />

      <div className="viewer-body">
        <div className="doc-frame-wrap">
          {editingNow ? (
            <SlidePanel
              doc={frame.doc}
              epoch={frame.epoch}
              editable={!lock.observing}
              onChanged={() => frame.doc?.dispatchEvent(new Event("input", { bubbles: true }))}
            />
          ) : null}
          <iframe
            {...frame.frameProps}
            ref={frame.ref}
            className="doc-frame"
            title={doc.title}
          />
          <SelectionFab
            doc={frame.doc}
            epoch={frame.epoch}
            enabled={mode.kind === "reading"}
            label={user ? "Comment" : "Sign in to comment"}
            onComment={() => void startComment()}
          />
          {presenting ? (
            <button
              type="button"
              className="btn present-exit"
              onClick={() => {
                setPresenting(false);
                void document.exitFullscreen?.().catch(() => {});
              }}
            >
              Exit
            </button>
          ) : null}
        </div>

        {commentsOpen && doc.currentVersion ? (
          <Sidebar
            docId={docId}
            versionId={doc.currentVersion}
            annotations={annotations}
            orphaned={annotationLayer.orphaned}
            selectedId={selectedId}
            canComment={signedIn}
            signedIn={signedIn}
            peers={presence.peers}
            uid={user?.uid ?? null}
            emailLower={emailLower}
            onSelect={setSelectedId}
            onComposing={presence.setComposing}
            onSignIn={() => navigate("/signup")}
            onClose={() => setCommentsOpen(false)}
          />
        ) : null}
      </div>

      {dialog === "share" && doc.meta ? (
        <SharePanel
          target={{
            kind: "doc",
            id: docId,
            title: doc.title,
            ownerEmail: doc.meta.ownerEmail,
            viewers: doc.meta.viewers,
            editors: doc.meta.editors,
            members: doc.meta.members,
          }}
          teams={teams}
          isOwner={isOwner}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "visibility" && doc.meta ? (
        <VisibilityDialog
          docId={docId}
          current={{
            visibility: doc.meta.visibility ?? "private",
            publicEdit: doc.meta.publicEdit ?? false,
            linkToken: doc.meta.linkToken ?? null,
          }}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "trust" ? (
        <TrustDialog
          docId={docId}
          isOwner={isOwner}
          personallyTrusted={liveTrust.personallyTrusted}
          onClose={() => setDialog(null)}
          onPersonalTrust={liveTrust.grantPersonal}
        />
      ) : null}

      {dialog === "marking" && doc.meta ? (
        <MarkingDialog
          docId={docId}
          current={doc.meta.marking ?? MARKING_OFF}
          onClose={() => setDialog(null)}
          onChanged={() => {}}
        />
      ) : null}

      {dialog === "stats" && doc.meta ? (
        <StatsPanel
          meta={doc.meta}
          canSeeDetail={isDocEditor}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "image" ? (
        <ImageExportDialog
          doc={frame.doc}
          title={doc.title}
          version={doc.currentVersion}
          user={emailLower}
          marking={doc.meta?.marking}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
